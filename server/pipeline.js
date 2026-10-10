// Core AI pipeline: claim extraction, then per-claim verification + bias
// analysis grounded in real search results.
//
// Note on scope vs. CLAUDE.md's spec: the spec describes a fully agentic,
// multi-iteration tool-use loop per claim (Agents 2 & 3, up to 3 search
// rounds each). To keep latency inside the ~5s/claim budget and the surface
// area testable, v1 collapses that into one search pass + one synthesis call
// per claim, grounded in the same real search results the agentic version
// would gather. The search/synthesis split is isolated below so a multi-turn
// tool-use loop can be dropped in later without touching the server routes.

const {
  Anthropic,
  APIError,
  APIConnectionTimeoutError,
  AuthenticationError,
  RateLimitError,
} = require("@anthropic-ai/sdk");
const { searchWeb } = require("./search");
const { getDomain, getLean, isPrimarySource } = require("./sourceLean");

const MODEL = "claude-haiku-4-5-20251001";

let anthropicClient = null;
/**
 * Returns the shared Anthropic SDK client, creating it on first call.
 * @returns {import("@anthropic-ai/sdk").Anthropic}
 */
function client() {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      // Haiku calls here finish in seconds. The SDK default (10 minutes per attempt, three
      // attempts) would otherwise hold an SSE stream open for up to 30 minutes on a stall.
      timeout: 60 * 1000,
      maxRetries: 2,
    });
  }
  return anthropicClient;
}

/**
 * Parses JSON from a string, stripping optional markdown code fences first.
 * @param {string} text - Raw text that may contain a fenced JSON block.
 * @returns {unknown} Parsed JSON value.
 * @throws {SyntaxError} If the extracted text is not valid JSON.
 */
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let candidate;
  if (fenced) {
    candidate = fenced[1];
  } else {
    candidate = text;
  }
  return JSON.parse(candidate.trim());
}

/**
 * Converts an Anthropic SDK error into an Error whose message is safe to show in the sidebar.
 * @param {unknown} error - Error thrown by the SDK.
 * @returns {Error}
 */
function describeAnthropicError(error) {
  if (error instanceof RateLimitError) {
    return new Error("The fact-check service is busy right now — please try again in a minute.");
  }
  if (error instanceof AuthenticationError) {
    return new Error("Server misconfiguration: ANTHROPIC_API_KEY was rejected.");
  }
  if (error instanceof APIConnectionTimeoutError) {
    return new Error("The request to Claude timed out — please try again.");
  }
  if (error instanceof APIError && error.status === 529) {
    return new Error("Claude is temporarily overloaded — please try again shortly.");
  }
  if (error instanceof APIError) {
    return new Error(`Claude request failed (${error.status ?? "network error"}).`);
  }
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

/**
 * Sends a prompt to Claude and parses the response as JSON, retrying once on parse failure.
 * @param {string} prompt - The user message to send.
 * @param {{ maxTokens?: number, retries?: number }} [options]
 * @param {number} [options.maxTokens=4096] - Claude max_tokens cap.
 * @param {number} [options.retries=1] - Number of extra attempts after a JSON parse failure.
 * @returns {Promise<unknown>} Parsed JSON value from Claude's response.
 * @throws {Error} If all attempts fail to produce valid JSON.
 */
async function askClaudeForJson(prompt, { maxTokens = 4096, retries = 1 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let response;
    try {
      response = await client().messages.create({
        model: MODEL,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      });
    } catch (error) {
      // Keep the upstream detail in server logs; the client only sees the sanitized message.
      console.error("Anthropic request failed:", error?.status ?? "network", error?.message);
      throw describeAnthropicError(error);
    }

    if (
      response.stop_reason === "max_tokens" ||
      response.stop_reason === "model_context_window_exceeded"
    ) {
      throw new Error(
        `Claude response was truncated (${response.stop_reason}, max_tokens=${maxTokens}); raise the cap or shorten the input.`
      );
    }
    if (response.stop_reason === "refusal") {
      const why = response.stop_details?.explanation;
      throw new Error(`Claude declined to process this content${why ? `: ${why}` : "."}`);
    }

    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    try {
      return extractJson(text);
    } catch (error) {
      lastError = error;
      prompt = `${prompt}\n\nYour previous response could not be parsed as JSON. Respond with ONLY a valid JSON value — no prose, no markdown fences.`;
    }
  }
  throw new Error(`Claude did not return valid JSON: ${lastError.message}`);
}

// ---- Volatility Classifier -------------------------------------------------

/**
 * Builds the classification prompt asking Claude to rate temporal urgency.
 * @param {string} headline - Article headline.
 * @param {string} intro - Opening text of the article (truncated by caller).
 * @returns {string} Prompt string ready to send to Claude.
 */
const VOLATILITY_PROMPT = (headline, intro) =>
  `You are classifying the temporal urgency of a news article.

Headline: "${headline}"

Opening text:
"""
${intro}
"""

Classify as one of:
- "breaking": actively unfolding right now; facts may change by the hour
- "developing": broke recently (within a day or two); primary facts mostly established but updates likely
- "stable": settled story; recency is not a concern for fact-checking

Respond with ONLY a JSON object, no prose, no markdown:
{"volatility": "breaking" | "developing" | "stable"}`;

/**
 * Classifies a news article's temporal urgency as breaking, developing, or stable.
 * Defaults to "stable" on any error so it never blocks the pipeline.
 * @param {string} headline - Article headline.
 * @param {string} intro - Opening article text used as context.
 * @returns {Promise<"breaking"|"developing"|"stable">}
 */
async function classifyVolatility(headline, intro) {
  try {
    const result = await askClaudeForJson(VOLATILITY_PROMPT(headline, intro.slice(0, 600)), {
      maxTokens: 50,
      retries: 1,
    });
    if (["breaking", "developing", "stable"].includes(result?.volatility)) {
      return result.volatility;
    }
    return "stable";
  } catch {
    return "stable"; // fail open — never block the pipeline on this
  }
}

// ---- Agent 1: Claim Extractor ----------------------------------------------

/**
 * Builds the claim-extraction prompt with adaptive count instruction.
 * @param {string} articleText - Full article body (sliced by caller before sending).
 * @param {number|"auto"} claimCount - Target claim count or "auto" for Claude to decide.
 * @returns {string} Prompt string ready to send to Claude.
 */
const CLAIM_EXTRACTION_PROMPT = (articleText, claimCount) => {
  let countInstruction;
  if (claimCount === "auto") {
    countInstruction =
      "Extract as many important, distinct factual claims as the article warrants — typically 5–8, fewer for short pieces, no more than 10.";
  } else {
    countInstruction = `Extract exactly the ${claimCount} most important distinct factual claims.`;
  }

  return `You are a fact-checking assistant that identifies discrete, checkable factual claims in a news article.

Read the article text below. ${countInstruction} Focus on specific, checkable assertions (statistics, quotes, events, attributions) — not opinions or vague statements. Prefer claims a reader would want verified and claims that may be controversial.

Also classify whether the piece reads as straight news reporting or opinion/editorial/analysis.

For each claim, also provide a one-sentence context field that resolves any vague references — pronouns, demonstratives ("such services", "the measure", "this bill", "those cuts"), and shorthand — by substituting the specific referent found in the surrounding article text. If the claim is already fully self-contained, set context to be identical to the claim.

CRITICAL — names of people: Never extract a surname alone (e.g. "Castro", "Smith", "Johnson"). Always use the full name as established in the article. If the article introduces the person with a title or role (e.g. "Senator", "CEO", "President"), include that identifier too (e.g. "Senator Bob Menendez (D-NJ)", "Fidel Castro, former Cuban leader"). This prevents confusing similarly named people during web search.

Respond with ONLY a JSON object in this exact shape, no prose, no markdown fences:
{
  "piece_type": "news" | "opinion" | "analysis",
  "claims": [
    {"claim": "verbatim or lightly cleaned factual sentence from the article", "context": "same sentence with all vague references resolved to their specific referents, and all people identified by full name + role"},
    ...
  ]
}

Article text:
"""
${articleText.slice(0, 12000)}
"""`;
};

/**
 * Extracts and normalizes factual claims from article text via Claude, then
 * runs a disambiguation pass to resolve ambiguous person names.
 * @param {string} articleText - Full article body.
 * @param {number|"auto"} [claimCount=5] - Desired number of claims.
 * @returns {Promise<{pieceType: "news"|"opinion"|"analysis", claims: Array<{claim: string, context: string}>}>}
 * @throws {Error} If Claude returns no claims.
 */
async function extractClaims(articleText, claimCount = 5) {
  const result = await askClaudeForJson(CLAIM_EXTRACTION_PROMPT(articleText, claimCount), {
    maxTokens: 4096,
  });

  if (!Array.isArray(result?.claims) || result.claims.length < 1) {
    throw new Error("Claim extraction returned no claims.");
  }

  let maxClaims;
  if (claimCount === "auto") {
    maxClaims = 10;
  } else {
    maxClaims = claimCount;
  }

  // Normalise: Claude may return strings (old format) or {claim, context} objects.
  const normalised = result.claims.slice(0, maxClaims).map((item) => {
    if (typeof item === "string") {
      return { claim: item, context: item };
    }
    return {
      claim: String(item.claim || ""),
      context: String(item.context || item.claim || ""),
    };
  });

  // Rewrite any claim that still contains an ambiguous surname before
  // fact-checking begins, so search queries target the right person.
  const disambiguated = await disambiguateEntities(articleText, normalised);

  let pieceType;
  if (result.piece_type === "opinion" || result.piece_type === "analysis") {
    pieceType = result.piece_type;
  } else {
    pieceType = "news";
  }

  return {
    pieceType,
    claims: disambiguated,
  };
}

// ---- Entity Disambiguation Pass --------------------------------------------
// Runs once after claim extraction. Takes the full article text and the
// extracted claims, and rewrites any claim where a person is identified only
// by a surname (or an ambiguous short name) to include their full name, role,
// and enough context for an unambiguous web search.

/**
 * Builds the entity disambiguation prompt used to rewrite ambiguous person references.
 * @param {string} articleText - Full article body for identity resolution.
 * @param {Array<{claim: string, context: string}>} claims - Claims to review.
 * @returns {string} Prompt string ready to send to Claude.
 */
const DISAMBIGUATION_PROMPT = (articleText, claims) =>
  `You are helping prepare fact-checking search queries. Your only job is to rewrite claims that reference a person by surname alone or by an ambiguous short name, so that each person is identified unambiguously.

For each claim and its context field, check whether any person is named only by surname (e.g. "Castro", "Johnson", "Lee") or by a short name that could match multiple well-known people. If so, rewrite both fields to use the person's full name and, where the article provides it, their role or affiliation (e.g. "Cuban leader Fidel Castro", "Senator Bob Menendez (D-NJ)", "Alejandro Castro Espín, son of Raúl Castro"). Use the article text below to resolve identities — do not guess.

If a claim already contains a fully unambiguous identifier, return it unchanged.

Article text (for identity resolution):
"""
${articleText.slice(0, 12000)}
"""

Claims to review (JSON array):
${JSON.stringify(claims, null, 2)}

Respond with ONLY a JSON array of the same length and shape as the input, with "claim" and "context" fields updated where needed. No prose, no markdown fences.`;

/**
 * Rewrites claims containing ambiguous surname-only references with full names and roles.
 * Falls back to the original claims array on any error so it never blocks the pipeline.
 * @param {string} articleText - Full article body used to resolve identities.
 * @param {Array<{claim: string, context: string}>} claims - Claims to potentially rewrite.
 * @returns {Promise<Array<{claim: string, context: string}>>} Rewritten (or original) claims.
 */
async function disambiguateEntities(articleText, claims) {
  try {
    const rewritten = await askClaudeForJson(DISAMBIGUATION_PROMPT(articleText, claims), {
      maxTokens: 4096,
      retries: 1,
    });
    if (!Array.isArray(rewritten) || rewritten.length !== claims.length) {
      return claims; // shape mismatch — fall back to originals
    }
    return rewritten.map((item, i) => {
      if (typeof item === "string") {
        return claims[i]; // unexpected format
      }
      return {
        claim: String(item.claim || claims[i].claim),
        context: String(item.context || item.claim || claims[i].context),
      };
    });
  } catch {
    return claims; // never block the pipeline on this pass
  }
}

// ---- Agents 2 & 3 merged: Verification + Divergence -------------------------

/**
 * Enriches raw Brave Search results with political lean, primary-source flag, and domain label.
 * @param {Array<{url: string, title: string, description: string, age: string|null, publishedAt: string|null}>} results
 * @returns {Array<{outlet: string, title: string, url: string, description: string, lean: string, isPrimary: boolean, age: string|null, publishedAt: string|null}>}
 */
function annotateSources(results) {
  return results.map((result) => {
    const annotated = {
      outlet: getDomain(result.url),
      title: result.title,
      url: result.url,
      description: result.description,
      lean: getLean(result.url),
      isPrimary: isPrimarySource(result.url),
      age: result.age || null,
      publishedAt: result.publishedAt || null,
    };
    return annotated;
  });
}

/**
 * Serializes annotated sources into a numbered list string suitable for Claude prompts.
 * @param {Array<{outlet: string, lean: string, isPrimary: boolean, title: string, description: string, url: string}>} sources
 * @returns {string} Numbered source list with outlet, lean, title, snippet, and URL.
 */
function formatSourcesForPrompt(sources) {
  const lines = sources.map((s, i) => {
    const primaryTag = s.isPrimary ? ", primary source" : "";
    return `[${i + 1}] ${s.outlet} (${s.lean}${primaryTag})\nTitle: ${s.title}\nSnippet: ${s.description}\nURL: ${s.url}`;
  });
  return lines.join("\n\n");
}

/**
 * Builds the fact-check synthesis prompt with claim, resolved context, and annotated sources.
 * @param {string} claim - Original claim text from the article.
 * @param {string|null} context - Resolved version of the claim with vague references replaced.
 * @param {Array<object>} sources - Annotated search results from annotateSources().
 * @param {string} pieceType - "news", "opinion", or "analysis".
 * @returns {string} Prompt string ready to send to Claude.
 */
const FACT_CHECK_PROMPT = (
  claim,
  context,
  sources,
  pieceType
) => `You are a careful, neutral research assistant helping a reader understand the context behind a factual claim from a news article. You never issue a hard true/false verdict — you assess how well-supported the claim is and surface sources across the political spectrum.
${pieceType !== "news" ? `\nNote: This claim comes from a ${pieceType} piece. Assess whether it is stated as objective fact or as the author's interpretation/argument — note this in your confidence_rationale if relevant.\n` : ""}
Claim to assess:
"${claim}"
${
  context && context !== claim
    ? `
Resolved claim (vague references replaced with their specific referents from the article):
"${context}"

Before formulating your assessment, resolve all pronouns and vague references in the claim using the resolved version above. Base your search query reasoning and synthesis on the resolved claim, not the shorthand form.
`
    : ""
}
Here is a set of search results gathered about this claim. Use ONLY these results plus your general knowledge of how to weigh source quality:

${formatSourcesForPrompt(sources)}

Respond with ONLY a JSON object in this exact shape, no prose, no markdown fences:
{
  "confidence": "high" | "medium" | "low",
  "confidence_rationale": "one sentence on why",
  "supporting_sources": [{"outlet": "...", "lean": "...", "url": "...", "title": "..."}],
  "contradicting_sources": [{"outlet": "...", "lean": "...", "url": "...", "title": "..."}],
  "primary_sources": [{"outlet": "...", "url": "...", "title": "..."}],
  "divergence_summary": "one or two sentences on how coverage of this claim differs across outlets, naming outlets and their framing — or 'No notable divergence found' if coverage is consistent",
  "outlet_positions": [{"outlet": "...", "lean": "...", "position": "short description of how this outlet frames/reports the claim"}]
}

Confidence thresholds — apply these strictly:
- "high": 3 or more independent sources confirm the claim, OR at least one primary source (AP/Reuters wire, .gov data) directly confirms it, AND there is no credible contradiction. Do not downgrade for temporal uncertainty (e.g., "this is a recent event") if search results confirm the claim — the search results ARE the evidence.
- "medium": The claim has some support but meaningful gaps remain — indirect evidence only, mixed signals, OR one credible contradicting source among several supporting ones.
- "low": No sources confirm the claim, sources actively contradict it, or the results do not address the claim at all.

Contradiction rules:
- Before flagging a source as contradicting, check whether the apparent discrepancy is a time zone difference (e.g., 7:30 p.m. CT vs 8:30 p.m. ET are the same moment), a unit difference, or a rounding difference. If so, it is NOT a true contradiction — treat both sources as supporting.
- A single low-credibility or local source contradicting several major outlets is weak contradiction. Favor "high" confidence if 4+ credible sources agree.

Additional rules:
- Only cite outlets/URLs that appear in the search results above — never invent sources.
- If the search results don't clearly address the claim, use "low" confidence and say so in the rationale.
- Keep "outlet_positions" to at most 4 entries, prioritizing outlets with different "lean" labels.
- PRIMARY SOURCES are government data (.gov sites), official wire service dispatches (AP/Reuters), peer-reviewed academic sources (.edu, academic journals), official government transcripts, and intergovernmental bodies (UN, WHO, World Bank). Reliable media outlets such as BBC, NPR, CNN, or The Guardian do NOT qualify as primary sources regardless of their reputation — list those under supporting_sources instead.`;

const RECENCY_THRESHOLD_MS = 10 * 60 * 60 * 1000;

// Brave freshness filter per volatility level. Volatile stories are searched for recent
// coverage first so applyRecencyAdjustment judges what is actually out there rather
// than penalising an unfiltered search that happened to surface older background pieces.
const FRESHNESS_BY_VOLATILITY = { breaking: "pd", developing: "pw" };
const MIN_FRESH_RESULTS = 3;
const CONFIDENCE_ORDER = ["high", "medium", "low"];

/**
 * Downgrades confidence by one level when the story is volatile and all dated sources
 * are older than the recency threshold. Returns the original result unchanged for stable stories.
 * @param {object} result - Fact-check synthesis object from Claude.
 * @param {"breaking"|"developing"|"stable"} volatility - Story's temporal urgency.
 * @returns {object} Result with potentially downgraded confidence and updated rationale.
 */
function applyRecencyAdjustment(result, volatility) {
  if (volatility === "stable") return result;

  const candidates = [
    ...(result.supporting_sources || []),
    ...(result.primary_sources || []),
  ].filter((s) => s.publishedAt);

  if (candidates.length === 0) return result; // no dates → can't assess; don't downgrade

  const times = candidates.map((s) => new Date(s.publishedAt).getTime()).filter(Number.isFinite);
  if (times.length === 0) return result; // unparseable dates → can't assess; don't downgrade

  const newestMs = Math.max(...times);
  if (Date.now() - newestMs <= RECENCY_THRESHOLD_MS) {
    return result; // fresh enough
  }

  const currentIdx = CONFIDENCE_ORDER.indexOf(result.confidence);
  let downgraded;
  if (currentIdx < CONFIDENCE_ORDER.length - 1) {
    downgraded = CONFIDENCE_ORDER[currentIdx + 1];
  } else {
    downgraded = result.confidence;
  }

  const note = `Confidence downgraded: this is a ${volatility} story and the most recent sources may be outdated.`;
  let updatedRationale;
  if (result.confidence_rationale) {
    updatedRationale = `${result.confidence_rationale} ${note}`;
  } else {
    updatedRationale = note;
  }

  const adjustedResult = {
    ...result,
    confidence: downgraded,
    confidence_rationale: updatedRationale,
    recency_downgraded: true,
  };
  return adjustedResult;
}

/**
 * Runs the full fact-check pipeline for a single claim: web search, source annotation,
 * Claude synthesis, primary-source enforcement, date enrichment, and recency adjustment.
 * @param {string} claim - Verbatim claim text extracted from the article.
 * @param {string|null} [context=null] - Resolved version of the claim for more accurate search queries.
 * @param {"news"|"opinion"|"analysis"} [pieceType="news"] - Article content type.
 * @param {"breaking"|"developing"|"stable"} [volatility="stable"] - Story temporal urgency.
 * @returns {Promise<object>} Fact-check result with confidence, sources, and divergence summary.
 */
async function factCheckClaim(claim, context = null, pieceType = "news", volatility = "stable") {
  // Use the resolved context as the search query when available — it contains
  // the specific referents that vague phrases ("such services", "the measure")
  // were pointing to, which produces more accurate search results.
  let searchQuery;
  if (context && context !== claim) {
    searchQuery = context;
  } else {
    searchQuery = claim;
  }
  const freshness = FRESHNESS_BY_VOLATILITY[volatility];
  let rawResults;
  if (freshness) {
    rawResults = await searchWeb(searchQuery, { count: 8, freshness });
    if (rawResults.length < MIN_FRESH_RESULTS) {
      // Thin recent coverage — top up with an unfiltered search, de-duplicated by URL.
      const broad = await searchWeb(searchQuery, { count: 8 });
      const seen = new Set(rawResults.map((r) => r.url));
      rawResults = rawResults.concat(broad.filter((r) => !seen.has(r.url))).slice(0, 8);
    }
  } else {
    rawResults = await searchWeb(searchQuery, { count: 8 });
  }
  const sources = annotateSources(rawResults);

  if (sources.length === 0) {
    return {
      claim,
      context: context || claim,
      confidence: "low",
      confidence_rationale: "No search results were found for this claim.",
      supporting_sources: [],
      contradicting_sources: [],
      primary_sources: [],
      divergence_summary: "No coverage found to compare.",
      outlet_positions: [],
      citation_needed: true,
    };
  }

  const synthesis = await askClaudeForJson(FACT_CHECK_PROMPT(claim, context, sources, pieceType), {
    maxTokens: 4096,
  });

  // Enforce primary source definition and fill in lean/outlet data that Claude
  // omits from primary_sources (unlike supporting/contradicting sources which
  // Claude annotates itself).
  if (Array.isArray(synthesis.primary_sources)) {
    synthesis.primary_sources = synthesis.primary_sources
      .filter((s) => s.url && isPrimarySource(s.url))
      .map((s) => {
        const enriched = {
          ...s,
          outlet: s.outlet || getDomain(s.url),
          lean: getLean(s.url),
        };
        return enriched;
      });
  }

  // Carry age/publishedAt from the search results onto each source bucket so
  // the UI can render timestamps and applyRecencyAdjustment can do math.
  const datesByUrl = Object.fromEntries(
    sources.map((s) => {
      return [s.url, { age: s.age, publishedAt: s.publishedAt }];
    })
  );

  const enrichDates = (list) => {
    const safeList = list || [];
    return safeList.map((s) => {
      const dates = datesByUrl[s.url] || {};
      return { ...s, ...dates };
    });
  };

  const enriched = {
    ...synthesis,
    supporting_sources: enrichDates(synthesis.supporting_sources),
    contradicting_sources: enrichDates(synthesis.contradicting_sources),
    primary_sources: enrichDates(synthesis.primary_sources),
  };

  const finalResult = {
    claim,
    context: context || claim,
    ...applyRecencyAdjustment(enriched, volatility),
  };
  if (
    (!finalResult.supporting_sources || finalResult.supporting_sources.length === 0) &&
    (!finalResult.primary_sources || finalResult.primary_sources.length === 0)
  ) {
    finalResult.citation_needed = true;
  }
  return finalResult;
}

module.exports = { classifyVolatility, extractClaims, factCheckClaim };

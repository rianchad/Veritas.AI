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

const Anthropic = require("@anthropic-ai/sdk");
const { searchWeb } = require("./search");
const { getDomain, getLean, isPrimarySource } = require("./sourceLean");

const MODEL = "claude-sonnet-4-20250514";

let anthropicClient = null;
function client() {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  return JSON.parse(candidate.trim());
}

async function askClaudeForJson(prompt, { maxTokens = 1500, retries = 1 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await client().messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    });

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

async function classifyVolatility(headline, intro) {
  try {
    const result = await askClaudeForJson(
      VOLATILITY_PROMPT(headline, intro.slice(0, 600)),
      { maxTokens: 50, retries: 1 }
    );
    if (["breaking", "developing", "stable"].includes(result?.volatility)) {
      return result.volatility;
    }
    return "stable";
  } catch {
    return "stable"; // fail open — never block the pipeline on this
  }
}

// ---- Agent 1: Claim Extractor ----------------------------------------------

const CLAIM_EXTRACTION_PROMPT = (articleText, claimCount) => {
  const countInstruction = claimCount === "auto"
    ? "Extract as many important, distinct factual claims as the article warrants — typically 5–8, fewer for short pieces, no more than 10."
    : `Extract exactly the ${claimCount} most important distinct factual claims.`;

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

async function extractClaims(articleText, claimCount = 5) {
  const result = await askClaudeForJson(CLAIM_EXTRACTION_PROMPT(articleText, claimCount), {
    maxTokens: 1500,
  });

  if (!Array.isArray(result?.claims) || result.claims.length < 1) {
    throw new Error("Claim extraction returned no claims.");
  }

  const maxClaims = claimCount === "auto" ? 10 : claimCount;

  // Normalise: Claude may return strings (old format) or {claim, context} objects.
  const normalised = result.claims.slice(0, maxClaims).map((item) => {
    if (typeof item === "string") return { claim: item, context: item };
    return {
      claim: String(item.claim || ""),
      context: String(item.context || item.claim || ""),
    };
  });

  // Rewrite any claim that still contains an ambiguous surname before
  // fact-checking begins, so search queries target the right person.
  const disambiguated = await disambiguateEntities(articleText, normalised);

  return {
    pieceType: result.piece_type === "opinion" || result.piece_type === "analysis"
      ? result.piece_type
      : "news",
    claims: disambiguated,
  };
}

// ---- Entity Disambiguation Pass --------------------------------------------
// Runs once after claim extraction. Takes the full article text and the
// extracted claims, and rewrites any claim where a person is identified only
// by a surname (or an ambiguous short name) to include their full name, role,
// and enough context for an unambiguous web search.

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

async function disambiguateEntities(articleText, claims) {
  try {
    const rewritten = await askClaudeForJson(
      DISAMBIGUATION_PROMPT(articleText, claims),
      { maxTokens: 1500, retries: 1 }
    );
    if (!Array.isArray(rewritten) || rewritten.length !== claims.length) {
      return claims; // shape mismatch — fall back to originals
    }
    return rewritten.map((item, i) => {
      if (typeof item === "string") return claims[i]; // unexpected format
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

function annotateSources(results) {
  return results.map((result) => ({
    outlet: getDomain(result.url),
    title: result.title,
    url: result.url,
    description: result.description,
    lean: getLean(result.url),
    isPrimary: isPrimarySource(result.url),
    age: result.age || null,
    publishedAt: result.publishedAt || null,
  }));
}

function formatSourcesForPrompt(sources) {
  return sources
    .map(
      (s, i) =>
        `[${i + 1}] ${s.outlet} (${s.lean}${s.isPrimary ? ", primary source" : ""})\nTitle: ${s.title}\nSnippet: ${s.description}\nURL: ${s.url}`
    )
    .join("\n\n");
}

const FACT_CHECK_PROMPT = (claim, context, sources, pieceType) => `You are a careful, neutral research assistant helping a reader understand the context behind a factual claim from a news article. You never issue a hard true/false verdict — you assess how well-supported the claim is and surface sources across the political spectrum.
${pieceType !== "news" ? `\nNote: This claim comes from a ${pieceType} piece. Assess whether it is stated as objective fact or as the author's interpretation/argument — note this in your confidence_rationale if relevant.\n` : ""}
Claim to assess:
"${claim}"
${context && context !== claim ? `
Resolved claim (vague references replaced with their specific referents from the article):
"${context}"

Before formulating your assessment, resolve all pronouns and vague references in the claim using the resolved version above. Base your search query reasoning and synthesis on the resolved claim, not the shorthand form.
` : ""}
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

// 10h threshold (12h spec minus ±2h tolerance for crawl-time lag).
const RECENCY_THRESHOLD_MS = 10 * 60 * 60 * 1000;
const CONFIDENCE_ORDER = ["high", "medium", "low"];

function applyRecencyAdjustment(result, volatility) {
  if (volatility === "stable") return result;

  const candidates = [
    ...(result.supporting_sources || []),
    ...(result.primary_sources || []),
  ].filter((s) => s.publishedAt);

  if (candidates.length === 0) return result; // no dates → can't assess; don't downgrade

  const newestMs = Math.max(...candidates.map((s) => new Date(s.publishedAt).getTime()));
  if (Date.now() - newestMs <= RECENCY_THRESHOLD_MS) return result; // fresh enough

  const currentIdx = CONFIDENCE_ORDER.indexOf(result.confidence);
  const downgraded =
    currentIdx < CONFIDENCE_ORDER.length - 1
      ? CONFIDENCE_ORDER[currentIdx + 1]
      : result.confidence;

  const note = `Confidence downgraded: this is a ${volatility} story and the most recent sources may be outdated.`;
  return {
    ...result,
    confidence: downgraded,
    confidence_rationale: result.confidence_rationale
      ? `${result.confidence_rationale} ${note}`
      : note,
    recency_downgraded: true,
  };
}

async function factCheckClaim(claim, context = null, pieceType = "news", volatility = "stable") {
  // Use the resolved context as the search query when available — it contains
  // the specific referents that vague phrases ("such services", "the measure")
  // were pointing to, which produces more accurate search results.
  const searchQuery = (context && context !== claim) ? context : claim;
  const rawResults = await searchWeb(searchQuery, { count: 8 });
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
    maxTokens: 1500,
  });

  // Enforce primary source definition and fill in lean/outlet data that Claude
  // omits from primary_sources (unlike supporting/contradicting sources which
  // Claude annotates itself).
  if (Array.isArray(synthesis.primary_sources)) {
    synthesis.primary_sources = synthesis.primary_sources
      .filter((s) => s.url && isPrimarySource(s.url))
      .map((s) => ({
        ...s,
        outlet: s.outlet || getDomain(s.url),
        lean: getLean(s.url),
      }));
  }

  // Carry age/publishedAt from the search results onto each source bucket so
  // the UI can render timestamps and applyRecencyAdjustment can do math.
  const datesByUrl = Object.fromEntries(
    sources.map((s) => [s.url, { age: s.age, publishedAt: s.publishedAt }])
  );
  const enrichDates = (list) =>
    (list || []).map((s) => ({ ...s, ...(datesByUrl[s.url] || {}) }));

  const enriched = {
    ...synthesis,
    supporting_sources: enrichDates(synthesis.supporting_sources),
    contradicting_sources: enrichDates(synthesis.contradicting_sources),
    primary_sources: enrichDates(synthesis.primary_sources),
  };

  const finalResult = { claim, context: context || claim, ...applyRecencyAdjustment(enriched, volatility) };
  if (
    (!finalResult.supporting_sources || finalResult.supporting_sources.length === 0) &&
    (!finalResult.primary_sources || finalResult.primary_sources.length === 0)
  ) {
    finalResult.citation_needed = true;
  }
  return finalResult;
}

module.exports = { classifyVolatility, extractClaims, factCheckClaim };

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

const CLAIM_EXTRACTION_PROMPT = (articleText) => `You are a fact-checking assistant that identifies discrete, checkable factual claims in a news article.

Read the article text below and extract as many distinct factual claims — specific, checkable assertions (statistics, quotes, events, attributions),
not opinions or vague statements. Prefer claims a reader would want verified and claims that may be controversial.

Also classify whether the piece reads as straight news reporting or opinion/editorial/analysis.

Respond with ONLY a JSON object in this exact shape, no prose, no markdown fences:
{
  "piece_type": "news" | "opinion" | "analysis",
  "claims": ["claim 1 as a self-contained sentence", "claim 2", ...]
}

Article text:
"""
${articleText.slice(0, 12000)}
"""`;

async function extractClaims(articleText) {
  const result = await askClaudeForJson(CLAIM_EXTRACTION_PROMPT(articleText), {
    maxTokens: 1200,
  });

  if (!Array.isArray(result?.claims) || result.claims.length < 3) {
    throw new Error("Claim extraction returned too few claims.");
  }

  return {
    pieceType: result.piece_type === "opinion" || result.piece_type === "analysis"
      ? result.piece_type
      : "news",
    claims: result.claims.slice(0, 8),
  };
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

const FACT_CHECK_PROMPT = (claim, sources, pieceType) => `You are a careful, neutral research assistant helping a reader understand the context behind a factual claim from a news article. You never issue a hard true/false verdict — you assess how well-supported the claim is and surface sources across the political spectrum.
${pieceType !== "news" ? `\nContext: This claim comes from a ${pieceType} piece. Assess whether it is stated as objective fact or as the author's interpretation/argument — note this in your confidence_rationale if relevant.\n` : ""}
Claim to assess:
"${claim}"

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

async function factCheckClaim(claim, pieceType = "news", volatility = "stable") {
  const rawResults = await searchWeb(claim, { count: 8 });
  const sources = annotateSources(rawResults);

  if (sources.length === 0) {
    return {
      claim,
      confidence: "low",
      confidence_rationale: "No search results were found for this claim.",
      supporting_sources: [],
      contradicting_sources: [],
      primary_sources: [],
      divergence_summary: "No coverage found to compare.",
      outlet_positions: [],
    };
  }

  const synthesis = await askClaudeForJson(FACT_CHECK_PROMPT(claim, sources, pieceType), {
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

  return { claim, ...applyRecencyAdjustment(enriched, volatility) };
}

module.exports = { classifyVolatility, extractClaims, factCheckClaim };

// Thin wrapper around the Brave Search API. Returns normalized results
// (title, url, description, dates) so the pipeline doesn't care which
// provider is behind it.

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

// Brave rejects queries beyond its documented limits (600 characters / 75 words).
const MAX_QUERY_CHARS = 600;
const MAX_QUERY_WORDS = 75;

// Hard cap on a single Brave request so a stalled search cannot hang a claim.
const BRAVE_TIMEOUT_MS = 15 * 1000;

/**
 * Trims a search query to Brave's documented length limits and collapses whitespace.
 * @param {string} query - Raw query text (a claim, its resolved context, or selected text).
 * @returns {string} Single-line query within the character and word limits.
 */
function clampQuery(query) {
  const words = String(query || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ");
  const joined = words.slice(0, MAX_QUERY_WORDS).join(" ");
  // Slice by code point so a cut never splits a surrogate pair into U+FFFD.
  return Array.from(joined).slice(0, MAX_QUERY_CHARS).join("").trim();
}

/**
 * Brave's page_age is an ISO timestamp with no timezone designator (UTC). Append "Z" so
 * Date parsing gives the same instant on the server and in the browser regardless of
 * local timezone.
 * @param {unknown} value - Raw page_age value.
 * @returns {string|null}
 */
function toUtcIso(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return value; // already has an offset
  if (!/T\d{2}:\d{2}/.test(value)) return value; // date-only strings already parse as UTC
  return `${value}Z`;
}

/**
 * Fetches a Brave endpoint with a hard timeout, translating the abort into a readable error.
 * @param {URL} url - Fully built request URL.
 * @param {Record<string, string>} headers - Request headers including the subscription token.
 * @returns {Promise<Response>}
 */
async function braveFetch(url, headers) {
  try {
    return await fetch(url, { headers, signal: AbortSignal.timeout(BRAVE_TIMEOUT_MS) });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new Error("Search provider timed out — please try again.");
    }
    throw error;
  }
}

/**
 * Queries the Brave Search API and returns normalized web results.
 * @param {string} query - The search query string.
 * @param {{ count?: number, freshness?: string }} [options] - Optional parameters.
 * @param {number} [options.count=6] - Maximum number of results to return.
 * @param {string} [options.freshness] - Brave freshness filter: "pd" (day), "pw" (week), "pm", "py".
 * @returns {Promise<Array<{title: string, url: string, description: string, age: string|null, publishedAt: string|null}>>}
 */
async function searchWeb(query, { count = 6, freshness } = {}) {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) throw new Error("BRAVE_SEARCH_API_KEY is not configured.");

  const url = new URL(BRAVE_ENDPOINT);
  url.searchParams.set("q", clampQuery(query));
  url.searchParams.set("count", String(count));
  url.searchParams.set("result_filter", "web"); // skip video/FAQ/discussion clusters we never read
  if (freshness) url.searchParams.set("freshness", freshness);

  const headers = { Accept: "application/json", "X-Subscription-Token": apiKey };
  let response = await braveFetch(url, headers);

  // Claims are searched concurrently, so a burst can trip Brave's per-second limit.
  // Retry once after the window Brave reports (capped) instead of failing the claim.
  if (response.status === 429) {
    const reset = Number((response.headers.get("x-ratelimit-reset") || "").split(",")[0]);
    let waitMs;
    if (Number.isFinite(reset) && reset > 0) {
      waitMs = Math.min(reset * 1000, 3000);
    } else {
      waitMs = 1000;
    }
    await response.body?.cancel().catch(() => {}); // release the socket before retrying
    await new Promise((resolve) => setTimeout(resolve, waitMs + Math.random() * 250));
    response = await braveFetch(url, headers);
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error("Server misconfiguration: BRAVE_SEARCH_API_KEY was rejected.");
    }
    if (response.status === 429) {
      throw new Error("Search provider rate limit reached — please try again in a moment.");
    }
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    let suffix;
    if (detail) {
      suffix = ` ${detail}`;
    } else {
      suffix = "";
    }
    throw new Error(`Brave Search request failed: ${response.status}${suffix}`);
  }

  const data = await response.json();
  const results = data?.web?.results || [];

  return results.map((result) => {
    const normalized = {
      title: result.title,
      url: result.url,
      description: result.description,
      age: result.age || null, // human-readable relative string, e.g. "5 hours ago"
      publishedAt: toUtcIso(result.page_age), // ISO publication timestamp, e.g. "2026-09-16T21:07:51Z"
    };
    return normalized;
  });
}

module.exports = { searchWeb };

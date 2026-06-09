// Thin wrapper around the Brave Search API. Returns normalized results
// (title, url, description) so the pipeline doesn't care which provider
// is behind it.

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

async function searchWeb(query, { count = 6 } = {}) {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) throw new Error("BRAVE_SEARCH_API_KEY is not configured.");

  const url = new URL(BRAVE_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey,
    },
  });

  if (!response.ok) {
    throw new Error(`Brave Search request failed: ${response.status}`);
  }

  const data = await response.json();
  const results = data?.web?.results || [];

  return results.map((result) => ({
    title: result.title,
    url: result.url,
    description: result.description,
    age: result.page_age || null,        // human-readable relative string, e.g. "5 hours ago"
    publishedAt: result.page_fetched || null, // ISO crawl timestamp used for threshold math
  }));
}

module.exports = { searchWeb };

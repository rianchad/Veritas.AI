# Veritas.ai server

Backend proxy that holds the Anthropic and Brave Search API keys and runs the
claim-extraction / fact-checking pipeline. The extension never talks to Claude
or the search API directly — it only talks to this server.

## Local development

```
cd server
npm install
cp .env.example .env   # fill in ANTHROPIC_API_KEY and BRAVE_SEARCH_API_KEY
npm run dev
```

The server listens on `http://localhost:8787` by default. Point the extension
at it by setting `API_BASE_URL` in [`sidebar.js`](../sidebar.js).

## Endpoints

- `GET /health` — liveness check
- `POST /api/analyze` — body `{ "articleText": "...", "articleTitle": "..." }`,
  rate-limited to **10 requests / minute per IP**; responds with a
  `text/event-stream` of:
  - `volatility` — `{ volatility }` (`"breaking"` | `"developing"` | `"stable"`) before claims arrive
  - `claims` — `{ pieceType, claims }` once extraction finishes
  - `claim_result` — one fact-check result per claim, as each finishes
  - `claim_error` — `{ claim, error }` if a single claim's check fails
  - `fatal_error` — `{ error }` if the pipeline fails before producing claims
  - `done` — stream complete
- `POST /api/check-claim` — body `{ "claim": "...", "volatility": "stable" }`;
  fact-checks a single user-selected claim; returns plain JSON (not SSE)
- `POST /api/share` — body `{ "articleUrl", "articleTitle", "results" }`,
  rate-limited to **20 requests / hour per IP**; stores a completed fact-check
  result set (7-day TTL in `shares.db`) and returns `{ "shareUrl": "..." }`
- `GET /share/:id` — renders a read-only HTML fact-check results page; returns
  `410 Gone` if the link has expired or does not exist

## Deploying (Railway / Render / Vercel free tier)

1. Push this `server/` directory (or the whole repo) to GitHub.
2. Create a new web service from the repo, root directory `server/`.
3. Set the start command to `npm start` and the build command to `npm install`.
4. Add environment variables: `ANTHROPIC_API_KEY`, `BRAVE_SEARCH_API_KEY`,
   `ALLOWED_ORIGINS` (set to `chrome-extension://<your-extension-id>`).
5. Once deployed, update `API_BASE_URL` in `sidebar.js` to the deployed URL.

## Notes

- `ALLOWED_ORIGINS` restricts CORS to your extension's origin. Find your
  extension ID at `chrome://extensions` (enable Developer Mode).
- The pipeline is described in detail in [`pipeline.js`](pipeline.js) — v1
  runs one search pass + one synthesis call per claim (grounded in real
  search results) rather than the fully agentic multi-loop version described
  in the project's `CLAUDE.md`; that can be layered in later without changing
  the server's HTTP surface.

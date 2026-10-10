# VeritasAI server

Backend proxy that holds the Anthropic and Brave Search API keys and runs the
claim-extraction / fact-checking pipeline. The extension never talks to Claude
or the search API directly — it only talks to this server.

## Local development

Requires Node.js 22–24 (`better-sqlite3` 13 needs 22+; the `engines` field caps at 24 so
hosting platforms don't drift onto a non-LTS release).

```
cd server
npm install
cp .env.example .env   # fill in ANTHROPIC_API_KEY and BRAVE_SEARCH_API_KEY
npm run dev
```

The server listens on `http://localhost:8787` by default. Point the extension
at it from the sidebar's **Settings → Backend URL** field (enter `http://localhost:8787`),
or change `DEFAULT_API_BASE_URL` in [`sidebar.js`](../sidebar.js).

## Endpoints

- `GET /health` — liveness check
- `GET /privacypolicy` — serves `landing/privacypolicy.html` when the whole repo is
  deployed; when only `server/` is deployed it redirects to `PRIVACY_POLICY_URL`
- `POST /api/analyze` — body `{ "articleText": "...", "articleTitle": "...", "claimCount": 5 }`
  (`claimCount` is 1–10 or `"auto"`; defaults to 5),
  rate-limited to **10 requests / minute per IP**; responds with a
  `text/event-stream` of:
  - `volatility` — `{ volatility }` (`"breaking"` | `"developing"` | `"stable"`) before claims arrive
  - `claims` — `{ pieceType, claims }` once extraction finishes
  - `claim_result` — one fact-check result per claim, as each finishes; includes
    `citation_needed: true` when no supporting or primary sources were found
  - `claim_error` — `{ claim, error }` if a single claim's check fails
  - `fatal_error` — `{ error }` if the pipeline fails before producing claims
  - `done` — stream complete
- `POST /api/check-claim` — body `{ "claim": "...", "volatility": "stable" }`;
  fact-checks a single user-selected claim, rate-limited to **20 requests / minute per IP**;
  returns plain JSON (not SSE).
  Result includes `citation_needed: true` when both `supporting_sources` and
  `primary_sources` are empty after synthesis — indicates the claim may be
  unverifiable or too newly reported to have coverage.
- `POST /api/share` — body `{ "articleUrl", "articleTitle", "results" }`,
  rate-limited to **20 requests / hour per IP**; stores a completed fact-check
  result set (7-day TTL in `shares.db`) and returns `{ "shareUrl": "..." }`
- `GET /share/:id` — renders a read-only HTML fact-check results page; returns
  `410 Gone` if the link has expired or does not exist

## Deploying (Railway / Render)

1. Push this `server/` directory (or the whole repo) to GitHub.
2. Create a new web service from the repo, root directory `server/`.
3. Set the start command to `npm start` and the build command to `npm ci`.
4. Add environment variables: `ANTHROPIC_API_KEY`, `BRAVE_SEARCH_API_KEY`,
   `ALLOWED_ORIGINS` (set to `chrome-extension://<your-extension-id>`). Optional:
   `PUBLIC_URL` (otherwise share links use each request's host), `TRUST_PROXY_HOPS`
   (auto: 1 on Railway/Render/Fly, else 0), `PRIVACY_POLICY_URL`, and `SHARES_DB_PATH` pointing at a persistent volume — without a
   volume, share links vanish on every deploy.
5. Once deployed, set `DEFAULT_API_BASE_URL` in `sidebar.js` to the deployed URL before
   publishing the extension. Already-installed copies can be pointed at the new URL from
   **Settings → Backend URL** without waiting for a store update.

## Notes

- `ALLOWED_ORIGINS` restricts CORS to your extension's origin. Find your
  extension ID at `chrome://extensions` (enable Developer Mode).
- The pipeline is described in detail in [`pipeline.js`](pipeline.js) — v1
  runs one search pass + one synthesis call per claim (grounded in real
  search results) rather than a fully agentic multi-loop version; that can be layered in later
  without changing the server's HTTP surface.

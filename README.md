# 🔍 Veritas.ai

> **Real-time AI fact-checking for news articles — right in your browser.**

Veritas.ai is a Chrome extension that extracts discrete factual claims from the article you're reading, verifies each one against primary sources and cross-outlet coverage, and surfaces confidence levels and source diversity in a clean sidebar panel. It never issues a hard TRUE/FALSE verdict — it shows you the evidence and lets you judge.

---

## ✨ Features

### 🧠 AI-Powered Claim Extraction
- Automatically identifies **5–8 discrete, checkable factual claims** from any news article — statistics, quotes, attributions, stated events
- Skips vague assertions and opinion language; focuses on what's actually verifiable
- Classifies the piece as **News**, **Opinion/Editorial**, or **Analysis/Commentary** and flags non-news pieces with a banner at the top of the sidebar

### ✅ Per-Claim Fact-Checking
- Each claim is independently verified against **real web search results** (Brave Search API)
- A synthesis agent weighs source quality, cross-references multiple outlets, and returns a structured confidence assessment
- **Confidence levels:** `High` · `Medium` · `Low` — with a one-sentence rationale explaining the score
- Strict confidence thresholds: `High` requires 3+ independent sources or a direct primary source confirmation with no credible contradictions

### 🏛️ Primary Source Priority
- **Primary sources** (`.gov` data, AP/Reuters wire dispatches, `.edu` research, WHO/UN/World Bank, SEC filings, court records) are identified and surfaced separately from media coverage
- Media outlets — even highly reputable ones — are never miscategorized as primary sources

### 🌐 Political Lean Labeling
- Every source card shows the outlet's political lean label: `Left` · `Lean Left` · `Center` · `Lean Right` · `Right`
- Ratings derived from AllSides and Ad Fontes Media public data, covering 100+ outlets
- Designed to show **spectrum diversity** across claims — the goal is to surface disagreement, not to editorialize

### 📊 Coverage Divergence Analysis
- For each claim, a divergence agent identifies **where outlets with different lean labels specifically disagree** — not just "they disagree," but "CNN says X, Fox says Y, Primary source says Z"
- Outlet positions are listed individually when notable divergence is detected

### ⚡ Volatility Classification & Recency Weighting
- Before fact-checking begins, the article is classified as **Breaking**, **Developing**, or **Stable** based on the headline and opening paragraphs
- **Breaking/Developing stories** show a prominent banner: *"This is a rapidly developing story — some sources may be outdated"*
- Sources older than **12 hours** in a breaking story trigger a **confidence downgrade** (one notch), with an explanation appended to the rationale
- Every source card shows a **relative timestamp** (e.g., `5 hours ago`, `2 days ago`) pulled from the search API
- Sources older than **24 hours** in a breaking or developing story receive a **subtle muted treatment** so stale sources are visually distinguishable at a glance
- Recency adjustment is skipped when publication dates are unavailable — unknown freshness is never penalized

### 🖊️ Text Selection Fact-Checking
- Highlight any sentence in the article and a popup appears in the sidebar offering to **fact-check that specific text**
- The selected claim is checked in isolation and inserted at the top of the claims list
- The current article's volatility classification is applied to selection-based checks automatically

### 🔦 Claim-to-Article Highlighting
- Hover over any claim card to **highlight the matching paragraph** in the article page
- Uses keyword-overlap scoring to find the best-matching paragraph; scrolls it into view if needed

### 📊 Article-Level Credibility Score
- After the first claim resolves, a **live credibility bar** appears at the top of the results panel — it updates in real time as each claim streams in, not after all claims finish
- Formula: `High = 1.0`, `Medium = 0.5`, `Low = 0.0` — averaged across all resolved claims, displayed as a percentage bar with a color-coded fill (`green / yellow / orange`)
- Summary text shows how many claims have resolved so far (e.g., `3 of 7 claims resolved · 67% avg confidence`) and finalizes when all claims are done
- Claims that error out are excluded from the average so a single failed search doesn't drag the score down

### ⚠️ Bias Blindspot Detector
- After sources are lean-labeled, each claim card checks whether **all supporting sources share the same political lean**
- If 3 or more supporting sources are all Left/Lean Left — or all Right/Lean Right — a warning surfaces on the card: *"Warning: all supporting sources are [Left/Right]-leaning — no opposing perspective found."*
- The 3-source threshold prevents false positives on single-source claims
- `Center` and `Unrated` sources are excluded from the check — a claim supported by Center sources won't trigger the warning
- Fires automatically for both full-article pipeline results and text-selection fact-checks

### 🔗 Shareable Fact-Check Links
- After analysis completes, a **"Copy share link"** button appears at the bottom of the results panel
- Clicking it POSTs the full results to the backend, generates a unique ID, and copies the link to your clipboard
- The link renders a **read-only fact-check page** served by the Express backend — no extension required to view it
- The shared page shows the credibility score, all claim cards with confidence badges, source lists, bias blindspot warnings, and divergence summaries — everything the sidebar shows, in a clean standalone page
- Text-selection claims (fact-checked on demand by highlighting) are included in the shared results alongside pipeline claims
- Shared results are **persisted to disk** (`server/shares.json`) so links survive server restarts
- Links **expire after 7 days**; expired links return a clear 410 page rather than a silent 404
- Set `PUBLIC_URL` in `server/.env` to your deployed domain so links point to the right host in production

### 📡 Streaming Results
- Results stream into the sidebar as each claim finishes — you don't wait for all claims to complete before seeing the first result
- A **live progress bar** tracks how many claims have been checked
- The sidebar transitions through `Idle → Loading → Streaming → Done` states with clear messaging at each step

### 🛡️ Edge Case Handling
- **Paywalled articles:** fact-checks the visible text only; no errors thrown on partial content
- **Opinion/editorial pieces:** flagged prominently; rationale notes when a claim is the author's argument rather than an established fact
- **No search results:** returns `Low` confidence with an explanation rather than silently failing
- **Contradiction sanity checks:** time zone differences, unit differences, and rounding differences are not treated as contradictions

---

## 🏗️ Architecture

```
Article page load
  └── content.js extracts article body text + title
        └── sends to sidebar.js

sidebar.js → POST /api/analyze (articleText + articleTitle)

  Server pipeline:
  ├── [1] Volatility Classifier       — headline + first 600 chars → "breaking" | "developing" | "stable"
  │         SSE event: "volatility"
  │
  ├── [2] Claim Extractor             — full article text → 5–8 claims + piece type
  │         SSE event: "claims"
  │
  └── [3] Per-claim (parallel):
        ├── Brave Search              — 8 results per claim
        ├── Source Annotator          — lean labels, primary-source flags, timestamps
        ├── Fact-Check Synthesizer    — confidence, supporting/contradicting/primary sources, divergence
        └── Recency Adjuster          — downgrades confidence if newest source > 10h old on breaking story
              SSE event: "claim_result"
```

**Tech stack:**
| Layer | Technology |
|---|---|
| Extension runtime | Chrome Manifest V3 |
| Extension language | Vanilla JavaScript (no framework) |
| AI | Claude API (`claude-sonnet-4-20250514`) via `@anthropic-ai/sdk` |
| Web search | Brave Search API |
| Source bias data | AllSides / Ad Fontes Media (static lookup table) |
| Backend | Node.js + Express |
| Streaming | Server-Sent Events (SSE) |

---

## 📁 File Structure

```
veritas-ai/
├── manifest.json        # Chrome MV3 manifest
├── background.js        # Service worker — opens the side panel on toolbar click
├── content.js           # Injected into article pages; extracts text, handles highlights, reports selections
├── sidebar.html         # Sidebar panel markup
├── sidebar.js           # Sidebar logic — SSE client, state machine, all UI rendering
├── sidebar.css          # Sidebar styles
├── icons/               # Extension icons (16px, 48px, 128px)
└── server/
    ├── server.js        # Express routes: /api/analyze (SSE), /api/check-claim (JSON), /api/share + /share/:id
    ├── pipeline.js      # AI pipeline: volatility classifier, claim extractor, fact-checker, recency adjuster
    ├── search.js        # Brave Search API wrapper
    ├── sourceLean.js    # Outlet → political lean + primary source lookup tables
    ├── shares.json      # Auto-created; stores shared fact-check results (7-day TTL, file-backed)
    └── package.json
```

---

## 🚀 Getting Started

### Prerequisites
- Node.js 18+
- A [Brave Search API](https://brave.com/search/api/) key (free tier works)
- An [Anthropic API](https://console.anthropic.com/) key

### 1. Start the backend server

```bash
cd server
npm install
```

Create `server/.env`:
```env
ANTHROPIC_API_KEY=sk-ant-...
BRAVE_SEARCH_API_KEY=BSA...
ALLOWED_ORIGINS=chrome-extension://YOUR_EXTENSION_ID
PORT=8787

# Base URL for shareable links — set to your deployed domain in production
PUBLIC_URL=https://your-deployed-domain.com
```

```bash
npm run dev   # or npm start for production
```

### 2. Load the Chrome extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked** and select the root `veritas-ai/` folder
4. Copy the extension ID shown on the card and paste it into `ALLOWED_ORIGINS` in your `.env`, then restart the server

### 3. Use it

1. Navigate to any news article
2. Click the **Veritas.ai** icon in the Chrome toolbar to open the sidebar
3. Click **Analyze this page**
4. Results stream in claim by claim — expand any card for sources and divergence detail
5. Highlight any sentence in the article and click **Fact-check this** in the popup to check it on demand

---

## 🎨 UI Reference

| Element | Meaning |
|---|---|
| 🟢 `High confidence` badge | 3+ independent sources confirm, or a primary source directly confirms, with no credible contradiction |
| 🟡 `Medium confidence` badge | Some support but gaps remain — indirect evidence, mixed signals, or one credible contradiction |
| 🟠 `Low confidence` badge | No sources confirm, active contradictions, or results don't address the claim |
| Credibility score bar | Live average across all resolved claims — green ≥75%, yellow ≥40%, orange below |
| ⚠️ Bias blindspot warning | All 3+ supporting sources share the same political lean — no opposing perspective found |
| ⚡ Breaking/Developing banner | Volatility classifier flagged this as an actively developing story |
| ⚠️ Opinion/Analysis banner | Piece is editorial or commentary — claims may reflect the author's viewpoint |
| Muted source card | Source is older than 24 hours in a breaking or developing story |
| `5 hours ago` timestamp | Relative age of the source's crawl timestamp from Brave Search |
| Copy share link button | Appears after analysis completes; generates a 7-day shareable link to a read-only results page |

---

## 🔑 Design Principles

- **No hard verdicts.** Confidence levels + cited sources, always. The reader decides.
- **Primary sources first.** Government data, wire dispatches, and academic sources are surfaced above media coverage.
- **Spectrum diversity.** Lean labels are shown so readers can see whether support comes from one side of the political spectrum or many.
- **Fail gracefully.** Paywalls, missing dates, empty search results, and API errors all have defined fallback states — nothing silently breaks.
- **Latency budget.** The volatility classifier and claim extractor are sequential (~2s combined); per-claim fact-checks run in parallel and stream as they finish.

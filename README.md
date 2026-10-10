# VeritasAI

A Chrome extension that fact-checks the news article you're reading, in real time, without telling you what to think.

![VeritasAI sidebar showing fact-check results](landing/images/screenshot1_new.png)

**[Try it on the Chrome Web Store →](https://chromewebstore.google.com/detail/veritasai/meihgjpilbhddfjoloampanbgmbmmnjj)**

---

## What it does

Open any news article and click the VeritasAI icon. The sidebar extracts the article's factual claims, verifies each one against live sources, and shows you confidence levels, cited sources, and how outlets across the political spectrum are framing the same underlying facts. No verdicts. No telling you what to think.

---

## Features

### Claim Extraction

Pulls the 5 most important discrete factual claims from the article by default (configurable from 1 to 10, or Auto for 5–8): statistics, attributed quotes, stated events, specific numbers. Vague assertions and opinion language get skipped.

Before claims load, the article gets classified as **News**, **Opinion/Editorial**, or **Analysis/Commentary**. Opinion and analysis pieces get a banner at the top of the sidebar.

---

### Per-Claim Verification

Each claim is searched once against live Brave Search results, using the claim's resolved context (pronouns and shorthand replaced with their referents) as the query. A single Claude synthesis call then weighs the eight lean-annotated results.

Every claim returns a confidence level with a one-sentence rationale:

| Level                   | Criteria                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| 🟢 **High**             | 3+ independent sources confirm, or a primary source directly confirms with no credible contradictions |
| 🟡 **Medium**           | Partial support, indirect evidence, mixed signals, or one credible contradiction                      |
| 🔴 **Low**              | No sources confirm, active contradictions found, or results don't address the claim                   |
| ⬛ **No sources found** | Zero supporting and zero primary sources returned — claim may be unverifiable or newly reported       |

---

### Primary Source Priority

Government data, wire dispatches, academic studies, court records, and institutional reports (WHO, UN, World Bank, SEC) get surfaced separately from media coverage — in their own section above the news source list on each claim card.

Media outlets, even highly reputable ones, are never categorized as primary sources. A Reuters article about a BLS report and the BLS report itself are different things.

---

### Political Lean Labels

Every source card shows the outlet's political lean — **Left, Lean Left, Center, Lean Right,** or **Right** — using Ad Fontes Media and AllSides data covering 100+ outlets.

The labels show where the support for a claim is coming from across the spectrum. A claim confirmed by outlets across the full lean range reads differently than one where all the supporting sources share the same label.

---

### Divergence Analysis

The same synthesis pass compares how the returned outlets with different lean labels frame the fact and extracts each outlet's specific position.

The output shows individual positions: CNN says X, Fox says Y, primary BLS data says Z. When outlets cite the same underlying statistic and build different stories from it, that shows up clearly.

---

### Bias Blindspot Detection

If 3 or more supporting sources for a claim all share the same political lean, a warning surfaces on the card:

> "All supporting sources are [Left/Right]-leaning — no opposing perspective found."

The 3-source threshold prevents false positives on claims with thin search results. Center and Unrated sources are excluded from the check.

---

### Volatility Classification

The article headline and opening paragraphs get classified as **Breaking**, **Developing**, or **Stable** before fact-checking starts.

- Breaking and Developing stories get a banner at the top of the sidebar
- Breaking stories are searched for coverage from the past day and Developing stories from the past week, falling back to an unfiltered search when recent coverage is thin
- If the newest supporting or primary source for a claim is more than 10 hours old on a breaking or developing story, that claim's confidence drops one notch
- Sources older than 24 hours in a breaking or developing story get visually muted on the card
- Every source card shows a relative timestamp (e.g. _5 hours ago_) pulled from the search API
- When publication dates are unavailable, recency adjustments are skipped

---

### More Features

| Feature                | Description                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Text Selection**     | Highlight any sentence in the article to fact-check it on demand. Result gets inserted at the top of the claims list. |
| **Claim Highlighting** | Hover over a claim card to highlight the matching paragraph in the article. Scrolls into view if needed.              |
| **Credibility Score**  | A live percentage bar updates as each claim streams in. Green 75%+, yellow 40%+, orange below that.                   |
| **Streaming Results**  | Claims appear in the sidebar as they finish. First result shows up within seconds.                                    |
| **Shareable Links**    | Generate a 7-day read-only link to the full fact-check. No extension required to view it.                             |
| **Backend URL**        | Point the extension at a self-hosted or redeployed server from Settings → Backend URL.                                |

---

### Edge Cases

| Scenario                     | Behavior                                             |
| ---------------------------- | ---------------------------------------------------- |
| Paywalled article            | Fact-checks the visible text only                    |
| Opinion or editorial piece   | Flagged at the top of the sidebar                    |
| Rounding or unit differences | Not treated as contradictions                        |
| Empty search results         | Returns Low confidence with a `citation_needed` flag |

---

## How It Works

The backend classifies the article's volatility, extracts claims (with an entity-disambiguation pass so surnames become full names), then checks every claim in parallel: one Brave Search query, lean and primary-source annotation of the results, and one Claude synthesis call that returns the confidence level, cited sources, and coverage divergence together. Results stream back to the sidebar over Server-Sent Events as each claim resolves.

No hard verdicts. On politically sensitive claims, a confident wrong verdict with no sources is worse than no verdict at all. Confidence levels and cited sources let the reader evaluate the evidence themselves.

```mermaid
flowchart TD
    classDef ext fill:#7c3aed,stroke:#a78bfa,color:#fff
    classDef srv fill:#0f766e,stroke:#5eead4,color:#fff
    classDef api fill:#b45309,stroke:#fcd34d,color:#fff

    subgraph chrome["Chrome Extension"]
        content(content.js):::ext
        sidebar(sidebar.js):::ext
    end

    subgraph server["Express Backend"]
        vol(Volatility Classifier):::srv
        extractor(Claim Extractor + Disambiguation):::srv

        subgraph par["Per Claim — Parallel"]
            direction LR
            search(Brave Search · 8 results):::srv
            synth(Synthesis · confidence + divergence):::srv
        end

        sse(SSE Stream):::srv
    end

    claude(Claude API):::api
    brave(Brave Search):::api

    content -->|article text| sidebar
    sidebar -->|POST /api/analyze| vol
    vol --> extractor
    extractor --> search
    search -->|lean-annotated sources| synth
    synth --> sse
    sse -->|streams results| sidebar

    search -->|query| brave
    vol -->|inference| claude
    extractor -->|inference| claude
    synth -->|inference| claude
```

---

## Permissions

| Permission                     | Why                                                                                                                                     |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `activeTab`                    | Reads the URL and title of the tab you choose to analyze and messages its content script                                                |
| `scripting`                    | Injects `content.js` into the page to extract the article body text                                                                     |
| `sidePanel`                    | Opens the fact-check results in Chrome's native side panel                                                                              |
| `storage`                      | Keeps preferences and domain lists in Chrome storage (synced with your Chrome profile) and analysis history on this device; no API keys |
| `host_permissions: <all_urls>` | Allows `content.js` to run on any news site, not just a hardcoded list                                                                  |

VeritasAI does not collect, transmit, or store your browsing history. The data that leaves your browser is the article text and title sent to the backend for analysis and, only when you click Share, the article URL and results needed to render the share page.

---

## Credits

- AI: [Anthropic Claude](https://anthropic.com) (`claude-haiku-4-5-20251001`)
- Web search: [Brave Search API](https://brave.com/search/api/)
- Source bias ratings: [Ad Fontes Media](https://adfontesmedia.com) and [AllSides](https://allsides.com)

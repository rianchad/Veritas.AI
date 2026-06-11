# VeritasAI — CLAUDE.md

Persistent context for Claude Code. Read this at the start of every session.

---

## Project Overview

**VeritasAI** is a Chrome extension (Manifest V3) that performs real-time AI-powered fact-checking on news articles as users read them. It extracts discrete factual claims from article text, verifies them against primary sources and cross-outlet coverage, and surfaces confidence levels and alternative sources in a sidebar panel.

**Core design principle:** Never render a hard TRUE/FALSE verdict. Always show confidence levels + cited sources and let the user judge. This is both a UX and liability decision — critical for eventual B2B sale to a news network.

**End goal:** Sell to a major news network (AP, Reuters, PBS, Nexstar, Tegna) or get acquired. Target buyer persona: VP of Product or Head of Digital Innovation, not editorial staff.

---

## File Structure

```
veritas-ai/
├── manifest.json        # Chrome MV3 manifest
├── background.js        # Service worker
├── content.js           # Injected into news pages; extracts article text
├── sidebar.html         # Sidebar panel UI
├── sidebar.js           # Sidebar logic; calls Claude API pipeline
├── sidebar.css          # Sidebar styles
└── icons/
    └── icon128.png
```

---

## Tech Stack

- **Runtime:** Chrome Extension, Manifest V3
- **AI:** Claude API (claude-sonnet-4-20250514) via `api.anthropic.com/v1/messages`
- **Search/Sources:** Brave Search API or Bing Search API (free tier to start)
- **Source Bias Data:** AllSides or Ad Fontes Media public ratings for outlet lean labels
- **Language:** Vanilla JS (no framework unless complexity demands React)

---

## Core AI Pipeline (Agentic)

The pipeline uses three parallel agents running concurrently per claim, with a hard cap of 2–3 loop iterations each to keep total latency under 5 seconds.

```
Article page load
  → content.js extracts article body text
  → sends to sidebar.js

  → Agent 1: Claim Extractor (runs once)
      Input: article text
      Output: JSON array of 5–8 discrete factual claims
      Self-corrects: if output is not valid JSON or has <3 claims, retries once
      e.g. ["Unemployment is at 4.2%", "Senator X voted for bill Y"]

  → For each claim (Agents 2 & 3 run in parallel):

      → Agent 2: Multi-step Verification Agent (primary)
          Tools: search_web(query), fetch_url(url), extract_claims(text)
          Loop (max 3 iterations):
            - Decide what to search for based on the claim
            - Execute search, evaluate quality of results
            - If results insufficient → refine query and retry
            - If results sufficient → synthesize and return
          Output: {
            claim: string,
            confidence: "high" | "medium" | "low",
            supporting_sources: [{outlet, lean, url}],
            contradicting_sources: [{outlet, lean, url}],
            primary_sources: [{name, url}]  ← gov data, studies, transcripts first
          }

      → Agent 3: Bias & Divergence Agent (runs concurrently with Agent 2)
          Tools: search_web(query), fetch_url(url)
          Loop (max 2 iterations):
            - Fetch coverage of same story from 3+ outlets with different lean labels
            - Identify where outlets specifically diverge (not just "they disagree")
            - Output structured divergence: "CNN says X, Fox says Y, Primary source says Z"
          Output: {
            divergence_summary: string,
            outlet_positions: [{outlet, lean, position}]
          }

  → Merge Agent 2 + Agent 3 outputs per claim
  → Render results in sidebar UI as claims finish (stream in, don't wait for all)
```

**Latency budget per claim:** ~3–5s total. Agents 2 & 3 run in parallel; claim extractor is ~1s. Stream results to UI as each claim resolves so the sidebar feels live, not blocking.

---

## UI Spec

- Sidebar panel activates on news article pages
- Claim list with color-coded confidence indicators (green/yellow/red)
- Expandable source cards per claim showing: outlet name, lean label, link
- Source lean labels: Left / Lean Left / Center / Lean Right / Right
- Flag opinion/editorial pieces as such at the top of the sidebar
- Handle paywalled articles gracefully (fact-check visible text only)
- One-paragraph "how it works" explainer in the extension popup

---

## Key Decisions & Constraints

| Decision | Choice | Reason |
|---|---|---|
| Verdict style | Confidence + sources, no TRUE/FALSE | Liability; network-safe |
| Claim granularity | Discrete factual claims (not full article) | More actionable than summaries |
| Source diversity | Show lean labels across political spectrum | Core differentiator |
| Primary sources first | Gov data, studies, transcripts before media | Authoritative |
| Extension type | Chrome MV3 consumer extension first | Validate before B2B pitch |

---

## 2-Week Roadmap

### Week 1 — Build
- Day 1: Architecture, repo setup, manifest.json, search API key
- Day 2–3: Claim extractor + fact-checker prompt pipeline, tested on 10–15 real articles
- Day 4–5: Chrome extension sidebar UI
- Day 6: Edge cases (paywalls, opinion pieces, rate limits, error states)
- Day 7: Polish, QA on 20+ articles, record demo video

### Week 2 — Validate & Sell
- Day 8: Submit to Chrome Web Store, post on r/journalism, r/chrome, r/neutral_news
- Day 9–10: Pitch deck (5 slides), landing page with demo video
- Day 11: Identify buyers (VP Product / Head of Digital) at AP, Reuters, PBS, Nexstar, Tegna via LinkedIn
- Day 12–13: Send 15–20 personalized cold outreach emails
- Day 14: Follow-ups, patch from user feedback, prep live demo on target network's own site

---

## Risks

| Risk | Mitigation |
|---|---|
| Claude API cost spikes | Free tier cap; paid unlimited tier |
| Network says "we'll build it" | Moat is working pipeline + traction, not idea |
| Hallucination causes public embarrassment | Confidence indicators + sources deflect; no hard verdicts |
| Chrome Store rejection | Review MV3 permissions policy carefully; avoid data harvesting signals |

---

## Dev Notes for Claude Code

- Do not add unnecessary dependencies; keep it vanilla JS unless complexity justifies a framework
- All API keys go in a `.env` file — never hardcoded, never committed
- The sidebar should feel like a native browser panel — clean, minimal, fast
- Test prompts on real articles from CNN, Fox News, NYT, AP, Reuters before finalizing
- When in doubt on UI decisions, refer to the core principle: research assistant, not arbiter


require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");
const Database = require("better-sqlite3");
const rateLimit = require("express-rate-limit");
const { classifyVolatility, extractClaims, factCheckClaim } = require("./pipeline");

// ---- SQLite share store (7-day TTL) -----------------------------------------

const db = new Database(path.join(__dirname, "shares.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS shares (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )
`);

const SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const stmtInsert = db.prepare("INSERT INTO shares (id, data, expires_at) VALUES (?, ?, ?)");
const stmtGet    = db.prepare("SELECT data, expires_at FROM shares WHERE id = ?");
const stmtPrune  = db.prepare("DELETE FROM shares WHERE expires_at < ?");

stmtPrune.run(Date.now());
setInterval(() => stmtPrune.run(Date.now()), 60 * 60 * 1000);

// ---- Rate limiters ----------------------------------------------------------

const analyzeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please wait a minute and try again." },
});

const shareLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many share requests — limit is 20 per hour." },
});

// ---- App setup --------------------------------------------------------------

const app = express();
app.use(express.json({ limit: "1mb" }));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : true,
  })
);

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// Fact-checks a single user-supplied claim (used by the text-selection flow).
// Returns plain JSON rather than SSE since there's only one result.
app.post("/api/check-claim", async (req, res) => {
  const { claim, volatility } = req.body || {};
  if (typeof claim !== "string" || claim.trim().length < 10) {
    return res.status(400).json({ error: "claim must be at least 10 characters." });
  }
  const safeVolatility = ["breaking", "developing", "stable"].includes(volatility)
    ? volatility
    : "stable";
  try {
    const result = await factCheckClaim(claim.trim(), "news", safeVolatility);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Streams results as Server-Sent Events so the sidebar can render each
// claim's fact-check as soon as it's ready, instead of waiting on all of them.
app.post("/api/analyze", analyzeLimiter, async (req, res) => {
  const { articleText, articleTitle = "" } = req.body || {};
  if (typeof articleText !== "string" || articleText.trim().length < 200) {
    return res.status(400).json({ error: "articleText must be at least 200 characters." });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // Classify volatility first so the UI can show the banner before claims arrive.
    const volatility = await classifyVolatility(articleTitle, articleText.slice(0, 600));
    send("volatility", { volatility });

    const { pieceType, claims } = await extractClaims(articleText);
    send("claims", { pieceType, claims });

    await Promise.all(
      claims.map(async (claim) => {
        try {
          const result = await factCheckClaim(claim, pieceType, volatility);
          send("claim_result", result);
        } catch (error) {
          send("claim_error", { claim, error: error.message });
        }
      })
    );

    send("done", {});
  } catch (error) {
    send("fatal_error", { error: error.message });
  } finally {
    res.end();
  }
});

// Stores a completed fact-check result set and returns a share URL.
app.post("/api/share", shareLimiter, (req, res) => {
  const { articleUrl, articleTitle, results } = req.body || {};
  if (!Array.isArray(results) || results.length === 0) {
    return res.status(400).json({ error: "results must be a non-empty array." });
  }

  const id = crypto.randomUUID();
  const data = JSON.stringify({
    articleUrl: typeof articleUrl === "string" ? articleUrl : "",
    articleTitle: typeof articleTitle === "string" ? articleTitle : "Untitled article",
    results,
  });
  stmtInsert.run(id, data, Date.now() + SHARE_TTL_MS);

  const base = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 8787}`;
  res.json({ shareUrl: `${base}/share/${id}` });
});

// Renders a read-only fact-check results page (no extension required).
app.get("/share/:id", (req, res) => {
  const row = stmtGet.get(req.params.id);
  if (!row || row.expires_at < Date.now()) {
    return res.status(410).send("<h1>Link expired or not found</h1><p>Shared fact-checks expire after 7 days.</p>");
  }

  const { articleUrl, articleTitle, results } = JSON.parse(row.data);
  const expiresDate = new Date(row.expires_at).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });

  const CONF_VALUES = { high: 1.0, medium: 0.5, low: 0.0 };
  const scored = results.filter((r) => r.confidence in CONF_VALUES);
  const avgScore = scored.length
    ? scored.reduce((sum, r) => sum + CONF_VALUES[r.confidence], 0) / scored.length
    : null;
  const avgPct = avgScore !== null ? Math.round(avgScore * 100) : null;
  const avgLabel = avgScore === null ? null : avgScore >= 0.75 ? "high" : avgScore >= 0.4 ? "medium" : "low";

  function escHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderSources(label, sources) {
    if (!sources || sources.length === 0) return "";
    const items = sources.map((s) => {
      const metaParts = [s.outlet, s.lean, s.age].filter(Boolean).join(" · ");
      const titleHtml = s.title ? escHtml(s.title) : escHtml(s.url);
      const metaHtml = metaParts ? `<span class="source-meta">${escHtml(metaParts)}</span>` : "";
      return `<li><a href="${escHtml(s.url)}" target="_blank" rel="noopener noreferrer">${titleHtml}</a>${metaHtml}</li>`;
    }).join("");
    return `<p class="section-heading">${escHtml(label)}</p><ul class="source-list">${items}</ul>`;
  }

  const claimsHtml = results.map((r) => {
    const conf = ["high", "medium", "low"].includes(r.confidence) ? r.confidence : "low";
    const rationale = r.confidence_rationale
      ? `<p class="rationale">${escHtml(r.confidence_rationale)}</p>` : "";

    let blindspot = "";
    const knownLeans = (r.supporting_sources || [])
      .map((s) => s.lean)
      .filter((l) => l && l !== "Unrated" && l !== "Center");
    if (knownLeans.length >= 3) {
      const leftSet = new Set(["Left", "Lean Left"]);
      const rightSet = new Set(["Right", "Lean Right"]);
      const side = knownLeans.every((l) => leftSet.has(l)) ? "Left"
        : knownLeans.every((l) => rightSet.has(l)) ? "Right" : null;
      if (side) {
        blindspot = `<div class="blindspot-warning">All supporting sources are ${escHtml(side)}-leaning — no opposing perspective found.</div>`;
      }
    }

    let divergence = "";
    if (r.divergence_summary && r.divergence_summary !== "No notable divergence found") {
      const positions = Array.isArray(r.outlet_positions) && r.outlet_positions.length
        ? `<ul class="source-list">${r.outlet_positions.map((p) =>
            `<li><span class="source-meta">${escHtml(p.outlet)} · ${escHtml(p.lean)}</span>${escHtml(p.position)}</li>`
          ).join("")}</ul>`
        : "";
      divergence = `<p class="section-heading">Coverage divergence</p><p class="rationale">${escHtml(r.divergence_summary)}</p>${positions}`;
    }

    return `
<li class="claim-card claim-card--${conf}">
  <div class="claim-header">
    <div class="claim-meta"><span class="badge badge--${conf}">${conf.toUpperCase()}</span></div>
    <p class="claim-text">${escHtml(r.claim)}</p>
  </div>
  <div class="claim-body">
    ${rationale}${blindspot}
    ${renderSources("Supporting sources", r.supporting_sources)}
    ${renderSources("Contradicting sources", r.contradicting_sources)}
    ${renderSources("Primary sources", r.primary_sources)}
    ${divergence}
  </div>
</li>`;
  }).join("");

  const scoreBar = avgPct !== null ? `
<div class="score-bar">
  <div class="score-bar__header">
    <span class="score-bar__label">Credibility Index</span>
    <span class="score-bar__summary">${scored.length}/${results.length} claims · ${avgPct}% avg confidence</span>
  </div>
  <div class="score-bar__track">
    <div class="score-bar__fill score-bar__fill--${avgLabel}" style="width:${avgPct}%"></div>
    <div class="score-bar__ticks"><span></span><span></span><span></span><span></span></div>
  </div>
</div>` : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Veritas.ai — ${escHtml(articleTitle)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=DM+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet"/>
<style>
:root{
  --bg:#0d0d0b;--surface:#131310;--surface-raised:#1b1b17;
  --border:#252420;--rule:#1c1c19;
  --text:#f0ede6;--text-secondary:#b8b2a8;--text-muted:#847d74;
  --gold:#b8965a;--gold-dim:rgba(184,150,90,.1);
  --high:#4e8c62;--high-dim:rgba(78,140,98,.1);
  --medium:#c4843a;--medium-dim:rgba(196,132,58,.1);
  --low:#b04848;--low-dim:rgba(176,72,72,.1);
  --radius:3px;
  --font-serif:"Playfair Display",Georgia,serif;
  --font-sans:"DM Sans",system-ui,sans-serif;
  --font-mono:"IBM Plex Mono","Courier New",monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--font-sans);font-size:14px;background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased}
.page{max-width:680px;margin:0 auto;padding:0 16px 48px}
a{color:var(--text-secondary);text-decoration:none}
a:hover{color:var(--text)}

/* Header */
.site-header{padding:20px 0 16px;margin-bottom:0}
.site-header__wordmark{font-family:var(--font-serif);font-size:22px;font-weight:700;color:var(--text);line-height:1;margin-bottom:4px}
.site-header__tagline{font-family:var(--font-mono);font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--text-muted)}
.header-rule{height:1px;background:linear-gradient(to right,var(--gold) 0%,rgba(184,150,90,.2) 50%,transparent 100%);opacity:.5;margin-bottom:24px}

/* Article meta */
.article-meta{margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid var(--rule)}
.article-meta__title{font-family:var(--font-sans);font-size:16px;font-weight:600;line-height:1.4;margin-bottom:5px}
.article-meta__url{font-size:11px;color:var(--text-muted);word-break:break-all}
.article-meta__expiry{font-size:11px;color:var(--text-muted);margin-top:5px;font-family:var(--font-mono)}

/* Score bar */
.score-bar{margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid var(--rule)}
.score-bar__header{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px}
.score-bar__label{font-family:var(--font-sans);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--text-muted)}
.score-bar__summary{font-family:var(--font-mono);font-size:11px;color:var(--text-secondary)}
.score-bar__track{position:relative;height:3px;background:var(--border);border-radius:999px;overflow:visible}
.score-bar__fill{height:100%;border-radius:999px}
.score-bar__fill--high{background:var(--high)}
.score-bar__fill--medium{background:var(--medium)}
.score-bar__fill--low{background:var(--low)}
.score-bar__ticks{position:absolute;top:-2px;left:0;right:0;display:flex;justify-content:space-around;pointer-events:none}
.score-bar__ticks span{width:1px;height:7px;background:var(--bg)}

/* Claims */
.claims-list{list-style:none;display:flex;flex-direction:column;gap:6px}
.claim-card{background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--border);border-radius:0 var(--radius) var(--radius) 0;overflow:hidden}
.claim-card--high{border-left-color:var(--high)}
.claim-card--medium{border-left-color:var(--medium)}
.claim-card--low{border-left-color:var(--low)}
.claim-header{display:flex;gap:10px;align-items:flex-start;padding:12px}
.claim-meta{flex-shrink:0;min-width:52px;padding-top:2px}
.badge{font-family:var(--font-mono);font-size:10px;font-weight:500;letter-spacing:.1em;text-transform:uppercase;white-space:nowrap}
.badge--high{color:var(--high)}
.badge--medium{color:var(--medium)}
.badge--low{color:var(--low)}
.claim-text{margin:0;font-family:var(--font-sans);font-size:14px;font-weight:400;line-height:1.5;color:var(--text)}
.claim-body{padding:10px 12px 12px;border-top:1px solid var(--rule)}
.rationale{font-family:var(--font-sans);font-size:13px;color:var(--text-secondary);line-height:1.6;margin-bottom:10px}
.section-heading{margin:10px 0 5px;font-family:var(--font-sans);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--text-muted)}
.source-list{list-style:none;display:flex;flex-direction:column;gap:6px}
.source-list li{line-height:1.4}
.source-list a{font-family:var(--font-sans);font-size:13px;color:var(--text-secondary);display:block}
.source-list a:hover{color:var(--text)}
.source-meta{display:block;font-family:var(--font-mono);font-size:10px;color:var(--text-muted);margin-top:2px;letter-spacing:.02em}
.blindspot-warning{margin-bottom:10px;padding:7px 10px;font-family:var(--font-sans);font-size:12px;font-weight:500;color:var(--medium);background:var(--medium-dim);border-left:2px solid var(--medium);border-radius:0 var(--radius) var(--radius) 0;line-height:1.5}

/* Footer */
.site-footer{margin-top:40px;padding-top:16px;border-top:1px solid var(--rule);font-size:11px;color:var(--text-muted);line-height:1.55}
</style>
</head>
<body>
<div class="page">
  <header class="site-header">
    <div class="site-header__wordmark">Veritas.ai</div>
    <div class="site-header__tagline">Fact Intelligence</div>
  </header>
  <div class="header-rule"></div>
  <div class="article-meta">
    <p class="article-meta__title">${escHtml(articleTitle)}</p>
    <p class="article-meta__url"><a href="${escHtml(articleUrl)}" target="_blank" rel="noopener noreferrer">${escHtml(articleUrl)}</a></p>
    <p class="article-meta__expiry">Link expires ${escHtml(expiresDate)}</p>
  </div>
  ${scoreBar}
  <ul class="claims-list">${claimsHtml}</ul>
  <div class="site-footer">Veritas.ai surfaces sources and confidence levels — it never issues true/false verdicts.</div>
</div>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

const port = process.env.PORT || 8787;
app.listen(port, () => {
  console.log(`Veritas.ai server listening on port ${port}`);
});

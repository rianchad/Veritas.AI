// Sidebar: wires up the UI states, pulls article text from the active tab's
// content script, then streams claim extraction + fact-checking results from
// the VeritasAI backend (server/) via Server-Sent Events.

const API_BASE_URL = "https://veritasai-production-2477.up.railway.app";
// ---- DOM refs ---------------------------------------------------------------

const analyzeBtn = document.getElementById("analyze-btn");
const retryBtn = document.getElementById("retry-btn");
const loadingMessage = document.getElementById("loading-message");
const errorMessage = document.getElementById("error-message");
const articleMetaEl = document.getElementById("article-meta");
const claimsListEl = document.getElementById("claims-list");
const progressContainer = document.getElementById("progress-container");
const progressText = document.getElementById("progress-text");
const progressFill = document.getElementById("progress-fill");

const credibilityScoreEl = document.getElementById("credibility-score");
const credibilityFillEl = document.getElementById("credibility-score__fill");
const credibilitySummaryEl = document.getElementById("credibility-score__summary");

const shareRowEl = document.getElementById("share-row");
const shareBtnEl = document.getElementById("share-btn");
const shareToastEl = document.getElementById("share-toast");
const exportPdfBtnEl = document.getElementById("export-pdf-btn");

const selectionPopup = document.getElementById("selection-popup");
const selectionPreview = document.getElementById("selection-preview");
const selectionCheckBtn = document.getElementById("selection-check-btn");
const selectionDismissBtn = document.getElementById("selection-dismiss-btn");

const gearBtnEl = document.getElementById("header-gear-btn");
const historyBtnEl = document.getElementById("header-history-btn");
const settingsBackBtn = document.getElementById("settings-back-btn");
const historyBackBtn = document.getElementById("history-back-btn");
const settingsContentEl = document.getElementById("settings-content");
const historyContentEl = document.getElementById("history-content");

// ---- State machine ----------------------------------------------------------

const states = {
  idle: document.getElementById("state-idle"),
  loading: document.getElementById("state-loading"),
  error: document.getElementById("state-error"),
  results: document.getElementById("state-results"),
  settings: document.getElementById("state-settings"),
  history: document.getElementById("state-history"),
};

let previousState = "idle";

function showState(name) {
  for (const [key, el] of Object.entries(states)) {
    el.classList.toggle("hidden", key !== name);
  }
}

const SECONDARY_VIEWS = new Set(["settings", "history"]);

function openSecondaryView(name) {
  for (const [key, el] of Object.entries(states)) {
    // Never record a secondary view as the return destination
    if (!el.classList.contains("hidden") && !SECONDARY_VIEWS.has(key)) {
      previousState = key;
      break;
    }
  }
  showState(name);
}

// ---- Settings ---------------------------------------------------------------

const DEFAULT_SETTINGS = {
  showLeanLabels: true,
  claimCount: 5,
  confidenceFilter: "all",
  autoAnalyze: false,
};

let currentSettings = { ...DEFAULT_SETTINGS };

async function loadSettings() {
  const stored = await chrome.storage.sync.get("veritas_settings");
  currentSettings = { ...DEFAULT_SETTINGS, ...(stored.veritas_settings || {}) };
}

async function saveSettings(patch) {
  currentSettings = { ...currentSettings, ...patch };
  await chrome.storage.sync.set({ veritas_settings: currentSettings });
}

// ---- Domain lists -----------------------------------------------------------

let domainWhitelist = [];
let domainBlacklist = [];

function normalizeDomain(urlOrDomain) {
  try {
    const host = urlOrDomain.includes("://")
      ? new URL(urlOrDomain).hostname
      : urlOrDomain.trim().toLowerCase();
    return host.replace(/^www\./, "");
  } catch {
    return urlOrDomain.trim().toLowerCase().replace(/^www\./, "");
  }
}

function domainMatches(tabDomain, listEntry) {
  const entry = normalizeDomain(listEntry);
  return tabDomain === entry || tabDomain.endsWith("." + entry);
}

async function loadDomainLists() {
  const stored = await chrome.storage.sync.get(["veritas_whitelist", "veritas_blacklist"]);
  domainWhitelist = stored.veritas_whitelist || [];
  domainBlacklist = stored.veritas_blacklist || [];
}

async function saveDomainLists() {
  await chrome.storage.sync.set({
    veritas_whitelist: domainWhitelist,
    veritas_blacklist: domainBlacklist,
  });
}

// ---- History ----------------------------------------------------------------

let articleHistory = [];
const HISTORY_MAX = 20;

async function loadHistory() {
  const stored = await chrome.storage.local.get("veritas_history");
  articleHistory = stored.veritas_history || [];
}

async function saveToHistory(article, results) {
  const dist = { high: 0, medium: 0, low: 0 };
  const claims = [];
  for (const r of results) {
    if (r.confidence === "high") dist.high++;
    else if (r.confidence === "medium") dist.medium++;
    else dist.low++;
    if (r.claim) claims.push({ text: r.claim, confidence: r.confidence || "low" });
  }

  const scored = results.filter((r) => r.confidence in CONFIDENCE_VALUES);
  const credScore = scored.length
    ? Math.round(
        scored.reduce((s, r) => s + CONFIDENCE_VALUES[r.confidence], 0) / scored.length * 100
      )
    : 0;

  const entry = {
    url: article.url,
    title: article.title || "Untitled article",
    timestamp: Date.now(),
    credibilityScore: credScore,
    claimCount: results.length,
    confidenceDistribution: dist,
    claims,
  };

  articleHistory = articleHistory.filter((e) => e.url !== article.url);
  articleHistory.unshift(entry);
  if (articleHistory.length > HISTORY_MAX) articleHistory = articleHistory.slice(0, HISTORY_MAX);
  await chrome.storage.local.set({ veritas_history: articleHistory });
}

// ---- Cross-article claim tracking -------------------------------------------

const STOP_WORDS_SIG = new Set([
  "that", "this", "with", "have", "from", "they", "been", "said", "will",
  "would", "could", "should", "their", "there", "about", "after", "before",
  "when", "where", "which", "were", "what", "into", "also", "more", "than",
  "some", "each", "such", "both", "then", "over", "only", "most", "other",
  "very", "just", "even", "much", "many", "time", "year", "years", "says",
  "according", "percent", "people", "those", "while", "through", "state",
  "government", "president", "official", "officials", "told", "during",
]);

function sigWords(text) {
  return new Set(
    (text.toLowerCase().match(/\b[a-z]{4,}\b/g) || []).filter((w) => !STOP_WORDS_SIG.has(w))
  );
}

function keywordOverlap(a, b) {
  const setA = sigWords(a);
  const setB = sigWords(b);
  // Require a minimum vocabulary to avoid short-claim false positives
  if (setA.size < 5 || setB.size < 5) return 0;
  let hits = 0;
  for (const w of setA) if (setB.has(w)) hits++;
  return hits / Math.min(setA.size, setB.size);
}

function findSimilarPastClaim(claimText) {
  let best = null;
  let bestScore = 0.6;
  for (const article of articleHistory) {
    if (!Array.isArray(article.claims)) continue;
    for (const past of article.claims) {
      const score = keywordOverlap(claimText, past.text);
      if (score > bestScore) {
        bestScore = score;
        best = { ...past, timestamp: article.timestamp };
      }
    }
  }
  return best;
}

// ---- Pipeline state ---------------------------------------------------------

let totalClaims = 0;
let completedClaims = 0;
let scoreSum = 0;
let scoreCount = 0;
let collectedResults = [];
let currentArticle = null;
let pendingSelectionText = "";
let currentVolatility = "stable";
let analyzeStartTime = 0;

// ---- Progress ---------------------------------------------------------------

function updateProgress() {
  const pct = totalClaims > 0 ? (completedClaims / totalClaims) * 100 : 0;
  progressFill.style.width = `${pct}%`;
  if (completedClaims >= totalClaims && totalClaims > 0) {
    progressText.textContent = `All ${totalClaims} claims checked`;
    progressContainer.classList.add("is-done");
  } else {
    progressText.textContent = `Checking ${completedClaims} of ${totalClaims} claims…`;
  }
}

// ---- Credibility score ------------------------------------------------------

const CONFIDENCE_VALUES = { high: 1.0, medium: 0.5, low: 0.0 };

function updateCredibilityScore(confidence) {
  if (!(confidence in CONFIDENCE_VALUES)) return;
  scoreSum += CONFIDENCE_VALUES[confidence];
  scoreCount++;
  renderCredibilityScore();
}

function renderCredibilityScore() {
  if (scoreCount === 0) return;
  credibilityScoreEl.classList.remove("hidden");
  const avg = scoreSum / scoreCount;
  const pct = Math.round(avg * 100);
  const label = avg >= 0.75 ? "high" : avg >= 0.4 ? "medium" : "low";
  credibilityFillEl.style.width = `${pct}%`;
  credibilityFillEl.className = `credibility-score__fill credibility-score__fill--${label}`;
  const resolvedLabel = scoreCount < totalClaims
    ? `${scoreCount} of ${totalClaims} claims resolved · ${pct}% avg confidence`
    : `${scoreCount}/${totalClaims} claims · ${pct}% avg confidence`;
  credibilitySummaryEl.textContent = resolvedLabel;
}

// ---- Confidence filter ------------------------------------------------------

function applyConfidenceFilter() {
  const filter = currentSettings.confidenceFilter;
  for (const li of claimsListEl.querySelectorAll(".claim-card")) {
    // Pinned disputed card is always visible regardless of filter
    if (li.classList.contains("claim-card--disputed")) {
      li.classList.remove("filter-hidden");
      continue;
    }
    if (filter === "all") { li.classList.remove("filter-hidden"); continue; }
    const isHigh = li.classList.contains("claim-card--high");
    const isMedium = li.classList.contains("claim-card--medium");
    let hide = false;
    if (filter === "below_high" && isHigh) hide = true;
    if (filter === "below_medium" && (isHigh || isMedium)) hide = true;
    li.classList.toggle("filter-hidden", hide);
  }
}

// ---- Tab / content-script helpers -------------------------------------------

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
async function getArticleFromActiveTab() {
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error("No active tab found.");

  // Programmatically inject content script if not already present
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
  } catch {
    // Already injected — safe to ignore
  }

  return chrome.tabs.sendMessage(tab.id, { type: "GET_ARTICLE" });
}

async function sendToContentScript(message) {
  try {
    const tab = await getActiveTab();
    if (tab?.id) await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    // Content script may not be present (e.g., chrome:// pages)
  }
}

// ---- Article meta -----------------------------------------------------------

function renderArticleMeta(article) {
  articleMetaEl.innerHTML = "";
  const title = document.createElement("p");
  title.className = "article-meta__title";
  title.textContent = article.title || "Untitled article";
  const url = document.createElement("p");
  url.className = "article-meta__url";
  url.textContent = article.url;
  articleMetaEl.append(title, url);
}

function renderVolatilityBanner(volatility) {
  const existing = document.getElementById("volatility-banner");
  if (existing) existing.remove();
  if (volatility === "stable") return;
  const banner = document.createElement("div");
  banner.id = "volatility-banner";
  banner.className = `volatility-banner volatility-banner--${volatility}`;
  banner.textContent = volatility === "breaking"
    ? "Breaking — sources may be incomplete or unverified"
    : "Developing — some sources may be outdated";
  articleMetaEl.appendChild(banner);
}

function renderReadingTimeStat(wordCount, elapsedSeconds) {
  const existing = document.getElementById("reading-stat-line");
  if (existing) existing.remove();
  const readMins = Math.max(1, Math.round(wordCount / 200));
  const readLabel = `${readMins} min read`;
  let timeLabel;
  if (elapsedSeconds < 60) {
    timeLabel = `fact-checked in ${elapsedSeconds}s`;
  } else {
    const m = Math.floor(elapsedSeconds / 60);
    const s = elapsedSeconds % 60;
    timeLabel = `fact-checked in ${m}m ${s}s`;
  }
  const stat = document.createElement("p");
  stat.id = "reading-stat-line";
  stat.className = "article-stat-line";
  stat.textContent = `${readLabel} · ${timeLabel}`;
  articleMetaEl.appendChild(stat);
}

function renderPieceTypeBanner(pieceType) {
  const existing = document.getElementById("piece-type-banner");
  if (existing) existing.remove();
  if (pieceType === "news") return;
  const banner = document.createElement("div");
  banner.id = "piece-type-banner";
  banner.className = "piece-type-banner";
  banner.textContent = pieceType === "opinion"
    ? "Opinion / Editorial — claims may reflect the author's perspective"
    : "Analysis / Commentary — interprets events rather than reporting them";
  articleMetaEl.appendChild(banner);
}

// ---- Claim cards ------------------------------------------------------------

const claimCardByText = new Map();

function createClaimCard(claimText) {
  const li = document.createElement("li");
  li.className = "claim-card claim-card--checking";

  const header = document.createElement("div");
  header.className = "claim-card__header";
  header.addEventListener("click", () => li.classList.toggle("is-open"));

  const meta = document.createElement("div");
  meta.className = "claim-card__meta";
  const badge = document.createElement("span");
  badge.className = "confidence-badge confidence-badge--checking";
  badge.textContent = "Checking";
  meta.appendChild(badge);

  const text = document.createElement("p");
  text.className = "claim-card__text";
  text.textContent = claimText;

  const toggle = document.createElement("span");
  toggle.className = "claim-card__toggle";
  toggle.setAttribute("aria-hidden", "true");
  toggle.textContent = "▾";

  header.append(meta, text, toggle);

  const body = document.createElement("div");
  body.className = "claim-card__body";

  li.append(header, body);

  li.addEventListener("mouseenter", () =>
    sendToContentScript({ type: "HIGHLIGHT_CLAIM", claimText })
  );
  li.addEventListener("mouseleave", () =>
    sendToContentScript({ type: "CLEAR_HIGHLIGHT" })
  );

  claimCardByText.set(claimText, li);
  return li;
}

function renderClaimPlaceholders(claims) {
  claimsListEl.innerHTML = "";
  claimCardByText.clear();
  claims.forEach((claimText, index) => {
    const card = createClaimCard(claimText);
    card.style.animationDelay = `${index * 80}ms`;
    claimsListEl.appendChild(card);
  });
}

function fillClaimCard(result) {
  const li = claimCardByText.get(result.claim);
  if (!li) return;

  li.classList.remove("claim-card--checking");
  const confidence = ["high", "medium", "low"].includes(result.confidence)
    ? result.confidence : "low";
  li.classList.add(`claim-card--${confidence}`);

  const badge = li.querySelector(".confidence-badge");
  if (result.citation_needed) {
    badge.className = "confidence-badge confidence-badge--citation-needed";
    badge.textContent = "No sources found";
    badge.title = "This claim may be unverifiable or newly reported.";
  } else {
    badge.className = `confidence-badge confidence-badge--${confidence}`;
    badge.textContent = confidence.toUpperCase();
  }

  const body = li.querySelector(".claim-card__body");
  body.innerHTML = "";

  if (result.confidence_rationale) {
    const rationale = document.createElement("p");
    rationale.className = "claim-card__rationale";
    rationale.textContent = result.confidence_rationale;
    body.appendChild(rationale);
  }

  // Feature 5: cross-article callout
  const pastMatch = findSimilarPastClaim(result.claim);
  if (pastMatch) {
    const date = new Date(pastMatch.timestamp).toLocaleDateString("en-US", {
      month: "short", day: "numeric", year: "numeric",
    });
    const callout = document.createElement("div");
    callout.className = "past-claim-callout";
    let msg = `Similar claim seen before — confidence was ${pastMatch.confidence.toUpperCase()} on ${date}.`;
    if (pastMatch.confidence !== confidence) {
      msg += ` Confidence has shifted from ${pastMatch.confidence.toUpperCase()} to ${confidence.toUpperCase()}.`;
    }
    callout.textContent = msg;
    body.appendChild(callout);
  }

  const spectrumBar = buildSpectrumBar(result.supporting_sources);
  if (spectrumBar) body.appendChild(spectrumBar);

  const blindspot = detectBiasBlindspot(result.supporting_sources);
  if (blindspot) {
    const warning = document.createElement("div");
    warning.className = "bias-blindspot-warning";
    warning.textContent = `All supporting sources are ${blindspot}-leaning — no opposing perspective found.`;
    body.appendChild(warning);
  }

  body.appendChild(buildSourceList("Supporting sources", result.supporting_sources));
  body.appendChild(buildSourceList("Contradicting sources", result.contradicting_sources));
  body.appendChild(buildSourceList("Primary sources", result.primary_sources));

  if (result.divergence_summary && result.divergence_summary !== "No notable divergence found") {
    const heading = document.createElement("p");
    heading.className = "claim-card__section-heading";
    heading.textContent = "Coverage divergence";
    const summary = document.createElement("p");
    summary.className = "claim-card__rationale";
    summary.textContent = result.divergence_summary;
    body.append(heading, summary);

    if (Array.isArray(result.outlet_positions) && result.outlet_positions.length > 0) {
      const list = document.createElement("ul");
      list.className = "source-list";
      for (const position of result.outlet_positions) {
        const item = document.createElement("li");
        const outletMeta = document.createElement("span");
        outletMeta.className = "source-meta";
        outletMeta.textContent = `${position.outlet} · ${position.lean}`;
        const positionText = document.createTextNode(position.position);
        item.append(outletMeta, positionText);
        list.appendChild(item);
      }
      body.appendChild(list);
    }
  }

  // Apply active confidence filter to this newly-resolved card
  applyConfidenceFilter();
}

function markClaimCardError(claimText, message) {
  const li = claimCardByText.get(claimText);
  if (!li) return;
  li.classList.remove("claim-card--checking");
  li.classList.add("claim-card--low");
  const badge = li.querySelector(".confidence-badge");
  if (badge) {
    badge.className = "confidence-badge confidence-badge--low";
    badge.textContent = "ERROR";
  }
  const body = li.querySelector(".claim-card__body");
  if (body) {
    const note = document.createElement("p");
    note.className = "claim-card__rationale";
    note.textContent = message || "This claim couldn't be checked.";
    body.appendChild(note);
  }
}

// ---- Spectrum bar -----------------------------------------------------------

const SPECTRUM_ZONES = [
  { key: "Left",       label: "Left",   cssClass: "spectrum-bar__zone--left" },
  { key: "Lean Left",  label: "Lean L", cssClass: "spectrum-bar__zone--lean-left" },
  { key: "Center",     label: "Center", cssClass: "spectrum-bar__zone--center" },
  { key: "Lean Right", label: "Lean R", cssClass: "spectrum-bar__zone--lean-right" },
  { key: "Right",      label: "Right",  cssClass: "spectrum-bar__zone--right" },
];

function buildSpectrumBar(supportingSources) {
  if (!currentSettings.showLeanLabels) return null;
  if (!supportingSources || supportingSources.length === 0) return null;

  const counts = {};
  let unratedCount = 0;
  for (const source of supportingSources) {
    const lean = source.lean || "Unrated";
    const matched = SPECTRUM_ZONES.find((z) => z.key === lean);
    if (matched) counts[lean] = (counts[lean] || 0) + 1;
    else unratedCount++;
  }

  const occupiedZones = SPECTRUM_ZONES.filter((z) => counts[z.key] > 0);
  if (occupiedZones.length === 0 && unratedCount === 0) return null;

  const bar = document.createElement("div");
  bar.className = "spectrum-bar";

  const summary = document.createElement("p");
  summary.className = "spectrum-bar__summary";
  summary.textContent = buildSpectrumSummary(counts, occupiedZones);
  bar.appendChild(summary);

  if (occupiedZones.length > 0) {
    const track = document.createElement("div");
    track.className = "spectrum-bar__track";
    for (const zone of SPECTRUM_ZONES) {
      const zoneEl = document.createElement("div");
      zoneEl.className = `spectrum-bar__zone ${zone.cssClass}`;
      const dots = document.createElement("div");
      dots.className = "spectrum-bar__dots";
      const count = counts[zone.key] || 0;
      for (let i = 0; i < count; i++) {
        const dot = document.createElement("span");
        dot.className = "spectrum-dot";
        dots.appendChild(dot);
      }
      zoneEl.appendChild(dots);
      const label = document.createElement("span");
      label.className = "spectrum-bar__label";
      label.textContent = zone.label;
      zoneEl.appendChild(label);
      track.appendChild(zoneEl);
    }
    bar.appendChild(track);
  }

  if (unratedCount > 0) {
    const unrated = document.createElement("p");
    unrated.className = "spectrum-bar__unrated";
    unrated.textContent = `· ${unratedCount} unrated source${unratedCount > 1 ? "s" : ""}`;
    bar.appendChild(unrated);
  }

  return bar;
}

function buildSpectrumSummary(counts, occupiedZones) {
  if (occupiedZones.length === 0) return "No rated sources";
  if (occupiedZones.length === 5) return "Sources span Left to Right";
  if (occupiedZones.length === 1) return `All sources are ${occupiedZones[0].key}`;
  const leftCount  = (counts["Left"]  || 0) + (counts["Lean Left"]  || 0);
  const rightCount = (counts["Right"] || 0) + (counts["Lean Right"] || 0);
  const centerCount = counts["Center"] || 0;
  if (leftCount > 0 && rightCount === 0 && centerCount === 0) return "Sources lean Left";
  if (rightCount > 0 && leftCount === 0 && centerCount === 0) return "Sources lean Right";
  if (centerCount > 0 && leftCount === 0 && rightCount === 0) return "All sources are Center";
  if (leftCount > rightCount) return "Sources lean Left";
  if (rightCount > leftCount) return "Sources lean Right";
  return "Sources are mixed";
}

function detectBiasBlindspot(supportingSources) {
  if (!supportingSources) return null;
  const knownLeans = supportingSources
    .map((s) => s.lean)
    .filter((l) => l && l !== "Unrated" && l !== "Center");
  if (knownLeans.length < 3) return null;
  const leftSet = new Set(["Left", "Lean Left"]);
  const rightSet = new Set(["Right", "Lean Right"]);
  if (knownLeans.every((l) => leftSet.has(l))) return "Left";
  if (knownLeans.every((l) => rightSet.has(l))) return "Right";
  return null;
}

function isSourceStale(source) {
  if (currentVolatility === "stable" || !source.publishedAt) return false;
  return Date.now() - new Date(source.publishedAt).getTime() > 24 * 60 * 60 * 1000;
}

function buildSourceList(label, sources) {
  const wrapper = document.createElement("div");
  if (!sources || sources.length === 0) return wrapper;

  const heading = document.createElement("p");
  heading.className = "claim-card__section-heading";
  heading.textContent = label;

  const list = document.createElement("ul");
  list.className = "source-list";

  for (const source of sources) {
    const item = document.createElement("li");
    if (isSourceStale(source)) item.classList.add("source-item--stale");

    const link = document.createElement("a");
    try {
      const { protocol } = new URL(source.url || "");
      link.href = (protocol === "http:" || protocol === "https:") ? source.url : "about:blank";
    } catch {
      link.href = "about:blank";
    }
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = source.title || source.url;
    item.appendChild(link);

    if (source.outlet) {
      const meta = document.createElement("span");
      meta.className = "source-meta";

      const outletSpan = document.createElement("span");
      outletSpan.className = "outlet-name";
      outletSpan.textContent = source.outlet;
      let hideTimer;
      outletSpan.addEventListener("mouseenter", () => {
        clearTimeout(hideTimer);
        showCredibilityCard(source.outlet, outletSpan);
      });
      outletSpan.addEventListener("mouseleave", () => {
        hideTimer = setTimeout(hideCredibilityCard, 120);
      });
      meta.appendChild(outletSpan);

      const trailingParts = [];
      if (currentSettings.showLeanLabels && source.lean) trailingParts.push(source.lean);
      if (source.age) trailingParts.push(source.age);
      if (trailingParts.length > 0) {
        meta.appendChild(document.createTextNode(" · " + trailingParts.join(" · ")));
      }

      item.appendChild(meta);
    }

    list.appendChild(item);
  }

  wrapper.append(heading, list);
  return wrapper;
}

// ---- Source credibility hover card ------------------------------------------

let activeHoverCard = null;

function hideCredibilityCard() {
  if (activeHoverCard) {
    activeHoverCard.remove();
    activeHoverCard = null;
  }
}

function showCredibilityCard(outletName, anchorEl) {
  hideCredibilityCard();
  const data = getOutletData(outletName);

  const card = document.createElement("div");
  card.className = "credibility-hover-card";
  card.addEventListener("mouseenter", () => clearTimeout(card._hideTimer));
  card.addEventListener("mouseleave", hideCredibilityCard);

  const nameEl = document.createElement("p");
  nameEl.className = "credibility-hover-card__name";
  nameEl.textContent = outletName;
  card.appendChild(nameEl);

  if (data) {
    const leanEl = document.createElement("p");
    leanEl.className = "credibility-hover-card__row";
    leanEl.textContent = `Lean: ${data.lean}`;
    card.appendChild(leanEl);

    const tierEl = document.createElement("p");
    tierEl.className = "credibility-hover-card__row";
    tierEl.textContent = TIER_LABELS[data.tier] || `Tier ${data.tier}`;
    card.appendChild(tierEl);

    if (data.allSides) {
      const allsidesEl = document.createElement("p");
      allsidesEl.className = "credibility-hover-card__row";
      allsidesEl.textContent = `AllSides: ${data.allSides}`;
      card.appendChild(allsidesEl);
    }

    if (data.description) {
      const descEl = document.createElement("p");
      descEl.className = "credibility-hover-card__desc";
      descEl.textContent = data.description;
      card.appendChild(descEl);
    }
  } else {
    const unknownEl = document.createElement("p");
    unknownEl.className = "credibility-hover-card__row";
    unknownEl.textContent = "Independent outlet — lean and tier unrated";
    card.appendChild(unknownEl);
  }

  document.body.appendChild(card);
  activeHoverCard = card;

  const anchorRect = anchorEl.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const spaceBelow = window.innerHeight - anchorRect.bottom;
  const top = spaceBelow >= cardRect.height + 8
    ? anchorRect.bottom + 6
    : anchorRect.top - cardRect.height - 6;
  const left = Math.min(anchorRect.left, window.innerWidth - cardRect.width - 8);
  card.style.top = `${top}px`;
  card.style.left = `${Math.max(8, left)}px`;
}

// ---- Most disputed claim pin ------------------------------------------------

const LEAN_ORDER = ["Left", "Lean Left", "Center", "Lean Right", "Right"];

function leanSpan(sources) {
  const positions = new Set(
    (sources || []).map((s) => s.lean).filter((l) => LEAN_ORDER.includes(l))
  );
  if (positions.size === 0) return 0;
  const indices = [...positions].map((l) => LEAN_ORDER.indexOf(l));
  return Math.max(...indices) - Math.min(...indices);
}

function pinMostDisputed() {
  if (collectedResults.length === 0) return;

  let maxDispute = 0;
  for (const r of collectedResults) {
    maxDispute = Math.max(maxDispute, r.contradicting_sources?.length ?? 0);
  }
  if (maxDispute === 0) return;

  const candidates = collectedResults.filter(
    (r) => (r.contradicting_sources?.length ?? 0) === maxDispute
  );

  const winner = candidates.reduce((best, r) => {
    const span = leanSpan([
      ...(r.supporting_sources || []),
      ...(r.contradicting_sources || []),
    ]);
    const bestSpan = leanSpan([
      ...(best.supporting_sources || []),
      ...(best.contradicting_sources || []),
    ]);
    return span > bestSpan ? r : best;
  });

  const li = claimCardByText.get(winner.claim);
  if (!li) return;

  li.classList.add("claim-card--disputed");
  li.classList.remove("filter-hidden");

  const badge = document.createElement("div");
  badge.className = "disputed-pin-badge";
  badge.textContent = `Most disputed · ${maxDispute} source${maxDispute !== 1 ? "s" : ""} disagree`;
  li.querySelector(".claim-card__header").prepend(badge);

  claimsListEl.insertBefore(li, claimsListEl.firstChild);
}

// ---- Selection popup --------------------------------------------------------

function showSelectionPopup(text) {
  pendingSelectionText = text;
  const preview = text.length > 140 ? text.slice(0, 140) + "…" : text;
  selectionPreview.textContent = `"${preview}"`;
  selectionPopup.classList.remove("hidden");
}

function hideSelectionPopup() {
  selectionPopup.classList.add("hidden");
  pendingSelectionText = "";
}

async function checkSingleClaim(claimText) {
  if (claimCardByText.has(claimText)) {
    claimCardByText.get(claimText).classList.add("is-open");
    return;
  }

  if (states.results.classList.contains("hidden")) showState("results");

  const li = createClaimCard(claimText);
  li.classList.add("selection-card");
  claimsListEl.insertBefore(li, claimsListEl.firstChild);

  try {
    const response = await fetch(`${API_BASE_URL}/api/check-claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claim: claimText, volatility: currentVolatility }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Server returned ${response.status}.`);
    }
    const result = await response.json();
    fillClaimCard(result);
    collectedResults.push(result);
    li.classList.add("is-open");
  } catch (error) {
    markClaimCardError(claimText, error.message);
    li.classList.add("is-open");
  }
}

selectionCheckBtn.addEventListener("click", () => {
  const text = pendingSelectionText;
  hideSelectionPopup();
  if (text) checkSingleClaim(text);
});

selectionDismissBtn.addEventListener("click", hideSelectionPopup);

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "TEXT_SELECTED") showSelectionPopup(message.text);
});

// ---- Share button -----------------------------------------------------------

shareBtnEl.addEventListener("click", async () => {
  shareBtnEl.disabled = true;
  shareBtnEl.textContent = "Generating link…";
  try {
    const response = await fetch(`${API_BASE_URL}/api/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        articleUrl: currentArticle?.url || "",
        articleTitle: currentArticle?.title || "",
        results: collectedResults,
      }),
    });
    if (!response.ok) throw new Error(`Server returned ${response.status}`);
    const { shareUrl } = await response.json();
    await navigator.clipboard.writeText(shareUrl);
    shareToastEl.classList.remove("hidden");
    setTimeout(() => shareToastEl.classList.add("hidden"), 2500);
  } catch {
    shareToastEl.textContent = "Failed to generate link.";
    shareToastEl.classList.remove("hidden");
    setTimeout(() => {
      shareToastEl.classList.add("hidden");
      shareToastEl.textContent = "Link copied to clipboard";
    }, 2500);
  } finally {
    shareBtnEl.disabled = false;
    shareBtnEl.textContent = "Copy share link";
  }
});

// ---- Export PDF (Feature 6) -------------------------------------------------

exportPdfBtnEl.addEventListener("click", () => {
  window.print();
});

// ---- Settings view (Feature 1 + 2) -----------------------------------------

function makeToggleRow(labelText, checked, onChange) {
  const row = document.createElement("div");
  row.className = "settings-row";
  const label = document.createElement("span");
  label.className = "settings-row__label";
  label.textContent = labelText;
  const toggle = document.createElement("button");
  toggle.className = `settings-toggle${checked ? " settings-toggle--on" : ""}`;
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-checked", String(checked));
  toggle.addEventListener("click", () => {
    const next = !toggle.classList.contains("settings-toggle--on");
    toggle.classList.toggle("settings-toggle--on", next);
    toggle.setAttribute("aria-checked", String(next));
    onChange(next);
  });
  row.append(label, toggle);
  return row;
}

function makeSelectRow(labelText, options, value, onChange) {
  const row = document.createElement("div");
  row.className = "settings-row";
  const label = document.createElement("span");
  label.className = "settings-row__label";
  label.textContent = labelText;
  const select = document.createElement("select");
  select.className = "settings-select";
  for (const opt of options) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    if (opt.value === value) o.selected = true;
    select.appendChild(o);
  }
  select.addEventListener("change", () => onChange(select.value));
  row.append(label, select);
  return row;
}

function makeSettingsSection(title) {
  const section = document.createElement("div");
  section.className = "settings-section";
  const heading = document.createElement("p");
  heading.className = "settings-section__heading";
  heading.textContent = title;
  section.appendChild(heading);
  return section;
}

function makeDomainListBlock(title, list, onAdd, onRemove) {
  const wrapper = document.createElement("div");
  wrapper.className = "settings-domain-group";

  const subheading = document.createElement("p");
  subheading.className = "settings-domain-group__title";
  subheading.textContent = title;
  wrapper.appendChild(subheading);

  const inputRow = document.createElement("div");
  inputRow.className = "settings-domain-input-row";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "settings-input";
  input.placeholder = "e.g. nytimes.com";
  const addBtn = document.createElement("button");
  addBtn.className = "btn btn--secondary btn--sm";
  addBtn.textContent = "Add";

  const listEl = document.createElement("ul");
  listEl.className = "settings-domain-list";

  function renderList() {
    listEl.innerHTML = "";
    for (const domain of list) {
      const li = document.createElement("li");
      li.className = "settings-domain-item";
      const span = document.createElement("span");
      span.textContent = domain;
      const removeBtn = document.createElement("button");
      removeBtn.className = "settings-domain-remove";
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", () => { onRemove(domain); renderList(); });
      li.append(span, removeBtn);
      listEl.appendChild(li);
    }
  }

  addBtn.addEventListener("click", () => {
    const val = normalizeDomain(input.value.trim());
    if (val && !list.includes(val)) {
      onAdd(val);
      input.value = "";
      renderList();
    }
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") addBtn.click(); });

  inputRow.append(input, addBtn);
  wrapper.append(inputRow, listEl);
  renderList();
  return wrapper;
}

function renderSettingsView() {
  settingsContentEl.innerHTML = "";

  const analysisSection = makeSettingsSection("Analysis");
  const claimCountOptions = [
    { value: "auto", label: "Auto" },
    ...Array.from({ length: 10 }, (_, i) => ({ value: String(i + 1), label: `${i + 1} claim${i === 0 ? "" : "s"}` })),
  ];
  analysisSection.appendChild(makeSelectRow(
    "Claims per article",
    claimCountOptions,
    String(currentSettings.claimCount),
    (v) => saveSettings({ claimCount: v === "auto" ? "auto" : Number(v) })
  ));
  analysisSection.appendChild(makeToggleRow(
    "Auto-analyze on page load",
    currentSettings.autoAnalyze,
    (v) => saveSettings({ autoAnalyze: v })
  ));

  const displaySection = makeSettingsSection("Display");
  displaySection.appendChild(makeToggleRow(
    "Show political lean labels",
    currentSettings.showLeanLabels,
    (v) => saveSettings({ showLeanLabels: v })
  ));
  displaySection.appendChild(makeSelectRow(
    "Show claims",
    [
      { value: "all", label: "All claims" },
      { value: "below_high", label: "Medium & Low only" },
      { value: "below_medium", label: "Low only" },
    ],
    currentSettings.confidenceFilter,
    (v) => { saveSettings({ confidenceFilter: v }); applyConfidenceFilter(); }
  ));

  const domainSection = makeSettingsSection("Domains");
  domainSection.appendChild(makeDomainListBlock(
    "Always analyze (whitelist)",
    domainWhitelist,
    (d) => { domainWhitelist.push(d); saveDomainLists(); },
    (d) => { domainWhitelist = domainWhitelist.filter((x) => x !== d); saveDomainLists(); }
  ));
  domainSection.appendChild(makeDomainListBlock(
    "Never analyze (blacklist)",
    domainBlacklist,
    (d) => { domainBlacklist.push(d); saveDomainLists(); },
    (d) => { domainBlacklist = domainBlacklist.filter((x) => x !== d); saveDomainLists(); }
  ));

  settingsContentEl.append(analysisSection, displaySection, domainSection);
}

gearBtnEl.addEventListener("click", () => {
  if (states.settings.classList.contains("hidden")) {
    renderSettingsView();
    openSecondaryView("settings");
  } else {
    showState(previousState);
  }
});
settingsBackBtn.addEventListener("click", () => showState(previousState));

// ---- History view (Feature 4) -----------------------------------------------

function renderHistoryView() {
  historyContentEl.innerHTML = "";

  if (articleHistory.length === 0) {
    const empty = document.createElement("p");
    empty.className = "history-empty";
    empty.textContent = "No articles checked yet.";
    historyContentEl.appendChild(empty);
    return;
  }

  const list = document.createElement("ul");
  list.className = "history-list";

  for (const entry of articleHistory) {
    const li = document.createElement("li");
    li.className = "history-item";

    const header = document.createElement("div");
    header.className = "history-item__header";
    header.addEventListener("click", () => li.classList.toggle("is-open"));

    const titleEl = document.createElement("p");
    titleEl.className = "history-item__title";
    titleEl.textContent = entry.title;

    const metaRow = document.createElement("div");
    metaRow.className = "history-item__meta";
    const dateEl = document.createElement("span");
    dateEl.className = "history-item__date";
    dateEl.textContent = new Date(entry.timestamp).toLocaleDateString("en-US", {
      month: "short", day: "numeric", year: "numeric",
    });
    const scoreLabel = entry.credibilityScore >= 75 ? "high"
      : entry.credibilityScore >= 40 ? "medium" : "low";
    const scoreBadge = document.createElement("span");
    scoreBadge.className = `confidence-badge confidence-badge--${scoreLabel}`;
    scoreBadge.textContent = `${entry.credibilityScore}%`;
    metaRow.append(dateEl, scoreBadge);

    header.append(titleEl, metaRow);

    const body = document.createElement("div");
    body.className = "history-item__body";
    const urlEl = document.createElement("p");
    urlEl.className = "history-item__url";
    urlEl.textContent = entry.url;
    const dist = entry.confidenceDistribution;
    const distEl = document.createElement("p");
    distEl.className = "history-item__dist";
    distEl.textContent = `${entry.claimCount} claims · ${dist.high} high · ${dist.medium} medium · ${dist.low} low`;
    body.append(urlEl, distEl);

    li.append(header, body);
    list.appendChild(li);
  }

  historyContentEl.appendChild(list);
}

historyBtnEl.addEventListener("click", async () => {
  if (states.history.classList.contains("hidden")) {
    await loadHistory();
    renderHistoryView();
    openSecondaryView("history");
  } else {
    showState(previousState);
  }
});
historyBackBtn.addEventListener("click", () => showState(previousState));

// ---- SSE stream -------------------------------------------------------------

async function* readSseStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = "message";
      let data = "";
      for (const line of rawEvent.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7).trim();
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (data) yield { event, data: JSON.parse(data) };
    }
  }
}

async function streamAnalysis(articleText, articleTitle = "", claimCount = 5) {
  const response = await fetch(`${API_BASE_URL}/api/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ articleText, articleTitle, claimCount }),
  });

  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Server returned ${response.status}.`);
  }

  for await (const { event, data } of readSseStream(response)) {
    switch (event) {
      case "volatility":
        currentVolatility = data.volatility;
        renderVolatilityBanner(data.volatility);
        break;
      case "claims":
        renderPieceTypeBanner(data.pieceType);
        renderClaimPlaceholders(data.claims);
        totalClaims = data.claims.length;
        completedClaims = 0;
        scoreSum = 0;
        scoreCount = 0;
        collectedResults = [];
        credibilityScoreEl.classList.add("hidden");
        shareRowEl.classList.add("hidden");
        progressContainer.classList.remove("is-done");
        updateProgress();
        showState("results");
        break;
      case "claim_result":
        fillClaimCard(data);
        collectedResults.push(data);
        completedClaims++;
        updateProgress();
        updateCredibilityScore(data.confidence);
        break;
      case "claim_error":
        markClaimCardError(data.claim, data.error);
        completedClaims++;
        updateProgress();
        break;
      case "fatal_error":
        throw new Error(data.error || "The analysis pipeline failed.");
      case "done":
        if (collectedResults.length > 0) {
          const elapsedSeconds = Math.round((Date.now() - analyzeStartTime) / 1000);
          const wordCount = currentArticle?.text ? currentArticle.text.trim().split(/\s+/).length : 0;
          if (wordCount > 0) renderReadingTimeStat(wordCount, elapsedSeconds);
          pinMostDisputed();
          shareRowEl.classList.remove("hidden");
          if (currentArticle) await saveToHistory(currentArticle, collectedResults);
        }
        return;
    }
  }
}

// ---- Entry points -----------------------------------------------------------

async function analyzeCurrentPage() {
  analyzeStartTime = Date.now();
  showState("loading");
  loadingMessage.textContent = "Reading the article…";
  currentVolatility = "stable";

  try {
    const article = await getArticleFromActiveTab();
    if (!article?.text || article.text.length < 200) {
      throw new Error(
        "Couldn't find enough article text on this page. Try opening a news article."
      );
    }
    currentArticle = article;
    renderArticleMeta(article);
    loadingMessage.textContent = "Extracting claims…";
    await streamAnalysis(article.text, article.title || "", currentSettings.claimCount);
  } catch (error) {
    errorMessage.textContent = error.message || "Something went wrong.";
    showState("error");
  }
}

analyzeBtn.addEventListener("click", analyzeCurrentPage);
retryBtn.addEventListener("click", analyzeCurrentPage);

// ---- Init -------------------------------------------------------------------

async function init() {
  await Promise.all([loadSettings(), loadDomainLists(), loadHistory()]);

  // Feature 2: auto-analyze based on domain lists + toggle
  try {
    const tab = await getActiveTab();
    if (tab?.url) {
      const tabDomain = normalizeDomain(tab.url);
      const isBlacklisted = domainBlacklist.some((d) => domainMatches(tabDomain, d));
      const isWhitelisted = domainWhitelist.some((d) => domainMatches(tabDomain, d));
      if (!isBlacklisted && (isWhitelisted || currentSettings.autoAnalyze)) {
        analyzeCurrentPage();
        return;
      }
    }
  } catch {
    // Restricted page (chrome://, etc.) — fall through to idle
  }

  showState("idle");
}
init();

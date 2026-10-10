// Sidebar: wires up the UI states, pulls article text from the active tab's
// content script, then streams claim extraction + fact-checking results from
// the VeritasAI backend (server/) via Server-Sent Events.

// Default backend. Users can override it under Settings → Backend URL (persisted in
// chrome.storage.sync), so an installed extension can follow a redeployed server
// without republishing.
const DEFAULT_API_BASE_URL = "https://veritasai-production-2477.up.railway.app";
let apiBaseUrl = DEFAULT_API_BASE_URL;

/**
 * True for hosts where plain http is acceptable: loopback, RFC 1918 ranges and .local names.
 * @param {string} hostname - Hostname from a parsed URL (IPv6 literals keep their brackets).
 * @returns {boolean}
 */
function isPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1") return true;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/**
 * Normalizes a user-supplied backend URL to origin + path: trims, drops query/fragment and
 * trailing slashes, rejects embedded credentials, and requires https except for private hosts.
 * @param {string} value - Raw input from the settings field.
 * @returns {string|null} Normalized URL, or null if empty or invalid.
 */
function normalizeBaseUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    if (url.protocol === "http:" && !isPrivateHost(url.hostname)) return null;
    return (url.origin + url.pathname).replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/**
 * Builds a user-facing message for a failed backend request.
 * @param {number|null} status - HTTP status code, or null for a network failure.
 * @returns {string}
 */
function backendErrorMessage(status) {
  if (status === null) {
    return `Couldn't reach the VeritasAI backend at ${apiBaseUrl}. Check your connection, or set a different Backend URL in Settings.`;
  }
  if (status === 404) {
    return `The VeritasAI backend at ${apiBaseUrl} returned 404 — it may be offline or moved. Update the Backend URL in Settings.`;
  }
  return `Server returned ${status}.`;
}

/**
 * Fetches a backend endpoint, translating network failures into readable errors.
 * @param {string} path - Endpoint path beginning with "/".
 * @param {RequestInit} [init] - Fetch options.
 * @returns {Promise<Response>}
 */
async function fetchBackend(path, init) {
  try {
    return await fetch(`${apiBaseUrl}${path}`, init);
  } catch {
    throw new Error(backendErrorMessage(null));
  }
}

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

const selectionPopup = document.getElementById("selection-popup");

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

/**
 * Shows one named state panel and hides all others.
 * @param {string} name - Key from the `states` map (e.g. "idle", "results").
 */
function showState(name) {
  for (const [key, el] of Object.entries(states)) {
    el.classList.toggle("hidden", key !== name);
  }
}

const SECONDARY_VIEWS = new Set(["settings", "history"]);

/**
 * Records the current primary state as the back-navigation target, then shows a secondary view.
 * Secondary views (settings, history) are never themselves recorded as back targets.
 * @param {string} name - Secondary state name to display.
 */
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
  backendUrl: "", // empty = DEFAULT_API_BASE_URL
};

let currentSettings = { ...DEFAULT_SETTINGS };

/**
 * Loads persisted settings from chrome.storage.sync and merges with defaults.
 * @returns {Promise<void>}
 */
async function loadSettings() {
  const stored = await chrome.storage.sync.get("veritas_settings");
  currentSettings = { ...DEFAULT_SETTINGS, ...(stored.veritas_settings || {}) };
  apiBaseUrl = normalizeBaseUrl(currentSettings.backendUrl) || DEFAULT_API_BASE_URL;
}

/**
 * Merges a settings patch into currentSettings and persists the result.
 * @param {Partial<typeof DEFAULT_SETTINGS>} patch - Fields to update.
 * @returns {Promise<void>}
 */
async function saveSettings(patch) {
  currentSettings = { ...currentSettings, ...patch };
  apiBaseUrl = normalizeBaseUrl(currentSettings.backendUrl) || DEFAULT_API_BASE_URL;
  await chrome.storage.sync.set({ veritas_settings: currentSettings });
}

// ---- Domain lists -----------------------------------------------------------

let domainWhitelist = [];
let domainBlacklist = [];

/**
 * Strips the scheme, port, path, and leading "www." from a URL or bare domain string.
 * @param {string} urlOrDomain - Full URL or domain name to normalize.
 * @returns {string} Lowercase, www-stripped hostname (e.g. "nytimes.com").
 */
function normalizeDomain(urlOrDomain) {
  try {
    const host = urlOrDomain.includes("://")
      ? new URL(urlOrDomain).hostname
      : urlOrDomain.trim().toLowerCase();
    return host.replace(/^www\./, "");
  } catch {
    return urlOrDomain
      .trim()
      .toLowerCase()
      .replace(/^www\./, "");
  }
}

/**
 * Returns true if tabDomain equals listEntry or is a subdomain of it.
 * @param {string} tabDomain - Normalized domain of the active tab.
 * @param {string} listEntry - Domain entry from the whitelist or blacklist.
 * @returns {boolean}
 */
function domainMatches(tabDomain, listEntry) {
  const entry = normalizeDomain(listEntry);
  return tabDomain === entry || tabDomain.endsWith("." + entry);
}

/**
 * Loads the whitelist and blacklist domain arrays from chrome.storage.sync.
 * @returns {Promise<void>}
 */
async function loadDomainLists() {
  const stored = await chrome.storage.sync.get(["veritas_whitelist", "veritas_blacklist"]);
  domainWhitelist = stored.veritas_whitelist || [];
  domainBlacklist = stored.veritas_blacklist || [];
}

/**
 * Persists the current in-memory whitelist and blacklist to chrome.storage.sync.
 * @returns {Promise<void>}
 */
async function saveDomainLists() {
  await chrome.storage.sync.set({
    veritas_whitelist: domainWhitelist,
    veritas_blacklist: domainBlacklist,
  });
}

// ---- History ----------------------------------------------------------------

let articleHistory = [];
const HISTORY_MAX = 20;

/**
 * Loads the article history array from chrome.storage.local.
 * @returns {Promise<void>}
 */
async function loadHistory() {
  const stored = await chrome.storage.local.get("veritas_history");
  articleHistory = stored.veritas_history || [];
}

/**
 * Computes a credibility score summary for the article and prepends it to the history list,
 * deduplicating by URL and capping at HISTORY_MAX entries.
 * @param {{url: string, title: string}} article - Article metadata.
 * @param {Array<{claim?: string, confidence?: string}>} results - Fact-check results.
 * @returns {Promise<void>}
 */
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
        (scored.reduce((s, r) => s + CONFIDENCE_VALUES[r.confidence], 0) / scored.length) * 100
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
  "that",
  "this",
  "with",
  "have",
  "from",
  "they",
  "been",
  "said",
  "will",
  "would",
  "could",
  "should",
  "their",
  "there",
  "about",
  "after",
  "before",
  "when",
  "where",
  "which",
  "were",
  "what",
  "into",
  "also",
  "more",
  "than",
  "some",
  "each",
  "such",
  "both",
  "then",
  "over",
  "only",
  "most",
  "other",
  "very",
  "just",
  "even",
  "much",
  "many",
  "time",
  "year",
  "years",
  "says",
  "according",
  "percent",
  "people",
  "those",
  "while",
  "through",
  "state",
  "government",
  "president",
  "official",
  "officials",
  "told",
  "during",
]);

/**
 * Returns the set of non-stop words (≥4 letters) from text, lowercased.
 * Mirrors the content-script version but uses STOP_WORDS_SIG.
 * @param {string} text - Input text to tokenize.
 * @returns {Set<string>} Unique significant word tokens.
 */
function sigWords(text) {
  const allWords = text.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
  const filtered = allWords.filter((w) => {
    return !STOP_WORDS_SIG.has(w);
  });
  return new Set(filtered);
}

/**
 * Computes the keyword overlap ratio between two claim strings.
 * Returns 0 if either string has fewer than 5 significant words to avoid false positives.
 * @param {string} a - First claim text.
 * @param {string} b - Second claim text.
 * @returns {number} Overlap ratio in [0, 1]: shared words / min(|setA|, |setB|).
 */
function keywordOverlap(a, b) {
  const setA = sigWords(a);
  const setB = sigWords(b);
  // Require a minimum vocabulary to avoid short-claim false positives
  if (setA.size < 5 || setB.size < 5) return 0;
  let hits = 0;
  for (const w of setA) if (setB.has(w)) hits++;
  return hits / Math.min(setA.size, setB.size);
}

/**
 * Searches article history for a past claim with keyword overlap ≥ 0.6.
 * @param {string} claimText - Current claim to compare against history.
 * @returns {{text: string, confidence: string, timestamp: number}|null} Best match or null.
 */
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

/**
 * Updates the progress bar fill width and status text based on completed/total claim counts.
 */
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

/**
 * Accumulates a single claim's confidence value into the running score and re-renders the bar.
 * @param {string} confidence - One of "high", "medium", or "low".
 */
function updateCredibilityScore(confidence) {
  if (!(confidence in CONFIDENCE_VALUES)) return;
  scoreSum += CONFIDENCE_VALUES[confidence];
  scoreCount++;
  renderCredibilityScore();
}

/**
 * Renders the credibility score bar and summary label from the current scoreSum/scoreCount state.
 * No-ops if no claims have been scored yet.
 */
function renderCredibilityScore() {
  if (scoreCount === 0) return;
  credibilityScoreEl.classList.remove("hidden");
  const avg = scoreSum / scoreCount;
  const pct = Math.round(avg * 100);
  let label;
  if (avg >= 0.75) {
    label = "high";
  } else if (avg >= 0.4) {
    label = "medium";
  } else {
    label = "low";
  }
  credibilityFillEl.style.width = `${pct}%`;
  credibilityFillEl.className = `credibility-score__fill credibility-score__fill--${label}`;
  let resolvedLabel;
  if (scoreCount < totalClaims) {
    resolvedLabel = `${scoreCount} of ${totalClaims} claims resolved · ${pct}% avg confidence`;
  } else {
    resolvedLabel = `${scoreCount}/${totalClaims} claims · ${pct}% avg confidence`;
  }
  credibilitySummaryEl.textContent = resolvedLabel;
}

// ---- Confidence filter ------------------------------------------------------

/**
 * Shows or hides claim cards based on the confidenceFilter setting.
 * The "disputed" pinned card is always kept visible regardless of filter.
 */
function applyConfidenceFilter() {
  const filter = currentSettings.confidenceFilter;
  for (const li of claimsListEl.querySelectorAll(".claim-card")) {
    // Pinned disputed card is always visible regardless of filter
    if (li.classList.contains("claim-card--disputed")) {
      li.classList.remove("filter-hidden");
      continue;
    }
    if (filter === "all") {
      li.classList.remove("filter-hidden");
      continue;
    }
    const isHigh = li.classList.contains("claim-card--high");
    const isMedium = li.classList.contains("claim-card--medium");
    let hide = false;
    if (filter === "below_high" && isHigh) hide = true;
    if (filter === "below_medium" && (isHigh || isMedium)) hide = true;
    li.classList.toggle("filter-hidden", hide);
  }
}

// ---- Tab / content-script helpers -------------------------------------------

/**
 * Returns the currently active tab in the current window.
 * @returns {Promise<chrome.tabs.Tab>}
 */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
/**
 * Injects the content script into the active tab if needed, then requests article metadata.
 * @returns {Promise<{url: string, title: string, text: string}>} Article metadata from the page.
 * @throws {Error} If there is no active tab.
 */
async function getArticleFromActiveTab() {
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error("No active tab found.");
  if (!tab.url) {
    throw new Error(
      "VeritasAI doesn't have access to this site. Click the VeritasAI toolbar icon on the page, or allow site access for the extension at chrome://extensions."
    );
  }
  if (!/^(https?|file):/.test(tab.url)) {
    throw new Error(
      "VeritasAI can't read this page — Chrome doesn't let extensions run here. Open a news article in a normal tab."
    );
  }

  // Inject content.js for tabs that were already open when the extension was installed or
  // updated (declared content scripts only run on pages loaded afterwards). Where it is
  // already present, re-injection fails on the file's top-level const declarations and
  // leaves the existing copy untouched.
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
  } catch {
    // Already present, or not injectable — fall through to messaging the existing copy
  }

  try {
    return await chrome.tabs.sendMessage(tab.id, { type: "GET_ARTICLE" });
  } catch {
    if (tab.url.startsWith("file:")) {
      throw new Error(
        'VeritasAI can\'t read local files unless "Allow access to file URLs" is enabled for it at chrome://extensions.'
      );
    }
    throw new Error(
      "VeritasAI couldn't connect to this page. Reload the tab and try again; if it keeps failing, Chrome may be blocking extensions on this site."
    );
  }
}

/**
 * Sends a message to the content script in the active tab. Silently ignores errors
 * that occur when the content script is absent (e.g. on chrome:// pages).
 * @param {object} message - Message object forwarded to the content script.
 * @returns {Promise<void>}
 */
async function sendToContentScript(message) {
  try {
    const tab = await getActiveTab();
    if (tab?.id) await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    // Content script may not be present (e.g., chrome:// pages)
  }
}

// ---- Article meta -----------------------------------------------------------

/**
 * Renders the article title and URL into the article-meta element.
 * @param {{title?: string, url: string}} article - Article metadata object.
 */
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

/**
 * Inserts or removes a volatility banner below the article meta.
 * No-ops for "stable" stories; removes any existing banner first.
 * @param {"breaking"|"developing"|"stable"} volatility
 */
function renderVolatilityBanner(volatility) {
  const existing = document.getElementById("volatility-banner");
  if (existing) existing.remove();
  if (volatility === "stable") return;
  const banner = document.createElement("div");
  banner.id = "volatility-banner";
  banner.className = `volatility-banner volatility-banner--${volatility}`;
  if (volatility === "breaking") {
    banner.textContent = "Breaking — sources may be incomplete or unverified";
  } else {
    banner.textContent = "Developing — some sources may be outdated";
  }
  articleMetaEl.appendChild(banner);
}

/**
 * Appends a one-line reading-time and fact-check-elapsed-time stat below the article meta.
 * Replaces any existing stat line from a previous run.
 * @param {number} wordCount - Article word count used to estimate reading time.
 * @param {number} elapsedSeconds - Wall-clock seconds taken to complete fact-checking.
 */
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

/**
 * Inserts a banner indicating opinion or analysis content when the piece type is not "news".
 * Removes any existing piece-type banner first.
 * @param {"news"|"opinion"|"analysis"} pieceType
 */
function renderPieceTypeBanner(pieceType) {
  const existing = document.getElementById("piece-type-banner");
  if (existing) existing.remove();
  if (pieceType === "news") return;
  const banner = document.createElement("div");
  banner.id = "piece-type-banner";
  banner.className = "piece-type-banner";
  if (pieceType === "opinion") {
    banner.textContent = "Opinion / Editorial — claims may reflect the author's perspective";
  } else {
    banner.textContent = "Analysis / Commentary — interprets events rather than reporting them";
  }
  articleMetaEl.appendChild(banner);
}

// ---- Claim cards ------------------------------------------------------------

const claimCardByText = new Map();

/**
 * Builds a claim card <li> element in the "checking" state and registers it in claimCardByText.
 * Mouse events on the card send highlight/clear-highlight messages to the content script.
 * @param {string} claimText - The claim text to display.
 * @returns {HTMLLIElement} The new claim card element.
 */
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
  li.addEventListener("mouseleave", () => sendToContentScript({ type: "CLEAR_HIGHLIGHT" }));

  claimCardByText.set(claimText, li);
  return li;
}

/**
 * Clears the claims list and inserts placeholder cards with staggered animation delays.
 * @param {string[]} claims - Array of claim text strings.
 */
function renderClaimPlaceholders(claims) {
  claimsListEl.innerHTML = "";
  claimCardByText.clear();
  claims.forEach((claimText, index) => {
    const card = createClaimCard(claimText);
    card.style.animationDelay = `${index * 80}ms`;
    claimsListEl.appendChild(card);
  });
}

/**
 * Populates an existing "checking" claim card with the completed fact-check result.
 * Renders badge, rationale, cross-article callout, spectrum bar, bias warning,
 * source lists, and divergence summary.
 * @param {object} result - Fact-check result object from the server.
 */
function fillClaimCard(result) {
  const li = claimCardByText.get(result.claim);
  if (!li) return;

  li.classList.remove("claim-card--checking");
  let confidence;
  if (["high", "medium", "low"].includes(result.confidence)) {
    confidence = result.confidence;
  } else {
    confidence = "low";
  }
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
      month: "short",
      day: "numeric",
      year: "numeric",
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

/**
 * Marks a claim card as errored, showing an ERROR badge and the error message in the body.
 * @param {string} claimText - Claim text used to look up the card.
 * @param {string} [message] - Error message to display.
 */
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
  { key: "Left", label: "Left", cssClass: "spectrum-bar__zone--left" },
  { key: "Lean Left", label: "Lean L", cssClass: "spectrum-bar__zone--lean-left" },
  { key: "Center", label: "Center", cssClass: "spectrum-bar__zone--center" },
  { key: "Lean Right", label: "Lean R", cssClass: "spectrum-bar__zone--lean-right" },
  { key: "Right", label: "Right", cssClass: "spectrum-bar__zone--right" },
];

/**
 * Builds the political-spectrum dot bar for the given supporting sources.
 * Returns null if lean labels are disabled, or if there are no sources.
 * @param {Array<{lean?: string}>} supportingSources - Supporting sources from the fact-check result.
 * @returns {HTMLElement|null} The spectrum bar element, or null if not applicable.
 */
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

/**
 * Returns a human-readable one-line description of source lean distribution.
 * @param {Record<string, number>} counts - Map from lean label to source count.
 * @param {Array<{key: string}>} occupiedZones - Spectrum zones that have at least one source.
 * @returns {string} Summary text (e.g. "Sources lean Left", "Sources are mixed").
 */
function buildSpectrumSummary(counts, occupiedZones) {
  if (occupiedZones.length === 0) return "No rated sources";
  if (occupiedZones.length === 5) return "Sources span Left to Right";
  if (occupiedZones.length === 1) return `All sources are ${occupiedZones[0].key}`;
  const leftCount = (counts["Left"] || 0) + (counts["Lean Left"] || 0);
  const rightCount = (counts["Right"] || 0) + (counts["Lean Right"] || 0);
  const centerCount = counts["Center"] || 0;
  if (leftCount > 0 && rightCount === 0 && centerCount === 0) return "Sources lean Left";
  if (rightCount > 0 && leftCount === 0 && centerCount === 0) return "Sources lean Right";
  if (centerCount > 0 && leftCount === 0 && rightCount === 0) return "All sources are Center";
  if (leftCount > rightCount) return "Sources lean Left";
  if (rightCount > leftCount) return "Sources lean Right";
  return "Sources are mixed";
}

/**
 * Detects a political bias blindspot when ≥3 rated supporting sources all lean the same way.
 * @param {Array<{lean?: string}>} supportingSources - Supporting sources from the fact-check result.
 * @returns {"Left"|"Right"|null} The dominant side, or null if no blindspot detected.
 */
function detectBiasBlindspot(supportingSources) {
  if (!supportingSources) return null;
  const knownLeans = supportingSources
    .map((s) => {
      return s.lean;
    })
    .filter((l) => {
      return l && l !== "Unrated" && l !== "Center";
    });
  if (knownLeans.length < 3) {
    return null;
  }
  const leftSet = new Set(["Left", "Lean Left"]);
  const rightSet = new Set(["Right", "Lean Right"]);
  if (knownLeans.every((l) => leftSet.has(l))) {
    return "Left";
  }
  if (knownLeans.every((l) => rightSet.has(l))) {
    return "Right";
  }
  return null;
}

/**
 * Returns true if the source was published more than 24 hours ago and the story is volatile.
 * @param {{publishedAt?: string}} source - Source object with an optional ISO timestamp.
 * @returns {boolean}
 */
function isSourceStale(source) {
  if (currentVolatility === "stable" || !source.publishedAt) return false;
  return Date.now() - new Date(source.publishedAt).getTime() > 24 * 60 * 60 * 1000;
}

/**
 * Builds a labeled <div> containing a source list with links, outlet hover cards, and meta text.
 * Returns an empty <div> wrapper if sources is empty.
 * @param {string} label - Section heading (e.g. "Supporting sources").
 * @param {Array<{url: string, title?: string, outlet?: string, lean?: string, age?: string, publishedAt?: string}>} sources
 * @returns {HTMLDivElement}
 */
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
      if (protocol === "http:" || protocol === "https:") {
        link.href = source.url;
      } else {
        link.href = "about:blank";
      }
    } catch {
      link.href = "about:blank";
    }
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    if (source.title) {
      link.textContent = source.title;
    } else {
      link.textContent = source.url;
    }
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

/**
 * Removes the active credibility hover card from the DOM, if one is visible.
 */
function hideCredibilityCard() {
  if (activeHoverCard) {
    activeHoverCard.remove();
    activeHoverCard = null;
  }
}

/**
 * Creates and positions a hover card showing credibility data for an outlet.
 * Positions the card below the anchor element, or above if there is insufficient space below.
 * @param {string} outletName - Display name of the outlet to look up.
 * @param {HTMLElement} anchorEl - Element the card should appear adjacent to.
 */
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

    const leanDot = document.createElement("span");
    leanDot.className = `lean-badge ${getLeanBadgeClass(outletName)}`;
    leanEl.appendChild(leanDot);
    leanEl.appendChild(document.createTextNode(`Lean: ${data.lean}`));

    card.appendChild(leanEl);

    const tierEl = document.createElement("p");
    tierEl.className = "credibility-hover-card__row";
    tierEl.textContent = getTierLabel(outletName);
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
  const top =
    spaceBelow >= cardRect.height + 8
      ? anchorRect.bottom + 6
      : anchorRect.top - cardRect.height - 6;
  const left = Math.min(anchorRect.left, window.innerWidth - cardRect.width - 8);
  card.style.top = `${top}px`;
  card.style.left = `${Math.max(8, left)}px`;
}

// ---- Most disputed claim pin ------------------------------------------------

const LEAN_ORDER = ["Left", "Lean Left", "Center", "Lean Right", "Right"];

/**
 * Computes the political-spectrum span (max index − min index in LEAN_ORDER) across sources.
 * Used to break ties when selecting the most-disputed claim to pin.
 * @param {Array<{lean?: string}>} sources - Combined supporting + contradicting sources.
 * @returns {number} Span value in [0, 4]; 0 if no rated sources.
 */
function leanSpan(sources) {
  const positions = new Set(
    (sources || []).map((s) => s.lean).filter((l) => LEAN_ORDER.includes(l))
  );
  if (positions.size === 0) return 0;
  const indices = [...positions].map((l) => LEAN_ORDER.indexOf(l));
  return Math.max(...indices) - Math.min(...indices);
}

/**
 * Identifies the claim with the most contradicting sources (breaking ties by lean span),
 * marks it with a "most disputed" badge, and moves its card to the top of the list.
 */
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
    const span = leanSpan([...(r.supporting_sources || []), ...(r.contradicting_sources || [])]);
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

/**
 * Displays the text-selection popup with a truncated preview of the selected text.
 * @param {string} text - The selected text to preview and optionally fact-check.
 */
function showSelectionPopup(text) {
  pendingSelectionText = text;
  let preview;
  if (text.length > 140) {
    preview = text.slice(0, 140) + "…";
  } else {
    preview = text;
  }
  document.getElementById("selection-preview").textContent = `"${preview}"`;
  selectionPopup.classList.remove("hidden");
}

/**
 * Hides the text-selection popup and clears the pending selection text.
 */
function hideSelectionPopup() {
  selectionPopup.classList.add("hidden");
  pendingSelectionText = "";
}

/**
 * Fact-checks a single user-selected claim via the /api/check-claim endpoint.
 * If the claim is already in the results list, it just opens that card instead of re-fetching.
 * @param {string} claimText - The selected text to fact-check.
 * @returns {Promise<void>}
 */
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
    const response = await fetchBackend("/api/check-claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claim: claimText, volatility: currentVolatility }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || backendErrorMessage(response.status));
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

document.getElementById("selection-check-btn").addEventListener("click", () => {
  const text = pendingSelectionText;
  hideSelectionPopup();
  if (text) checkSingleClaim(text);
});

document.getElementById("selection-dismiss-btn").addEventListener("click", hideSelectionPopup);

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "TEXT_SELECTED" || !sender?.tab) return;
  // Tabs in other windows broadcast here too — only react to the tab this panel shows.
  getActiveTab().then((tab) => {
    if (tab?.id === sender.tab.id) showSelectionPopup(message.text);
  });
});

// ---- Share button -----------------------------------------------------------

shareBtnEl.addEventListener("click", async () => {
  shareBtnEl.disabled = true;
  shareBtnEl.textContent = "Generating link…";
  try {
    const response = await fetchBackend("/api/share", {
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

// export PDF
document.getElementById("export-pdf-btn").addEventListener("click", () => {
  window.print();
});

// settings panel

/**
 * Creates a settings row containing a label and an ARIA switch toggle button.
 * @param {string} labelText - Display text for the setting label.
 * @param {boolean} checked - Initial on/off state of the toggle.
 * @param {(value: boolean) => void} onChange - Callback invoked with the new state on click.
 * @returns {HTMLDivElement}
 */
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

/**
 * Creates a settings row containing a label and a <select> dropdown.
 * @param {string} labelText - Display text for the setting label.
 * @param {Array<{value: string, label: string}>} options - Select options.
 * @param {string} value - The currently selected option value.
 * @param {(value: string) => void} onChange - Callback invoked with the new value on change.
 * @returns {HTMLDivElement}
 */
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

/**
 * Creates a titled settings section container.
 * @param {string} title - Section heading text (e.g. "Analysis").
 * @returns {HTMLDivElement}
 */
function makeSettingsSection(title) {
  const section = document.createElement("div");
  section.className = "settings-section";
  const heading = document.createElement("p");
  heading.className = "settings-section__heading";
  heading.textContent = title;
  section.appendChild(heading);
  return section;
}

/**
 * Creates the Backend URL block: an input prefilled with the saved override, a Save button
 * that validates and persists it, and a status line that pings /health after saving.
 * @returns {HTMLDivElement}
 */
function makeBackendUrlBlock() {
  const wrapper = document.createElement("div");
  wrapper.className = "settings-domain-group";

  const subheading = document.createElement("p");
  subheading.className = "settings-domain-group__title";
  subheading.textContent = "Backend URL";

  const inputRow = document.createElement("div");
  inputRow.className = "settings-domain-input-row";
  const input = document.createElement("input");
  input.type = "url";
  input.className = "settings-input";
  input.placeholder = DEFAULT_API_BASE_URL;
  input.value = currentSettings.backendUrl || "";
  const saveBtn = document.createElement("button");
  saveBtn.className = "btn btn--secondary btn--sm";
  saveBtn.textContent = "Save";
  inputRow.append(input, saveBtn);

  const hint = document.createElement("p");
  hint.className = "settings-hint";
  const status = document.createElement("p");
  status.className = "settings-hint";

  /** Refreshes the hint line to show which backend is currently in use. */
  function renderHint() {
    hint.textContent = `Leave blank to use the default. Currently using ${apiBaseUrl}`;
  }

  /** Pings the backend's /health endpoint and reports the outcome in the status line. */
  async function pingBackend() {
    status.textContent = "Checking connection…";
    try {
      const response = await fetchBackend("/health");
      if (response.ok) {
        status.textContent = "Connected to backend.";
      } else {
        status.textContent = backendErrorMessage(response.status);
      }
    } catch (error) {
      status.textContent = error.message;
    }
  }

  saveBtn.addEventListener("click", async () => {
    const raw = input.value.trim();
    const normalized = normalizeBaseUrl(raw);
    if (raw && !normalized) {
      status.textContent =
        "Enter a full https:// URL without credentials (http:// is only allowed for localhost and private networks).";
      return;
    }
    await saveSettings({ backendUrl: normalized || "" });
    input.value = normalized || "";
    renderHint();
    pingBackend();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveBtn.click();
  });

  renderHint();
  wrapper.append(subheading, inputRow, hint, status);
  return wrapper;
}

/**
 * Creates a domain list management block with an add-input and remove buttons for each entry.
 * Mutations are reflected immediately in the rendered list and delegated to onAdd/onRemove.
 * @param {string} title - Section title (e.g. "Always analyze (whitelist)").
 * @param {string[]} list - The mutable domain list to display and manage.
 * @param {(domain: string) => void} onAdd - Called when a valid new domain is added.
 * @param {(domain: string) => void} onRemove - Called when a domain is removed.
 * @returns {HTMLDivElement}
 */
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

  /** Re-renders the domain list <ul> from the current list array. */
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
      removeBtn.addEventListener("click", () => {
        onRemove(domain);
        renderList();
      });
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
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addBtn.click();
  });

  inputRow.append(input, addBtn);
  wrapper.append(inputRow, listEl);
  renderList();
  return wrapper;
}

/**
 * Rebuilds and renders the full settings panel into settingsContentEl.
 * Called each time the settings view is opened to reflect current values.
 */
function renderSettingsView() {
  settingsContentEl.innerHTML = "";

  const analysisSection = makeSettingsSection("Analysis");
  const claimCountOptions = [
    { value: "auto", label: "Auto" },
    ...Array.from({ length: 10 }, (_, i) => ({
      value: String(i + 1),
      label: `${i + 1} claim${i === 0 ? "" : "s"}`,
    })),
  ];
  analysisSection.appendChild(
    makeSelectRow(
      "Claims per article",
      claimCountOptions,
      String(currentSettings.claimCount),
      (v) => saveSettings({ claimCount: v === "auto" ? "auto" : Number(v) })
    )
  );
  analysisSection.appendChild(
    makeToggleRow("Auto-analyze on page load", currentSettings.autoAnalyze, (v) =>
      saveSettings({ autoAnalyze: v })
    )
  );

  const displaySection = makeSettingsSection("Display");
  displaySection.appendChild(
    makeToggleRow("Show political lean labels", currentSettings.showLeanLabels, (v) =>
      saveSettings({ showLeanLabels: v })
    )
  );
  displaySection.appendChild(
    makeSelectRow(
      "Show claims",
      [
        { value: "all", label: "All claims" },
        { value: "below_high", label: "Medium & Low only" },
        { value: "below_medium", label: "Low only" },
      ],
      currentSettings.confidenceFilter,
      (v) => {
        saveSettings({ confidenceFilter: v });
        applyConfidenceFilter();
      }
    )
  );

  const domainSection = makeSettingsSection("Domains");
  domainSection.appendChild(
    makeDomainListBlock(
      "Always analyze (whitelist)",
      domainWhitelist,
      (d) => {
        domainWhitelist.push(d);
        saveDomainLists();
      },
      (d) => {
        domainWhitelist = domainWhitelist.filter((x) => x !== d);
        saveDomainLists();
      }
    )
  );
  domainSection.appendChild(
    makeDomainListBlock(
      "Never analyze (blacklist)",
      domainBlacklist,
      (d) => {
        domainBlacklist.push(d);
        saveDomainLists();
      },
      (d) => {
        domainBlacklist = domainBlacklist.filter((x) => x !== d);
        saveDomainLists();
      }
    )
  );

  const backendSection = makeSettingsSection("Backend");
  backendSection.appendChild(makeBackendUrlBlock());

  settingsContentEl.append(analysisSection, displaySection, domainSection, backendSection);
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

/**
 * Renders the article history list into historyContentEl.
 * Shows a placeholder message when history is empty.
 */
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
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    let scoreLabel;
    if (entry.credibilityScore >= 75) {
      scoreLabel = "high";
    } else if (entry.credibilityScore >= 40) {
      scoreLabel = "medium";
    } else {
      scoreLabel = "low";
    }
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

/**
 * Async generator that reads an SSE response body and yields parsed {event, data} frames.
 * Handles chunked delivery by buffering until a double-newline frame delimiter appears.
 * @param {Response} response - Fetch Response with a readable body stream.
 * @yields {{event: string, data: unknown}} Parsed SSE frames.
 */
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
      if (data) {
        const parsed = JSON.parse(data);
        yield { event, data: parsed };
      }
    }
  }
}

/**
 * Posts the article to /api/analyze and processes the SSE stream, updating the UI
 * for each event (volatility, claims, claim_result, claim_error, done, fatal_error).
 * @param {string} articleText - Full article body to analyze.
 * @param {string} [articleTitle=""] - Article headline used for volatility classification.
 * @param {number|"auto"} [claimCount=5] - Desired claim count.
 * @returns {Promise<void>}
 * @throws {Error} On HTTP error or fatal_error SSE event.
 */
async function streamAnalysis(articleText, articleTitle = "", claimCount = 5) {
  const response = await fetchBackend("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ articleText, articleTitle, claimCount }),
  });

  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || backendErrorMessage(response.status));
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
          let wordCount;
          if (currentArticle?.text) {
            wordCount = currentArticle.text.trim().split(/\s+/).length;
          } else {
            wordCount = 0;
          }
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

/**
 * Top-level entry point for a full article analysis run.
 * Extracts article text from the active tab, then streams analysis results.
 * Transitions the UI through loading → results (or error) states.
 * @returns {Promise<void>}
 */
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

/**
 * Initializes the sidebar: loads settings, domain lists, and history in parallel,
 * then auto-analyzes if the active tab is whitelisted or auto-analyze is enabled.
 * Falls through to the idle state for restricted pages (chrome://, etc.).
 * @returns {Promise<void>}
 */
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

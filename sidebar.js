// Sidebar: wires up the UI states, pulls article text from the active tab's
// content script, then streams claim extraction + fact-checking results from
// the Veritas.ai backend (server/) via Server-Sent Events.

// Set this to your deployed backend URL (see server/README.md).
const API_BASE_URL = "http://localhost:8787";

const states = {
  idle: document.getElementById("state-idle"),
  loading: document.getElementById("state-loading"),
  error: document.getElementById("state-error"),
  results: document.getElementById("state-results"),
};

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
const selectionPreview = document.getElementById("selection-preview");
const selectionCheckBtn = document.getElementById("selection-check-btn");
const selectionDismissBtn = document.getElementById("selection-dismiss-btn");

let totalClaims = 0;
let completedClaims = 0;
let scoreSum = 0;
let scoreCount = 0;
let collectedResults = [];
let currentArticle = null;
let pendingSelectionText = "";
let currentVolatility = "stable";

// ---- State helpers ----------------------------------------------------------

function showState(name) {
  for (const [key, el] of Object.entries(states)) {
    el.classList.toggle("hidden", key !== name);
  }
}

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

// ---- Tab / content-script helpers -------------------------------------------

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function getArticleFromActiveTab() {
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error("No active tab found.");
  return chrome.tabs.sendMessage(tab.id, { type: "GET_ARTICLE" });
}

async function sendToContentScript(message) {
  try {
    const tab = await getActiveTab();
    if (tab?.id) await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    // Content script may not be present (e.g., chrome:// pages, no article loaded yet)
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

// claim text → <li> element
const claimCardByText = new Map();

// Creates a placeholder card with hover-highlight wiring. Used by both the
// full-article pipeline and the single-claim selection flow.
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

  // Hover → highlight the matching paragraph in the article
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
    ? result.confidence
    : "low";

  li.classList.add(`claim-card--${confidence}`);

  const badge = li.querySelector(".confidence-badge");
  badge.className = `confidence-badge confidence-badge--${confidence}`;
  badge.textContent = confidence.toUpperCase();

  const body = li.querySelector(".claim-card__body");
  body.innerHTML = "";

  if (result.confidence_rationale) {
    const rationale = document.createElement("p");
    rationale.className = "claim-card__rationale";
    rationale.textContent = result.confidence_rationale;
    body.appendChild(rationale);
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

const SPECTRUM_ZONES = [
  { key: "Left",       label: "Left",   cssClass: "spectrum-bar__zone--left" },
  { key: "Lean Left",  label: "Lean L", cssClass: "spectrum-bar__zone--lean-left" },
  { key: "Center",     label: "Center", cssClass: "spectrum-bar__zone--center" },
  { key: "Lean Right", label: "Lean R", cssClass: "spectrum-bar__zone--lean-right" },
  { key: "Right",      label: "Right",  cssClass: "spectrum-bar__zone--right" },
];

function buildSpectrumBar(supportingSources) {
  if (!supportingSources || supportingSources.length === 0) return null;

  const counts = {};
  let unratedCount = 0;

  for (const source of supportingSources) {
    const lean = source.lean || "Unrated";
    const matched = SPECTRUM_ZONES.find((z) => z.key === lean);
    if (matched) {
      counts[lean] = (counts[lean] || 0) + 1;
    } else {
      unratedCount++;
    }
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
    link.href = source.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = source.title || source.url;
    item.appendChild(link);

    // Outlet · lean on a separate mono metadata line
    const metaParts = [source.outlet, source.lean].filter(Boolean);
    if (source.age) metaParts.push(source.age);
    if (metaParts.length > 0) {
      const meta = document.createElement("span");
      meta.className = "source-meta";
      meta.textContent = metaParts.join(" · ");
      item.appendChild(meta);
    }

    list.appendChild(item);
  }

  wrapper.append(heading, list);
  return wrapper;
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

// Fact-checks a single user-selected sentence and adds it to the claims list.
async function checkSingleClaim(claimText) {
  // If a card for this exact text already exists, just open it
  if (claimCardByText.has(claimText)) {
    claimCardByText.get(claimText).classList.add("is-open");
    return;
  }

  // Make sure the results pane is visible
  if (states.results.classList.contains("hidden")) {
    showState("results");
  }

  // Insert the new card at the top so it's immediately visible
  const li = createClaimCard(claimText);
  li.classList.add("selection-card"); // visual marker
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
    li.classList.add("is-open"); // auto-expand so the user sees the result
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

// Listen for TEXT_SELECTED messages from the content script
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "TEXT_SELECTED") {
    showSelectionPopup(message.text);
  }
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
  } catch (error) {
    shareToastEl.textContent = "Failed to generate link.";
    shareToastEl.classList.remove("hidden");
    setTimeout(() => {
      shareToastEl.classList.add("hidden");
      shareToastEl.textContent = "Link copied!";
    }, 2500);
  } finally {
    shareBtnEl.disabled = false;
    shareBtnEl.textContent = "Copy share link";
  }
});

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

async function streamAnalysis(articleText, articleTitle = "") {
  const response = await fetch(`${API_BASE_URL}/api/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ articleText, articleTitle }),
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
        if (collectedResults.length > 0) shareRowEl.classList.remove("hidden");
        return;
    }
  }
}

// ---- Entry points -----------------------------------------------------------

async function analyzeCurrentPage() {
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
    await streamAnalysis(article.text, article.title || "");
  } catch (error) {
    errorMessage.textContent = error.message || "Something went wrong.";
    showState("error");
  }
}

analyzeBtn.addEventListener("click", analyzeCurrentPage);
retryBtn.addEventListener("click", analyzeCurrentPage);

showState("idle");

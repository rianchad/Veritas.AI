// Injected into article pages. Responsibilities:
//   1. Extract article text on demand (GET_ARTICLE)
//   2. Match claims to paragraphs and highlight them on hover (HIGHLIGHT_CLAIM / CLEAR_HIGHLIGHT)
//   3. Detect user text selections and report them to the sidebar (TEXT_SELECTED)

// ---- Article extraction -----------------------------------------------------

function collectParagraphText(root) {
  const paragraphs = root.querySelectorAll("p");
  return Array.from(paragraphs)
    .map((p) => p.innerText.trim())
    .filter((t) => t.length > 0)
    .join("\n\n");
}

function findArticleContainer() {
  const article = document.querySelector("article");
  if (article && collectParagraphText(article).length > 200) return article;

  let best = document.body;
  let bestLength = 0;
  for (const candidate of document.querySelectorAll("div, section, main")) {
    const len = collectParagraphText(candidate).length;
    if (len > bestLength) {
      best = candidate;
      bestLength = len;
    }
  }
  return best;
}

function getArticleMetadata() {
  return {
    url: window.location.href,
    title: document.title,
    text: collectParagraphText(findArticleContainer()),
  };
}

// ---- Highlight infrastructure -----------------------------------------------

const highlightStyle = document.createElement("style");
highlightStyle.textContent = `
  .veritas-highlight {
    background-color: rgba(79, 140, 255, 0.18) !important;
    outline: 2px solid rgba(79, 140, 255, 0.4) !important;
    outline-offset: 3px !important;
    border-radius: 3px !important;
    transition: background-color 0.15s ease !important;
  }
`;
document.head.appendChild(highlightStyle);

// Words too common to be useful for matching
const STOP_WORDS = new Set([
  "that", "this", "with", "have", "from", "they", "been", "said", "will",
  "would", "could", "should", "their", "there", "about", "after", "before",
  "when", "where", "which", "were", "what", "into", "also", "more", "than",
  "some", "each", "such", "both", "then", "over", "only", "most", "other",
  "very", "just", "even", "much", "many", "time", "year", "years", "says",
  "according", "percent", "people", "those", "while", "through", "state",
  "government", "president", "official", "officials", "told", "during",
]);

function significantWords(text) {
  return new Set(
    (text.toLowerCase().match(/\b[a-z]{4,}\b/g) || []).filter(
      (w) => !STOP_WORDS.has(w)
    )
  );
}

// Lazily populated: claim text → best-matching <p> element (or null)
const claimParagraphMap = new Map();
let articleParagraphs = null;

function getArticleParagraphs() {
  if (articleParagraphs) return articleParagraphs;
  const container = findArticleContainer();
  articleParagraphs = Array.from(container.querySelectorAll("p")).filter(
    (p) => p.innerText.trim().length > 40
  );
  return articleParagraphs;
}

function findBestParagraph(claimText) {
  const words = significantWords(claimText);
  if (words.size === 0) return null;

  const paragraphs = getArticleParagraphs();
  let best = null;
  let bestScore = 0.25; // minimum threshold — below this the match is too loose

  for (const p of paragraphs) {
    const pWords = p.innerText.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
    const hits = pWords.filter((w) => words.has(w)).length;
    const score = hits / words.size;
    if (score > bestScore) {
      best = p;
      bestScore = score;
    }
  }

  return best;
}

let currentHighlighted = null;

function highlightClaim(claimText) {
  clearHighlight();

  if (!claimParagraphMap.has(claimText)) {
    claimParagraphMap.set(claimText, findBestParagraph(claimText));
  }

  const p = claimParagraphMap.get(claimText);
  if (p) {
    p.classList.add("veritas-highlight");
    // Scroll the paragraph into view only if it's not already visible
    p.scrollIntoView({ behavior: "smooth", block: "nearest" });
    currentHighlighted = p;
  }
}

function clearHighlight() {
  if (currentHighlighted) {
    currentHighlighted.classList.remove("veritas-highlight");
    currentHighlighted = null;
  }
}

// ---- Text selection detection -----------------------------------------------

document.addEventListener("mouseup", () => {
  const selection = window.getSelection();
  const text = selection ? selection.toString().trim() : "";
  // Only fire for plausible sentence-length selections
  if (text.length >= 20 && text.length <= 1000) {
    chrome.runtime.sendMessage({ type: "TEXT_SELECTED", text }, () => {
      // Suppress "no listener" errors when the sidebar is closed
      void chrome.runtime.lastError;
    });
  }
});

// ---- Message router ---------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case "GET_ARTICLE":
      sendResponse(getArticleMetadata());
      break;
    case "HIGHLIGHT_CLAIM":
      highlightClaim(message.claimText);
      sendResponse({ ok: true });
      break;
    case "CLEAR_HIGHLIGHT":
      clearHighlight();
      sendResponse({ ok: true });
      break;
  }
  return true; // keep the message channel open for async sendResponse
});

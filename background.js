// Service worker: opens the side panel when the user clicks the toolbar icon.

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error("Failed to set side panel behavior:", error));

chrome.runtime.onInstalled.addListener(() => {
  console.log("Veritas.ai installed.");
});

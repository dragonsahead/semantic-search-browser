chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "search-github-issues",
    title: "Search GitHub Issues: \"%s\"",
    contexts: ["selection"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "search-github-issues" && info.selectionText) {
    const query = encodeURIComponent(info.selectionText.trim());
    const resultsUrl = chrome.runtime.getURL(`results.html?q=${query}`);
    chrome.tabs.create({ url: resultsUrl });
  }
});

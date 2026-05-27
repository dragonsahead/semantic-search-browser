const queryInput = document.getElementById("query-input");
const searchBtn = document.getElementById("search-btn");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const settingsLink = document.getElementById("settings-link");

settingsLink.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

const noticeEl = document.getElementById("summarize-notice");
const toggleBtns = document.querySelectorAll(".toggle-btn");

const MAX_QUERY_LENGTH = 256;
let searchType = "hybrid";

toggleBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    toggleBtns.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    searchType = btn.dataset.type;
    if (queryInput.value.trim()) {
      doSearch(queryInput.value);
    }
  });
});

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      ["githubToken", "openaiKey", "scopeType", "scopeValue"],
      resolve
    );
  });
}

async function summarizeQuery(text, openaiKey) {
  if (text.length <= MAX_QUERY_LENGTH) {
    return { text, wasSummarized: false };
  }

  if (!openaiKey) {
    const truncated = text.slice(0, MAX_QUERY_LENGTH - 3).trimEnd() + "...";
    return { text: truncated, wasSummarized: true, method: "no_key" };
  }

  let resp;
  try {
    resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-5.4-nano",
        messages: [
          {
            role: "system",
            content:
              "You are a search query optimizer. The user will give you a long piece of text. " +
              "Condense it into a concise GitHub issue search query that captures the core meaning. " +
              "The query MUST be under 256 characters. Output ONLY the search query text, nothing else." +
              "Don't return the word Metabase or the version number in the query.",
          },
          { role: "user", content: text },
        ],
        max_completion_tokens: 150,
        temperature: 0.3,
      }),
    });
  } catch (err) {
    const truncated = text.slice(0, MAX_QUERY_LENGTH - 3).trimEnd() + "...";
    return { text: truncated, wasSummarized: true, method: "network_error", error: err.message };
  }

  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    const truncated = text.slice(0, MAX_QUERY_LENGTH - 3).trimEnd() + "...";
    return {
      text: truncated,
      wasSummarized: true,
      method: "api_error",
      error: `${resp.status}: ${body.error?.message || resp.statusText}`,
    };
  }

  const data = await resp.json();
  const summary = (data.choices?.[0]?.message?.content || "").trim();

  if (!summary || summary.length > MAX_QUERY_LENGTH) {
    const truncated = text.slice(0, MAX_QUERY_LENGTH - 3).trimEnd() + "...";
    return { text: truncated, wasSummarized: true, method: "bad_summary" };
  }

  return { text: summary, wasSummarized: true, method: "llm" };
}

function showSummarizeNotice(originalLength, finalQuery, method, error) {
  const labels = {
    llm: "Summarized by AI",
    no_key: "Truncated — no OpenAI key configured",
    api_error: `Truncated — OpenAI API error: ${error || "unknown"}`,
    network_error: `Truncated — network error: ${error || "unknown"}`,
    bad_summary: "Truncated — AI returned an invalid summary",
  };
  const methodLabel = labels[method] || "Truncated";
  noticeEl.innerHTML = `
    <strong>${escapeHtml(methodLabel)}</strong> &mdash;
    Original selection was ${originalLength} chars (limit: ${MAX_QUERY_LENGTH}).
    Searching for: <em>${escapeHtml(finalQuery)}</em>
  `;
  noticeEl.classList.add("visible");
}

function hideSummarizeNotice() {
  noticeEl.classList.remove("visible");
  noticeEl.innerHTML = "";
}

function buildQuery(text, scopeType, scopeValue) {
  let q = text + " is:issue";
  if (scopeType === "org" && scopeValue) {
    q += ` org:${scopeValue}`;
  } else if (scopeType === "repo" && scopeValue) {
    q += ` repo:${scopeValue}`;
  }
  return q;
}

function truncate(text, max) {
  if (!text) return "";
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + "...";
}

// --- TF-IDF relevance ranking ---

function normalizeText(s) {
  return (s || "").toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
}

function tokenize(s) {
  return normalizeText(s).split(" ").filter((t) => t.length >= 2);
}

function termFrequency(tokens) {
  const tf = {};
  for (const t of tokens) {
    tf[t] = (tf[t] || 0) + 1;
  }
  const len = tokens.length || 1;
  for (const t in tf) tf[t] /= len;
  return tf;
}

function buildTfidfVectors(docs) {
  const n = docs.length;
  const docFreq = {};
  const tfs = docs.map((tokens) => {
    const tf = termFrequency(tokens);
    for (const t in tf) docFreq[t] = (docFreq[t] || 0) + 1;
    return tf;
  });
  return tfs.map((tf) => {
    const vec = {};
    for (const t in tf) {
      vec[t] = tf[t] * Math.log(n / docFreq[t]);
    }
    return vec;
  });
}

function cosineSimilarity(vecA, vecB) {
  let dot = 0, magA = 0, magB = 0;
  for (const t in vecA) {
    magA += vecA[t] * vecA[t];
    if (t in vecB) dot += vecA[t] * vecB[t];
  }
  for (const t in vecB) magB += vecB[t] * vecB[t];
  if (!magA || !magB) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

const BODY_CAP = 4000;

function issueDocument(issue) {
  const title = issue.title || "";
  const body = (issue.body || "").slice(0, BODY_CAP);
  return title + "\n" + title + "\n" + body;
}

function rankIssuesByRelevance(issues, originalQuery) {
  if (!issues.length) return [];
  const queryTokens = tokenize(originalQuery);
  if (!queryTokens.length) {
    return issues.map((issue, i) => ({ issue, score: 0 }));
  }
  const docTokensList = issues.map((issue) => tokenize(issueDocument(issue)));
  const allDocs = [queryTokens, ...docTokensList];
  const vectors = buildTfidfVectors(allDocs);
  const queryVec = vectors[0];
  const ranked = issues.map((issue, i) => ({
    issue,
    score: cosineSimilarity(queryVec, vectors[i + 1]),
  }));
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

function formatRelevance(score) {
  return `${Math.round(score * 100)}% match`;
}

// --- End TF-IDF relevance ranking ---

function relativeTime(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function contrastColor(hex) {
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luma > 0.5 ? "#000" : "#fff";
}

function issueStateIcon(state) {
  if (state === "open") {
    return `<svg class="state-icon open" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z"/>
      <path fill-rule="evenodd" d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z"/>
    </svg>`;
  }
  return `<svg class="state-icon closed" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <path fill-rule="evenodd" d="M11.28 6.78a.75.75 0 00-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 00-1.06 1.06l2 2a.75.75 0 001.06 0l3.5-3.5z"/>
    <path fill-rule="evenodd" d="M16 8A8 8 0 110 8a8 8 0 0116 0zm-1.5 0a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z"/>
  </svg>`;
}

function repoFromUrl(url) {
  const m = url.match(/github\.com\/([^/]+\/[^/]+)/);
  return m ? m[1] : "";
}

function renderResults(rankedItems) {
  if (!rankedItems.length) {
    statusEl.textContent = "No issues found for this query.";
    return;
  }

  statusEl.innerHTML = "";
  resultsEl.innerHTML = "";

  const countEl = document.createElement("div");
  countEl.className = "result-count";
  countEl.textContent = `${rankedItems.length} issue${rankedItems.length !== 1 ? "s" : ""} found \u00b7 sorted by relevance`;
  resultsEl.appendChild(countEl);

  for (const { issue, score } of rankedItems) {
    const repo = repoFromUrl(issue.html_url);
    const card = document.createElement("div");
    card.className = "card";

    let labelsHtml = "";
    if (issue.labels && issue.labels.length) {
      labelsHtml = issue.labels
        .map((l) => {
          const bg = `#${l.color}`;
          const fg = contrastColor(l.color);
          return `<span class="label-badge" style="background:${bg};color:${fg}">${escapeHtml(l.name)}</span>`;
        })
        .join("");
    }

    card.innerHTML = `
      <div class="card-header">
        ${issueStateIcon(issue.state)}
        <span class="card-title">
          <a href="${escapeAttr(issue.html_url)}" target="_blank" rel="noopener">
            ${escapeHtml(issue.title)}
          </a>
        </span>
      </div>
      <div class="card-repo">
        <a href="https://github.com/${escapeAttr(repo)}" target="_blank" rel="noopener">${escapeHtml(repo)}</a>
        &middot; #${issue.number}
      </div>
      ${issue.body ? `<div class="card-body">${escapeHtml(truncate(issue.body, 300))}</div>` : ""}
      <div class="card-footer">
        ${labelsHtml}
        <span class="relevance-score">${formatRelevance(score)}</span>
        <span class="card-meta">updated ${relativeTime(issue.updated_at)}</span>
      </div>
    `;
    resultsEl.appendChild(card);
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function showError(msg) {
  statusEl.className = "status error";
  statusEl.innerHTML = msg;
  resultsEl.innerHTML = "";
}

function showLoading() {
  resultsEl.innerHTML = "";
  statusEl.className = "status";
  statusEl.innerHTML = `<div class="spinner"></div>Searching...`;
}

async function doSearch(query) {
  if (!query.trim()) return;

  queryInput.value = query;
  searchBtn.disabled = true;
  hideSummarizeNotice();
  showLoading();

  const settings = await getSettings();

  if (!settings.githubToken) {
    showError(
      'No GitHub token configured. <a href="#" id="open-options">Open settings</a> to add one.'
    );
    document.getElementById("open-options")?.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
    searchBtn.disabled = false;
    return;
  }

  let searchText = query.trim();
  const originalLength = searchText.length;

  if (searchText.length > MAX_QUERY_LENGTH) {
    statusEl.innerHTML = `<div class="spinner"></div>Summarizing long selection...`;
    try {
      const result = await summarizeQuery(searchText, settings.openaiKey);
      searchText = result.text;
      if (result.wasSummarized) {
        showSummarizeNotice(originalLength, searchText, result.method, result.error);
      }
    } catch (err) {
      searchText = searchText.slice(0, MAX_QUERY_LENGTH - 3).trimEnd() + "...";
      showSummarizeNotice(originalLength, searchText, "truncated");
    }
    showLoading();
  }

  const fullQuery = buildQuery(searchText, settings.scopeType, settings.scopeValue);

  try {
    const url = `https://api.github.com/search/issues?q=${encodeURIComponent(fullQuery)}&search_type=${searchType}&per_page=30`;

    const resp = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${settings.githubToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (resp.status === 401) {
      showError(
        'Invalid GitHub token. <a href="#" id="open-options">Update settings</a>.'
      );
      document
        .getElementById("open-options")
        ?.addEventListener("click", (e) => {
          e.preventDefault();
          chrome.runtime.openOptionsPage();
        });
      searchBtn.disabled = false;
      return;
    }

    if (resp.status === 403) {
      const resetHeader = resp.headers.get("x-ratelimit-reset");
      let extra = "";
      if (resetHeader) {
        const resetDate = new Date(parseInt(resetHeader, 10) * 1000);
        extra = ` Resets at ${resetDate.toLocaleTimeString()}.`;
      }
      showError(`Rate limit exceeded.${extra} Semantic search is limited to 10 requests/minute.`);
      searchBtn.disabled = false;
      return;
    }

    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      showError(`GitHub API error ${resp.status}: ${escapeHtml(body.message || "Unknown error")}`);
      searchBtn.disabled = false;
      return;
    }

    const data = await resp.json();

    const issuesOnly = (data.items || []).filter(
      (item) => !item.pull_request
    );

    const originalQuery = query.trim();
    const ranked = rankIssuesByRelevance(issuesOnly, originalQuery);
    renderResults(ranked);
  } catch (err) {
    showError(`Network error: ${escapeHtml(err.message)}`);
  } finally {
    searchBtn.disabled = false;
  }
}

searchBtn.addEventListener("click", () => doSearch(queryInput.value));
queryInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doSearch(queryInput.value);
});

const params = new URLSearchParams(window.location.search);
const initialQuery = params.get("q");
if (initialQuery) {
  doSearch(initialQuery);
}

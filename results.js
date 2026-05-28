const queryInput = document.getElementById("query-input");
const searchBtn = document.getElementById("search-btn");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const deepwikiStatusEl = document.getElementById("deepwiki-status");
const deepwikiStreamEl = document.getElementById("deepwiki-stream");
const deepwikiFooterEl = document.getElementById("deepwiki-footer");
const deepwikiRepoLabelEl = document.getElementById("deepwiki-repo-label");
const settingsLink = document.getElementById("settings-link");

let deepwikiAbortController = null;

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
      [
        "githubToken",
        "openaiKey",
        "scopeType",
        "scopeValue",
        "deepwikiEnabled",
        "deepwikiRepo",
      ],
      (data) => {
        const repoFromScope =
          data.scopeType === "repo" && data.scopeValue ? data.scopeValue.trim() : "";
        const deepwikiRepo =
          (data.deepwikiRepo && data.deepwikiRepo.trim()) || repoFromScope;
        const deepwikiEnabled =
          typeof data.deepwikiEnabled === "boolean"
            ? data.deepwikiEnabled
            : Boolean(repoFromScope);
        resolve({
          ...data,
          deepwikiRepo,
          deepwikiEnabled,
        });
      }
    );
  });
}

const EXTRACT_SYSTEM_PROMPT =
  "You are a search query optimizer for GitHub issue search. " +
  "The user will give you text (often chat, support tickets, or email). " +
  "Extract ONLY the technical problem as a concise GitHub issue search query. " +
  "REMOVE: @mentions, person names, emojis, reactions, timestamps, greetings, " +
  "and attachment meta (e.g. 'sending you sample', 'see screenshot', 'attached'). " +
  "KEEP: product area, symptoms, errors, expected vs actual behavior. " +
  "Do NOT include: Metabase, version numbers, dashboard/question/model/table/column names. " +
  "The query MUST be under 256 characters, so you need to include as much information as possible within this limit. Do NOT use double quotes. " +
  "Output ONLY the search query text, nothing else.";

function fallbackFocusedQuery(text) {
  let focused = stripConversationalNoise(text);
  if (focused.length > MAX_QUERY_LENGTH) {
    focused = focused.slice(0, MAX_QUERY_LENGTH - 3).trimEnd() + "...";
  }
  return focused;
}

async function extractProblemQuery(text, openaiKey) {
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
          { role: "system", content: EXTRACT_SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
        max_completion_tokens: 150,
        temperature: 0.3,
      }),
    });
  } catch (err) {
    return {
      text: fallbackFocusedQuery(text),
      wasFocused: true,
      method: "network_error",
      error: err.message,
    };
  }

  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    return {
      text: fallbackFocusedQuery(text),
      wasFocused: true,
      method: "api_error",
      error: `${resp.status}: ${body.error?.message || resp.statusText}`,
    };
  }

  const data = await resp.json();
  const summary = (data.choices?.[0]?.message?.content || "")
    .trim()
    .replace(/"/g, "");

  if (!summary || summary.length > MAX_QUERY_LENGTH) {
    return { text: fallbackFocusedQuery(text), wasFocused: true, method: "bad_summary" };
  }

  return { text: summary, wasFocused: true, method: "llm" };
}

async function focusSearchQuery(text, openaiKey) {
  if (openaiKey) {
    return extractProblemQuery(text, openaiKey);
  }
  return { text: fallbackFocusedQuery(text), wasFocused: true, method: "no_key" };
}

function showFocusNotice(method, searchPart, error, originalLength) {
  const labels = {
    llm: "Focused on problem (AI)",
    no_key: "Focused with basic cleanup — add OpenAI key for better results",
    api_error: `Focused with basic cleanup — OpenAI API error: ${error || "unknown"}`,
    network_error: `Focused with basic cleanup — network error: ${error || "unknown"}`,
    bad_summary: "Focused with basic cleanup — AI returned an invalid summary",
  };
  const methodLabel = labels[method] || "Focused with basic cleanup";
  const lengthNote =
    originalLength > MAX_QUERY_LENGTH
      ? ` Original selection was ${originalLength} chars (limit: ${MAX_QUERY_LENGTH}).`
      : "";
  noticeEl.innerHTML = `
    <strong>${escapeHtml(methodLabel)}</strong> &mdash;${lengthNote}
    Searching for: <em>${escapeHtml(searchPart)}</em>
  `;
  noticeEl.classList.add("visible");
}

function hideSummarizeNotice() {
  noticeEl.classList.remove("visible");
  noticeEl.innerHTML = "";
}

function showQueryAdjustedNotice(message, adjustedQuery) {
  noticeEl.innerHTML = `
    <strong>${escapeHtml(message)}</strong> &mdash;
    Searching for: <em>${escapeHtml(adjustedQuery)}</em>
  `;
  noticeEl.classList.add("visible");
}

// GitHub issue search treats ()[]{}:; etc. as syntax. We strip them (never quote) so hybrid/semantic search is not forced to lexical exact-phrase mode.
const GITHUB_SEARCH_SPECIAL = /[()[\]{}<>@#;:/\\]|"(?:[^"\\]|\\.)*"/;

function sanitizeGitHubSearchText(text) {
  return text
    .replace(/[()[\]{}<>@#;:/\\"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripConversationalNoise(text) {
  let s = text;
  s = s.replace(/\p{Extended_Pictographic}/gu, " ");
  s = s.replace(/@[\w][\w.-]*(?:\s+[\w][\w.-]*)*/g, " ");
  s = s.replace(/\b\d{1,2}:\d{2}\s*(?:[AaPp][Mm])?\b/g, " ");
  s = s.replace(/\bsending you\b[\s\S]*$/i, " ");
  s = s.replace(/\bwith other screenshots\.?\s*$/i, " ");
  s = s.replace(/\bsee attached\b[\s\S]*$/i, " ");
  s = s.replace(/^(?:another issue with|hi|hello|hey)[,\s]*/i, " ");
  return sanitizeGitHubSearchText(s);
}

function getSearchPart(text, { sanitize = false } = {}) {
  const trimmed = text.trim();
  return sanitize || GITHUB_SEARCH_SPECIAL.test(trimmed)
    ? sanitizeGitHubSearchText(text)
    : trimmed;
}

function buildQuery(text, scopeType, scopeValue, { sanitize = false } = {}) {
  const searchPart = getSearchPart(text, { sanitize });
  let q = searchPart + " is:issue";
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

// --- BM25 relevance ranking ---

const STOP_WORDS = new Set([
  "the", "be", "to", "of", "and", "in", "that", "have", "it", "for",
  "not", "on", "with", "he", "as", "you", "do", "at", "this", "but",
  "his", "by", "from", "they", "we", "say", "her", "she", "or", "an",
  "will", "my", "one", "all", "would", "there", "their", "what", "so",
  "up", "out", "if", "about", "who", "get", "which", "go", "me",
  "when", "make", "can", "like", "no", "just", "him", "know", "take",
  "into", "your", "some", "could", "them", "see", "other", "than",
  "then", "now", "its", "also", "after", "use", "how", "our",
  "was", "is", "are", "been", "has", "had", "did", "does",
  "hello", "hi", "dear", "team", "support", "please", "thanks",
  "thank", "regards", "best", "sincerely",
]);

function normalizeText(s) {
  return (s || "").toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
}

function tokenize(s) {
  return normalizeText(s).split(" ").filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

const BODY_CAP = 4000;
const TITLE_REPEATS = 4;
const SUBJECT_BOOST = 10;
const SEARCH_TEXT_REPEATS = 4;

function issueDocument(issue) {
  const title = issue.title || "";
  const body = (issue.body || "").slice(0, BODY_CAP);
  return Array(TITLE_REPEATS).fill(title).join("\n") + "\n" + body;
}

function buildRankingQuery(originalQuery, searchText) {
  if (originalQuery === searchText) return originalQuery;
  return Array(SEARCH_TEXT_REPEATS).fill(searchText).join("\n") + "\n" + originalQuery;
}

function extractSubjectTokens(searchText) {
  const match = searchText.match(/^([^:\u2014\u2013-]+)[:\u2014\u2013-]/);
  if (!match) return [];
  return tokenize(match[1]);
}

function bm25Score(queryTokens, docTokens, docFreq, numDocs, avgDl, subjectSet, k1 = 1.2, b = 0.75) {
  const dl = docTokens.length;
  const docTf = {};
  for (const t of docTokens) docTf[t] = (docTf[t] || 0) + 1;

  const queryTf = {};
  for (const t of queryTokens) queryTf[t] = (queryTf[t] || 0) + 1;

  let score = 0;
  for (const term of Object.keys(queryTf)) {
    const df = docFreq[term] || 0;
    if (df === 0) continue;
    const idf = Math.log((numDocs - df + 0.5) / (df + 0.5) + 1);
    const termTf = docTf[term] || 0;
    const tfNorm = (termTf * (k1 + 1)) / (termTf + k1 * (1 - b + b * (dl / avgDl)));
    const boost = subjectSet.has(term) ? SUBJECT_BOOST : 1;
    score += queryTf[term] * boost * idf * tfNorm;
  }
  return score;
}

function rankIssuesByRelevance(issues, originalQuery, searchText) {
  if (!issues.length) return [];

  const blended = buildRankingQuery(originalQuery, searchText);
  const queryTokens = tokenize(blended);
  if (!queryTokens.length) {
    return issues.map((issue, i) => ({
      issue,
      rank: i + 1,
      total: issues.length,
      queryTokens: [],
      docTokens: [],
    }));
  }

  const subjectSet = new Set(extractSubjectTokens(searchText));
  const docTokensList = issues.map((issue) => tokenize(issueDocument(issue)));

  const docFreq = {};
  for (const tokens of docTokensList) {
    const unique = new Set(tokens);
    for (const t of unique) docFreq[t] = (docFreq[t] || 0) + 1;
  }

  const numDocs = docTokensList.length;
  const avgDl = docTokensList.reduce((sum, t) => sum + t.length, 0) / (numDocs || 1);

  const ranked = issues.map((issue, i) => ({
    issue,
    score: bm25Score(queryTokens, docTokensList[i], docFreq, numDocs, avgDl, subjectSet),
    originalIndex: i,
  }));

  ranked.sort((a, b) => {
    const diff = b.score - a.score;
    if (diff !== 0) return diff;
    return a.originalIndex - b.originalIndex;
  });

  const total = ranked.length;
  return ranked.map(({ issue }, i) => ({
    issue,
    rank: i + 1,
    total,
    queryTokens,
    docTokens: docTokensList[i],
  }));
}

function queryTermsInDoc(queryTokens, docTokens) {
  const docSet = new Set(docTokens);
  const matched = [];
  const missing = [];
  const seen = new Set();
  for (const term of queryTokens) {
    if (seen.has(term)) continue;
    seen.add(term);
    if (docSet.has(term)) matched.push(term);
    else missing.push(term);
  }
  return { matched, missing };
}

const WEAK_MATCH_MIN_QUERY_TERMS = 3;
const WEAK_MATCH_COVERAGE_THRESHOLD = 0.35;

function buildWeakMatchNotice(rankedItems) {
  if (!rankedItems.length) return null;
  const top = rankedItems[0];
  const { queryTokens, docTokens } = top;
  if (!queryTokens?.length) return null;

  const { matched, missing } = queryTermsInDoc(queryTokens, docTokens);
  const uniqueCount = matched.length + missing.length;
  if (!uniqueCount) return null;

  const coverage = matched.length / uniqueCount;
  if (
    missing.length === 0 ||
    uniqueCount < WEAK_MATCH_MIN_QUERY_TERMS ||
    coverage >= WEAK_MATCH_COVERAGE_THRESHOLD
  ) {
    return null;
  }

  const shown = missing.slice(0, 8);
  const extra = missing.length > shown.length ? ` (+${missing.length - shown.length} more)` : "";
  return (
    "Top result may be a weak match — few keywords from your query appear in that issue. " +
    `Not found in #1: ${shown.join(", ")}${extra}. ` +
    "Scores are relative to GitHub’s result set, not a guarantee of relevance."
  );
}

function formatRelevance(rank, total) {
  if (total <= 1) return "#1";
  return `#${rank} of ${total}`;
}

// --- End BM25 relevance ranking ---

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

  const weakNotice = buildWeakMatchNotice(rankedItems);
  if (weakNotice) {
    const weakEl = document.createElement("div");
    weakEl.className = "weak-match-notice";
    weakEl.textContent = weakNotice;
    resultsEl.appendChild(weakEl);
  }

  const countEl = document.createElement("div");
  countEl.className = "result-count";
  countEl.textContent = `${rankedItems.length} issue${rankedItems.length !== 1 ? "s" : ""} found \u00b7 ranked locally among GitHub results`;
  resultsEl.appendChild(countEl);

  for (const { issue, rank, total } of rankedItems) {
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
        <span class="relevance-score" title="Position after local re-ranking of GitHub results">${formatRelevance(rank, total)}</span>
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

function showDeepWikiLoading() {
  deepwikiStreamEl.textContent = "";
  deepwikiStreamEl.classList.add("deepwiki-streaming");
  deepwikiFooterEl.innerHTML = "";
  deepwikiStatusEl.className = "status deepwiki-status";
  deepwikiStatusEl.innerHTML = `<div class="spinner"></div>Asking DeepWiki...`;
}

function showDeepWikiHint(messageHtml) {
  deepwikiStreamEl.classList.remove("deepwiki-streaming");
  deepwikiStreamEl.innerHTML = "";
  deepwikiStatusEl.innerHTML = "";
  deepwikiFooterEl.innerHTML = "";
  deepwikiStatusEl.innerHTML = `<div class="deepwiki-hint">${messageHtml}</div>`;
}

function showDeepWikiError(msg) {
  deepwikiStreamEl.classList.remove("deepwiki-streaming");
  deepwikiStreamEl.innerHTML = "";
  deepwikiStatusEl.className = "status deepwiki-status error";
  deepwikiStatusEl.textContent = msg;
  deepwikiFooterEl.innerHTML = "";
}

function appendDeepWikiChunk(delta) {
  deepwikiStatusEl.innerHTML = "";
  deepwikiStreamEl.append(document.createTextNode(delta));
}

function finishDeepWiki(repo, fullText) {
  deepwikiStreamEl.classList.remove("deepwiki-streaming");
  deepwikiStatusEl.innerHTML = "";
  if (fullText) {
    deepwikiStreamEl.textContent = fullText;
  }
  deepwikiFooterEl.innerHTML = `
    <a href="https://deepwiki.com/${escapeAttr(repo)}" target="_blank" rel="noopener">
      Open on DeepWiki
    </a>
  `;
}

function resetDeepWikiColumn(repo) {
  if (deepwikiAbortController) {
    deepwikiAbortController.abort();
    deepwikiAbortController = null;
  }
  deepwikiRepoLabelEl.textContent = repo ? repo : "";
  deepwikiStreamEl.classList.remove("deepwiki-streaming");
  deepwikiStreamEl.textContent = "";
  deepwikiFooterEl.innerHTML = "";
  deepwikiStatusEl.className = "status deepwiki-status";
  deepwikiStatusEl.innerHTML = "";
}

async function runDeepWikiSearch(searchText, settings) {
  const repo = settings.deepwikiRepo;
  if (!settings.deepwikiEnabled || !repo) {
    showDeepWikiHint(
      'DeepWiki is off or no repository is set. <a href="#" id="deepwiki-open-options">Configure in settings</a> (use <code style="color:#f0883e">owner/repo</code>).'
    );
    document.getElementById("deepwiki-open-options")?.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
    return;
  }

  resetDeepWikiColumn(repo);
  showDeepWikiLoading();

  deepwikiAbortController = new AbortController();
  const signal = deepwikiAbortController.signal;

  try {
    await askDeepWikiStream(repo, searchText, {
      signal,
      onChunk: (delta) => appendDeepWikiChunk(delta),
      onDone: (fullText) => finishDeepWiki(repo, fullText),
    });
  } catch (err) {
    if (err.name !== "AbortError") {
      showDeepWikiError(err.message || "DeepWiki unavailable");
    }
  } finally {
    deepwikiAbortController = null;
  }
}

async function searchGitHubIssues(query, searchText, settings, focusMeta) {
  const { focusMethod, focusError, originalLength } = focusMeta;

  const trimmedForQuery = searchText.trim();
  const autoSanitized = GITHUB_SEARCH_SPECIAL.test(trimmedForQuery);
  const queryAttempts = [
    {
      query: buildQuery(searchText, settings.scopeType, settings.scopeValue),
      sanitized: autoSanitized,
    },
    {
      query: buildQuery(searchText, settings.scopeType, settings.scopeValue, { sanitize: true }),
      sanitized: true,
    },
  ].filter((attempt, i, arr) => arr.findIndex((a) => a.query === attempt.query) === i);

  let resp;
  let body = {};
  let usedSanitizedQuery = false;

  for (let i = 0; i < queryAttempts.length; i++) {
    const { query: fullQuery, sanitized } = queryAttempts[i];
    const url = `https://api.github.com/search/issues?q=${encodeURIComponent(fullQuery)}&search_type=${searchType}&per_page=30`;

    resp = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${settings.githubToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (resp.ok) {
      usedSanitizedQuery = sanitized;
      break;
    }

    body = await resp.json().catch(() => ({}));
    const isSyntaxError =
      resp.status === 422 &&
      (body.errors || []).some(
        (err) =>
          err.field === "q" &&
          err.code === "invalid" &&
          /invalid syntax/i.test(err.message || "")
      );

    if (!isSyntaxError || i === queryAttempts.length - 1) break;
  }

  if (resp.status === 401) {
    showError(
      'Invalid GitHub token. <a href="#" id="open-options">Update settings</a>.'
    );
    document.getElementById("open-options")?.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
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
    return;
  }

  if (!resp.ok) {
    const detail = (body.errors || [])
      .map((err) => err.message)
      .filter(Boolean)
      .join(" ");
    const msg = detail || body.message || "Unknown error";
    showError(`GitHub API error ${resp.status}: ${escapeHtml(msg)}`);
    return;
  }

  const sentSearchPart = getSearchPart(searchText);
  if (focusMethod) {
    showFocusNotice(focusMethod, sentSearchPart, focusError, originalLength);
  } else if (usedSanitizedQuery) {
    showQueryAdjustedNotice("GitHub syntax adjusted", sentSearchPart);
  }

  const data = await resp.json();
  const issuesOnly = (data.items || []).filter((item) => !item.pull_request);
  const originalQuery = query.trim();
  const ranked = rankIssuesByRelevance(issuesOnly, originalQuery, searchText);
  renderResults(ranked);
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
  let focusMethod = null;
  let focusError = null;

  statusEl.innerHTML = `<div class="spinner"></div>Extracting problem from selection...`;
  try {
    const focusResult = await focusSearchQuery(searchText, settings.openaiKey);
    searchText = focusResult.text;
    focusMethod = focusResult.method;
    focusError = focusResult.error;
  } catch (err) {
    searchText = fallbackFocusedQuery(searchText);
    focusMethod = "network_error";
    focusError = err.message;
  }
  showLoading();
  resetDeepWikiColumn(settings.deepwikiRepo || "");

  const focusMeta = {
    focusMethod,
    focusError,
    originalLength,
  };

  try {
    await Promise.allSettled([
      searchGitHubIssues(query, searchText, settings, focusMeta),
      runDeepWikiSearch(searchText, settings),
    ]);
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

const queryInput = document.getElementById("query-input");
const searchBtn = document.getElementById("search-btn");
const statusEl = document.getElementById("status");
const issuesMetaEl = document.getElementById("issues-meta");
const resultsEl = document.getElementById("results");
const prStatusEl = document.getElementById("pr-status");
const prMetaEl = document.getElementById("pr-meta");
const prResultsEl = document.getElementById("pr-results");
const deepwikiStatusEl = document.getElementById("deepwiki-status");
const deepwikiStreamEl = document.getElementById("deepwiki-stream");
const deepwikiFooterEl = document.getElementById("deepwiki-footer");
const deepwikiRepoLabelEl = document.getElementById("deepwiki-repo-label");
const context7StatusEl = document.getElementById("context7-status");
const context7LinksEl = document.getElementById("context7-links");
const settingsLink = document.getElementById("settings-link");

const noticeEl = document.getElementById("summarize-notice");
const focusNoticeStatusEl = document.getElementById("focus-notice-status");
const focusedQueryInput = document.getElementById("focused-query-input");
const focusedQueryCountEl = document.getElementById("focused-query-count");
const focusedSearchBtn = document.getElementById("focused-search-btn");
const focusedQueryErrorEl = document.getElementById("focused-query-error");
const searchTypeToggle = document.getElementById("search-type-toggle");
const searchTypeBtns = searchTypeToggle.querySelectorAll(".toggle-btn[data-type]");
const issueStateBtns = document.querySelectorAll("#github-column .issue-state-btn");
const prStateBtns = document.querySelectorAll("#pr-column .pr-state-btn");
const prKeywordInput = document.getElementById("pr-keyword-input");
const prKeywordCountEl = document.getElementById("pr-keyword-count");
const prKeywordSearchBtn = document.getElementById("pr-keyword-search-btn");
const prKeywordErrorEl = document.getElementById("pr-keyword-error");
const featureRequestsCheckbox = document.getElementById("feature-requests-only");

let deepwikiAbortController = null;
let context7AbortController = null;

const CONTEXT7_DOCS_URL =
  "https://context7.com/api/web/docs/info/websites/metabase?tokens=100000&type=json";

const MAX_QUERY_LENGTH = 256;
const MAX_CODE_KEYWORD_LENGTH = 32;
let searchType = "hybrid";
let lastSourceQuery = "";
let lastFocusedText = "";
let lastCodeKeyword = "";

settingsLink.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

searchTypeBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    searchTypeBtns.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    searchType = btn.dataset.type;
    if (lastSourceQuery.trim() || getFocusedSearchText()) {
      rerunSearchWithoutRefocus();
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

function parseStateFilter(value) {
  return value === "open" || value === "closed" ? value : "all";
}

function loadFilterPrefs() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      ["issueStateFilter", "prStateFilter", "featureRequestsOnly"],
      (data) => {
        resolve({
          issueState: parseStateFilter(data.issueStateFilter),
          prState: parseStateFilter(data.prStateFilter),
          featureRequestsOnly: Boolean(data.featureRequestsOnly),
        });
      }
    );
  });
}

function saveIssueFilterPrefs() {
  const filters = getIssueSearchFilters();
  chrome.storage.sync.set({
    issueStateFilter: filters.issueState,
    featureRequestsOnly: filters.featureRequestsOnly,
  });
}

function savePrFilterPrefs() {
  const filters = getPrSearchFilters();
  chrome.storage.sync.set({ prStateFilter: filters.prState });
}

function applyFilterPrefs({ issueState, prState, featureRequestsOnly }) {
  issueStateBtns.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.state === issueState);
  });
  prStateBtns.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.state === prState);
  });
  featureRequestsCheckbox.checked = featureRequestsOnly;
}

function getIssueSearchFilters() {
  const activeStateBtn = document.querySelector("#github-column .issue-state-btn.active");
  return {
    issueState: activeStateBtn?.dataset.state || "all",
    featureRequestsOnly: featureRequestsCheckbox.checked,
  };
}

function getPrSearchFilters() {
  const activeStateBtn = document.querySelector("#pr-column .pr-state-btn.active");
  return {
    prState: activeStateBtn?.dataset.state || "all",
  };
}

function getSearchFilters() {
  return getIssueSearchFilters();
}

const EXTRACT_SYSTEM_PROMPT =
  "You are a search query optimizer for GitHub. " +
  "The user will give you text (often chat, support tickets, or email). " +
  "Respond with JSON only, no markdown, using exactly these keys:\n" +
  "githubSearchQuery: concise GitHub issue hybrid search query for the technical problem. " +
  "REMOVE @mentions, person names, emojis, reactions, timestamps, greetings, attachment meta. " +
  "KEEP product area, symptoms, errors, expected vs actual behavior. " +
  "Do NOT include Metabase, version numbers, or dashboard/question/model/table/column names. " +
  "Stay under 256 characters. No double quotes in the value.\n" +
  "codeKeyword: separate from githubSearchQuery — ONE plain token for GitHub pull request title/body search only. " +
  "NOT GitHub issue search syntax: no +, no :, no quotes, no is/open/closed/org/repo qualifiers, no boolean operators. " +
  "Letters, digits, underscore only; lowercase; must appear in the user message (exact snake_case substring allowed, e.g. known_hosts). " +
  "Pick a distinctive technical term from the message (protocol, feature, error class) that engineers use in PR titles. " +
  "Examples: SSH tunnel timeout ticket → known_hosts or ssh (not timeout+is, not connection). " +
  "Pivot Excel export → export or pivot (not pivot_export). Bad: timeout+is, is, open, invented compounds.";

const CODE_KEYWORD_USER_SUFFIX =
  "\n\n---\nFor codeKeyword only: pick ONE word from the message above (not GitHub search syntax). " +
  "Valid examples: known_hosts, ssh, export. Invalid: timeout+is, is, open, any string with + or :.";

const GITHUB_SEARCH_QUALIFIERS = new Set([
  "is",
  "open",
  "closed",
  "pr",
  "issue",
  "org",
  "repo",
  "user",
  "label",
  "state",
]);

function fallbackFocusedQuery(text, maxLen = MAX_QUERY_LENGTH) {
  let focused = stripConversationalNoise(text);
  return truncateSearchPart(focused, maxLen);
}

function normalizeCodeKeyword(keyword) {
  let k = String(keyword || "")
    .trim()
    .replace(/"/g, "")
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (k.length > MAX_CODE_KEYWORD_LENGTH) {
    k = k.slice(0, MAX_CODE_KEYWORD_LENGTH);
  }
  return k;
}

function isValidCodeKeywordShape(keyword) {
  const k = normalizeCodeKeyword(keyword);
  if (!k || !/^[a-z0-9_]+$/.test(k)) return false;
  if (/[+:]/.test(k)) return false;
  if (GITHUB_SEARCH_QUALIFIERS.has(k)) return false;
  return true;
}

function isCodeKeywordGrounded(keyword, sourceText) {
  const k = normalizeCodeKeyword(keyword);
  if (!k) return false;
  const source = String(sourceText || "");
  if (k.includes("_")) {
    return source.toLowerCase().includes(k);
  }
  return tokenize(source).includes(k);
}

function reconcileCodeKeyword(llmKeyword, sourceText, githubSearchQuery) {
  const normalized = normalizeCodeKeyword(llmKeyword);
  if (
    normalized &&
    isValidCodeKeywordShape(normalized) &&
    isCodeKeywordGrounded(normalized, sourceText)
  ) {
    return normalized;
  }
  return deriveCodeKeyword(githubSearchQuery || sourceText);
}

function resolvePrKeywordForSearch(rawKeyword, sourceText, issueSearchText) {
  const normalized = normalizeCodeKeyword(rawKeyword);
  if (normalized && isValidCodeKeywordShape(normalized)) {
    return normalized;
  }
  return reconcileCodeKeyword("", sourceText, issueSearchText);
}

function sanitizeManualPrKeyword(raw) {
  const normalized = normalizeCodeKeyword(raw);
  if (!normalized) {
    return { keyword: "", error: "Enter a PR search keyword." };
  }
  if (!isValidCodeKeywordShape(normalized)) {
    return {
      keyword: "",
      error: "Use one word only — no +, :, or GitHub qualifiers (is, open, …).",
    };
  }
  return { keyword: normalized, error: "" };
}

function formatPrSearchText(keyword, sourceText) {
  const k = String(keyword || "").trim().toLowerCase();
  if (!k) return "";
  const source = String(sourceText || "").toLowerCase();
  if (source.includes(k)) return k;
  if (k.includes("_")) {
    return k.split("_").filter(Boolean).join(" ");
  }
  if (k.includes("+")) {
    return k.split("+").filter(Boolean).join(" ");
  }
  return k;
}

function deriveCodeKeyword(text) {
  const tokens = tokenize(text);
  const candidates = tokens.filter((t) => t.length >= 4 && isValidCodeKeywordShape(t));
  if (candidates.length) {
    candidates.sort((a, b) => b.length - a.length);
    return normalizeCodeKeyword(candidates[0]);
  }
  const fallback = normalizeText(text)
    .split(" ")
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t) && isValidCodeKeywordShape(t));
  if (fallback.length) {
    fallback.sort((a, b) => b.length - a.length);
    return normalizeCodeKeyword(fallback[0]);
  }
  const first = normalizeText(text)
    .split(" ")
    .find((t) => t.length >= 2 && isValidCodeKeywordShape(t));
  return normalizeCodeKeyword(first || "bug");
}

function derivePrPhraseFromQuery(githubSearchQuery, settings, filters) {
  const tokens = tokenize(githubSearchQuery).filter((t) => t.length >= 3);
  if (!tokens.length) return "";
  tokens.sort((a, b) => b.length - a.length);
  const phrase = tokens.slice(0, 3).join(" ");
  const maxLen = maxSearchPartLength(
    settings.scopeType,
    settings.scopeValue,
    filters,
    "pr"
  );
  return truncateSearchPart(phrase, maxLen);
}

function makeFallbackFocusResult(text, maxSearchPartLen, method, error) {
  const githubSearchQuery = fallbackFocusedQuery(text, maxSearchPartLen);
  return {
    githubSearchQuery,
    codeKeyword: reconcileCodeKeyword("", text, githubSearchQuery),
    wasFocused: true,
    method,
    error,
  };
}

function parseFocusResponse(raw, maxSearchPartLen, sourceText) {
  try {
    const parsed = JSON.parse(raw);
    let githubSearchQuery = String(parsed.githubSearchQuery || "")
      .trim()
      .replace(/"/g, "");
    if (!githubSearchQuery) return null;
    githubSearchQuery = truncateSearchPart(githubSearchQuery, maxSearchPartLen);
    const codeKeyword = reconcileCodeKeyword(parsed.codeKeyword, sourceText, githubSearchQuery);
    return { githubSearchQuery, codeKeyword };
  } catch {
    return null;
  }
}

async function extractProblemQuery(text, openaiKey, maxSearchPartLen = MAX_QUERY_LENGTH) {
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
          { role: "user", content: text + CODE_KEYWORD_USER_SUFFIX },
        ],
        response_format: { type: "json_object" },
        max_completion_tokens: 200,
        temperature: 0.3,
      }),
    });
  } catch (err) {
    return makeFallbackFocusResult(text, maxSearchPartLen, "network_error", err.message);
  }

  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    return makeFallbackFocusResult(
      text,
      maxSearchPartLen,
      "api_error",
      `${resp.status}: ${body.error?.message || resp.statusText}`
    );
  }

  const data = await resp.json();
  const raw = (data.choices?.[0]?.message?.content || "").trim();
  const parsed = parseFocusResponse(raw, maxSearchPartLen, text);
  if (!parsed) {
    return makeFallbackFocusResult(text, maxSearchPartLen, "bad_summary");
  }

  return { ...parsed, wasFocused: true, method: "llm" };
}

async function focusSearchQuery(text, openaiKey, maxSearchPartLen = MAX_QUERY_LENGTH) {
  if (openaiKey) {
    return extractProblemQuery(text, openaiKey, maxSearchPartLen);
  }
  return makeFallbackFocusResult(text, maxSearchPartLen, "no_key");
}

function updatePrKeywordCount() {
  const len = prKeywordInput.value.length;
  prKeywordCountEl.textContent = `${len}/${MAX_CODE_KEYWORD_LENGTH}`;
}

function setPrKeywordValue(keyword) {
  const k = String(keyword || "").trim().slice(0, MAX_CODE_KEYWORD_LENGTH);
  prKeywordInput.value = k;
  lastCodeKeyword = k;
  updatePrKeywordCount();
  showPrKeywordError("");
}

function getPrKeywordText() {
  const fromInput = prKeywordInput.value.trim();
  if (fromInput) return fromInput;
  return (lastCodeKeyword || "").trim();
}

function showPrKeywordError(message) {
  if (message) {
    prKeywordErrorEl.textContent = message;
    prKeywordErrorEl.hidden = false;
  } else {
    prKeywordErrorEl.textContent = "";
    prKeywordErrorEl.hidden = true;
  }
}

function getPrSearchText(issueSearchText) {
  const raw = getPrKeywordText();
  if (raw) return raw;
  return (lastCodeKeyword || deriveCodeKeyword(issueSearchText)).trim();
}

function updateFocusedQueryCount(maxLen = focusedQueryInput.maxLength || MAX_QUERY_LENGTH) {
  const len = focusedQueryInput.value.length;
  focusedQueryCountEl.textContent = `${len}/${maxLen}`;
}

function applyFocusedQueryBudget(settings) {
  const maxLen = minFocusedSearchPartBudget(settings.scopeType, settings.scopeValue);
  focusedQueryInput.maxLength = maxLen;
  if (focusedQueryInput.value.length > maxLen) {
    const value = truncateSearchPart(focusedQueryInput.value, maxLen);
    focusedQueryInput.value = value;
    lastFocusedText = value;
  }
  updateFocusedQueryCount(maxLen);
}

function setFocusedQueryValue(text, settings = null) {
  const maxLen = settings
    ? minFocusedSearchPartBudget(settings.scopeType, settings.scopeValue)
    : focusedQueryInput.maxLength || MAX_QUERY_LENGTH;
  focusedQueryInput.maxLength = maxLen;
  const value = truncateSearchPart(text || "", maxLen);
  focusedQueryInput.value = value;
  lastFocusedText = value;
  updateFocusedQueryCount(maxLen);
}

function getFocusedSearchText() {
  const fromInput = focusedQueryInput.value.trim();
  if (fromInput) return fromInput;
  return lastFocusedText.trim();
}

function showFocusedQueryError(message) {
  if (message) {
    focusedQueryErrorEl.textContent = message;
    focusedQueryErrorEl.hidden = false;
  } else {
    focusedQueryErrorEl.textContent = "";
    focusedQueryErrorEl.hidden = true;
  }
}

function showFocusNotice(method, searchPart, error, originalLength, settings = null) {
  const labels = {
    llm: "Focused on problem (AI)",
    no_key: "Focused with basic cleanup — add OpenAI key for better results",
    api_error: `Focused with basic cleanup — OpenAI API error: ${error || "unknown"}`,
    network_error: `Focused with basic cleanup — network error: ${error || "unknown"}`,
    bad_summary: "Focused with basic cleanup — AI returned an invalid summary",
    manual: "Using your edited query",
  };
  const methodLabel = labels[method] || "Focused with basic cleanup";
  const lengthNote =
    originalLength > MAX_QUERY_LENGTH
      ? ` Original selection was ${originalLength} chars (limit: ${MAX_QUERY_LENGTH}).`
      : "";
  focusNoticeStatusEl.innerHTML = `<strong>${escapeHtml(methodLabel)}</strong>${lengthNote ? ` &mdash;${lengthNote}` : ""}`;
  setFocusedQueryValue(searchPart, settings);
  noticeEl.classList.add("visible");
  showFocusedQueryError("");
}

function hideSummarizeNotice() {
  noticeEl.classList.remove("visible");
  focusNoticeStatusEl.innerHTML = "";
  showFocusedQueryError("");
}

function showQueryAdjustedNotice(message, adjustedQuery, settings = null) {
  focusNoticeStatusEl.innerHTML = `<strong>${escapeHtml(message)}</strong>`;
  setFocusedQueryValue(adjustedQuery, settings);
  noticeEl.classList.add("visible");
  showFocusedQueryError("");
}

// GitHub issue search treats ()[]{}:; etc. as syntax. We strip them (never quote) so hybrid/semantic search is not forced to lexical exact-phrase mode.
const GITHUB_SEARCH_SPECIAL = /[()[\]{}<>@#;:/\\]|"(?:[^"\\]|\\.)*"/;
const FEATURE_REQUEST_LABEL = "Type:New Feature";

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

function buildQuerySuffix(scopeType, scopeValue, filters, itemType) {
  let suffix = itemType === "pr" ? " is:pr" : " is:issue";
  const state = itemType === "pr" ? filters.prState : filters.issueState;
  if (state === "open") {
    suffix += " is:open";
  } else if (state === "closed") {
    suffix += " is:closed";
  }
  if (itemType === "issue" && filters.featureRequestsOnly) {
    suffix += ` label:"${FEATURE_REQUEST_LABEL}"`;
  }
  if (scopeType === "org" && scopeValue) {
    suffix += ` org:${scopeValue}`;
  } else if (scopeType === "repo" && scopeValue) {
    suffix += ` repo:${scopeValue}`;
  }
  return suffix;
}

function maxSearchPartLength(scopeType, scopeValue, filters, itemType) {
  return Math.max(1, MAX_QUERY_LENGTH - buildQuerySuffix(scopeType, scopeValue, filters, itemType).length);
}

function minFocusedSearchPartBudget(scopeType, scopeValue) {
  return maxSearchPartLength(scopeType, scopeValue, getIssueSearchFilters(), "issue");
}

function truncateSearchPart(searchPart, maxLen) {
  if (!searchPart || searchPart.length <= maxLen) return searchPart;
  if (maxLen <= 3) return searchPart.slice(0, maxLen);
  return searchPart.slice(0, maxLen - 3).trimEnd() + "...";
}

function buildQuery(
  text,
  scopeType,
  scopeValue,
  filters = {},
  { sanitize = false, itemType = "issue" } = {}
) {
  const suffix = buildQuerySuffix(scopeType, scopeValue, filters, itemType);
  const maxLen = Math.max(1, MAX_QUERY_LENGTH - suffix.length);
  const searchPart = truncateSearchPart(getSearchPart(text, { sanitize }), maxLen);
  return searchPart + suffix;
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

function buildWeakMatchNotice(rankedItems, itemKind = "issue") {
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
    `Top result may be a weak match — few keywords from your query appear in that ${itemKind}. ` +
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

function renderGitHubResults(
  rankedItems,
  { statusEl: colStatus, metaEl: colMeta, resultsEl: colResults, emptyMessage, countLabel, itemKind, extraMetaHtml = "" }
) {
  if (!rankedItems.length) {
    colStatus.textContent = emptyMessage;
    colMeta.innerHTML = "";
    colResults.innerHTML = "";
    return;
  }

  colStatus.innerHTML = "";
  colMeta.innerHTML = extraMetaHtml || "";
  colResults.innerHTML = "";

  const weakNotice = buildWeakMatchNotice(rankedItems, itemKind);
  if (weakNotice) {
    const weakEl = document.createElement("div");
    weakEl.className = "weak-match-notice";
    weakEl.textContent = weakNotice;
    colMeta.appendChild(weakEl);
  }

  const countEl = document.createElement("div");
  countEl.className = "result-count";
  countEl.textContent = `${rankedItems.length} ${countLabel} found \u00b7 ranked locally among GitHub results`;
  colMeta.appendChild(countEl);

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
    colResults.appendChild(card);
  }
}

function renderResults(rankedItems) {
  renderGitHubResults(rankedItems, {
    statusEl,
    metaEl: issuesMetaEl,
    resultsEl,
    emptyMessage: "No issues found for this query.",
    countLabel: rankedItems.length === 1 ? "issue" : "issues",
    itemKind: "issue",
  });
}

function renderPrResults(rankedItems, { prSearchNote = "" } = {}) {
  renderGitHubResults(rankedItems, {
    statusEl: prStatusEl,
    metaEl: prMetaEl,
    resultsEl: prResultsEl,
    emptyMessage: "No pull requests found for this query.",
    countLabel: rankedItems.length === 1 ? "pull request" : "pull requests",
    itemKind: "pull request",
    extraMetaHtml: prSearchNote
      ? `<div class="pr-search-adjusted">${escapeHtml(prSearchNote)}</div>`
      : "",
  });
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
  issuesMetaEl.innerHTML = "";
  resultsEl.innerHTML = "";
}

function showLoading() {
  issuesMetaEl.innerHTML = "";
  resultsEl.innerHTML = "";
  statusEl.className = "status";
  statusEl.innerHTML = `<div class="spinner"></div>Searching issues...`;
}

function showPrError(msg) {
  prStatusEl.className = "status error";
  prStatusEl.innerHTML = msg;
  prMetaEl.innerHTML = "";
  prResultsEl.innerHTML = "";
}

function showPrLoading(adjustmentNote = "") {
  prMetaEl.innerHTML = "";
  prResultsEl.innerHTML = "";
  prStatusEl.className = "status";
  const adjNote = adjustmentNote
    ? ` <span class="pr-search-adjusted">${escapeHtml(adjustmentNote)}</span>`
    : "";
  prStatusEl.innerHTML = `<div class="spinner"></div>Searching pull requests...${adjNote}`;
}

function buildPrSearchAttempts(codeKeyword, formattedPrimary, issueSearchText, sourceText, settings, filters) {
  const seen = new Set();
  const attempts = [];
  const add = (query, display) => {
    const q = String(query || "").trim();
    if (!q || seen.has(q)) return;
    seen.add(q);
    attempts.push({
      query: q,
      display: String(display || q).trim() || q,
    });
  };

  add(formattedPrimary, codeKeyword);
  const derived = deriveCodeKeyword(issueSearchText);
  add(formatPrSearchText(derived, sourceText), derived);
  const phrase = derivePrPhraseFromQuery(issueSearchText, settings, filters);
  add(phrase, phrase);
  const maxLen = maxSearchPartLength(
    settings.scopeType,
    settings.scopeValue,
    filters,
    "pr"
  );
  add(truncateSearchPart(issueSearchText, Math.min(80, maxLen)), truncateSearchPart(issueSearchText, 40));

  return attempts;
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

function resetContext7Section() {
  if (context7AbortController) {
    context7AbortController.abort();
    context7AbortController = null;
  }
  context7StatusEl.className = "context7-status";
  context7StatusEl.innerHTML = "";
  context7LinksEl.innerHTML = "";
}

function showContext7Loading() {
  context7StatusEl.className = "context7-status";
  context7StatusEl.innerHTML = `<div class="spinner"></div>Loading Metabase docs...`;
  context7LinksEl.innerHTML = "";
}

function showContext7Error(msg) {
  context7StatusEl.className = "context7-status error";
  context7StatusEl.textContent = msg;
  context7LinksEl.innerHTML = "";
}

function showContext7Empty() {
  context7StatusEl.className = "context7-status";
  context7StatusEl.textContent = "No matching docs found.";
  context7LinksEl.innerHTML = "";
}

function renderContext7Links(urls) {
  context7StatusEl.className = "context7-status";
  context7StatusEl.innerHTML = "";
  context7LinksEl.innerHTML = urls
    .map(
      (url) =>
        `<li><a href="${escapeAttr(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a></li>`
    )
    .join("");
}

function dedupeWebsiteUrls(snippets) {
  const urls = [];
  const seen = new Set();
  for (const snippet of snippets || []) {
    const url = snippet.websiteUrl?.trim();
    if (url && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

async function fetchContext7Docs(topic, signal) {
  const url = `${CONTEXT7_DOCS_URL}&topic=${encodeURIComponent(topic)}`;
  const resp = await fetch(url, { signal });
  if (!resp.ok) {
    throw new Error(`Context7 HTTP ${resp.status}`);
  }
  const data = await resp.json();
  return dedupeWebsiteUrls(data.snippets);
}

async function runContext7Search(topic) {
  const trimmedTopic = topic.trim();
  if (!trimmedTopic) {
    resetContext7Section();
    return;
  }

  resetContext7Section();
  showContext7Loading();

  context7AbortController = new AbortController();
  const signal = context7AbortController.signal;

  try {
    const urls = await fetchContext7Docs(trimmedTopic, signal);
    if (urls.length === 0) {
      showContext7Empty();
      return;
    }
    renderContext7Links(urls);
  } catch (err) {
    if (err.name !== "AbortError") {
      showContext7Error(err.message || "Context7 unavailable");
    }
  } finally {
    context7AbortController = null;
  }
}

async function fetchRankedGitHubItems({ itemType, searchText, settings, filters }) {
  const trimmedForQuery = searchText.trim();
  const autoSanitized = GITHUB_SEARCH_SPECIAL.test(trimmedForQuery);
  const queryAttempts = [
    {
      query: buildQuery(searchText, settings.scopeType, settings.scopeValue, filters, {
        itemType,
      }),
      sanitized: autoSanitized,
    },
    {
      query: buildQuery(searchText, settings.scopeType, settings.scopeValue, filters, {
        sanitize: true,
        itemType,
      }),
      sanitized: true,
    },
  ].filter((attempt, i, arr) => arr.findIndex((a) => a.query === attempt.query) === i);

  let resp;
  let body = {};
  let usedSanitizedQuery = false;

  for (let i = 0; i < queryAttempts.length; i++) {
    const { query: fullQuery, sanitized } = queryAttempts[i];
    const params = new URLSearchParams({
      q: fullQuery,
      per_page: "30",
    });
    if (itemType === "issue") {
      params.set("search_type", searchType);
    } else {
      params.set("sort", "updated");
      params.set("order", "desc");
    }
    const url = `https://api.github.com/search/issues?${params}`;

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

  const optionsLinkId = itemType === "pr" ? "open-options-pr" : "open-options";

  if (resp.status === 401) {
    return {
      ok: false,
      ranked: [],
      usedSanitizedQuery,
      errorHtml: `Invalid GitHub token. <a href="#" id="${optionsLinkId}">Update settings</a>.`,
      optionsLinkId,
    };
  }

  if (resp.status === 403) {
    const resetHeader = resp.headers.get("x-ratelimit-reset");
    let extra = "";
    if (resetHeader) {
      const resetDate = new Date(parseInt(resetHeader, 10) * 1000);
      extra = ` Resets at ${resetDate.toLocaleTimeString()}.`;
    }
    const rateMsg =
      itemType === "issue"
        ? `Rate limit exceeded.${extra} Semantic search is limited to 10 requests/minute.`
        : `Rate limit exceeded.${extra}`;
    return { ok: false, ranked: [], usedSanitizedQuery, errorHtml: rateMsg };
  }

  if (!resp.ok) {
    const detail = (body.errors || [])
      .map((err) => err.message)
      .filter(Boolean)
      .join(" ");
    const msg = detail || body.message || "Unknown error";
    return {
      ok: false,
      ranked: [],
      usedSanitizedQuery,
      errorHtml: `GitHub API error ${resp.status}: ${escapeHtml(msg)}`,
    };
  }

  const data = await resp.json();
  const items =
    itemType === "pr"
      ? (data.items || []).filter((item) => item.pull_request)
      : (data.items || []).filter((item) => !item.pull_request);
  const trimmedSearchText = searchText.trim();
  const ranked = rankIssuesByRelevance(items, trimmedSearchText, searchText);
  return { ok: true, ranked, usedSanitizedQuery };
}

async function searchGitHubItems({
  itemType,
  searchText,
  settings,
  filters,
  focusMeta,
  showErrorFn,
  renderFn,
}) {
  const result = await fetchRankedGitHubItems({ itemType, searchText, settings, filters });

  if (!result.ok) {
    showErrorFn(result.errorHtml);
    if (result.optionsLinkId) {
      document.getElementById(result.optionsLinkId)?.addEventListener("click", (e) => {
        e.preventDefault();
        chrome.runtime.openOptionsPage();
      });
    }
    return;
  }

  if (itemType === "issue" && focusMeta) {
    const { focusMethod, focusError, originalLength } = focusMeta;
    const sentSearchPart = getSearchPart(searchText);
    if (focusMethod && focusMethod !== "manual") {
      showFocusNotice(focusMethod, sentSearchPart, focusError, originalLength, settings);
    } else if (result.usedSanitizedQuery) {
      showQueryAdjustedNotice("GitHub syntax adjusted", sentSearchPart, settings);
    } else if (focusMethod === "manual") {
      showFocusNotice("manual", sentSearchPart, focusError, originalLength, settings);
    }
  }

  renderFn(result.ranked);
}

async function searchGitHubIssues(searchText, settings, focusMeta, filters) {
  await searchGitHubItems({
    itemType: "issue",
    searchText,
    settings,
    filters,
    focusMeta,
    showErrorFn: showError,
    renderFn: renderResults,
  });
}

async function searchGitHubPullRequests(
  codeKeyword,
  formattedPrQuery,
  issueSearchText,
  sourceText,
  settings,
  filters
) {
  const attempts = buildPrSearchAttempts(
    codeKeyword,
    formattedPrQuery,
    issueSearchText,
    sourceText,
    settings,
    filters
  );
  if (!attempts.length) {
    renderPrResults([]);
    return;
  }

  let firstDisplay = attempts[0].display;
  showPrLoading();

  for (let i = 0; i < attempts.length; i++) {
    const { query, display } = attempts[i];
    if (i > 0) {
      showPrLoading("Broadening search after no results");
    }

    const result = await fetchRankedGitHubItems({
      itemType: "pr",
      searchText: query,
      settings,
      filters,
    });

    if (!result.ok) {
      showPrError(result.errorHtml);
      if (result.optionsLinkId) {
        document.getElementById(result.optionsLinkId)?.addEventListener("click", (e) => {
          e.preventDefault();
          chrome.runtime.openOptionsPage();
        });
      }
      return;
    }

    if (result.ranked.length > 0) {
      const usedFallback = i > 0;
      renderPrResults(result.ranked, {
        prSearchNote: usedFallback
          ? `No PRs for "${firstDisplay}"; results use "${display}".`
          : "",
      });
      return;
    }
  }

  renderPrResults([]);
}

async function runGitHubAndDeepWiki(githubSearchQuery, codeKeyword, settings, focusMeta) {
  const issueSearchText = (getFocusedSearchText() || githubSearchQuery).trim();
  const sourceText = lastSourceQuery.trim();
  const prKeyword = resolvePrKeywordForSearch(
    codeKeyword || getPrKeywordText(),
    sourceText,
    issueSearchText
  );
  setPrKeywordValue(prKeyword);
  const formattedPrQuery = formatPrSearchText(prKeyword, sourceText).trim() || prKeyword;
  showPrLoading();
  const issueFilters = getIssueSearchFilters();
  const prFilters = getPrSearchFilters();
  await Promise.allSettled([
    searchGitHubIssues(issueSearchText, settings, focusMeta, issueFilters),
    searchGitHubPullRequests(
      prKeyword,
      formattedPrQuery,
      issueSearchText,
      sourceText,
      settings,
      prFilters
    ),
    runDeepWikiSearch(issueSearchText, settings),
    runContext7Search(issueSearchText),
  ]);
}

function rerunSearchWithoutRefocus() {
  if (!lastSourceQuery.trim() && !getFocusedSearchText()) return;
  doSearch(lastSourceQuery || queryInput.value, { refocus: false });
}

async function rerunPrSearchOnly() {
  const issueSearchText = getFocusedSearchText();
  if (!issueSearchText) {
    showPrKeywordError("Run a search first, or set a GitHub issue query.");
    return;
  }

  const sanitized = sanitizeManualPrKeyword(getPrKeywordText());
  if (sanitized.error) {
    showPrKeywordError(sanitized.error);
    return;
  }
  showPrKeywordError("");

  const settings = await getSettings();
  if (!settings.githubToken) {
    const noTokenMsg =
      'No GitHub token configured. <a href="#" id="open-options-pr">Open settings</a> to add one.';
    showPrError(noTokenMsg);
    document.getElementById("open-options-pr")?.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
    return;
  }

  const codeKeyword = sanitized.keyword;
  lastCodeKeyword = codeKeyword;
  setPrKeywordValue(codeKeyword);

  const sourceText = lastSourceQuery.trim();
  const formattedPrQuery = formatPrSearchText(codeKeyword, sourceText).trim() || codeKeyword;
  showPrLoading();

  try {
    await searchGitHubPullRequests(
      codeKeyword,
      formattedPrQuery,
      issueSearchText,
      sourceText,
      settings,
      getPrSearchFilters()
    );
  } catch (err) {
    showPrError(`Network error: ${escapeHtml(err.message)}`);
  }
}

async function doSearch(sourceQuery, { refocus = true } = {}) {
  const trimmedSource = sourceQuery.trim();
  if (!trimmedSource && !refocus) {
    const focused = getFocusedSearchText();
    if (!focused) return;
  }
  if (!trimmedSource && refocus) return;

  if (trimmedSource) {
    queryInput.value = trimmedSource;
    lastSourceQuery = trimmedSource;
  }

  if (!refocus) {
    const focused = getFocusedSearchText();
    if (!focused) {
      showFocusedQueryError("Enter a GitHub search query before searching.");
      noticeEl.classList.add("visible");
      return;
    }
    showFocusedQueryError("");
    lastFocusedText = focused;
  } else {
    showFocusedQueryError("");
  }

  searchBtn.disabled = true;
  focusedSearchBtn.disabled = true;
  if (refocus) {
    hideSummarizeNotice();
  }
  showLoading();
  showPrLoading();

  const settings = await getSettings();

  if (!settings.githubToken) {
    const noTokenMsg =
      'No GitHub token configured. <a href="#" id="open-options">Open settings</a> to add one.';
    showError(noTokenMsg);
    showPrError(noTokenMsg.replace('id="open-options"', 'id="open-options-pr"'));
    document.getElementById("open-options")?.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
    document.getElementById("open-options-pr")?.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
    searchBtn.disabled = false;
    focusedSearchBtn.disabled = false;
    return;
  }

  let searchText;
  let codeKeyword = "";
  let focusMethod = null;
  let focusError = null;
  const originalLength = trimmedSource.length;

  if (refocus) {
    searchText = trimmedSource;
    applyFocusedQueryBudget(settings);
    const maxSearchPartLen = minFocusedSearchPartBudget(settings.scopeType, settings.scopeValue);
    statusEl.innerHTML = `<div class="spinner"></div>Extracting problem from selection...`;
    showPrLoading("");
    try {
      const focusResult = await focusSearchQuery(searchText, settings.openaiKey, maxSearchPartLen);
      searchText = focusResult.githubSearchQuery;
      codeKeyword = focusResult.codeKeyword;
      lastCodeKeyword = codeKeyword;
      focusMethod = focusResult.method;
      focusError = focusResult.error;
    } catch (err) {
      const fallback = makeFallbackFocusResult(
        searchText,
        maxSearchPartLen,
        "network_error",
        err.message
      );
      searchText = fallback.githubSearchQuery;
      codeKeyword = fallback.codeKeyword;
      lastCodeKeyword = codeKeyword;
      focusMethod = fallback.method;
      focusError = fallback.error;
    }
    setFocusedQueryValue(searchText, settings);
    setPrKeywordValue(codeKeyword);
    noticeEl.classList.add("visible");
  } else {
    applyFocusedQueryBudget(settings);
    searchText = getFocusedSearchText();
    lastFocusedText = searchText;
    const sourceText = lastSourceQuery.trim();
    codeKeyword = resolvePrKeywordForSearch(getPrKeywordText(), sourceText, searchText);
    setPrKeywordValue(codeKeyword);
  }

  showLoading();
  showPrLoading();
  resetDeepWikiColumn(settings.deepwikiRepo || "");
  resetContext7Section();

  const focusMeta = {
    focusMethod: refocus ? focusMethod : "manual",
    focusError,
    originalLength,
  };

  try {
    await runGitHubAndDeepWiki(searchText, codeKeyword, settings, focusMeta);
  } catch (err) {
    const networkMsg = `Network error: ${escapeHtml(err.message)}`;
    showError(networkMsg);
    showPrError(networkMsg);
  } finally {
    searchBtn.disabled = false;
    focusedSearchBtn.disabled = false;
  }
}

searchBtn.addEventListener("click", () => doSearch(queryInput.value, { refocus: true }));
queryInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doSearch(queryInput.value, { refocus: true });
});

focusedSearchBtn.addEventListener("click", () => {
  doSearch(lastSourceQuery || queryInput.value, { refocus: false });
});

focusedQueryInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    doSearch(lastSourceQuery || queryInput.value, { refocus: false });
  }
});

focusedQueryInput.addEventListener("input", () => {
  updateFocusedQueryCount();
  showFocusedQueryError("");
});

focusedQueryInput.addEventListener("paste", (e) => {
  const maxLen = focusedQueryInput.maxLength || MAX_QUERY_LENGTH;
  const pasted = (e.clipboardData || window.clipboardData).getData("text");
  const selectionLen =
    focusedQueryInput.selectionEnd - focusedQueryInput.selectionStart;
  const nextLen = focusedQueryInput.value.length - selectionLen + pasted.length;
  if (nextLen > maxLen) {
    e.preventDefault();
    const available = maxLen - (focusedQueryInput.value.length - selectionLen);
    const trimmed = pasted.slice(0, available);
    const start = focusedQueryInput.selectionStart;
    const end = focusedQueryInput.selectionEnd;
    focusedQueryInput.setRangeText(trimmed, start, end, "end");
    updateFocusedQueryCount(maxLen);
  }
});

issueStateBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    issueStateBtns.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    saveIssueFilterPrefs();
    rerunSearchWithoutRefocus();
  });
});

prStateBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    prStateBtns.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    savePrFilterPrefs();
    rerunPrSearchOnly();
  });
});

prKeywordSearchBtn.addEventListener("click", () => rerunPrSearchOnly());

prKeywordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") rerunPrSearchOnly();
});

prKeywordInput.addEventListener("input", () => updatePrKeywordCount());

featureRequestsCheckbox.addEventListener("change", () => {
  saveIssueFilterPrefs();
  rerunSearchWithoutRefocus();
});

loadFilterPrefs().then(applyFilterPrefs);

const params = new URLSearchParams(window.location.search);
const initialQuery = params.get("q");
if (initialQuery) {
  doSearch(initialQuery, { refocus: true });
}

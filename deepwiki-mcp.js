/**
 * DeepWiki MCP client — Streamable HTTP only.
 *
 * Endpoint: POST https://mcp.deepwiki.com/mcp (recommended by Devin)
 * https://docs.devin.ai/work-with-devin/deepwiki-mcp#streamable-http-/mcp
 *
 * Do NOT use the legacy wire protocol URL https://mcp.deepwiki.com/sse
 * (deprecated per https://docs.devin.ai/work-with-devin/deepwiki-mcp#wire-protocols).
 *
 * Streamable HTTP may respond with Content-Type: text/event-stream on /mcp.
 * That is the MCP transport framing for one POST — not the deprecated /sse endpoint.
 */
const DEEPWIKI_MCP_URL = "https://mcp.deepwiki.com/mcp";
const MCP_PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_TIMEOUT_MS = 90000;

let sessionId = null;
let sessionPromise = null;

function mcpHeaders(extra = {}) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...extra,
  };
  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }
  return headers;
}

function captureSessionId(response) {
  const id = response.headers.get("Mcp-Session-Id");
  if (id) sessionId = id;
}

function createProgressToken() {
  return `dw-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function mcpPost(body, signal) {
  const response = await fetch(DEEPWIKI_MCP_URL, {
    method: "POST",
    headers: mcpHeaders(),
    body: JSON.stringify(body),
    signal,
  });
  captureSessionId(response);
  return response;
}

async function ensureSession(signal) {
  if (sessionId) return;
  if (sessionPromise) {
    await sessionPromise;
    return;
  }

  sessionPromise = (async () => {
    const initResp = await mcpPost(
      {
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: "github-semantic-search-extension",
            version: "1.0.0",
          },
        },
      },
      signal
    );

    const contentType = initResp.headers.get("Content-Type") || "";
    if (contentType.includes("text/event-stream")) {
      await consumeStreamableHttpBody(initResp, { expectId: 0 });
    } else if (initResp.ok) {
      await initResp.json().catch(() => ({}));
    }

    await mcpPost(
      {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      },
      signal
    );
  })();

  try {
    await sessionPromise;
  } finally {
    sessionPromise = null;
  }
}

function extractTextFromMcpResult(result) {
  if (!result) return "";
  const content = result.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("");
}

function extractTextFromMessage(msg) {
  if (!msg || typeof msg !== "object") return "";
  if (msg.result) return extractTextFromMcpResult(msg.result);
  if (msg.params?.content) return extractTextFromMcpResult({ content: msg.params.content });
  if (typeof msg.params?.message === "string") return msg.params.message;
  if (typeof msg.params?.delta === "string") return msg.params.delta;
  return "";
}

function createStreamState() {
  return {
    accumulated: "",
    hadIncremental: false,
    eventCount: 0,
  };
}

function pushIncremental(delta, state, onChunk) {
  if (!delta) return;
  state.hadIncremental = true;
  state.accumulated += delta;
  if (onChunk) onChunk(delta, state.accumulated);
}

function storeBulkText(text, state) {
  if (!text) return;
  state.accumulated = text;
}

function handleProgressNotification(msg, state, onChunk) {
  const params = msg.params;
  if (!params) return;

  const partial = params.partialResult;
  if (partial?.chunk) {
    const chunkText = extractTextFromMcpResult(partial.chunk);
    if (!chunkText) return;

    if (partial.append) {
      pushIncremental(chunkText, state, onChunk);
    } else {
      const delta = chunkText.slice(state.accumulated.length);
      storeBulkText(chunkText, state);
      if (delta) pushIncremental(delta, state, onChunk);
    }
    return;
  }

  const progressText =
    typeof params.message === "string" ? params.message : extractTextFromMessage(msg);
  if (!progressText || progressText === state.accumulated) return;

  if (progressText.startsWith(state.accumulated)) {
    pushIncremental(progressText.slice(state.accumulated.length), state, onChunk);
  } else {
    const delta = progressText.slice(state.accumulated.length);
    storeBulkText(progressText, state);
    if (delta) pushIncremental(delta, state, onChunk);
  }
}

function handleResultText(text, state, onChunk) {
  if (!text) return;

  if (text.length > state.accumulated.length && text.startsWith(state.accumulated)) {
    const delta = text.slice(state.accumulated.length);
    storeBulkText(text, state);
    if (state.eventCount > 1 && delta) {
      pushIncremental(delta, state, onChunk);
    }
    return;
  }

  if (!state.accumulated) {
    storeBulkText(text, state);
    return;
  }

  if (text !== state.accumulated) {
    const delta = text.slice(state.accumulated.length);
    storeBulkText(text, state);
    if (delta) pushIncremental(delta, state, onChunk);
  }
}

/** Parse Streamable HTTP response body (often event-stream framed) from POST /mcp. */
async function consumeStreamableHttpBody(response, { onChunk, expectId } = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const state = createStreamState();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split("\n");
    buffer = parts.pop() || "";

    for (const line of parts) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;

      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        continue;
      }

      if (msg.error) {
        throw new Error(msg.error.message || "DeepWiki MCP error");
      }

      state.eventCount++;

      if (msg.method === "notifications/progress") {
        handleProgressNotification(msg, state, onChunk);
        continue;
      }

      const text = extractTextFromMessage(msg);
      if (text) {
        handleResultText(text, state, onChunk);
      }

      if (
        msg.result &&
        (expectId === undefined || msg.id === expectId || msg.id === null)
      ) {
        const resultText = extractTextFromMcpResult(msg.result);
        if (resultText) {
          handleResultText(resultText, state, onChunk);
        }
      }
    }
  }

  return state.accumulated;
}

async function parseJsonResponse(response) {
  const data = await response.json();
  if (data.error) {
    throw new Error(data.error.message || "DeepWiki MCP error");
  }
  return extractTextFromMcpResult(data.result) || "";
}

/**
 * Ask DeepWiki about a repo.
 * onChunk fires only when the server sends incremental MCP progress/content.
 * onDone receives the full answer (render once if nothing was streamed).
 */
async function askDeepWikiStream(repoName, question, handlers = {}) {
  const { onChunk, onDone, onError, signal } = handlers;
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), DEFAULT_TIMEOUT_MS);

  let combinedSignal = timeoutController.signal;
  if (signal) {
    const linked = new AbortController();
    const onAbort = () => linked.abort();
    if (signal.aborted || timeoutController.signal.aborted) {
      linked.abort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
      timeoutController.signal.addEventListener("abort", onAbort, { once: true });
    }
    combinedSignal = linked.signal;
  }

  try {
    await ensureSession(combinedSignal);

    const requestId = Date.now();
    const progressToken = createProgressToken();
    const response = await mcpPost(
      {
        jsonrpc: "2.0",
        id: requestId,
        method: "tools/call",
        params: {
          name: "ask_question",
          arguments: {
            repoName,
            question,
          },
          _meta: {
            progressToken,
            partialResults: true,
          },
        },
      },
      combinedSignal
    );

    if (!response.ok) {
      throw new Error(`DeepWiki MCP HTTP ${response.status}`);
    }

    const contentType = response.headers.get("Content-Type") || "";

    let fullText = "";
    if (contentType.includes("text/event-stream")) {
      fullText = await consumeStreamableHttpBody(response, {
        expectId: requestId,
        onChunk: onChunk
          ? (delta, full) => {
              onChunk(delta, full);
            }
          : undefined,
      });
    } else {
      fullText = await parseJsonResponse(response);
    }

    if (onDone) onDone(fullText);
    return fullText;
  } catch (err) {
    const error =
      err.name === "AbortError"
        ? new Error("DeepWiki request timed out or was cancelled")
        : err instanceof Error
          ? err
          : new Error(String(err));
    if (onError) onError(error);
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

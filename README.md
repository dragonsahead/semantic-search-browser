# GitHub Semantic Search

A Chrome extension that lets you search GitHub Issues using semantic search from any selected text on a page. Right-click highlighted text and choose **"Search GitHub Issues"** to find relevant issues — with optional **DeepWiki** repo answers side by side.

## Installation

1. Open your Chromium-based browser (Chrome, Edge, Brave, Arc, etc.)
2. Navigate to `chrome://extensions`
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked**
5. Select the folder containing this project

The extension icon should appear in your toolbar.

## Configuration

After installing, right-click the extension icon and select **Options** (or go to `chrome://extensions`, find "GitHub Semantic Search", and click **Details → Extension options**).

You need to provide two tokens:

### GitHub Personal Access Token

1. Go to [github.com/settings/tokens](https://github.com/settings/tokens)
2. Generate a new token (classic)
3. No extra scopes are required for searching public repos. Enable the `repo` scope if you want to search private repos.
4. Paste the token into the **GitHub Personal Access Token** field

### OpenAI API Key

Used on **every** search to turn chat/support text into a short GitHub-friendly query (strips @mentions, emojis, timestamps, and similar noise). Your **full selection** is sent to OpenAI; the **256-character limit applies only to the AI summary** sent to GitHub's search API. **Recommended** — without a key, only basic cleanup is applied.

1. Go to [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. Create a new secret key
3. Paste the key into the **OpenAI API Key** field

### Search Scope (optional)

You can optionally limit search results to a specific organization or repository (e.g. `metabase/metabase`).

### DeepWiki (optional)

When enabled, the results page shows a **split view**: GitHub issues on the left, a streaming DeepWiki answer on the right.

- **Enable DeepWiki answers** — turn on repo Q&A via the official [DeepWiki MCP](https://docs.devin.ai/work-with-devin/deepwiki-mcp) server (public repos, no API key).
- **DeepWiki repository** — `owner/repo` to ask about (defaults from repo search scope when set).

The same AI-focused problem text is sent to both GitHub search and DeepWiki `ask_question`. Answers typically take 10–30 seconds; the right panel shows a spinner until the full reply arrives via [Streamable HTTP](https://docs.devin.ai/work-with-devin/deepwiki-mcp#streamable-http-/mcp) at `https://mcp.deepwiki.com/mcp` (not the deprecated `/sse` endpoint). If the server sends incremental MCP progress chunks, those appear as they arrive.

## Usage

1. Select any text on a webpage
2. Right-click and choose **"Search GitHub Issues: ..."**
3. A new tab opens with:
   - **Left:** semantically relevant GitHub issues (ranked locally)
   - **Right:** DeepWiki answer for your configured repo (if enabled)

## Manual test checklist

1. Options: set repo scope or DeepWiki repo to `metabase/metabase`, enable DeepWiki, save.
2. Right-click a support-style message → Search GitHub Issues.
3. Left column shows issues; right column shows a spinner, then the full DeepWiki answer (same focused query in the notice).
4. Disable DeepWiki → right column shows a settings hint only.
5. In DevTools Network, confirm requests go to `mcp.deepwiki.com/mcp`, not `/sse`.

# GitHub Semantic Search

A Chrome extension that lets you search GitHub Issues using semantic search from any selected text on a page. Right-click highlighted text and choose **"Search GitHub Issues"** to find relevant issues.

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

Used to summarize long text selections that exceed GitHub's 256-character query limit.

1. Go to [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. Create a new secret key
3. Paste the key into the **OpenAI API Key** field

### Search Scope (optional)

You can optionally limit search results to a specific organization or repository (e.g. `metabase/metabase`).

## Usage

1. Select any text on a webpage
2. Right-click and choose **"Search GitHub Issues: ..."**
3. A new tab opens with semantically relevant GitHub Issues (+ some other modifications we do locally to enhance matches)

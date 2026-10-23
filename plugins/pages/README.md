# Pages plugin

A workspace tab that shows a folder of HTML pages (reports, dashboards, anything an agent wrote as `index.html`) as a gallery of live thumbnails and opens them inside AgentHarbor.

A page is either a subfolder with an `index.html` or a single `.html` file in the folder. The folder's own `index.html` is skipped, since it is usually a hand-written list of the same pages. Pages are sorted by their newest file, so a dashboard whose data file a job rewrites moves to the top. The list refreshes every 30 seconds, and an open page reloads by itself when its files change.

## Install

The plugin ships with AgentHarbor but stays off until it is linked into the plugins folder:

```bash
ln -s /path/to/agentharbor/plugins/pages ~/.agentharbor/plugins/pages
```

Then restart AgentHarbor (or reload the page). To remove it, delete the link or uninstall it in Settings -> Plugins. Only the link is removed.

## Settings

Open the tab and press the gear button. Settings are stored in `~/.agentharbor/plugin-data/pages/config.json`.

- Pages folder: where the pages are. A Windows path such as `C:\Users\me\Documents\pages` is accepted when AgentHarbor runs in WSL and is mapped to `/mnt/c/...`.
- Static server address (optional): the base URL of a web server that already serves this folder. Pages then load from it, relative links and images work, and the viewer gets an "open in a new tab" button. Without it, the page HTML is read through AgentHarbor and shown in a sandboxed frame, which works for self-contained pages only.

## Files

- `manifest.json`: plugin manifest (tab slot, entry, server).
- `index.js`: the tab UI, plain DOM, styled with AgentHarbor's theme variables.
- `server.mjs`: a small local HTTP server that AgentHarbor starts and proxies to under `/api/plugins/pages/rpc/*`.
- `pages-store.mjs`: reading the folder and the settings; tests in `pages-store.test.mjs` run with `npm test`.

# AgentHarbor — design

Fork of CloudCLI UI (https://github.com/siteboon/claudecodeui), AGPL-3.0.
Tagline: **Web UI for your live AI CLI agents.**

## Goal

Run any number of Claude Code agents and drive them from a browser (desktop or phone) with the
CloudCLI chat UI (markdown, diffs, tool cards, file tree, git panel), while every agent is a real,
interactive Claude Code TUI living in a tmux window. The server never runs Claude itself in
SDK/stream-json mode. The same agent can be used at the same time from the web chat, the web
terminal tab, and ssh/mosh + tmux, and it survives server restarts and dropped connections.

Problems with upstream that motivated the fork: SDK runs are separate processes from the user's
terminal sessions, sessions get duplicated, and stream-mode behaves differently from the TUI.

## Non-goals

- Other agent CLIs (Codex, Cursor, OpenCode, Gemini). Claude Code only.
- Voice, TaskMaster/PRD editor, browser-use, scheduled messages, `/api/agent`, Electron desktop app.
- Features that need SDK control of the run: edit-and-resend/rewind, fork, model/effort/permission
  mode pickers, AI commit-message generation. The TUI owns these (slash commands, Shift+Tab).

## Architecture

```
browser ──/ws chat──────┐                       ┌── tmux server (session "main")
browser ──/shell xterm──┤  AgentHarbor server   │     window = 1 agent = claude TUI
                        ├─ tmux adapter ────────┤        └─ SessionStart hook → panes/<pane>.json
                        ├─ pane registry ◄──────┘
                        ├─ transcript tailer ◄── <CLAUDE_HOME>/projects/**/<session>.jsonl (polled)
                        ├─ liveness ◄─────────── <CLAUDE_HOME>/sessions/<pid>.json (busy/idle)
                        └─ prompt detector ◄──── tmux capture-pane
```

The server runs on Linux next to the tmux server (on Windows: inside WSL; Claude may be the Windows
`claude.exe` launched through WSL interop, which is the author's setup).

### Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `AH_TMUX_SESSION` | `main` | tmux session that holds agent windows |
| `AH_CLAUDE_CMD` | `claude` | command started in new windows |
| `CLAUDE_HOME` | `~/.claude` | where Claude writes `projects/` and `sessions/` (WSL+Windows claude: `/mnt/c/Users/<u>/.claude`) |
| `AH_STATE_DIR` | `~/.agentharbor` | pane registry + generated hook settings + DB; must be writable by the Claude process (WSL+Windows: a `/mnt/c/...` dir) |
| `PORT` | `3001` | HTTP port |

Path translation: when `AH_CLAUDE_CMD` ends in `.exe`, Windows paths (`D:\x`) coming from Claude
(cwd, transcript_path) are mapped to `/mnt/d/x` and back with `wslpath`. One module
(`server/shared/path-translation.ts`) does this; every place that touches the filesystem or tmux
with a project path goes through it.

## Components

### 1. tmux adapter — `server/modules/tmux/tmux.service.ts`
Thin wrapper over `execFile('tmux', …)`: `listAgentWindows()` (window id, name, pane id, pane pid,
cwd, dead flag), `newAgentWindow({cwd, name, args})`, `killWindow`, `pasteText(paneId, text)`
(`load-buffer` + `paste-buffer -p -d`, so multi-line text is one bracketed paste), `sendKeys(paneId,
keys[])`, `capturePane(paneId)`. Tests run against a private server (`tmux -L ah-test`).

New windows run: `AH_PANE=${TMUX_PANE#%} AH_STATE_DIR=… [WSLENV=AH_PANE:AH_STATE_DIR/p] <AH_CLAUDE_CMD>
--settings <state>/hook-settings.json [--resume <id> | --session-id <uuid>]`.

### 2. Pane registry — `server/modules/tmux/pane-registry.service.ts`
`hook-settings.json` (generated at startup) registers a `SessionStart` hook that writes the hook's
stdin JSON to `<AH_STATE_DIR>/panes/<pane>.json` when `AH_PANE` is set. SessionStart fires on
startup, resume, `/clear` and compaction, so the file always holds the pane's current
`session_id` + `transcript_path`. The registry joins these files with live tmux panes and answers
`findPaneForSession(providerSessionId)` and `sessionForPane(paneId)`. Files of dead panes are deleted.
The author's `cc` helper is updated to launch with the same env + `--settings`, so windows opened
from the phone are registered too.

### 3. Liveness — existing `claude-cli-liveness.service.ts`
Reads `<CLAUDE_HOME>/sessions/<pid>.json` (`sessionId`, `status: busy|idle`). Made to honor
`CLAUDE_HOME`. Gives busy/idle per session id.

### 4. Transcript tailer — `server/modules/tmux/transcript-tail.service.ts`
For every session with at least one chat subscriber: poll `stat` of its jsonl every 750 ms
(inotify does not see writes from Windows into `/mnt/c`), read appended bytes from the last offset,
keep a partial trailing line until it is completed, parse rows, and run them through the existing
`ClaudeSessionsProvider.normalizeMessage`. Ids are deterministic (`<uuid>_<i>`), so live frames
dedupe with REST history in the client store. Frames go to subscribers through the existing chat
run registry (`seq`, replay buffer). Busy→idle transition emits `complete`, which makes the client
re-sync the tail over REST (handles anything the incremental path got wrong). Subscribers stop →
tailer for that file stops.

### 5. TUI prompt detector — `server/modules/tmux/tui-prompt.ts` (pure) + poller
While a session is busy (and once after it turns idle), capture its pane every 1 s. A pure function
parses the screen: a selection menu is a block of lines `❯ 1. Yes` / `  2. …` near the bottom with
a question line above it. Output `{question, options:[{key, label, selected}], screenTail}` or
`null`. Changes are sent as `{kind:'tui_prompt'}` / `{kind:'tui_prompt_cleared'}`. The client shows
the question with one button per option; a click sends `chat.tui-keys {sessionId, keys:['2']}`.
The pane screen tail is also sent (throttled) as `{kind:'tui_screen', lines}` while busy, so the
UI can show what the TUI is doing right now (streaming text, spinners) before the jsonl row lands.
A small key bar (Esc, Enter, ↑, ↓, Shift+Tab, Ctrl+C) covers anything the detector misses.
Fixtures for tests are real `capture-pane` dumps.

### 6. Runtime — `server/modules/providers/list/claude/claude-tmux.runtime.ts`
Replaces `claude-runtime.provider.js` behind the same `IProviderRuntime` interface:
- `run(command, options, writer, ctx)`: resolve the provider session id; find its pane; if none,
  open a window (`--resume <id>` for an existing session, `--session-id <new uuid>` for a new one)
  and wait until the registry reports the pane and the screen shows the input box (timeout 30 s →
  `error`). Paste the text, press Enter. Image attachments are written to
  `<AH_STATE_DIR>/uploads/` and their (translated) paths are appended to the text. Mark the
  session processing; the tailer delivers the turn; `complete` comes from busy→idle.
- `abort(sessionId)`: send `Escape`.
- `permissions`: not used (prompts go through the detector).
Sending to a busy session is allowed (Claude queues typed input).

### 7. Terminal tab — shell websocket "attach" mode
For a session with a pane: node-pty runs `tmux new-session -t <AH_TMUX_SESSION> -s ah-v-<rand>
\; set destroy-unattached on \; select-window -t <window>` → a grouped viewer session: the viewer
sees the live window (tmux redraws on attach, no replay buffer), switching windows in one viewer
does not move other clients. Socket close kills the PTY immediately. "Plain shell" opens a new
tmux window with `$SHELL` in the project dir and attaches the same way. The 30-minute detached PTY
cache and the per-provider command builder are removed.

### 8. Sessions and projects
Kept: DB, synchronizer (scans `<CLAUDE_HOME>/projects`), sidebar. Added to session rows sent to
the client: `liveWindow` (tmux window name or null) and `busy`. Sidebar: live dot, "open in tmux"
(window with `--resume`), "close window". "New session" creates the app session row and a window
with `--session-id`. Polling watcher interval lowered to 2 s.

### 9. Removed modules
Server: codex/cursor/opencode providers, voice, taskmaster (+projects-has-taskmaster), browser-use,
scheduled-messages, agent, SDK runtime, claude-fork, `/generate-commit-message`, the
`@anthropic-ai/claude-agent-sdk`, `@openai/*`, `@octokit/rest` deps, Electron. Frontend: the matching
modules/tabs/settings, provider selector, model/effort/permission menus, voice controls, schedule
popover, edit-and-resend, fork. Plugins, MCP (Claude config), skills (Claude only), file tree, code
editor, git panel (minus AI commit message), auth, settings, i18n stay.

### 10. Branding and license
Package/bin `agentharbor`, UI name "AgentHarbor", data dir `~/.agentharbor`. README states
prominently: "AgentHarbor is a modified version of CloudCLI UI
(https://github.com/siteboon/claudecodeui)" and is not the original; no use of the
CloudCLI/Siteboon names for promotion; logos replaced. LICENSE kept, NOTICE extended with the
modification notice. Published as a public GitHub repo (with the user's go-ahead at publish time).

## Error handling

- tmux server missing → API returns 503 with a clear message; UI banner "tmux session X not found".
- Window dies mid-run (Claude exited) → runtime emits `error` + `complete`; session stays readable.
- Hook never fires within 30 s (e.g. old `cc` window) → fallback: newest jsonl in the pane cwd's
  project dir modified after the window was created.
- jsonl truncated/rewritten (offset > size) → reset offset, emit `complete` to force REST resync.

## Testing

- Unit (node:test, existing harness): prompt parser on captured fixtures; tail reader (partial
  lines, truncation); path translation; pane registry join logic.
- Integration: tmux adapter + runtime on `tmux -L ah-test` with a fake `claude` script that
  writes a jsonl, a sessions/<pid>.json, and prints a menu.
- End-to-end on this machine: real `claude.exe` in tmux `main`; drive through the websocket
  (new session → message → assistant reply rendered; permission prompt → button → resolved;
  terminal tab attach shows the same window); browser check with Playwright screenshots
  (desktop + 400 px phone width).

## Deployment (author's machine)

systemd service `agentharbor` in WSL (user vital), port 7690, Windows firewall rule
`WSL AgentHarbor 7690`, reachable on ZeroTier/LAN like ttyd; documented in TerminalShare README.

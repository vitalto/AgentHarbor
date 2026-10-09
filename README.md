<div align="center">
 <img src="public/logo.svg" alt="AgentHarbor" width="64" height="64">
 <h1>AgentHarbor</h1>
 <p><b>Web UI for your live AI CLI agents.</b><br>
 Run any number of Claude Code agents in tmux and drive them from a browser on your desktop or phone,
 without giving up the real terminal.</p>
</div>

> AgentHarbor is a modified version of CloudCLI UI (https://github.com/siteboon/claudecodeui).
> It is not the original CloudCLI UI and is not affiliated with or endorsed by Siteboon AI B.V.

---

## Why

Claude Code is at its best as an interactive TUI: slash commands, `/model`, Shift+Tab permission
modes, menus, hooks. Web front-ends usually replace that TUI with an SDK or `stream-json` process,
so the agent you chat with in the browser is not the one you can attach to from a terminal, and it
dies with the web server.

AgentHarbor keeps every agent a real, interactive Claude Code TUI living in a tmux window, and puts a
chat UI on top of it:

- the same agent is reachable from the browser **and** over ssh/mosh + `tmux attach`;
- agents survive server restarts, browser reloads and dropped mobile connections;
- nothing is emulated: what you type in the web composer is typed into the TUI.

## Features

- **Chat view of a live TUI** - markdown, code blocks, diffs, tool cards and thinking blocks, rendered
  live from the session's `.jsonl` transcript.
- **TUI menus as buttons** - permission prompts, `AskUserQuestion` questions and the folder-trust
  dialog show up as buttons in the chat.
- **Terminal tab** - attaches to the very same tmux window, for anything the chat does not cover.
- **Many agents at once** - every session is its own tmux window; the sidebar shows which agents are
  busy, waiting for input or idle.
- **File tree and editor**, **git panel** (stage, commit, branches, worktrees), MCP server and skills
  management, plugins.
- **Responsive / PWA** - usable from a phone; the chat composer, menus and terminal all work on a
  small touch screen.
- **Login required** - single-user account stored in a local SQLite database.

Model, effort and permission mode are not separate pickers: use the TUI itself (`/model`,
Shift+Tab), from the chat composer or the terminal tab.

## How it works

- The server launches agents as `claude --settings <AH_STATE_DIR>/hook-settings.json ...` in new
  windows of a tmux session (default `main`). A `SessionStart` hook from that settings file records
  which tmux pane runs which Claude session.
- Messages from the web are typed into the pane (`tmux send-keys`); menus are parsed from the pane
  and answered the same way.
- The chat is rendered from the session transcript (`<CLAUDE_CONFIG_DIR>/projects/**/<session>.jsonl`),
  which is polled (inotify does not work on `/mnt/c`).
- Claude's own status files (`<CLAUDE_CONFIG_DIR>/sessions/<pid>.json`: busy / waiting / idle) drive
  the activity indicators.
- The server never runs Claude in SDK or `stream-json` mode.

## Requirements

- Linux, or Windows via WSL 2
- tmux >= 3.3
- Node.js 22
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI, logged in

## Install and run

```bash
git clone https://github.com/vitalto/AgentHarbor.git
cd AgentHarbor
npm ci
npm run build
npm run server        # serves the built UI and API on http://<HOST>:3001
```

Open the URL, create the account on first visit, pick a project folder and start an agent.
Make sure the tmux session exists (`tmux new -d -s main`) before starting agents.

For development with hot reload: `npm run dev` (Vite on port 5173 plus the API server).

The package also exposes an `agentharbor` command (`agentharbor status`, `agentharbor --port 8080`,
`agentharbor help`) when installed with `npm link` or `npm install -g .`.

### Configuration

Set variables in the environment or in a `.env` file in the repository root (see `.env.example`).

| Variable | Default | Meaning |
|---|---|---|
| `AH_TMUX_SESSION` | `main` | tmux session whose windows hold the agents |
| `AH_CLAUDE_CMD` | `claude` | Claude Code command. A path ending in `.exe` means the Windows `claude.exe` via WSL interop and turns on Windows <-> WSL path translation |
| `AH_CLAUDE_ARGS` | *(empty)* | Extra flags for every launch, e.g. `--permission-mode default` |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code's config directory (projects, sessions) |
| `AH_STATE_DIR` | `~/.agentharbor` | AgentHarbor state (hook settings, pane registry). Must be writable by the Claude process |
| `SERVER_PORT` | `3001` | HTTP / WebSocket port |
| `HOST` | `0.0.0.0` | Address to bind to |
| `DATABASE_PATH` | `~/.agentharbor/auth.db` | SQLite database with the login account and app settings |

### Windows + WSL

You can drive **Claude Code for Windows** from tmux in WSL, so the agents work on Windows paths with
Windows tooling while AgentHarbor and tmux run in WSL:

```bash
AH_CLAUDE_CMD=/mnt/c/Users/<you>/.local/bin/claude.exe
CLAUDE_CONFIG_DIR=/mnt/c/Users/<you>/.claude
AH_STATE_DIR=/mnt/c/Users/<you>/.agentharbor
```

- `AH_STATE_DIR` must live on `/mnt/c` so the Windows Claude process can read the hook settings and
  write the pane registry.
- Start the tmux server from a **long-lived** WSL session (for example a systemd user service or a
  terminal you keep open). Windows binaries launched through WSL interop die together with the
  `wsl.exe` process that started them, so a tmux server spawned from a short-lived `wsl.exe -e ...`
  call takes its Claude agents down when that call returns.

## Security

- There is no TLS built in. Bind `HOST` to a LAN or VPN address (or `127.0.0.1` behind a reverse proxy
  with TLS); do not expose the port to the internet.
- A login is required for the UI, the API and the WebSocket. Anyone who logs in controls your agents
  and, through them and the terminal tab, your shell account.

## What is different from CloudCLI UI

AgentHarbor started from CloudCLI UI and keeps its chat rendering, file tree, git panel, settings
and plugin system. It replaces the SDK-based Claude runtime with the tmux/TUI runtime described above
and removes: the Codex, Cursor, OpenCode and Gemini providers, voice input, TaskMaster / PRD editor,
browser use, scheduled messages, `/api/agent`, the Electron desktop app, the Docker sandbox, edit and
resend, fork, the model / effort / permission pickers and AI commit messages.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports and pull requests:
https://github.com/vitalto/AgentHarbor/issues

## License

GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later), see [LICENSE](LICENSE) for the
full text, including the additional terms under Section 7, and [NOTICE](NOTICE).

AgentHarbor is a modified version of CloudCLI UI (https://github.com/siteboon/claudecodeui),
copyright Siteboon AI B.V. and contributors. Modifications copyright 2026 vitalto.
If you run a modified version as a network service, you must offer its source code to its users.

# AgentHarbor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the CloudCLI UI fork into AgentHarbor: a web UI that drives live Claude Code TUIs in tmux windows instead of SDK runs, with all non-Claude/unneeded modules removed.

**Architecture:** A tmux layer (adapter, pane registry fed by a SessionStart hook, transcript tailer, TUI prompt detector) sits behind the existing `IProviderRuntime` interface as `claude-tmux.runtime.ts`. A per-session monitor turns busy periods (from `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json`) into chat runs and feeds tailed jsonl rows through the existing normalizer, so the existing frontend store/render path works unchanged. The shell websocket attaches grouped tmux viewer sessions.

**Tech Stack:** Node 22 (Linux/WSL), TypeScript server (tsx, node:test), React/Vite frontend (vitest), tmux ≥ 3.3, better-sqlite3, node-pty.

**Spec:** `docs/superpowers/specs/2026-10-09-agentharbor-design.md`

## Global Constraints

- Claude is never started by the server in SDK/stream-json/`-p` mode; only as an interactive TUI inside a tmux window.
- Env: `AH_TMUX_SESSION` (default `main`), `AH_CLAUDE_CMD` (default `claude`), `CLAUDE_CONFIG_DIR` (default `~/.claude`), `AH_STATE_DIR` (default `~/.agentharbor`), `PORT` (default `3001`).
- Windows-path translation only when `AH_CLAUDE_CMD` ends with `.exe`; all of it in `server/shared/path-translation.ts`.
- Branding: package/bin `agentharbor`, UI "AgentHarbor"; README carries "AgentHarbor is a modified version of CloudCLI UI (https://github.com/siteboon/claudecodeui)"; no "CloudCLI"/"Siteboon" in product name, logos or promotion. LICENSE (AGPL-3.0) kept; NOTICE extended.
- Commands run inside WSL: `export PATH=$HOME/.local/node/bin:$PATH; cd /mnt/d/Develop/AgentHarbor`.
- Server tests: `npm test` (node:test via tsx). Client tests: `npm run test:client`. Types: `npm run typecheck`. Lint: `npm run lint`.

## Review Focus

1. Agent window opened from the phone with old `cc` (no hook) → web shows the session read-only and "open in tmux" re-launch works; nothing crashes. Test: registry fallback by newest jsonl in cwd (Task 3).
2. User types in the TUI directly (phone/terminal tab) while web chat is open → web chat updates live without a send from the web. Test: monitor starts a run on busy without a prior `chat.send` (Task 6).
3. Multi-line message with quotes, `$`, backticks, unicode → arrives verbatim in the TUI as one prompt. Test: tmux adapter paste round-trip on `tmux -L ah-test` (Task 2).
4. jsonl line split across two polls / file rewritten shorter → no lost or duplicated rows. Test: tailer partial-line + truncation cases (Task 4).
5. Claude exits / window killed mid-turn → run completes with an error, session not stuck "processing". Test: monitor completes run when pane disappears (Task 6).

---

### Task 0: Baseline build in WSL

**Files:** none (verification only)

- [ ] Step 1: `npm ci` in WSL; `npm run typecheck && npm test && npm run test:client && npm run build`. Record failures that exist upstream (do not fix unrelated ones; note them in the commit message of Task 1).

### Task 1: Remove other providers and unneeded modules

**Files (delete):** `server/modules/providers/list/{codex,cursor,opencode}/`, `server/modules/{voice,taskmaster,browser-use,scheduled-messages,agent}/`, `server/modules/projects/services/projects-has-taskmaster.service.ts`, `electron/`, `src/modules/{task-master,prd-editor,browser-use}/`, voice files listed in spec §9, scheduled-message composer files, `src/shared/ui/{Codex,Cursor,OpenCode}Logo.tsx`, `scripts/release/{prepare-desktop-app,build-server-bundle}.js`, `.github/workflows/desktop-*.yml`.
**Modify:** `server/index.ts` (imports/routes/startup listed in the architecture map §7), `provider.registry.ts`, `sessions-watcher.service.ts`, `session-synchronizer.service.ts`, `provider-token-usage.service.ts`, `session-conversations-search.service.ts`, `provider-capabilities.service.ts`, `sessions.service.ts`, `provider.routes.ts`, `shell-websocket.service.ts`, `database/schema.ts` (provider CHECK → `('claude')` via migration that leaves old rows readable), `server/shared/types.ts` (`LLMProvider = 'claude'`), `server/shared/utils.ts`, `git.routes.ts` + `git.module.ts` (drop `/generate-commit-message`), frontend import sites from map §7, `package.json` (scripts, `build` block, deps: `@openai/codex`, `@openai/codex-sdk`, `@iarna/toml`, `@octokit/rest`, `electron*`).

- [ ] Step 1: Delete directories; fix every import site until `npm run typecheck` passes.
- [ ] Step 2: Delete tests that only cover removed modules; `npm test && npm run test:client` green (except baseline failures).
- [ ] Step 3: `npm run build` succeeds. Commit `refactor: remove non-Claude providers, voice, taskmaster, browser-use, scheduled messages, agent API, desktop app`.

### Task 2: Path translation + tmux adapter

**Files:** Create `server/shared/path-translation.ts`, `server/modules/tmux/tmux.service.ts`, `server/modules/tmux/agent-config.ts`; Test `server/modules/tmux/tests/tmux.service.test.ts`, `server/shared/tests/path-translation.test.ts`.

**Interfaces (produces):**
```ts
// agent-config.ts
export type AgentConfig = { tmuxSession: string; claudeCommand: string; claudeHome: string; stateDir: string; windowsClaude: boolean };
export function readAgentConfig(env?: NodeJS.ProcessEnv): AgentConfig;
// path-translation.ts
export function toLocalPath(p: string): string;   // 'D:\\a\\b' -> '/mnt/d/a/b' when windowsClaude, else identity
export function toClaudePath(p: string): string;  // '/mnt/d/a' -> 'D:\\a'; '/home/x' -> '\\\\wsl.localhost\\<distro>\\home\\x'
// tmux.service.ts
export type AgentPane = { windowId: string; windowName: string; paneId: string; panePid: number; cwd: string; dead: boolean };
export function createTmuxService(opts?: { socketName?: string; session?: string }): {
  hasSession(): Promise<boolean>;
  listPanes(): Promise<AgentPane[]>;
  newWindow(input: { cwd: string; name: string; command: string; env: Record<string,string> }): Promise<AgentPane>;
  killWindow(windowId: string): Promise<void>;
  pasteText(paneId: string, text: string): Promise<void>;   // load-buffer from stdin + paste-buffer -p -d
  sendKeys(paneId: string, keys: string[]): Promise<void>;   // tmux key names: Enter, Escape, Up, BTab, C-c, '1'
  capturePane(paneId: string): Promise<string[]>;            // visible screen lines, trailing spaces trimmed
};
```
- [ ] Step 1: Tests: path translation table (drive letters, UNC, already-linux, mixed slashes); tmux tests start `tmux -L ah-test-<pid> new -d -s t`, run `newWindow` with `cat` as command, `pasteText` a string containing `"quotes" $HOME \`tick\` юникод\nline2`, `sendKeys(['Enter'])`, `capturePane` contains both lines verbatim; `listPanes` shows the window; `killWindow` removes it; teardown kills the server.
- [ ] Step 2: Implement with `execFile('tmux', ['-L', socket, ...])` (no shell), env passed via `new-window -e KEY=VAL`. Pane ids `%N`.
- [ ] Step 3: Tests green. Commit `feat(tmux): tmux adapter and path translation`.

### Task 3: Hook settings + pane registry

**Files:** Create `server/modules/tmux/pane-registry.service.ts`, `server/modules/tmux/hook-settings.ts`; Test `server/modules/tmux/tests/pane-registry.test.ts`.

**Interfaces:**
```ts
export function writeHookSettings(config: AgentConfig): string;   // writes <stateDir>/hook-settings.json, returns path as Claude sees it
export function buildAgentLaunch(config: AgentConfig, input: { resumeSessionId?: string; newSessionId?: string }): { command: string; env: Record<string,string> };
export type PaneSession = { pane: AgentPane; providerSessionId: string | null; transcriptPath: string | null; cwd: string };
export function createPaneRegistry(deps: { tmux: ReturnType<typeof createTmuxService>; config: AgentConfig }): {
  refresh(): Promise<PaneSession[]>;                  // join tmux panes with <stateDir>/panes/<n>.json; delete files of dead panes
  findPaneForSession(providerSessionId: string): Promise<PaneSession | null>;
  waitForSession(paneId: string, timeoutMs: number): Promise<PaneSession>;
};
```
Hook command (POSIX sh, works in Git Bash and Linux): `if [ -n "$AH_PANE" ]; then mkdir -p "$AH_STATE_DIR/panes" && cat > "$AH_STATE_DIR/panes/$AH_PANE.json"; else cat > /dev/null; fi`.
Launch command: `AH_PANE=${TMUX_PANE#%} <claudeCommand> --settings '<claudePath(hook)>' [--resume <id>|--session-id <id>]` with env `AH_STATE_DIR` (+ `WSLENV=AH_PANE:AH_STATE_DIR/p` when windowsClaude).
Fallback when a pane has no file: newest `*.jsonl` in `<claudeHome>/projects/<encode(cwd)>/` with mtime ≥ pane start; `encode = p.replace(/[^a-zA-Z0-9-]/g,'-')` applied to the Claude-side cwd.
- [ ] Step 1: Tests with a temp stateDir and a fake tmux object: file present → mapped (transcript path translated); dead pane → file deleted; no file → fallback picks newest jsonl; `buildAgentLaunch` output for both config modes (snapshot of strings).
- [ ] Step 2: Implement. Step 3: green, commit `feat(tmux): pane registry fed by SessionStart hook`.

### Task 4: Transcript tailer

**Files:** Create `server/modules/tmux/transcript-tail.ts`; Test `server/modules/tmux/tests/transcript-tail.test.ts`.
```ts
export function createTranscriptTail(filePath: string, startOffset?: number): {
  poll(): Promise<{ rows: unknown[]; reset: boolean }>;  // new complete JSON rows since last poll; reset=true if file shrank
  offset(): number;
};
```
- [ ] Step 1: Tests: append 2 rows → 2 rows; append half a row → 0 rows, then rest → 1 row; malformed line skipped; truncate file → `reset:true` and offset 0; start at end-of-file by default (`startOffset = size`).
- [ ] Step 2: Implement with `fs.open` + `read` from offset (no full-file reads). Step 3: green, commit.

### Task 5: TUI prompt parser

**Files:** Create `server/modules/tmux/tui-prompt.ts`, fixtures `server/modules/tmux/tests/fixtures/*.txt` (captured from real claude.exe: Bash permission prompt, Edit permission prompt, AskUserQuestion, plan approval, idle input box, busy spinner); Test `server/modules/tmux/tests/tui-prompt.test.ts`.
```ts
export type TuiPrompt = { question: string; options: Array<{ key: string; label: string; selected: boolean }> };
export function parseTuiPrompt(lines: string[]): TuiPrompt | null;
export function isInputReady(lines: string[]): boolean;   // input box visible, no menu
```
- [ ] Step 1: Capture fixtures with `tmux capture-pane -p` from a real session (temporary window in `main`, `--permission-mode default`, ask it to run `ls`). Tests: each prompt fixture → expected question + options; idle → null + `isInputReady` true; spinner → null + false.
- [ ] Step 2: Implement: scan bottom-up for ≥2 consecutive lines matching `/^\s*(❯\s*)?(\d+)\.\s+(.+)$/`; question = nearest non-empty line above the block not matching it. Step 3: green, commit.

### Task 6: Session monitor + tmux runtime

**Files:** Create `server/modules/providers/list/claude/claude-tmux.runtime.ts`, `server/modules/tmux/session-monitor.service.ts`; Modify `claude.provider.ts`, `claude-cli-liveness.service.ts` (honor `CLAUDE_CONFIG_DIR`; skip pid probe when `pidDomain` starts with `win32:`; expose `readClaudeCliStatuses(): Promise<Map<providerSessionId, 'busy'|'idle'>>`), `claude-sessions.provider.ts` (drop SDK import), `chat-websocket.service.ts` (add `chat.tui-keys`; subscribe registers the socket with the monitor), delete `claude-runtime.provider.js`, `claude-fork.provider.ts`, SDK dep. Test `server/modules/tmux/tests/session-monitor.test.ts`.

**Interfaces:**
```ts
export const sessionMonitor: {
  watch(appSessionId: string, ws: RealtimeClientConnection): void;  // from chat.subscribe
  unwatchSocket(ws): void;                                         // on socket close
  ensurePane(appSessionId: string): Promise<PaneSession>;          // open window if missing (resume / session-id)
  waitForTurnEnd(appSessionId: string, signal: AbortSignal): Promise<{ exitCode: number }>;
  sendKeys(appSessionId: string, keys: string[]): Promise<void>;
};
```
Loop per watched session (750 ms): refresh status; tail transcript → `normalizeMessage` → if a chat run exists `run.writer.send(msg)` else broadcast to watchers; busy && no run → `chatRunRegistry.startRun({connection:null})` + attach watchers; idle (or pane gone) && run → `completeRun` (exitCode 1 + `error` frame if pane gone); while busy capture pane every 1 s → emit `tui_prompt` / `tui_prompt_cleared` on change and `tui_screen` (last 12 non-empty lines) throttled.
Runtime: `run()` = `ensurePane` → wait `isInputReady` (30 s) → `pasteText` (+ attachment paths) → `sendKeys(['Enter'])` → `waitForTurnEnd` (if no busy within 20 s → complete). `abort()` → `sendKeys(['Escape'])`. New session: provider session id = `randomUUID()` assigned to the DB row before launch (`--session-id`).
- [ ] Step 1: Tests with fake tmux/registry/status/tail: busy without send starts a run and forwards rows; idle completes; pane disappears → error+complete; `run()` pastes text then Enter after input-ready.
- [ ] Step 2: Implement; Step 3: `npm test` green; typecheck; commit `feat: drive Claude TUI in tmux instead of the SDK`.

### Task 7: Shell websocket attach mode

**Files:** Modify `shell-websocket.service.ts` (replace `buildShellCommand` and PTY cache), `src/modules/shell/hooks/useShellConnection.ts` (send `{type:'init', sessionId|projectPath, mode:'attach'|'shell'}`); Test update `shell-websocket.service.test.ts`.
Attach: `pty.spawn('tmux', ['new-session','-t',session,'-s',`ah-v-${rand}`,';','set','destroy-unattached','on',';','select-window','-t',windowId])`. Shell mode: tmux `new-window` with `$SHELL` in `toLocalPath(projectPath)`, then attach as above. Close socket → `pty.kill()`.
- [ ] Step 1: Test: init for a session with pane spawns the tmux args above (pty spawn mocked); unknown session → error frame. Step 2: implement; Step 3: green; manual check via browser in Task 10. Commit.

### Task 8: Frontend — chat composer, prompts, live screen, sidebar

**Files:** Modify `ChatComposer.tsx` (remove model/effort/permission menus, schedule, voice), `useChatComposerState.ts` (no edit-send, keep send/abort), `useChatRealtimeHandlers.ts` (handle `tui_prompt`, `tui_prompt_cleared`, `tui_screen`), Create `src/modules/chat/composer/TuiPromptPanel.tsx`, `src/modules/chat/composer/TuiKeyBar.tsx`, `src/modules/chat/transcript/LiveScreen.tsx`; sidebar session item: live dot + "Open in tmux"/"Close window" (server routes `POST /api/providers/sessions/:id/window`, `DELETE …/window`); remove provider selection empty state (always claude). Tests: vitest for `TuiPromptPanel` (renders options, click sends `chat.tui-keys` with key), realtime handler reducer for the three kinds.
- [ ] Steps: tests → implement → `npm run test:client` + typecheck green → commit `feat(ui): TUI prompt buttons, key bar, live screen`.

### Task 9: Branding, README, NOTICE, package

**Files:** `package.json` (name `agentharbor`, bin `agentharbor`, homepage/repo to the new GitHub repo, version `0.1.0`), `server/load-env.ts` (DB under `~/.agentharbor`), `index.html` title, `public/` logos/manifest, i18n strings containing "CloudCLI", `README.md` (rewritten: what/why, requirements, setup on Linux and on Windows+WSL, env table, attribution line), `NOTICE` (append modification notice), `server/modules/cli/cli.ts` name.
- [ ] `grep -ri cloudcli src server public index.html` returns only attribution/notice lines. Build passes. Commit.

### Task 10: End-to-end on this machine + deployment

- [ ] Build in WSL; run with `AH_CLAUDE_CMD=/mnt/c/Users/<you>/.local/bin/claude.exe CLAUDE_CONFIG_DIR=/mnt/c/Users/<you>/.claude AH_STATE_DIR=/mnt/c/Users/<you>/.agentharbor PORT=7690`.
- [ ] E2E script (`scripts/e2e/tmux-e2e.mjs`): login → create session in a Windows project folder → `chat.send` "Reply with exactly PONG" → receive assistant text `PONG` and `complete`; send "run `ls` with Bash" in default permission mode → receive `tui_prompt` → send key `1` → tool_result arrives; type into the tmux pane directly → web receives frames without send.
- [ ] Playwright screenshots desktop + 400 px; fix visual breakage.
- [ ] systemd unit `agentharbor.service`, a firewall rule for port 7690, deployment notes.
- [ ] Create GitHub repo `AgentHarbor` (public) and push — after the user confirms publishing.

#!/usr/bin/env node
// End-to-end check against a running AgentHarbor server and a real Claude CLI in tmux.
//
//   AH_URL=http://127.0.0.1:7691 AH_E2E_PROJECT=/path/to/scratch/project node scripts/e2e/tmux-e2e.mjs
//
// The server must run with AH_CLAUDE_ARGS="--permission-mode default" so the Bash step asks for permission.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const baseUrl = process.env.AH_URL ?? 'http://127.0.0.1:7691';
const projectPath = process.env.AH_E2E_PROJECT;
const username = process.env.AH_E2E_USER ?? 'e2e';
const password = process.env.AH_E2E_PASSWORD ?? 'e2e-password-1';
const tmuxSession = process.env.AH_TMUX_SESSION ?? 'main';

if (!projectPath) {
  console.error('AH_E2E_PROJECT is required');
  process.exit(2);
}
mkdirSync(projectPath, { recursive: true });

const step = (name) => console.log(`\n=== ${name}`);
const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
};

async function api(method, path, token, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function authenticate() {
  try {
    return (await api('POST', '/api/auth/register', null, { username, password })).token;
  } catch {
    return (await api('POST', '/api/auth/login', null, { username, password })).token;
  }
}

function connect(token) {
  const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`);
  const frames = [];
  const waiters = [];
  socket.addEventListener('message', (event) => {
    const frame = JSON.parse(String(event.data));
    frames.push(frame);
    const summary = frame.kind === 'tui_screen' ? `${frame.lines?.length ?? 0} lines` : (frame.content ?? frame.prompt?.question ?? frame.error ?? '');
    console.log(`  <- ${frame.kind}${frame.role ? `/${frame.role}` : ''} ${String(summary).replace(/\s+/g, ' ').slice(0, 100)}`);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(frame)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
    }
  });
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const waitFor = (predicate, timeoutMs, label) => new Promise((resolve, reject) => {
    const earlier = frames.find(predicate);
    if (earlier) {
      resolve(earlier);
      return;
    }
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
    waiters.push({ predicate, resolve: (frame) => { clearTimeout(timer); resolve(frame); } });
  });
  const send = (payload) => socket.send(JSON.stringify(payload));
  return { socket, frames, opened, waitFor, send, clear: () => frames.splice(0) };
}

/** Answers menus that block the turn (folder trust) by picking the option whose label matches. */
function autoAnswer(connection, sessionId, labelPattern) {
  connection.socket.addEventListener('message', (event) => {
    const frame = JSON.parse(String(event.data));
    if (frame.kind !== 'tui_prompt' || frame.sessionId !== sessionId) {
      return;
    }
    const index = frame.prompt.options.findIndex((option) => labelPattern.test(option.label));
    if (index >= 0) {
      console.log(`  -> answering "${frame.prompt.options[index].label}"`);
      connection.send({ type: 'chat.tui-keys', sessionId, optionIndex: index });
    }
  });
}

const assistantText = (frames) => frames
  .filter((frame) => frame.kind === 'text' && frame.role === 'assistant')
  .map((frame) => frame.content)
  .join('\n');

step('authenticate');
const token = await authenticate();

step('create session');
const created = await api('POST', '/api/providers/sessions', token, { provider: 'claude', projectPath, initialMessage: 'e2e' });
const sessionId = created.data?.sessionId ?? created.sessionId;
if (!sessionId) fail(`no session id in ${JSON.stringify(created)}`);
console.log(`  session ${sessionId}`);

const chat = connect(token);
await chat.opened;
autoAnswer(chat, sessionId, /trust this folder/i);
chat.send({ type: 'chat.subscribe', sessions: [{ sessionId, lastSeq: 0 }] });

step('web message reaches the TUI and the reply streams back');
chat.send({ type: 'chat.send', sessionId, content: 'Reply with exactly the word PONG and nothing else.', options: {} });
await chat.waitFor((frame) => frame.kind === 'complete' && frame.sessionId === sessionId, 180_000, 'complete of turn 1');
if (!/PONG/.test(assistantText(chat.frames))) fail('assistant reply PONG not received');
console.log('  OK: PONG');

step('permission prompt is surfaced and answered from the web');
chat.clear();
chat.send({
  type: 'chat.send',
  sessionId,
  content: 'Run exactly this shell command with the Bash tool: mkdir e2e-made-dir && echo created',
  options: {},
});
const promptFrame = await chat.waitFor(
  (frame) => frame.kind === 'tui_prompt' && /proceed/i.test(frame.prompt?.question ?? ''),
  180_000,
  'Bash permission prompt',
);
const yesIndex = promptFrame.prompt.options.findIndex((option) => option.label === 'Yes');
chat.send({ type: 'chat.tui-keys', sessionId, optionIndex: yesIndex });
await chat.waitFor((frame) => frame.kind === 'tui_prompt_cleared', 30_000, 'prompt cleared');
await chat.waitFor((frame) => frame.kind === 'complete', 180_000, 'complete of turn 2');
if (!chat.frames.some((frame) => frame.kind === 'tool_result' || frame.toolResult)) fail('no tool result after approving');
console.log('  OK: approved via web, tool ran');

step('typing straight into tmux shows up in the web chat');
chat.clear();
const windows = await api('GET', '/api/providers/agents/windows', token);
const agentWindow = (windows.data ?? []).find((entry) => entry.sessionId === sessionId);
if (!agentWindow) fail(`session window not listed: ${JSON.stringify(windows)}`);
const paneTarget = `${tmuxSession}:${agentWindow.windowName}`;
execFileSync('tmux', ['send-keys', '-t', paneTarget, '-l', 'Reply with exactly the word TERMINAL and nothing else.']);
execFileSync('tmux', ['send-keys', '-t', paneTarget, 'Enter']);
await chat.waitFor((frame) => frame.kind === 'text' && frame.role === 'assistant' && /TERMINAL/.test(frame.content ?? ''), 180_000, 'TERMINAL reply');
await chat.waitFor((frame) => frame.kind === 'complete', 60_000, 'complete of terminal turn');
console.log('  OK: terminal-typed turn mirrored');

step('close window');
await api('DELETE', `/api/providers/sessions/${sessionId}/window`, token);
chat.socket.close();
console.log('\nALL E2E CHECKS PASSED');
process.exit(0);

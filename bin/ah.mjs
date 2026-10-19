#!/usr/bin/env node
// `ah`: lets an agent (or you) drive other AgentHarbor sessions from a shell.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const HELP = `Usage: ah <command> [options]

  projects                         Registered projects
  ls [--project P] [--recent N]    Live agent windows (or the N most recent conversations)
  new [--project P] [text]         Start a session (project defaults to the current directory)
  send <session> [text]            Send a message; a busy session queues it
  read <session> [--last N]        Last N messages (default 10)
  usage [session]                  Context use (default: the calling Claude session)
  models                           Models and effort levels for --model / --effort

new and send take --model M --effort E (applied when the session starts its turn;
a busy session keeps its model for a queued message). Without [text] the message is
read from stdin.

Config: ~/.agentharbor/cli.json {"url": "http://localhost:3001", "apiKey": "ck_..."}
(create the key in Settings -> API keys); AH_URL / AH_API_KEY override it.`;

function loadConfig() {
  let fileConfig = {};
  try {
    fileConfig = JSON.parse(readFileSync(path.join(os.homedir(), '.agentharbor', 'cli.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
  const url = (process.env.AH_URL || fileConfig.url || 'http://localhost:3001').replace(/\/+$/, '');
  const apiKey = process.env.AH_API_KEY || fileConfig.apiKey;
  if (!apiKey) {
    fail('No API key: create one in Settings -> API keys and put it in ~/.agentharbor/cli.json as "apiKey".');
  }
  return { url, apiKey };
}

function fail(message) {
  console.error(`ah: ${message}`);
  process.exit(1);
}

async function api(config, method, route, body) {
  const response = await fetch(`${config.url}/api${route}`, {
    method,
    headers: { Authorization: `Bearer ${config.apiKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    fail(`${method} ${route}: ${payload?.error?.message ?? payload?.error ?? response.statusText}`);
  }
  return payload?.success === true && 'data' in payload ? payload.data : payload;
}

/** One spelling for `D:\x`, `D:/x`, `/d/x` (Git Bash) and `/mnt/d/x` (WSL). */
function pathKey(rawPath) {
  return rawPath
    .replace(/\\/g, '/')
    .replace(/^\/mnt\/([a-z])\//i, '$1:/')
    .replace(/^\/([a-z])\//i, '$1:/')
    .replace(/^([a-z]):/i, (_match, drive) => `${drive.toLowerCase()}:`)
    .replace(/\/+$/, '');
}

async function findProject(config, nameOrPath) {
  const projects = await api(config, 'GET', '/projects');
  const wanted = nameOrPath ?? process.cwd();
  const project = projects.find((candidate) => pathKey(candidate.fullPath) === pathKey(wanted))
    ?? projects.find((candidate) => candidate.displayName.toLowerCase() === wanted.toLowerCase());
  if (!project) {
    fail(`No project "${wanted}". Known: ${projects.map((candidate) => candidate.displayName).join(', ')}`);
  }
  return project;
}

async function readMessageText(positionals) {
  const text = positionals.join(' ').trim() || (process.stdin.isTTY ? '' : (await readStdin()).trim());
  if (!text) {
    fail('Empty message: pass it as an argument or on stdin.');
  }
  return text;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function findOwnSessionId(config) {
  const providerSessionId = process.env.CLAUDE_CODE_SESSION_ID;
  if (!providerSessionId) {
    fail('Name a session: this shell is not inside a Claude session.');
  }
  const windows = await api(config, 'GET', '/providers/agents/windows');
  const own = windows.find((window) => window.providerSessionId === providerSessionId);
  if (!own) {
    fail(`This Claude session (${providerSessionId}) is not an AgentHarbor session.`);
  }
  return own.sessionId;
}

function sendBody(content, values) {
  return { content, model: values.model, effort: values.effort };
}

const commands = {
  async projects(config) {
    for (const project of await api(config, 'GET', '/projects')) {
      console.log(`${project.displayName}\t${project.fullPath}`);
    }
  },

  async ls(config, { values }) {
    const projectKey = values.project ? pathKey((await findProject(config, values.project)).fullPath) : null;
    if (values.recent) {
      const { conversations } = await api(config, 'GET', `/providers/sessions/recent?limit=${Number(values.recent)}`);
      for (const conversation of conversations) {
        console.log(`${conversation.sessionId}  ${conversation.lastActivity}  [${conversation.projectDisplayName}] ${conversation.sessionTitle}`);
      }
      return;
    }
    for (const window of await api(config, 'GET', '/providers/agents/windows')) {
      if (!projectKey || pathKey(window.projectPath) === projectKey) {
        console.log(`${window.sessionId}  ${window.activity.padEnd(7)} [${path.basename(window.projectPath)}] ${window.title ?? ''}`);
      }
    }
  },

  async new(config, { values, positionals }) {
    const project = await findProject(config, values.project);
    const content = await readMessageText(positionals);
    const { sessionId } = await api(config, 'POST', '/providers/sessions', {
      provider: 'claude',
      projectPath: project.fullPath,
      initialMessage: content,
    });
    const { delivery } = await api(config, 'POST', `/chat/sessions/${sessionId}/messages`, sendBody(content, values));
    console.log(`${sessionId} ${delivery} in ${project.displayName}`);
  },

  async send(config, { values, positionals: [sessionId, ...words] }) {
    if (!sessionId) {
      fail('Usage: ah send <session> [text]');
    }
    const { delivery } = await api(config, 'POST', `/chat/sessions/${sessionId}/messages`, sendBody(await readMessageText(words), values));
    console.log(delivery);
  },

  async read(config, { values, positionals: [sessionId] }) {
    if (!sessionId) {
      fail('Usage: ah read <session> [--last N]');
    }
    const last = Number(values.last ?? 10);
    // Tool rows outnumber text many times over; fetch enough to find the last N texts.
    const { messages } = await api(config, 'GET', `/providers/sessions/${sessionId}/messages?limit=${last * 20}`);
    const textIndexes = messages.flatMap((message, index) => (message.kind === 'text' ? [index] : []));
    const firstShown = textIndexes.at(-last) ?? textIndexes[0] ?? messages.length;
    for (const message of messages.slice(firstShown)) {
      if (message.kind === 'text') {
        console.log(`\n## ${message.role}${message.model ? ` (${message.model})` : ''} ${message.timestamp}\n${message.content}`);
      } else if (message.kind === 'tool_use') {
        console.log(`  · ${message.toolName}: ${message.toolInput?.description ?? ''}`);
      }
    }
  },

  async usage(config, { positionals: [sessionId] }) {
    const id = sessionId ?? (await findOwnSessionId(config));
    const usage = await api(config, 'GET', `/providers/sessions/${id}/token-usage`);
    const percent = Math.round((usage.used / usage.total) * 100);
    console.log(`session ${id}: context ${usage.used} of ${usage.total} tokens (${percent}%)`);
  },

  async models(config) {
    const { models } = await api(config, 'GET', '/providers/claude/models');
    for (const model of models.OPTIONS) {
      const efforts = model.effort?.values.map((effort) => effort.value).join('/') ?? '-';
      console.log(`${model.value.padEnd(14)} effort ${efforts}  ${model.label}`);
    }
  },
};

const [command, ...rest] = process.argv.slice(2);
if (!command || command === 'help' || command === '--help' || !commands[command]) {
  console.log(HELP);
  process.exit(command && command !== 'help' && command !== '--help' ? 1 : 0);
}
const parsed = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    project: { type: 'string', short: 'p' },
    model: { type: 'string' },
    effort: { type: 'string' },
    last: { type: 'string' },
    recent: { type: 'string' },
  },
});
await commands[command](loadConfig(), parsed);

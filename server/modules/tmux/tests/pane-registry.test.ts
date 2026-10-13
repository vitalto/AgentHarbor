import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { AgentConfig } from '@/modules/tmux/agent-config.js';
import { buildAgentLaunch, writeHookSettings } from '@/modules/tmux/agent-launch.js';
import { createPaneRegistry } from '@/modules/tmux/pane-registry.service.js';
import type { AgentPane, TmuxService } from '@/modules/tmux/tmux.service.js';

function pane(overrides: Partial<AgentPane>): AgentPane {
  return {
    windowId: '@1', windowName: 'proj', paneId: '%3', panePid: 100, cwd: '/mnt/d/Develop/proj',
    dead: false, command: 'claude.exe', currentCommand: 'init', ...overrides,
  };
}

async function setup(panes: AgentPane[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ah-registry-'));
  const config: AgentConfig = {
    tmuxSession: 'main',
    claudeCommand: '/mnt/c/claude.exe',
    claudeArgs: '',
    idleCloseMinutes: 60,
    attachmentRetentionDays: 7,
    claudeHome: path.join(root, 'claude'),
    stateDir: path.join(root, 'state'),
    windowsClaude: true,
    wslDistro: 'Ubuntu',
  };
  await mkdir(path.join(config.stateDir, 'panes'), { recursive: true });
  const tmux = { listPanes: async () => panes } as unknown as TmuxService;
  const registry = createPaneRegistry({ tmux, config: () => config });
  return { root, config, registry, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('hook file maps a pane to its session and translates paths', async (t) => {
  const { config, registry, cleanup } = await setup([pane({})]);
  t.after(cleanup);
  await writeFile(path.join(config.stateDir, 'panes', '3-100.json'), JSON.stringify({
    session_id: 'abc',
    transcript_path: 'C:\\Users\\u\\.claude\\projects\\D--Develop-proj\\abc.jsonl',
    cwd: 'D:\\Develop\\proj',
  }));

  const [session] = await registry.refresh();
  assert.equal(session.providerSessionId, 'abc');
  assert.equal(session.transcriptPath, '/mnt/c/Users/u/.claude/projects/D--Develop-proj/abc.jsonl');
  assert.equal(session.cwd, '/mnt/d/Develop/proj');
  assert.equal(session.registered, true);
  assert.equal((await registry.findPaneForSession('abc'))?.pane.paneId, '%3');
});

test('files of panes that no longer exist (or reused numbers) are removed', async (t) => {
  const { config, registry, cleanup } = await setup([pane({})]);
  t.after(cleanup);
  await writeFile(path.join(config.stateDir, 'panes', '3-99.json'), JSON.stringify({ session_id: 'old' }));
  await writeFile(path.join(config.stateDir, 'panes', '7-5.json'), JSON.stringify({ session_id: 'gone' }));

  const sessions = await registry.refresh();
  assert.notEqual(sessions[0]?.providerSessionId, 'old');
  assert.deepEqual(await readdir(path.join(config.stateDir, 'panes')), []);
});

test('unregistered claude pane falls back to the newest transcript of its cwd', async (t) => {
  const { config, registry, cleanup } = await setup([pane({}), pane({ paneId: '%4', panePid: 7, command: 'bash' })]);
  t.after(cleanup);
  const projectDirectory = path.join(config.claudeHome, 'projects', 'D--Develop-proj');
  await mkdir(projectDirectory, { recursive: true });
  await writeFile(path.join(projectDirectory, 'older.jsonl'), '');
  await writeFile(path.join(projectDirectory, 'newer.jsonl'), '');
  const past = new Date(Date.now() - 60_000);
  await utimes(path.join(projectDirectory, 'older.jsonl'), past, past);

  const sessions = await registry.refresh();
  assert.equal(sessions.length, 1, 'plain shell panes are not agents');
  assert.equal(sessions[0].providerSessionId, 'newer');
  assert.equal(sessions[0].registered, false);
});

test('launch command registers the pane through the hook', async (t) => {
  const { config, cleanup } = await setup([]);
  t.after(cleanup);
  const settingsPath = writeHookSettings(config);
  assert.ok(settingsPath.startsWith('\\\\wsl.localhost\\Ubuntu\\') || /^[A-Z]:\\/.test(settingsPath));
  const settings = JSON.parse(await readFile(path.join(config.stateDir, 'hook-settings.json'), 'utf8'));
  assert.equal(settings.disableAgentView, true, 'agent view would move the conversation out of its window');

  const resume = buildAgentLaunch(config, { resumeSessionId: 'abc' });
  assert.match(resume.command, /^export AH_PANE="\$\{TMUX_PANE#%\}-\$\$"; exec '\/mnt\/c\/claude\.exe' --settings '.+hook-settings\.json' --resume 'abc'$/);
  assert.deepEqual(resume.env, { AH_STATE_DIR: config.stateDir, WSLENV: 'AH_PANE:AH_STATE_DIR/p' });

  const fresh = buildAgentLaunch({ ...config, windowsClaude: false, claudeCommand: 'claude' }, { newSessionId: 'n1' });
  assert.match(fresh.command, /exec 'claude' --settings '.+' --session-id 'n1'$/);
  assert.equal(fresh.env.WSLENV, undefined);
});

test('the PreToolUse hook sends UAC attempts to elevate, only once the broker is installed', async (t) => {
  const { config, cleanup } = await setup([]);
  t.after(cleanup);
  writeHookSettings(config);
  const settings = JSON.parse(await readFile(path.join(config.stateDir, 'hook-settings.json'), 'utf8'));
  const hook = settings.hooks.PreToolUse[0];
  assert.equal(hook.matcher, 'Bash|PowerShell');

  const runHook = (command: string) => spawnSync('bash', ['-c', hook.hooks[0].command], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command, description: 'sudo-free description' } }),
    env: { ...process.env, AH_STATE_DIR: config.stateDir, PROGRAMDATA: path.join(config.stateDir, 'programdata') },
    encoding: 'utf8',
  });
  const blocked = [
    `Start-Process powershell -Verb RunAs -ArgumentList '-File x.ps1'`,
    `powershell -Command "Start-Process cmd -Verb \\"runAs\\""`,
    'Start-Process pwsh -Verb:RunAs',
    'runas /user:Administrator cmd',
    'sudo netsh advfirewall show allprofiles',
  ];
  const allowed = ['ls -la', 'wsl.exe -e sudo apt install jq', 'ssh pc sudo systemctl restart ttyd', 'echo runaway', 'grep -r sudoers .'];

  for (const command of blocked) {
    assert.equal(runHook(command).status, 0, `no broker, so no block: ${command}`);
  }

  await mkdir(path.join(config.stateDir, 'programdata', 'ElevationBroker'), { recursive: true });
  await writeFile(path.join(config.stateDir, 'programdata', 'ElevationBroker', 'broker.ps1'), '# broker');
  for (const command of blocked) {
    const result = runHook(command);
    assert.equal(result.status, 2, command);
    assert.match(result.stderr, /elevate "<PowerShell command>"/);
  }
  for (const command of allowed) {
    assert.equal(runHook(command).status, 0, command);
  }
});

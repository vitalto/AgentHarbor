import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import TOML from '@iarna/toml';

import { CodexMcpProvider } from '@/modules/providers/list/codex/codex-mcp.provider.js';

test('Codex renames a server without losing native options or overwriting another entry', async () => {
  const mcp = new CodexMcpProvider();
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'ah-codex-mcp-'));
  const configPath = path.join(workspacePath, '.codex', 'config.toml');
  try {
    await fs.mkdir(path.dirname(configPath));
    await fs.writeFile(configPath, '[mcp_servers.first]\nurl="https://example.test"\nenabled=false\n[mcp_servers.other]\ncommand="example"\n');
    const input = { previousName: 'first', scope: 'project' as const, transport: 'http' as const,
      workspacePath, url: 'https://example.test', bearerTokenEnvVar: 'TOKEN', envHttpHeaders: { Authorization: 'AUTH_HEADER' } };
    await assert.rejects(mcp.upsertServer({ ...input, name: 'other' }), /already uses/);
    await mcp.upsertServer({ ...input, name: 'renamed' });
    await mcp.upsertServer({ scope: 'project', workspacePath, name: 'renamed', transport: 'http', url: input.url });
    const config = TOML.parse(await fs.readFile(configPath, 'utf8')) as { mcp_servers: Record<string, Record<string, unknown>> };
    assert.equal(config.mcp_servers.first, undefined);
    assert.equal(config.mcp_servers.other.command, 'example');
    assert.equal(config.mcp_servers.renamed.enabled, false);
    assert.equal(config.mcp_servers.renamed.bearer_token_env_var, 'TOKEN');
    assert.deepEqual(config.mcp_servers.renamed.env_http_headers, { Authorization: 'AUTH_HEADER' });
    await mcp.upsertServer({ scope: 'project', workspacePath, name: 'renamed', transport: 'http', url: 'https://different.test' });
    const [changed] = (await mcp.listServersForScope('project', { workspacePath })).filter(server => server.name === 'renamed');
    assert.equal(changed.bearerTokenEnvVar, undefined);
    assert.equal(changed.envHttpHeaders, undefined);
  } finally {
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
});

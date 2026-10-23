import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// The registry resolves ~/.agentharbor/plugins when it is imported, so HOME must point at the sandbox first.
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-plugin-registry-'));
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;
const { getPluginsDir, scanPlugins, uninstallPlugin } = await import('../plugin-registry.service.js');

function writePlugin(directory: string, name: string): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ name, displayName: name, entry: 'index.js' }));
}

test.after(() => {
  fs.rmSync(sandboxHome, { recursive: true, force: true });
});

test('finds plugins installed as a directory or as a symlink to one', () => {
  const pluginsDir = getPluginsDir();
  writePlugin(path.join(pluginsDir, 'copied'), 'copied');
  const bundled = path.join(sandboxHome, 'repo', 'plugins', 'bundled');
  writePlugin(bundled, 'bundled');
  fs.symlinkSync(bundled, path.join(pluginsDir, 'bundled'), 'dir');
  fs.symlinkSync(path.join(sandboxHome, 'missing'), path.join(pluginsDir, 'dangling'), 'dir');

  assert.deepEqual(scanPlugins().map((plugin) => plugin.name).sort(), ['bundled', 'copied']);
});

test('uninstalling a symlinked plugin removes only the link', async () => {
  const bundled = path.join(sandboxHome, 'repo', 'plugins', 'bundled');
  await uninstallPlugin('bundled');

  assert.equal(fs.existsSync(path.join(getPluginsDir(), 'bundled')), false);
  assert.equal(fs.existsSync(path.join(bundled, 'manifest.json')), true);
});

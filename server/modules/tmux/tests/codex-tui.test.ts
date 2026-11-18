import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCodexScreen } from '@/modules/tmux/codex-tui.js';

const base = { title: 'thread', dead: false, cursorVisible: true, cursorX: 2, cursorY: 1 };

test('Codex identifies the empty composer, a draft with the cursor at Home, and a native selection menu', () => {
  const placeholder = '\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m';
  assert.equal(parseCodexScreen({ ...base, lines: ['', placeholder, '', '  ? for shortcuts'] }).activity, 'idle');
  assert.equal(parseCodexScreen({ ...base, lines: ['', '› unsent text', '', '  project'] }).empty, false);
  const menu = parseCodexScreen({ ...base, lines: ['Select Model and Effort', '› 1. GPT', '  enter select · esc back'] });
  assert.equal(menu.activity, 'waiting');
  assert.equal(menu.composer, false);
  assert.equal(parseCodexScreen({ ...base, lines: ['• Working (5s • esc to interrupt)', placeholder] }).activity, 'working');
});

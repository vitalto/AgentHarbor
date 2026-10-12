import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

import { runWindowsPowerShell } from '@/modules/tmux/windows-powershell.js';

const hasWindowsPowerShell = existsSync('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe');

test('Cyrillic in PowerShell output reaches Node intact', { skip: !hasWindowsPowerShell && 'no Windows PowerShell here' }, async () => {
  assert.equal((await runWindowsPowerShell("Write-Output 'ванная ОШИБКА'")).trim(), 'ванная ОШИБКА');
});

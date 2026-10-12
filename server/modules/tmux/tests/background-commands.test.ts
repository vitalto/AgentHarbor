import assert from 'node:assert/strict';
import test from 'node:test';

import { isShellRunningCommand } from '@/modules/tmux/background-commands.js';

// As Win32_Process reports the shell Claude's Bash tool starts (newlines already folded to spaces).
const shellCommandLine = (evaluated: string) =>
  '"C:\\Program Files\\Git\\bin\\bash.exe" -c "source /c/Users/alice/.claude/shell-snapshots/snapshot-bash-1.sh 2>/dev/null || true '
  + `&& shopt -u extglob 2>/dev/null || true && eval '${evaluated}' < /dev/null && pwd -P >| /c/Users/alice/AppData/Local/Temp/claude-82eb-cwd"`;

test('the shell of a backgrounded command is recognised by the command it evaluates', () => {
  assert.equal(isShellRunningCommand(shellCommandLine('sleep 300; echo done'), 'sleep 300; echo done'), true);
  assert.equal(isShellRunningCommand(shellCommandLine('sleep 300; echo done'), 'sleep 300'), false);
});

test('quotes Claude re-escapes for bash and Windows do not hide the match', () => {
  const command = `grep -n 'needle' "my file.txt"`;
  const evaluated = `grep -n '\\"'\\"'needle'\\"'\\"' \\"my file.txt\\"`;
  assert.equal(isShellRunningCommand(shellCommandLine(evaluated), command), true);
});

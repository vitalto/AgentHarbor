import { execFile } from 'node:child_process';

import type { ClaudeProcess } from '@/modules/tmux/claude-status.js';
import { runWindowsPowerShell } from '@/modules/tmux/windows-powershell.js';

const TASKKILL = '/mnt/c/Windows/System32/taskkill.exe';

/**
 * Quotes and backslashes differ between the command Claude was given and the
 * command line it runs (`eval '<command>'` with `'` re-quoted, then `"`
 * escaped for Windows); whitespace and those characters are dropped on both
 * sides before comparing.
 */
export function normalizeShellText(text: string): string {
  return text.replace(/[\s'"\\]/g, '');
}

/**
 * Whether a shell's command line is the one Claude's Bash tool started for
 * `command`: it wraps the command as `eval '<command>' < /dev/null`.
 */
export function isShellRunningCommand(commandLine: string, command: string): boolean {
  return normalizeShellText(commandLine).includes(`eval${normalizeShellText(command)}</dev/null`);
}

type ChildProcess = { pid: number; commandLine: string };

async function listChildShells(parentPids: number[]): Promise<ChildProcess[]> {
  const filter = parentPids.map((pid) => `ParentProcessId=${pid}`).join(' OR ');
  const script = `Get-CimInstance Win32_Process -Filter "(${filter}) AND Name='bash.exe'" | `
    + "ForEach-Object { '{0}|{1}' -f $_.ProcessId, ($_.CommandLine -replace \"`r?`n\", ' ') }";
  const children: ChildProcess[] = [];
  for (const line of (await runWindowsPowerShell(script)).split(/\r?\n/)) {
    const separator = line.indexOf('|');
    const pid = Number(line.slice(0, separator));
    if (separator > 0 && Number.isInteger(pid) && pid > 0) {
      children.push({ pid, commandLine: line.slice(separator + 1) });
    }
  }
  return children;
}

/**
 * Ends one backgrounded command of a Windows Claude: the shell its Bash tool
 * started for it (a direct child of claude.exe) and everything under it.
 * Refuses (false) unless exactly one shell matches, so a second copy of the
 * same command is never hit by mistake. Claude then reports the task as ended
 * like any other that exits.
 */
export async function stopBackgroundCommand(holders: ClaudeProcess[], command: string): Promise<boolean> {
  const windowsHolders = holders.filter((holder) => holder.windowsPid);
  if (windowsHolders.length === 0 || !command.trim()) {
    return false;
  }
  const matches = (await listChildShells(windowsHolders.map((holder) => holder.pid)))
    .filter((child) => isShellRunningCommand(child.commandLine, command));
  if (matches.length !== 1) {
    return false;
  }
  return new Promise((resolve) => {
    execFile(TASKKILL, ['/PID', String(matches[0].pid), '/T', '/F'], { timeout: 10_000 }, (error) => resolve(!error));
  });
}

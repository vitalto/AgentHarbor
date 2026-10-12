import { execFile } from 'node:child_process';

const POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';

/**
 * Runs a Windows PowerShell script from WSL and returns its stdout, or '' on
 * failure. PowerShell writes in the console's OEM code page (cp866 here), so
 * non-ASCII text such as Cyrillic in a command line would reach Node as U+FFFD
 * unless the output is switched to UTF-8 first.
 */
export function runWindowsPowerShell(script: string, timeoutMs = 15_000): Promise<string> {
  const utf8Script = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${script}`;
  return new Promise((resolve) => {
    execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', utf8Script], { timeout: timeoutMs }, (error, stdout) => {
      resolve(error ? '' : stdout);
    });
  });
}

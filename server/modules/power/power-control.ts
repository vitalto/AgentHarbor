import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

export type PowerControl = {
  /** Asks the OS to power off after `delaySeconds`, leaving that long to cancel it. */
  scheduleShutdown(delaySeconds: number, reason: string): Promise<void>;
  cancelShutdown(): Promise<void>;
};

const WSL_WINDOWS_SHUTDOWN = '/mnt/c/Windows/System32/shutdown.exe';
const COMMAND_TIMEOUT_MS = 15_000;

/**
 * Windows tools write in the console's OEM code page, which differs per
 * machine; text that is not UTF-8 is replaced by the Win32 error code the
 * tool prints at its end, e.g. "(1116)".
 */
function describeOutput(output: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(output).trim();
  } catch {
    const errorCode = /\((\d+)\)\s*$/.exec(output.toString('latin1'))?.[1];
    return errorCode ? `Windows error ${errorCode}` : '';
  }
}

function runCommand(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: COMMAND_TIMEOUT_MS, windowsHide: true, encoding: 'buffer' }, (error, stdout, stderr) => {
      if (error) {
        const detail = describeOutput(stderr) || describeOutput(stdout) || error.message;
        reject(new Error(`${file} ${args.join(' ')} failed: ${detail}`));
        return;
      }
      resolve();
    });
  });
}

export function createWindowsPowerControl(shutdownExecutable: string): PowerControl {
  return {
    scheduleShutdown: (delaySeconds, reason) =>
      runCommand(shutdownExecutable, ['/s', '/t', String(delaySeconds), '/c', reason]),
    cancelShutdown: () => runCommand(shutdownExecutable, ['/a']),
  };
}

export function createLinuxPowerControl(): PowerControl {
  return {
    // shutdown(8) counts in whole minutes.
    scheduleShutdown: (delaySeconds, reason) =>
      runCommand('shutdown', ['-P', `+${Math.max(1, Math.ceil(delaySeconds / 60))}`, reason]),
    cancelShutdown: () => runCommand('shutdown', ['-c']),
  };
}

/**
 * Under WSL the agents run on Windows, so Windows is powered off through
 * interop (WSL goes down with it); a plain Linux host powers itself off.
 */
export function createPowerControl(): PowerControl {
  if (process.platform === 'win32') {
    return createWindowsPowerControl('shutdown.exe');
  }
  return existsSync(WSL_WINDOWS_SHUTDOWN)
    ? createWindowsPowerControl(WSL_WINDOWS_SHUTDOWN)
    : createLinuxPowerControl();
}

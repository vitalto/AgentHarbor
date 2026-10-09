import { getAgentConfig, type AgentConfig } from '@/modules/tmux/agent-config.js';

const WINDOWS_DRIVE_PATH = /^([a-zA-Z]):[\\/]?(.*)$/;
const WSL_UNC_PATH = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/][^\\/]+([\\/].*)?$/i;
const MOUNTED_DRIVE_PATH = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/;

/**
 * Maps a path reported by Claude (cwd, transcript_path, hook payloads) to one
 * this server can open. Identity unless Claude is the Windows binary.
 */
export function toLocalPath(claudePath: string, config: AgentConfig = getAgentConfig()): string {
  if (!config.windowsClaude || !claudePath) {
    return claudePath;
  }

  const unc = WSL_UNC_PATH.exec(claudePath);
  if (unc) {
    return (unc[1] ?? '/').replace(/\\/g, '/');
  }

  const drive = WINDOWS_DRIVE_PATH.exec(claudePath);
  if (drive) {
    const rest = drive[2].replace(/\\/g, '/').replace(/\/+$/, '');
    return `/mnt/${drive[1].toLowerCase()}${rest ? `/${rest}` : ''}`;
  }

  return claudePath;
}

/** Inverse of toLocalPath: a path this server holds, expressed the way Claude expects it. */
export function toClaudePath(localPath: string, config: AgentConfig = getAgentConfig()): string {
  if (!config.windowsClaude || !localPath || WINDOWS_DRIVE_PATH.test(localPath)) {
    return localPath;
  }

  const mounted = MOUNTED_DRIVE_PATH.exec(localPath);
  if (mounted) {
    const rest = (mounted[2] ?? '').replace(/\/+$/, '').replace(/\//g, '\\');
    return `${mounted[1].toUpperCase()}:\\${rest}`;
  }

  if (localPath.startsWith('/') && config.wslDistro) {
    return `\\\\wsl.localhost\\${config.wslDistro}${localPath.replace(/\//g, '\\')}`;
  }

  return localPath;
}

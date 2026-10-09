export { getAgentConfig, readAgentConfig } from '@/modules/tmux/agent-config.js';
export type { AgentConfig } from '@/modules/tmux/agent-config.js';
export { writeHookSettings } from '@/modules/tmux/agent-launch.js';
export { stageAttachmentForClaude } from '@/modules/tmux/attachment-staging.js';
export {
  AgentBusyElsewhereError,
  AgentWindowError,
  clearAgentConversation,
  closeAgentWindow,
  ensureAgentWindow,
  startAgentWindow,
  findAgentWindow,
  moveSessionToTmux,
  typeIntoAgent,
  waitForInputReady,
} from '@/modules/tmux/agent-windows.service.js';
export { findSessionHolders, getLiveProcessStartTime, readClaudeProcesses, readClaudeStatuses } from '@/modules/tmux/claude-status.js';
export type { ClaudeActivity, ClaudeStatus } from '@/modules/tmux/claude-status.js';
export { paneRegistry } from '@/modules/tmux/pane-registry.service.js';
export type { PaneSession } from '@/modules/tmux/pane-registry.service.js';
export { toClaudePath, toLocalPath } from '@/modules/tmux/path-translation.js';
export { configureSessionMonitor, getSessionMonitor } from '@/modules/tmux/session-monitor.service.js';
export type { MonitorSocket, SessionMonitor } from '@/modules/tmux/session-monitor.service.js';
export { tmuxService } from '@/modules/tmux/tmux.service.js';
export type { AgentPane } from '@/modules/tmux/tmux.service.js';
export { getPermissionMode, setPermissionMode } from '@/modules/tmux/permission-mode.js';
export type { PermissionMode } from '@/modules/tmux/permission-mode.js';
export { startIdleReaper } from '@/modules/tmux/idle-reaper.service.js';

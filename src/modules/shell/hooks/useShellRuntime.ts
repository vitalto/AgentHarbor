import { useCallback, useEffect, useRef } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

import type { Project, ProjectSession } from '@/shared/types';
import { useShellConnection } from '@/modules/shell/hooks/useShellConnection';
import { useShellTerminal } from '@/modules/shell/hooks/useShellTerminal';

type UseShellRuntimeOptions = {
  selectedProject: Project | null | undefined;
  selectedSession: ProjectSession | null | undefined;
  isPlainShell: boolean;
  minimal: boolean;
  autoConnect: boolean;
  isRestarting: boolean;
  onOutputRef?: MutableRefObject<(() => void) | null>;
};

type UseShellRuntimeResult = {
  terminalContainerRef: RefObject<HTMLDivElement>;
  terminalRef: MutableRefObject<Terminal | null>;
  wsRef: MutableRefObject<WebSocket | null>;
  isConnected: boolean;
  isInitialized: boolean;
  isConnecting: boolean;
  connectToShell: () => void;
  disconnectFromShell: (options?: { suppressAutoConnect?: boolean }) => void;
};

export function useShellRuntime({
  selectedProject,
  selectedSession,
  isPlainShell,
  minimal,
  autoConnect,
  isRestarting,
  onOutputRef,
}: UseShellRuntimeOptions): UseShellRuntimeResult {
  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const selectedProjectRef = useRef(selectedProject);
  const selectedSessionRef = useRef(selectedSession);
  const isPlainShellRef = useRef(isPlainShell);
  const lastSessionIdRef = useRef<string | null>(selectedSession?.id ?? null);

  // Keep mutable values in refs so websocket handlers always read current data.
  useEffect(() => {
    selectedProjectRef.current = selectedProject;
    selectedSessionRef.current = selectedSession;
    isPlainShellRef.current = isPlainShell;
  }, [selectedProject, selectedSession, isPlainShell]);

  const closeSocket = useCallback(() => {
    const activeSocket = wsRef.current;
    if (!activeSocket) {
      return;
    }

    if (
      activeSocket.readyState === WebSocket.OPEN ||
      activeSocket.readyState === WebSocket.CONNECTING
    ) {
      activeSocket.close();
    }

    wsRef.current = null;
  }, []);

  const { isInitialized, clearTerminalScreen, disposeTerminal } = useShellTerminal({
    terminalContainerRef,
    terminalRef,
    fitAddonRef,
    wsRef,
    selectedProject,
    minimal,
    isRestarting,
    closeSocket,
  });

  const {
    isConnected,
    isConnecting,
    connectToShell,
    disconnectFromShell,
  } = useShellConnection({
    wsRef,
    terminalRef,
    fitAddonRef,
    selectedProjectRef,
    selectedSessionRef,
    isPlainShellRef,
    isInitialized,
    autoConnect,
    closeSocket,
    clearTerminalScreen,
    onOutputRef,
  });

  useEffect(() => {
    if (!isRestarting) {
      return;
    }

    disconnectFromShell({ suppressAutoConnect: true });
    disposeTerminal();
  }, [disconnectFromShell, disposeTerminal, isRestarting]);

  useEffect(() => {
    if (selectedProject) {
      return;
    }

    disconnectFromShell();
    disposeTerminal();
  }, [disconnectFromShell, disposeTerminal, selectedProject]);

  useEffect(() => {
    const currentSessionId = selectedSession?.id ?? null;
    if (lastSessionIdRef.current !== currentSessionId && isInitialized) {
      disconnectFromShell();
    }

    lastSessionIdRef.current = currentSessionId;
  }, [disconnectFromShell, isInitialized, selectedSession?.id]);

  return {
    terminalContainerRef,
    terminalRef,
    wsRef,
    isConnected,
    isInitialized,
    isConnecting,
    connectToShell,
    disconnectFromShell,
  };
}

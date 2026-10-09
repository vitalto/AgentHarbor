import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import type { LLMProvider, PermissionMode, Project, ProjectSession } from '@/shared/types';
import { resetUserPreferences, writeUserPreference } from '@/shared/userSettings';

/**
 * The composer resolves the tool-permission settings it sends with every
 * `chat.send` from the provider's preference key.
 *
 * These tests drive the real hook: they seed the preference store, submit a
 * message and read the options handed to `sendMessage`.
 */

const PROJECT: Project = {
  projectId: 'project-1',
  displayName: 'Project One',
  fullPath: '/tmp/project-one',
};

const SESSION: ProjectSession = { id: 'session-1' };

type SentMessage = {
  type: string;
  options?: {
    toolsSettings?: { allowedTools?: string[]; skipPermissions?: boolean };
    skipPermissions?: boolean;
  };
};

/** Sends one message through the real submit path and returns its `chat.send` options. */
const submit = async (provider: LLMProvider) => {
  const sent: SentMessage[] = [];
  const view = renderHook(() =>
    useChatComposerState({
      selectedProject: PROJECT,
      selectedSession: SESSION,
      currentSessionId: SESSION.id,
      provider,
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: 'test-model',
      currentProviderEffort: 'medium',
      isLoading: false,
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: (message) => {
        sent.push(message as SentMessage);
      },
      scrollToBottom: () => undefined,
      addMessage: () => undefined,
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
  );

  await act(async () => {
    view.result.current.setInput('hello');
  });
  await act(async () => {
    await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
  });

  const send = sent.find((message) => message.type === 'chat.send');
  assert.ok(send, 'expected the composer to dispatch a chat.send');
  return send.options ?? {};
};

const seedClaudeSettings = () => {
  writeUserPreference('claudePermissions', {
    allowedTools: ['claude-tool'],
    skipPermissions: true,
  });
};

beforeEach(() => {
  // The composer's slash-command hook fetches commands and skills on mount.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('[]', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })),
  );
  // The preference store keeps its copy in memory, so clearing localStorage is
  // not enough to give each case a store with nothing in it.
  resetUserPreferences();
  localStorage.clear();
});

afterEach(() => {
  // Also drops the debounced save the seeding queued, so no preference write
  // outlives the stubbed fetch.
  resetUserPreferences();
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('a claude send carries the tools and skipPermissions stored in its preference', async () => {
  seedClaudeSettings();

  const options = await submit('claude');

  assert.deepEqual(options.toolsSettings?.allowedTools, ['claude-tool']);
  assert.equal(options.skipPermissions, true);
});

test('a send with nothing stored carries empty tool settings', async () => {
  const options = await submit('claude');

  assert.deepEqual(options.toolsSettings, {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false,
  });
  assert.equal(options.skipPermissions, false);
});

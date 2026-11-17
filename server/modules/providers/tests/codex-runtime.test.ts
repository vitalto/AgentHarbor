import assert from 'node:assert/strict';
import test from 'node:test';

import { runCodexTmuxTurn } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import type { AnyRecord, ProviderRuntimeContext } from '@/shared/index.js';

for (const requested of ['default', 'acceptEdits', 'bypassPermissions']) {
  test(`Interactive Codex resumes its exact thread with native restrictions for ${requested}`, async () => {
    const calls: Array<[string, AnyRecord]> = [];
    const messages: AnyRecord[] = [];
    let notify: (method: string, params: AnyRecord) => void = () => {};
    const sandbox = { type: 'readOnly', networkAccess: false };
    const context: ProviderRuntimeContext = {
      resolveProviderSessionId: () => 'native-thread',
      resolveResumeModel: async () => 'test-model',
      getProviderModels: async () => ({ OPTIONS: [{ value: 'test-model', label: 'Test', effort: { default: 'low', values: [{ value: 'high', label: 'High' }] } }], DEFAULT: 'test-model' }),
      normalizeMessage: () => [], isProviderInstalled: async () => true,
    };
    await runCodexTmuxTurn('hello', { sessionId: 'app-id', permissionMode: requested }, {
      isWebSocketWriter: true, send: (event) => messages.push(event as AnyRecord),
    }, context, {
      window: async (id, attach) => {
        assert.equal(id, 'app-id'); assert.equal(attach, false);
        return { providerSessionId: 'native-thread', pane: { windowId: '@1', windowName: 'codex-app-id', paneId: '%1', panePid: 1, dead: false, cwd: '', command: 'codex', currentCommand: 'codex' } };
      },
      waitForPrompt: async () => {}, effort: () => 'high', stopped: () => {}, failed: () => {},
      connect: async () => ({
        close: () => {}, observe: (listener) => { notify = listener; },
        request: async (method: string, params: AnyRecord) => {
          calls.push([method, params]);
          if (method === 'thread/resume') return { thread: { status: { type: 'idle' } }, sandbox, approvalPolicy: 'on-request' };
          notify('turn/completed', { threadId: 'other-thread', turn: { id: 'ignored', status: 'failed' } });
          notify('turn/completed', { threadId: 'native-thread', turn: { id: 'turn-id', status: 'completed' } });
          return { turn: { id: 'turn-id' } };
        },
      }),
    });
    assert.deepEqual(calls[0], ['thread/resume', { threadId: 'native-thread', excludeTurns: true }]);
    assert.deepEqual(calls[1], ['turn/start', { threadId: 'native-thread', input: [{ type: 'text', text: 'hello', text_elements: [] }], model: 'test-model', effort: 'high', approvalPolicy: 'on-request', sandboxPolicy: sandbox }]);
    assert.deepEqual(messages.map((message) => message.kind), ['complete']);
    assert.equal(messages[0].success, true);
  });
}

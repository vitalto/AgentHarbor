import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { test, vi } from 'vitest';

import '@/modules/i18n';
import CommandResultModal from '@/modules/chat/modals/CommandResultModal';
import ComposerModelButton from '@/modules/chat/composer/ComposerModelButton';
import type { LLMProvider, ProviderModelsDefinition } from '@/shared/types';

const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionLastReply: () => okJson({ success: true, data: { model: 'claude-opus-5-5', effort: 'high' } }),
    },
  },
}));

const CATALOG: Partial<Record<LLMProvider, ProviderModelsDefinition>> = {
  claude: {
    OPTIONS: [
      { value: 'default', label: 'Default (recommended)', isCustom: false },
      {
        value: 'opus',
        label: 'Opus',
        isCustom: false,
        effort: { default: 'high', values: [{ value: 'low' }, { value: 'high' }, { value: 'max' }] },
      },
      { value: 'my-model-id', label: 'My Model', isCustom: true, recordId: 3 },
    ],
    DEFAULT: 'default',
  },
};

const NO_MODEL_ACTIONS = {
  create: async () => undefined,
  update: async () => undefined,
  remove: async () => undefined,
};

const renderModelsModal = (onSelectProviderEffort = vi.fn(async (_p: LLMProvider, effort: string) => ({
  scope: 'session' as const,
  effort,
}))) => {
  render(
    <CommandResultModal
      payload={{
        kind: 'models',
        data: { current: { provider: 'claude', model: 'opus', answeringModel: 'claude-opus-5-5', answeringEffort: 'high' } },
      }}
      onClose={() => undefined}
      providerModelCatalog={CATALOG}
      providerModelActions={NO_MODEL_ACTIONS}
      activeProvider="claude"
      activeProviderModel="opus"
      currentSessionId="session-1"
      onSelectProviderModel={async (_provider, model) => ({ scope: 'session', model })}
      activeProviderEffort="default"
      onSelectProviderEffort={onSelectProviderEffort}
    />,
  );
  return onSelectProviderEffort;
};

test('a built-in model card names the model once; a custom one also shows its ID', () => {
  renderModelsModal();

  const opusCard = screen.getByRole('button', { name: 'Select model opus' });
  assert.equal(within(opusCard).queryByText('opus'), null);
  const customCard = screen.getByRole('button', { name: 'Select model my-model-id' });
  assert.ok(within(customCard).getByText('my-model-id'));
});

test('the models dialog offers the current model\'s effort levels and says what the last reply ran at', async () => {
  const onSelectProviderEffort = renderModelsModal();

  const picker = screen.getByTestId('effort-picker');
  const levels = within(picker).getAllByRole('button').map((button) => button.textContent);
  assert.deepEqual(levels, ['Default', 'low', 'high', 'max']);
  assert.equal(within(picker).getByRole('button', { name: 'Default' }).getAttribute('aria-pressed'), 'true');
  assert.ok(screen.getByText(/the last reply ran at high/));

  fireEvent.click(within(picker).getByRole('button', { name: 'max' }));

  await waitFor(() => assert.ok(screen.getByText('Effort switches to max with your next message.')));
  assert.deepEqual(onSelectProviderEffort.mock.calls[0], ['claude', 'max', 'session-1']);
});

test('on Claude\'s own settings the composer button shows what the last reply ran with', async () => {
  render(
    <ComposerModelButton
      provider="claude"
      sessionId="session-1"
      followsClaudeModel
      selectedModelLabel="Default (recommended)"
      selectedEffort="default"
      isLoading={false}
      onClick={() => undefined}
    />,
  );

  const button = screen.getByTestId('composer-model-button');
  await waitFor(() => assert.equal(button.textContent, 'Opus· high'));
});

test('an explicit choice is shown as chosen, ahead of the last reply', async () => {
  render(
    <ComposerModelButton
      provider="claude"
      sessionId="session-1"
      followsClaudeModel={false}
      selectedModelLabel="Sonnet"
      selectedEffort="low"
      isLoading={false}
      onClick={() => undefined}
    />,
  );

  const button = screen.getByTestId('composer-model-button');
  await waitFor(() => assert.match(button.title, /Last reply: claude-opus-5-5, high effort/));
  assert.equal(button.textContent, 'Sonnet· low');
});

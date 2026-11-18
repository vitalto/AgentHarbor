import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import '@/modules/i18n';
import AgentsSettingsTab from '@/modules/settings/tabs/agents-settings/AgentsSettingsTab';
import type { ProviderAuthStatus } from '@/shared/types';

const { saveAgentSettings } = vi.hoisted(() => ({ saveAgentSettings: vi.fn() }));
function runtimeSettings(overrides: Record<string, number> = {}) {
  const defaults = { idleCloseMinutes: 60, attachmentRetentionDays: 7, backgroundReminderMinutes: 60,
    apiErrorRetryAttempts: 3, apiErrorRetryDelayMinutes: 1 };
  const limits = Object.fromEntries(Object.keys(defaults).map((name) => [name, { minimum: 0, maximum: 10080 }]));
  return Response.json({ settings: { values: { ...defaults, idleCloseMinutes: 30, ...overrides }, defaults, limits } });
}

vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: {
    providers: { claudeSettingsPermissions: async () => Response.json({ success: true, data: { sources: [] } }) },
    settings: { agentSettings: async () => runtimeSettings(), saveAgentSettings },
    power: { shutdownWhenIdle: async () => Response.json({ data: { armed: false, shutdownAt: null, quietPeriodMs: 60000, shutdownDelaySeconds: 60 } }) },
  },
}));

describe('agent selection in settings', () => {
  it('opens the Codex account and only offers settings supported by its provider', () => {
    const status: ProviderAuthStatus = { authenticated: false, email: null, method: null, error: null, loading: false };
    const onLogin = vi.fn();
    render(<AgentsSettingsTab
      providerAuthStatus={{ claude: status, codex: status }} onProviderLogin={onLogin}
      claudePermissions={{ allowedTools: [], disallowedTools: [], skipPermissions: false }}
      onClaudePermissionsChange={vi.fn()} projects={[]}
    />);
    fireEvent.click(screen.getByRole('button', { name: 'Claude' }));
    fireEvent.click(screen.getByRole('tab', { name: /permissions/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
    expect(screen.getByRole('heading', { name: 'Codex' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /permissions/i })).toBeNull();
    expect(screen.getByRole('tab', { name: /MCP/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /skills/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /log.?in|sign.?in/i }));
    expect(onLogin).toHaveBeenCalledWith('codex');
  });

  it('edits timeout, reminder and retry settings from Codex Runtime', async () => {
    const status: ProviderAuthStatus = { authenticated: false, email: null, method: null, error: null, loading: false };
    saveAgentSettings.mockImplementation(async (changes) => runtimeSettings(changes));
    render(<AgentsSettingsTab
      providerAuthStatus={{ claude: status, codex: status }} onProviderLogin={vi.fn()}
      claudePermissions={{ allowedTools: [], disallowedTools: [], skipPermissions: false }}
      onClaudePermissionsChange={vi.fn()} projects={[]}
    />);
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Runtime' }));
    const timeout = await screen.findByRole('spinbutton', { name: /close idle agents after/i });
    expect((timeout as HTMLInputElement).value).toBe('30');
    expect((screen.getByRole('spinbutton', { name: /keep pasted files/i }) as HTMLInputElement).value).toBe('7');
    expect(screen.getByRole('switch', { name: /shut down when all agents finish/i }).getAttribute('aria-checked')).toBe('false');
    for (const [name, label, value] of [
      ['idleCloseMinutes', /close idle agents after/i, 0],
      ['backgroundReminderMinutes', /remind about background commands/i, 12],
      ['apiErrorRetryAttempts', /continue after a network error/i, 2],
      ['apiErrorRetryDelayMinutes', /first retry after/i, 5],
    ] as const) {
      const input = screen.getByRole('spinbutton', { name: label });
      fireEvent.change(input, { target: { value: String(value) } });
      fireEvent.blur(input);
      await waitFor(() => expect(saveAgentSettings).toHaveBeenCalledWith({ [name]: value }));
      await waitFor(() => expect((screen.getByRole('spinbutton', { name: label }) as HTMLInputElement).disabled).toBe(false));
    }
  });
});

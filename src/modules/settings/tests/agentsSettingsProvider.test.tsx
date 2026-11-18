import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import '@/modules/i18n';
import AgentsSettingsTab from '@/modules/settings/tabs/agents-settings/AgentsSettingsTab';
import type { ProviderAuthStatus } from '@/shared/types';

const { saveAgentSettings } = vi.hoisted(() => ({ saveAgentSettings: vi.fn() }));
const idleSettings = (minutes: number) => Response.json({ settings: {
  values: { idleCloseMinutes: minutes }, defaults: { idleCloseMinutes: 60 },
  limits: { idleCloseMinutes: { minimum: 0, maximum: 10080 } },
} });

vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: {
    providers: { claudeSettingsPermissions: async () => Response.json({ success: true, data: { sources: [] } }) },
    settings: { agentSettings: async () => idleSettings(30), saveAgentSettings },
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

  it('edits the shared idle timeout from Codex Runtime', async () => {
    const status: ProviderAuthStatus = { authenticated: false, email: null, method: null, error: null, loading: false };
    saveAgentSettings.mockResolvedValueOnce(idleSettings(0));
    render(<AgentsSettingsTab
      providerAuthStatus={{ claude: status, codex: status }} onProviderLogin={vi.fn()}
      claudePermissions={{ allowedTools: [], disallowedTools: [], skipPermissions: false }}
      onClaudePermissionsChange={vi.fn()} projects={[]}
    />);
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Runtime' }));
    const timeout = await screen.findByRole('spinbutton', { name: /close idle agents after/i });
    expect((timeout as HTMLInputElement).value).toBe('30');
    expect(screen.getAllByRole('spinbutton')).toHaveLength(1);
    fireEvent.change(timeout, { target: { value: '0' } });
    fireEvent.blur(timeout);
    await waitFor(() => expect(saveAgentSettings).toHaveBeenCalledWith({ idleCloseMinutes: 0 }));
    await waitFor(() => expect((screen.getByDisplayValue('0') as HTMLInputElement).disabled).toBe(false));
  });
});

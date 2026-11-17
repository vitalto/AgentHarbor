import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import '@/modules/i18n';
import AgentsSettingsTab from '@/modules/settings/tabs/agents-settings/AgentsSettingsTab';
import type { ProviderAuthStatus } from '@/shared/types';

vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: { providers: { claudeSettingsPermissions: async () => new Response(JSON.stringify({ success: true, data: { sources: [] } })) } },
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
});

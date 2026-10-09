import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

let currentMode = 'bypassPermissions';
const setPermissionMode = vi.fn(async (_sessionId: string, mode: string) => {
  currentMode = mode;
  return new Response(JSON.stringify({ success: true, data: { mode } }));
});

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      permissionMode: vi.fn(async () => new Response(JSON.stringify({ success: true, data: { mode: currentMode } }))),
      setPermissionMode: (sessionId: string, mode: string) => setPermissionMode(sessionId, mode),
    },
  },
}));

test('shows the window\'s mode and switches it on choice', async () => {
  const { default: PermissionModePicker } = await import('@/modules/chat/composer/PermissionModePicker');
  await act(async () => {
    render(<PermissionModePicker sessionId="s1" />);
  });
  const select = screen.getByLabelText('Permission mode') as HTMLSelectElement;
  assert.equal(select.value, 'bypassPermissions');

  await act(async () => {
    fireEvent.change(select, { target: { value: 'plan' } });
  });
  assert.deepEqual(setPermissionMode.mock.calls, [['s1', 'plan']]);
  assert.equal((screen.getByLabelText('Permission mode') as HTMLSelectElement).value, 'plan');
});

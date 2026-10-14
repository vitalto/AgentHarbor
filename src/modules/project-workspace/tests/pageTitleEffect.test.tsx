import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

/**
 * The tab title used to be set by the sidebar's project list, which is not
 * mounted on the Recent/Archived tabs, in search or with the sidebar collapsed,
 * so switching conversations from there left the old title. The workspace's
 * headless effects controller owns it now and nothing of the sidebar renders here.
 */

const effectsState = {
  pageTitle: 'First conversation',
  openSettings: () => {},
  refreshProjectsSilently: async () => {},
  setActiveTab: () => {},
  setSidebarOpen: () => {},
};

vi.mock('@/modules/project-workspace/context/ProjectsStateContext', () => ({
  useProjectEffectsState: () => effectsState,
}));

vi.mock('@/modules/command-palette', () => ({
  usePaletteOpsRegister: () => {},
}));

const { default: ProjectEffects } = await import('@/modules/project-workspace/controllers/ProjectEffects');

test('the tab title follows the open conversation without the sidebar list mounted', () => {
  const navigate = vi.fn();
  const { rerender } = render(React.createElement(ProjectEffects, { navigate }));
  assert.equal(document.title, 'First conversation');

  effectsState.pageTitle = 'Second conversation';
  rerender(React.createElement(ProjectEffects, { navigate }));
  assert.equal(document.title, 'Second conversation');
});

import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

import TuiPromptPanel from '@/modules/chat/composer/TuiPromptPanel';
import type { TuiPrompt } from '@/modules/chat/utils/tuiPrompt';

const bashPermission: TuiPrompt = {
  question: 'Do you want to proceed?',
  body: ['Bash command', 'mkdir build-out && echo done', 'Do you want to proceed?'],
  options: [
    { label: 'Yes', detail: null, selected: true },
    { label: 'Yes, and always allow access to', detail: 'C:\\proj from this project', selected: false },
    { label: 'No', detail: null, selected: false },
  ],
};

test('each TUI option is a button that reports its index', () => {
  const onChoose = vi.fn();
  render(<TuiPromptPanel prompt={bashPermission} onChoose={onChoose} onCancel={vi.fn()} />);

  assert.ok(screen.getByText('Do you want to proceed?'));
  assert.ok(screen.getByText('mkdir build-out && echo done', { exact: false }));
  assert.ok(screen.getByText('C:\\proj from this project'));

  fireEvent.click(screen.getByText('No'));
  assert.deepEqual(onChoose.mock.calls, [[2]]);
});

test('cancel sends Esc through its own callback', () => {
  const onCancel = vi.fn();
  render(<TuiPromptPanel prompt={bashPermission} onChoose={vi.fn()} onCancel={onCancel} />);
  fireEvent.click(screen.getByText('Cancel (Esc)'));
  assert.equal(onCancel.mock.calls.length, 1);
});

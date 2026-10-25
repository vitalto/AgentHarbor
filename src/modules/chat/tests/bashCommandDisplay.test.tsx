import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import { BashCommandDisplay } from '@/modules/chat/tools/BashCommandDisplay';

const LONG_COMMAND = 'cd /repo && grep -rn "pattern" src --include=*.tsx | grep -v test | head -40';

// jsdom does no layout, so a clamped command is simulated by a scroll height
// above the visible height.
function simulateClampedText() {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(80);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(48);
}

describe('BashCommandDisplay', () => {
  afterEach(() => vi.restoreAllMocks());

  it('expands a running command that has no output yet when its text is cut off', () => {
    simulateClampedText();
    render(<BashCommandDisplay command={LONG_COMMAND} status="running" />);

    const header = screen.getByRole('button', { expanded: false });
    fireEvent.click(header);

    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(LONG_COMMAND).className).not.toContain('line-clamp-3');
  });

  it('keeps a command that fits and has no output as a plain row', () => {
    render(<BashCommandDisplay command="ls" status="running" />);

    expect(screen.queryByRole('button', { expanded: false })).toBeNull();
  });
});

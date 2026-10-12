import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import { test } from 'vitest';

import { Markdown } from '@/modules/chat/transcript/Markdown';

/**
 * A link with an empty destination falls back to its text as the file
 * reference. That text never went through react-markdown's URL sanitizer, so
 * a model reply must not be able to plant a script URL in the href that way.
 */

test('a script URL in a link text does not become the href', () => {
  const { container } = render(<Markdown>{'[javascript:alert(document.domain)//x.ts]()'}</Markdown>);
  const href = container.querySelector('a')?.getAttribute('href') ?? '';
  assert.doesNotMatch(href, /^\s*javascript:/i);
});

test('a workspace path in a link text is still the href', () => {
  const { container } = render(<Markdown>{'[src/app/main.ts]()'}</Markdown>);
  assert.equal(container.querySelector('a')?.getAttribute('href'), 'src/app/main.ts');
});

test('a Windows drive path in a link text is still the href', () => {
  const { container } = render(<Markdown>{'[D:\\out\\report.pdf]()'}</Markdown>);
  assert.equal(container.querySelector('a')?.getAttribute('href'), 'D:\\out\\report.pdf');
});

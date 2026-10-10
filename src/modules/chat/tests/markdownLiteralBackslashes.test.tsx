import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import { test } from 'vitest';

import { Markdown } from '@/modules/chat/transcript/Markdown';

/**
 * A user's own message is plain text that happens to go through markdown:
 * `C:\Users\vital\.agentharbor` must not lose the backslash before the dot to
 * a markdown character escape. Model replies keep standard escapes.
 */

test('a user-typed Windows path keeps every backslash', () => {
  const { container } = render(
    <Markdown breaks literalBackslashes>{'see C:\\Users\\vital\\.agentharbor\\attachments and `C:\\x\\.y`'}</Markdown>,
  );
  assert.match(container.textContent ?? '', /see C:\\Users\\vital\\\.agentharbor\\attachments and C:\\x\\\.y/);
});

test('user-typed markdown still formats', () => {
  const { container } = render(<Markdown breaks literalBackslashes>{'**bold** in C:\\a\\_b'}</Markdown>);
  assert.equal(container.querySelector('strong')?.textContent, 'bold');
  assert.match(container.textContent ?? '', /C:\\a\\_b/);
});

test('model replies keep standard markdown escapes', () => {
  const { container } = render(<Markdown>{'2 \\* 3'}</Markdown>);
  assert.equal(container.textContent, '2 * 3');
});

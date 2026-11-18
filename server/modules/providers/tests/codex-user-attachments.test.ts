import assert from 'node:assert/strict';
import test from 'node:test';

import { CodexSessionsProvider, extractCodexSearchableMessage, readCodexRollout } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import { appendFilesInputTag, type AnyRecord } from '@/shared/index.js';

const timestamp = '2026-11-18T17:47:45.569Z';
const imagePath = 'C:/agentharbor/attachments/1795024000000-921-image.png';

function textPart(text: string, textElements: AnyRecord[] = []) {
  return { type: 'text', text, text_elements: textElements };
}

function marker(start: number, placeholder = '[Image #1]') {
  return { byte_range: { start, end: start + Buffer.byteLength(placeholder) }, placeholder };
}

function typedPrompt(id: string, content: AnyRecord[]) {
  return { timestamp, type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn', item: { type: 'UserMessage', id, content } } };
}

function legacyPrompt(message: string, extra: AnyRecord = {}) {
  return { timestamp, type: 'event_msg', payload: { type: 'user_message', message, ...extra } };
}

async function readLiveAndSaved(rows: AnyRecord[]) {
  const provider = new CodexSessionsProvider();
  const normalize = (row: AnyRecord) => provider.normalizeMessage(row, 'session');
  const live: ReturnType<typeof normalize> = [];
  async function* entries() { yield* rows; }
  await readCodexRollout(entries(), undefined, row => live.push(...normalize(row)));
  const saved = await readCodexRollout(entries());
  return [live, saved.messages.flatMap(normalize)];
}

test('Codex renders one clean image caption per send and preserves genuine repeated sends', async () => {
  const caption = 'Inspect [Image #1] in the help text';
  const text = `[Image #1] ${caption}`;
  const input = [{ type: 'local_image', path: imagePath }, textPart(text, [marker(0)])];
  const wire = { timestamp, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } };
  const first = typedPrompt('send-one', input);
  const second = typedPrompt('send-two', input);
  for (const messages of await readLiveAndSaved([wire, first, wire, second])) {
    assert.deepEqual(messages.map(({ id, content, images }) => ({ id, content, images })), [
      { id: 'send-one', content: caption, images: [{ path: imagePath }] },
      { id: 'send-two', content: caption, images: [{ path: imagePath }] },
    ]);
  }
  assert.deepEqual(extractCodexSearchableMessage(first), { role: 'user', text: caption });
});

test('Codex removes marked image ranges at UTF-8 byte offsets and leaves unmarked or invalid ranges in place', async () => {
  const prefix = 'Фото 📷 ';
  const previous = '[Image #9] ';
  const text = `${previous}${prefix}[Image #1] после [Image #2]`;
  const ranges = [marker(Buffer.byteLength(previous + prefix)), marker(text.length + 50, '[Image #2]'), marker(1, '[Image #9]')];
  const prompt = legacyPrompt(text, { local_images: [imagePath], text_elements: ranges });
  const literal = typedPrompt('literal', [textPart('[Image #1] literal', [marker(0)])]);
  for (const messages of await readLiveAndSaved([prompt, literal])) {
    assert.deepEqual(messages.map(message => message.content), [`${previous}${prefix}после [Image #2]`, '[Image #1] literal']);
  }
  assert.equal(extractCodexSearchableMessage(prompt)?.text, `${previous}${prefix}после [Image #2]`);
});

test('Codex preserves an image-only message when its only text is a placeholder or the legacy caption is empty', async () => {
  const inline = 'data:image/png;base64,AA==';
  const typed = typedPrompt('image-only', [{ type: 'image', image_url: inline }, textPart('[Image #1]', [marker(0)])]);
  const legacy = legacyPrompt('', { local_images: [imagePath] });
  for (const messages of await readLiveAndSaved([typed, legacy])) {
    assert.deepEqual(messages.map(({ content, images }) => ({ content, images })), [
      { content: '', images: [{ data: inline }] }, { content: '', images: [{ path: imagePath }] },
    ]);
  }
});

test('Codex search, live chat, and saved history strip the generated file block and keep its attachment', async () => {
  const caption = 'Explain the literal <files_input> tag.';
  const file = { path: 'C:/agentharbor/attachments/1795024000000-703-report.pdf', name: 'Report.pdf' };
  const transport = appendFilesInputTag(caption, [file])
    .replace('\n<files_input>\n', '\nfiles_input\n').replace('\n</files_input>', '\n/files_input');
  const prompt = typedPrompt('file-send', [textPart(transport)]);
  for (const messages of await readLiveAndSaved([prompt])) {
    assert.equal(messages.length, 1);
    assert.equal(messages[0].content, caption);
    assert.deepEqual(messages[0].files, [file]);
  }
  assert.deepEqual(extractCodexSearchableMessage(prompt), { role: 'user', text: caption });
  assert.deepEqual(extractCodexSearchableMessage(legacyPrompt(transport)), { role: 'user', text: caption });
});

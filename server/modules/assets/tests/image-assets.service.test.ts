import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildStoredAttachmentRecords,
  buildStoredImageRecords,
  createStoredFileName,
  isAllowedImageMimeType,
  resolveAttachmentAssetFile,
  resolveImageAssetFile,
} from '@/modules/assets/services/image-assets.service.js';

const ASSETS_DIR = path.join(os.homedir(), '.agentharbor', 'assets');

test('isAllowedImageMimeType accepts image formats and rejects the rest', () => {
  assert.equal(isAllowedImageMimeType('image/png'), true);
  assert.equal(isAllowedImageMimeType('image/svg+xml'), true);
  assert.equal(isAllowedImageMimeType('application/pdf'), false);
  assert.equal(isAllowedImageMimeType('text/html'), false);
});

test('buildStoredImageRecords returns absolute posix paths in the assets dir', () => {
  const records = buildStoredImageRecords([
    { originalname: 'shot.png', filename: '123-456-shot.png', size: 42, mimetype: 'image/png' },
  ]);

  assert.equal(records.length, 1);
  assert.equal(records[0].name, 'shot.png');
  assert.equal(records[0].size, 42);
  assert.equal(records[0].mimeType, 'image/png');
  assert.equal(records[0].path, `${ASSETS_DIR.replace(/\\/g, '/')}/123-456-shot.png`);
});

test('buildStoredAttachmentRecords preserves metadata for non-image files', () => {
  const records = buildStoredAttachmentRecords([
    {
      originalname: 'requirements.pdf',
      filename: '123-456-requirements.pdf',
      size: 2048,
      mimetype: 'application/pdf',
    },
  ]);

  assert.deepEqual(records[0], {
    name: 'requirements.pdf',
    path: `${ASSETS_DIR.replace(/\\/g, '/')}/123-456-requirements.pdf`,
    size: 2048,
    mimeType: 'application/pdf',
  });
});

test('buildStoredImageRecords decodes a Cyrillic name from multer latin1 mojibake', () => {
  const mojibake = Buffer.from('Снимок.png', 'utf8').toString('latin1');
  const records = buildStoredImageRecords([
    { originalname: mojibake, filename: '123-456-Снимок.png', size: 10, mimetype: 'image/png' },
  ]);

  assert.equal(records[0].name, 'Снимок.png');
  assert.equal(records[0].path, `${ASSETS_DIR.replace(/\\/g, '/')}/123-456-Снимок.png`);
});

test('stored names keep short Unicode names readable and remove characters the asset route cannot serve', () => {
  assert.ok(createStoredFileName('Отчёт за март.pdf').endsWith('-Отчёт_за_март.pdf'));
  assert.ok(createStoredFileName('shot.png').endsWith('-shot.png'));
  assert.ok(createStoredFileName('a (1)/b.txt').endsWith('-a__1__b.txt'));
  assert.ok(resolveImageAssetFile(createStoredFileName('отчёт...май.pdf')));
});

test('uploads with the same shortened name stay distinct and even an oversized extension fits on disk', () => {
  const longName = `${'я'.repeat(160)}.docx`;
  assert.notEqual(createStoredFileName(longName), createStoredFileName(longName));
  const longExtension = createStoredFileName(`notes.${'字'.repeat(100)}`);
  assert.ok(Buffer.byteLength(longExtension) <= 255);
  assert.ok(resolveImageAssetFile(longExtension));
});

test('resolveImageAssetFile resolves plain filenames inside the assets dir', () => {
  const resolved = resolveImageAssetFile('123-shot.png');
  assert.equal(resolved, path.join(path.resolve(ASSETS_DIR), '123-shot.png'));
});

test('resolveImageAssetFile rejects traversal and separator attempts', () => {
  assert.equal(resolveImageAssetFile(''), null);
  assert.equal(resolveImageAssetFile('   '), null);
  assert.equal(resolveImageAssetFile('../auth.db'), null);
  assert.equal(resolveImageAssetFile('..'), null);
  assert.equal(resolveImageAssetFile('sub/dir.png'), null);
  assert.equal(resolveImageAssetFile('sub\\dir.png'), null);
  assert.equal(resolveImageAssetFile('a..b/../c.png'), null);
});

test('resolveAttachmentAssetFile uses the same direct-child boundary', () => {
  assert.equal(
    resolveAttachmentAssetFile('123-notes.txt'),
    path.join(path.resolve(ASSETS_DIR), '123-notes.txt'),
  );
  assert.equal(resolveAttachmentAssetFile('../notes.txt'), null);
});

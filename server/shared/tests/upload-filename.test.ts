import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeMultipartFilename } from '@/shared/upload-filename.js';

/** Reproduces how busboy/multer surfaces a UTF-8 form-data filename: as latin1. */
function asMulterOriginalName(utf8Name: string): string {
  return Buffer.from(utf8Name, 'utf8').toString('latin1');
}

test('decodeMultipartFilename recovers a Cyrillic name from multer latin1 mojibake', () => {
  assert.equal(decodeMultipartFilename(asMulterOriginalName('Отчёт за март.pdf')), 'Отчёт за март.pdf');
});

test('decodeMultipartFilename leaves a plain ASCII name unchanged', () => {
  assert.equal(decodeMultipartFilename('report.pdf'), 'report.pdf');
});

test('decodeMultipartFilename keeps the raw name when the bytes are not valid UTF-8', () => {
  // A lone 0xFF byte is not a valid UTF-8 sequence, so the name is kept as-is.
  assert.equal(decodeMultipartFilename('ÿ.bin'), 'ÿ.bin');
});

test('decodeMultipartFilename handles empty input', () => {
  assert.equal(decodeMultipartFilename(''), '');
});

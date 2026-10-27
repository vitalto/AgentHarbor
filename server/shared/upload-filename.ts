/**
 * Recovers the original UTF-8 filename from a multipart upload.
 *
 * Busboy (under multer) decodes RFC 7578 form-data filenames as latin1 by
 * default, so a browser that sends a UTF-8 name like `Отчёт.pdf` arrives as
 * mojibake (`ÐžÑ‚Ñ‡Ñ‘Ñ‚.pdf`). Re-reading those code points as the latin1 bytes
 * they stand for and decoding them as UTF-8 restores the real name. A name that
 * was already pure ASCII round-trips unchanged; bytes that are not valid UTF-8
 * decode with U+FFFD, in which case the raw name is kept as-is.
 */
export function decodeMultipartFilename(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    return raw;
  }
  const decoded = Buffer.from(raw, 'latin1').toString('utf8');
  return decoded.includes('�') ? raw : decoded;
}

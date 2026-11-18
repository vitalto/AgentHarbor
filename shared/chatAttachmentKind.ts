const NATIVE_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** The composer and gateway must agree which uploads the provider receives as native images. */
export function isImageAttachmentDescriptor(attachment: { path?: string; name?: string; mimeType?: string }): boolean {
  return NATIVE_IMAGE_MIME_TYPES.has(attachment.mimeType ?? '')
    || /[^\\/]\.(?:jpe?g|png|gif|webp)$/i.test(attachment.path || attachment.name || '');
}

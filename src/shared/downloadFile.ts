import { api, readApiJson } from '@/shared/api';

/**
 * Saves a file from this machine through the browser's download manager. The
 * server hands out a one-time link, so the session token never lands in a URL
 * (history, logs), and the file streams to disk instead of through page memory.
 */
export async function downloadFile(absolutePath: string): Promise<void> {
  const { url } = await readApiJson<{ url: string }>(await api.downloads.issue(absolutePath));
  const anchor = document.createElement('a');
  anchor.href = url;
  // Keeps the page in place even when the link fails (an error body is saved, not navigated to).
  anchor.download = '';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

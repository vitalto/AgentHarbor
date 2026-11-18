/** The Codex screen reader uses the live unified-exec footer, which disappears when the processes exit. */
export function readCodexBackgroundTerminalCount(lines: string[], prompt: number): number {
  // A follow-up queue can be arbitrarily tall and can quote the footer itself.
  let header = prompt - 1;
  while (header >= 0 && (!lines[header] || /^\s/.test(lines[header]))) header--;
  let row = lines[header] === '• Queued follow-up inputs' ? header - 1 : prompt - 1;
  while (row >= 0 && (!lines[row] || /^  └/.test(lines[row]))) row--;
  // Narrow panes clip the trailing /ps and /stop shortcuts.
  const match = /^(?: {2}|• .+\besc to interrupt\) · )([1-9]\d*) background terminals? running(?: ·|…|$)/u.exec(lines[row] ?? '');
  return match ? Number(match[1]) : 0;
}

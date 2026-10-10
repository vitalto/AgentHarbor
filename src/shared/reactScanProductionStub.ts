/**
 * Production builds alias `react-scan` here (vite.config.js): the overlay is dev-only, yet the real
 * package would still ship 410 kB and hook React's DevTools slot on import.
 */
export function scan(_options?: unknown) {}

import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';

import { api } from '@/shared/api';

/** Claude Code permission modes, in the order Shift+Tab cycles them. */
const MODES = [
  { value: 'bypassPermissions', label: 'Bypass' },
  { value: 'auto', label: 'Auto' },
  { value: 'default', label: 'Ask' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'plan', label: 'Plan' },
] as const;

type Mode = (typeof MODES)[number]['value'];

type PermissionModePickerProps = {
  sessionId: string;
};

/**
 * The permission mode of the session's Claude window. Changing it presses
 * Shift+Tab in the window until Claude shows the chosen mode, exactly as a
 * user at the terminal would.
 */
export default function PermissionModePicker({ sessionId }: PermissionModePickerProps) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [isSwitching, setIsSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await api.providers.permissionMode(sessionId);
      const body = (await response.json()) as { data?: { mode?: Mode | null } };
      setMode(body.data?.mode ?? null);
    } catch {
      setMode(null);
    }
  }, [sessionId]);

  useEffect(() => {
    setError(null);
    void load();
  }, [load]);

  const choose = async (target: Mode) => {
    setIsSwitching(true);
    setError(null);
    try {
      const response = await api.providers.setPermissionMode(sessionId, target);
      const body = (await response.json()) as { data?: { mode?: Mode }; error?: { message?: string } };
      if (!response.ok) {
        setError(body.error?.message ?? 'Could not switch the mode');
      }
      setMode(body.data?.mode ?? mode);
    } finally {
      setIsSwitching(false);
      void load();
    }
  };

  return (
    <span className="relative inline-flex items-center gap-1" data-testid="permission-mode-picker">
      <ShieldCheck className={mode === 'bypassPermissions' ? 'h-3.5 w-3.5 text-amber-600' : 'h-3.5 w-3.5 text-muted-foreground'} />
      <select
        aria-label="Permission mode"
        value={mode ?? ''}
        disabled={isSwitching}
        onFocus={() => void load()}
        onChange={(event) => void choose(event.target.value as Mode)}
        className="rounded border border-border bg-background px-1 py-0.5 text-xs text-foreground disabled:opacity-50"
      >
        {mode === null && <option value="">Mode…</option>}
        {MODES.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      {error && (
        <button
          type="button"
          onClick={() => setError(null)}
          className="absolute bottom-full right-0 z-50 mb-1 w-64 rounded-md border border-red-500/30 bg-background p-2 text-left text-[11px] text-foreground shadow-lg"
        >
          {error}
        </button>
      )}
    </span>
  );
}

import fsp from 'node:fs/promises';

/** The composer's "use Claude's own setting", for the model and for the effort. */
export const DEFAULT_SELECTION_VALUE = 'default';

const ULTRACODE_EFFORT = 'ultracode';
/** Levels both `--effort` and `/effort <level>` accept. */
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
/** The app's ultracode is xhigh plus standing workflows; switching ultracode on in the TUI keeps whatever effort it had. */
const ULTRACODE_BASE_EFFORT = 'xhigh';

export type AgentSelection = { model: string; effort: string };

/** A window started with neither `--model` nor `--effort` runs on Claude's own settings. */
export const LAUNCH_DEFAULT_SELECTION: AgentSelection = { model: DEFAULT_SELECTION_VALUE, effort: DEFAULT_SELECTION_VALUE };

/** Keeps `fallback` for anything the input does not name usably; a model id is typed into the TUI, so whitespace is refused. */
export function normalizeSelection(input: { model?: unknown; effort?: unknown }, fallback: AgentSelection): AgentSelection {
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  const effort = typeof input.effort === 'string' ? input.effort.trim() : '';
  const isKnownEffort = EFFORT_LEVELS.has(effort) || effort === ULTRACODE_EFFORT || effort === DEFAULT_SELECTION_VALUE;
  return {
    model: /^\S+$/.test(model) ? model : fallback.model,
    effort: isKnownEffort ? effort : fallback.effort,
  };
}

/** Launch flags for a selection and what they leave the TUI running with: ultracode has no flag, so it starts at its base level. */
export function selectionLaunch(wanted: AgentSelection): { args: string[]; applied: AgentSelection } {
  const args: string[] = [];
  if (wanted.model !== DEFAULT_SELECTION_VALUE) {
    args.push('--model', wanted.model);
  }
  const launchEffort = wanted.effort === ULTRACODE_EFFORT ? ULTRACODE_BASE_EFFORT : wanted.effort;
  if (EFFORT_LEVELS.has(launchEffort)) {
    args.push('--effort', launchEffort);
  }
  return { args, applied: { model: wanted.model, effort: launchEffort } };
}

/** The TUI commands that take a window from the `applied` selection to the `wanted` one. */
export function selectionCommands(applied: AgentSelection, wanted: AgentSelection): string[] {
  const commands: string[] = [];
  const modelChanges = wanted.model !== applied.model;
  if (modelChanges) {
    commands.push(`/model ${wanted.model}`);
  }
  // The next model may come with its own stored effort, so an explicit level is set again after a switch.
  const effortChanges = wanted.effort !== applied.effort || (modelChanges && wanted.effort !== DEFAULT_SELECTION_VALUE);
  if (!effortChanges) {
    return commands;
  }
  if (applied.effort === ULTRACODE_EFFORT && wanted.effort !== ULTRACODE_EFFORT) {
    commands.push('/effort ultracode off');
  }
  if (wanted.effort === ULTRACODE_EFFORT) {
    commands.push(`/effort ${ULTRACODE_BASE_EFFORT}`, '/effort ultracode on');
  } else if (wanted.effort === DEFAULT_SELECTION_VALUE) {
    commands.push('/effort auto');
  } else {
    commands.push(`/effort ${wanted.effort}`);
  }
  return commands;
}

/**
 * `/model` saves the model as the default for every new Claude session and
 * `/effort auto` drops the effort stored for the current model (verified on
 * Claude Code 2.1.303); a level given to `/effort` stays in the session.
 */
export function rewritesUserSettings(command: string): boolean {
  return command.startsWith('/model ') || command === '/effort auto';
}

/**
 * Whether the screen shows the confirmation `/model` asks for when the
 * conversation is cached for the current model (Claude Code 2.1.303), with
 * the cursor on "Yes, switch".
 */
export function isModelSwitchConfirmation(lines: string[]): boolean {
  return lines.some((line) => line.trim() === 'Switch model?')
    && lines.some((line) => /^\s*>\s*1\.\s+Yes, switch\b/.test(line));
}

/** The user-settings keys those commands rewrite; the app means its choice for one session only. */
const SELECTION_SETTING_KEYS = ['model', 'effortLevel', 'modelSettings'] as const;

/** `currentText` with the selection keys put back as in `snapshotText`; null when nothing differs or either is not JSON. */
export function restoreSelectionSettings(currentText: string, snapshotText: string): string | null {
  let current: Record<string, unknown>;
  let snapshot: Record<string, unknown>;
  try {
    current = JSON.parse(currentText) as Record<string, unknown>;
    snapshot = JSON.parse(snapshotText) as Record<string, unknown>;
  } catch {
    return null;
  }
  let changed = false;
  for (const key of SELECTION_SETTING_KEYS) {
    if (JSON.stringify(current[key]) === JSON.stringify(snapshot[key])) {
      continue;
    }
    changed = true;
    if (key in snapshot) {
      current[key] = snapshot[key];
    } else {
      delete current[key];
    }
  }
  return changed ? `${JSON.stringify(current, null, 2)}${currentText.endsWith('\n') ? '\n' : ''}` : null;
}

const SETTINGS_WRITE_TIMEOUT_MS = 3_000;
const SETTINGS_POLL_MS = 100;
/** Claude may write the file more than once for one command batch (model, then effort). */
const SETTINGS_SETTLE_MS = 300;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readText(filePath: string): Promise<string | null> {
  try {
    return await fsp.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Runs `typeCommands` and then puts the selection keys of Claude's user
 * settings back as they were, once Claude has written its own change. Other
 * keys keep whatever was written meanwhile.
 */
export async function keepUserSelectionSettings(settingsPath: string, typeCommands: () => Promise<void>): Promise<void> {
  const snapshot = await readText(settingsPath);
  try {
    await typeCommands();
  } finally {
    if (snapshot !== null) {
      const deadline = Date.now() + SETTINGS_WRITE_TIMEOUT_MS;
      while (Date.now() < deadline && (await readText(settingsPath)) === snapshot) {
        await delay(SETTINGS_POLL_MS);
      }
      await delay(SETTINGS_SETTLE_MS);
      const current = await readText(settingsPath);
      const restored = current === null ? null : restoreSelectionSettings(current, snapshot);
      if (restored !== null) {
        await fsp.writeFile(settingsPath, restored);
      }
    }
  }
}

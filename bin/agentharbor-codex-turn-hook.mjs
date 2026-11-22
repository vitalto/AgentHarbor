import { randomUUID } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';

const events = new Set(['UserPromptSubmit', 'Stop', 'Interrupt']);
const destination = process.env.AH_CODEX_TURN_STATUS;

try {
  if (destination) {
    const input = [];
    for await (const chunk of process.stdin) input.push(chunk);
    const { hook_event_name: event, session_id: sessionId, turn_id: turnId } = JSON.parse(Buffer.concat(input).toString('utf8'));
    if (events.has(event) && typeof sessionId === 'string' && typeof turnId === 'string' && sessionId && turnId) {
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify({ sessionId, turnId, event }), { mode: 0o600, flag: 'wx' });
        renameSync(temporary, destination);
      } finally {
        rmSync(temporary, { force: true });
      }
    }
  }
} catch {
  // Telemetry must not block a turn or leak hook input into Codex output.
}
process.stdout.write('{}\n');

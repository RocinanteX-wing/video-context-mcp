import { VcmError } from '../errors.js';

/** Parse "H:MM:SS", "MM:SS", "90", "90.5", or "90s" into milliseconds. */
export function parseTimestamp(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) {
      throw new VcmError('UNSUPPORTED_URL', `Invalid timestamp: ${input}`);
    }
    return Math.round(input * 1000);
  }
  const s = input.trim().replace(/s$/i, '');
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{2}(?:\.\d+)?)$/);
  if (!m) {
    throw new VcmError(
      'UNSUPPORTED_URL',
      `Invalid timestamp "${input}". Use seconds (90), MM:SS (1:30), or H:MM:SS (1:02:30).`,
    );
  }
  const h = m[1] ? Number(m[1]) : 0;
  const min = Number(m[2]);
  const sec = Number(m[3]);
  return Math.round(((h * 60 + min) * 60 + sec) * 1000);
}

/** Format milliseconds as "M:SS" or "H:MM:SS". */
export function formatMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

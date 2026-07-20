import { z } from 'zod';
import { VcmError, toToolError } from '../errors.js';
import { formatMs, parseTimestamp } from '../utils/time.js';
import { type Deps, getVideoRow, ingestStateNote, textResult } from './shared.js';

export const name = 'get_transcript';

export const description =
  'Timestamped transcript of an ingested video, optionally sliced to a time range. Timestamps ' +
  'accept seconds (90), MM:SS (1:30), or H:MM:SS (1:02:30). Output is capped; if truncated, the ' +
  'response says where to resume. Prefer slicing to ranges found via search_videos or the timeline.';

export const inputSchema = {
  video_id: z.string().describe('The video_id returned by ingest_video'),
  start: z
    .union([z.string(), z.number()])
    .optional()
    .describe('Start of range (default: beginning)'),
  end: z.union([z.string(), z.number()]).optional().describe('End of range (default: end)'),
};

const MAX_CHARS = 30_000;

export function handler(deps: Deps) {
  return async (args: { video_id: string; start?: string | number; end?: string | number }) => {
    try {
      const row = getVideoRow(deps.db, args.video_id);
      const note = ingestStateNote(row, deps.ingest);

      const startMs = args.start !== undefined ? parseTimestamp(args.start) : 0;
      const endMs = args.end !== undefined ? parseTimestamp(args.end) : Number.MAX_SAFE_INTEGER;
      if (endMs < startMs) {
        throw new VcmError(
          'UNSUPPORTED_URL',
          `Invalid range: end (${formatMs(endMs)}) is before start (${formatMs(startMs)}).`,
        );
      }
      const segments = deps.db
        .prepare(
          `SELECT start_ms, end_ms, text FROM segments
           WHERE video_id = ? AND end_ms >= ? AND start_ms <= ?
           ORDER BY start_ms`,
        )
        .all(row.id, startMs, endMs) as { start_ms: number; end_ms: number; text: string }[];

      if (segments.length === 0) {
        return textResult(
          `No transcript segments in range for ${row.id}. The video may have no captions (check get_ingest_status) or the range may be outside its duration.${note ? `\n${note}` : ''}`,
        );
      }

      const lines: string[] = [];
      let chars = 0;
      let truncatedAt: number | null = null;
      for (const seg of segments) {
        const line = `[${formatMs(seg.start_ms)}] ${seg.text}`;
        if (chars + line.length > MAX_CHARS) {
          truncatedAt = seg.start_ms;
          break;
        }
        lines.push(line);
        chars += line.length + 1;
      }
      if (truncatedAt !== null) {
        lines.push(
          '',
          `[TRUNCATED at ${formatMs(truncatedAt)}] Call get_transcript again with start="${formatMs(truncatedAt)}" to continue.`,
        );
      }
      if (note) lines.push('', note);
      return textResult(lines.join('\n'));
    } catch (err) {
      return toToolError(err);
    }
  };
}

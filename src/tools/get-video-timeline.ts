import { z } from 'zod';
import { toToolError } from '../errors.js';
import { formatMs } from '../utils/time.js';
import { type Deps, getVideoRow, requireDone, textResult } from './shared.js';

export const name = 'get_video_timeline';

export const description =
  'Compact overview of an ingested video: title, duration, chapters, and a sampled transcript ' +
  'outline (no images, low token cost). Use this first to orient, then get_transcript for full ' +
  'text of a time range or search_videos to jump to specific content.';

export const inputSchema = {
  video_id: z.string().describe('The video_id returned by ingest_video'),
};

const OUTLINE_BUCKETS = 12;
const OUTLINE_CHARS = 110;

export function handler(deps: Deps) {
  return async (args: { video_id: string }) => {
    try {
      const row = getVideoRow(deps.db, args.video_id);
      requireDone(row, deps.ingest);

      const chapters = deps.db
        .prepare('SELECT start_ms, title FROM chapters WHERE video_id = ? ORDER BY start_ms')
        .all(row.id) as { start_ms: number; title: string }[];
      const segments = deps.db
        .prepare('SELECT start_ms, end_ms, text FROM segments WHERE video_id = ? ORDER BY start_ms')
        .all(row.id) as { start_ms: number; end_ms: number; text: string }[];

      const frameClasses = deps.db
        .prepare(
          'SELECT class, COUNT(*) AS n FROM frames WHERE video_id = ? GROUP BY class ORDER BY n DESC',
        )
        .all(row.id) as { class: string | null; n: number }[];

      const lines: string[] = [];
      const dur = row.duration_s ? formatMs(row.duration_s * 1000) : '?';
      const whisperUsed =
        segments.length > 0 &&
        (
          deps.db.prepare('SELECT source FROM segments WHERE video_id = ? LIMIT 1').get(row.id) as
            | { source: string }
            | undefined
        )?.source === 'whisper';
      const caps = row.captions_lang
        ? `captions: ${row.captions_lang}${row.captions_auto ? ' (auto)' : ''}`
        : whisperUsed
          ? 'transcript: local whisper ASR'
          : 'no captions';
      const totalFrames = frameClasses.reduce((s, c) => s + c.n, 0);
      const framesDesc =
        totalFrames > 0
          ? `${totalFrames} keyframes (${frameClasses.map((c) => `${c.n} ${c.class ?? '?'}`).join(', ')})`
          : 'no keyframes';
      lines.push(
        `# ${row.title ?? row.id}${row.channel ? ` — ${row.channel}` : ''}`,
        `video_id: ${row.id} · duration: ${dur} · ${caps} · ${segments.length} transcript segments · ${framesDesc}`,
        '',
      );

      if (chapters.length > 0) {
        lines.push('## Chapters');
        for (const ch of chapters) lines.push(`[${formatMs(ch.start_ms)}] ${ch.title}`);
        lines.push('');
      }

      if (segments.length > 0) {
        lines.push('## Transcript outline (sampled)');
        const lastMs = segments[segments.length - 1]!.end_ms;
        const bucketMs = Math.max(1, Math.ceil(lastMs / OUTLINE_BUCKETS));
        let nextBucketStart = 0;
        for (const seg of segments) {
          if (seg.start_ms >= nextBucketStart) {
            const t =
              seg.text.length > OUTLINE_CHARS ? `${seg.text.slice(0, OUTLINE_CHARS)}…` : seg.text;
            lines.push(`[${formatMs(seg.start_ms)}] ${t}`);
            nextBucketStart = seg.start_ms + bucketMs;
          }
        }
        lines.push(
          '',
          `Use get_transcript(video_id, start, end) for full text of any range${totalFrames > 0 ? ', peek_frame(video_id, timestamp) to see the screen.' : '.'}`,
        );
      } else {
        lines.push('No transcript available for this video (no captions).');
      }

      return textResult(lines.join('\n'));
    } catch (err) {
      return toToolError(err);
    }
  };
}

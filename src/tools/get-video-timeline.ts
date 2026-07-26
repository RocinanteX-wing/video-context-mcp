import { z } from 'zod';
import { capabilitiesSchema, loadCapabilities, publicSource, sourceSchema } from '../domain.js';
import { VcmError, toToolError } from '../errors.js';
import { formatMs } from '../utils/time.js';
import { type Deps, getVideoRow, ingestStateNote, textResult } from './shared.js';

export const name = 'get_video_timeline';

export const description =
  'Compact overview of an ingested video: structured metadata plus a Markdown view with chapters ' +
  'and a sampled transcript outline (no images, low token cost). Use this first to orient, then ' +
  'get_transcript for full text of a time range or search_videos to jump to specific content.';

export const inputSchema = {
  video_id: z.string().describe('The video_id returned by ingest_video'),
};

export const outputSchema = {
  video_id: z.string(),
  title: z.string(),
  source: sourceSchema,
  creator: z.string().nullable(),
  published_at: z.string().nullable(),
  duration_seconds: z.number().nonnegative().nullable(),
  capabilities: capabilitiesSchema,
  captions: z
    .object({
      language: z.string(),
      automatic: z.boolean(),
    })
    .nullable(),
  transcript: z.object({
    source: z.enum(['captions', 'whisper']).nullable(),
    segment_count: z.number().int().nonnegative(),
  }),
  chapters: z.array(
    z.object({
      title: z.string(),
      start_seconds: z.number().nonnegative(),
      timestamp: z.string(),
    }),
  ),
  outline: z.array(
    z.object({
      start_seconds: z.number().nonnegative(),
      timestamp: z.string(),
      text: z.string(),
    }),
  ),
  frames: z.object({
    total: z.number().int().nonnegative(),
    by_class: z.array(
      z.object({
        class: z.string().nullable(),
        count: z.number().int().nonnegative(),
      }),
    ),
  }),
  stage: z.string(),
  state_note: z.string().nullable(),
};

const OUTLINE_BUCKETS = 12;
const OUTLINE_CHARS = 110;

export function handler(deps: Deps) {
  return async (args: { video_id: string }) => {
    try {
      const row = getVideoRow(deps.db, args.video_id);
      deps.cache.touchVideo(row.id);
      const note = ingestStateNote(row, deps.ingest);
      if (row.title === null) {
        // Nothing usable yet — not even metadata has landed.
        throw new VcmError('STAGE_NOT_READY', note ?? `Video ${row.id} has no data yet.`);
      }

      const chapters = deps.db
        .prepare('SELECT start_ms, title FROM chapters WHERE video_id = ? ORDER BY start_ms')
        .all(row.id) as { start_ms: number; title: string }[];
      const segments = deps.db
        .prepare(
          'SELECT start_ms, end_ms, text, source FROM segments WHERE video_id = ? ORDER BY start_ms',
        )
        .all(row.id) as {
        start_ms: number;
        end_ms: number;
        text: string;
        source: 'captions' | 'whisper';
      }[];
      const frameClasses = deps.db
        .prepare(
          'SELECT class, COUNT(*) AS n FROM frames WHERE video_id = ? GROUP BY class ORDER BY n DESC',
        )
        .all(row.id) as { class: string | null; n: number }[];

      const transcriptSource = segments[0]?.source ?? null;
      const whisperUsed = transcriptSource === 'whisper';
      const caps = row.captions_lang
        ? `captions: ${row.captions_lang}${row.captions_auto ? ' (auto)' : ''}`
        : whisperUsed
          ? 'transcript: local whisper ASR'
          : 'no captions';
      const totalFrames = frameClasses.reduce((sum, item) => sum + item.n, 0);
      const framesDesc =
        totalFrames > 0
          ? `${totalFrames} keyframes (${frameClasses.map((item) => `${item.n} ${item.class ?? '?'}`).join(', ')})`
          : 'no keyframes';
      const outline: { start_seconds: number; timestamp: string; text: string }[] = [];
      if (segments.length > 0) {
        const lastMs = segments[segments.length - 1]!.end_ms;
        const bucketMs = Math.max(1, Math.ceil(lastMs / OUTLINE_BUCKETS));
        let nextBucketStart = 0;
        for (const segment of segments) {
          if (segment.start_ms < nextBucketStart) continue;
          const text =
            segment.text.length > OUTLINE_CHARS
              ? `${segment.text.slice(0, OUTLINE_CHARS)}…`
              : segment.text;
          outline.push({
            start_seconds: segment.start_ms / 1000,
            timestamp: formatMs(segment.start_ms),
            text,
          });
          nextBucketStart = segment.start_ms + bucketMs;
        }
      }

      const lines: string[] = [];
      const duration = row.duration_s !== null ? formatMs(row.duration_s * 1000) : '?';
      lines.push(
        `# ${row.title}${row.channel ? ` — ${row.channel}` : ''}`,
        `video_id: ${row.id} · duration: ${duration} · ${caps} · ${segments.length} transcript segments · ${framesDesc}`,
        '',
      );

      if (chapters.length > 0) {
        lines.push('## Chapters');
        for (const chapter of chapters) {
          lines.push(`[${formatMs(chapter.start_ms)}] ${chapter.title}`);
        }
        lines.push('');
      }

      if (outline.length > 0) {
        lines.push('## Transcript outline (sampled)');
        for (const item of outline) lines.push(`[${item.timestamp}] ${item.text}`);
        lines.push(
          '',
          `Use get_transcript(video_id, start, end) for full text of any range${totalFrames > 0 ? ', peek_frame(video_id, timestamp) to see the screen.' : '.'}`,
        );
      } else {
        lines.push('No transcript available for this video (no captions).');
      }

      if (note) lines.push('', note);
      return {
        ...textResult(lines.join('\n')),
        structuredContent: {
          video_id: row.id,
          title: row.title,
          source: publicSource(row),
          creator: row.channel,
          published_at: row.upload_date,
          duration_seconds: row.duration_s,
          capabilities: loadCapabilities(deps.db, row),
          captions: row.captions_lang
            ? { language: row.captions_lang, automatic: Boolean(row.captions_auto) }
            : null,
          transcript: { source: transcriptSource, segment_count: segments.length },
          chapters: chapters.map((chapter) => ({
            title: chapter.title,
            start_seconds: chapter.start_ms / 1000,
            timestamp: formatMs(chapter.start_ms),
          })),
          outline,
          frames: {
            total: totalFrames,
            by_class: frameClasses.map((item) => ({ class: item.class, count: item.n })),
          },
          stage: row.stage,
          state_note: note,
        },
      };
    } catch (err) {
      return toToolError(err);
    }
  };
}

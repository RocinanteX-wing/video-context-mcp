import { z } from 'zod';
import { toToolError } from '../errors.js';
import { type Deps, getVideoRow, jsonResult, segmentCount } from './shared.js';

export const name = 'get_ingest_status';

export const description =
  'Check ingestion progress for a video. Returns the current pipeline stage (metadata → ' +
  'transcript → done), progress percent, what is already queryable, and an actionable error ' +
  'message if ingestion failed.';

export const inputSchema = {
  video_id: z.string().describe('The video_id returned by ingest_video'),
};

export function handler(deps: Deps) {
  return async (args: { video_id: string }) => {
    try {
      const row = getVideoRow(deps.db, args.video_id);
      const job = deps.db
        .prepare('SELECT stage, progress_pct, updated_at FROM jobs WHERE video_id = ?')
        .get(args.video_id) as
        | { stage: string; progress_pct: number; updated_at: string }
        | undefined;
      const segments = segmentCount(deps.db, args.video_id);
      const frames = (
        deps.db
          .prepare('SELECT COUNT(*) AS n FROM frames WHERE video_id = ?')
          .get(args.video_id) as {
          n: number;
        }
      ).n;
      const ocrBlocks = (
        deps.db
          .prepare(
            'SELECT COUNT(*) AS n FROM ocr_blocks b JOIN frames f ON f.id = b.frame_id WHERE f.video_id = ?',
          )
          .get(args.video_id) as { n: number }
      ).n;

      const notes: string[] = [];
      if (row.stage === 'error') {
        notes.push(`Ingest failed [${row.error_code}]: ${row.error_detail}`);
      }
      if (row.stage === 'done' && row.error_code) {
        notes.push(
          `Ingest completed with warnings: ${row.error_detail}. Everything else is usable; re-ingest with force=true to retry the failed sub-stage(s).`,
        );
      }
      const maxFrameWidth = (
        deps.db
          .prepare('SELECT MAX(width) AS w FROM frames WHERE video_id = ?')
          .get(args.video_id) as { w: number | null }
      ).w;
      if (
        row.kind === 'youtube' &&
        row.stage === 'done' &&
        frames > 0 &&
        (maxFrameWidth ?? 0) < 800
      ) {
        notes.push(
          `Keyframes are low-resolution (${maxFrameWidth}px wide — YouTube is currently serving only progressive 360p to this yt-dlp session, a SABR streaming restriction). OCR on dense text like code will be degraded; peek_frame images are still readable for large text. Re-ingesting later or updating yt-dlp may restore 720p.`,
        );
      }
      if (row.stage === 'done' && segments > 0 && row.embedded_count === null) {
        notes.push(
          'This video predates semantic search — search_videos uses full-text only for it. Re-ingest with force=true to embed.',
        );
      }
      if (row.stage === 'done' && segments === 0) {
        const opts = JSON.parse(row.opts_json ?? '{}') as { whisperFallback?: boolean };
        const source =
          row.kind === 'local'
            ? 'Local files have no captions'
            : 'Video has no captions in any language';
        notes.push(
          opts.whisperFallback
            ? `${source} and whisper transcription produced no segments (see warnings above if any).`
            : `${source}, so transcript/search are empty. Re-ingest with whisper_fallback=true (and force=true) to transcribe locally with whisper.`,
        );
      }

      return jsonResult({
        video_id: row.id,
        title: row.title,
        stage: row.stage,
        progress_pct: job?.progress_pct ?? 0,
        running: deps.ingest.isRunning(row.id),
        available: {
          metadata: row.title !== null,
          transcript: segments > 0,
          segments,
          frames,
          ocr_blocks: ocrBlocks,
          vectors: row.embedded_count,
        },
        captions: row.captions_lang
          ? { lang: row.captions_lang, auto: Boolean(row.captions_auto) }
          : null,
        transcript_source:
          (
            deps.db
              .prepare('SELECT source FROM segments WHERE video_id = ? LIMIT 1')
              .get(args.video_id) as { source: string } | undefined
          )?.source ?? null,
        error: row.error_code ? { code: row.error_code, detail: row.error_detail } : null,
        notes,
      });
    } catch (err) {
      return toToolError(err);
    }
  };
}

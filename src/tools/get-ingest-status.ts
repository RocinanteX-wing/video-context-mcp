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
          `Transcript is ready, but visual indexing failed [${row.error_code}]: ${row.error_detail}. Re-ingest with force=true to retry frames+OCR.`,
        );
      }
      const maxFrameWidth = (
        deps.db
          .prepare('SELECT MAX(width) AS w FROM frames WHERE video_id = ?')
          .get(args.video_id) as { w: number | null }
      ).w;
      if (row.stage === 'done' && frames > 0 && (maxFrameWidth ?? 0) < 800) {
        notes.push(
          `Keyframes are low-resolution (${maxFrameWidth}px wide — YouTube is currently serving only progressive 360p to this yt-dlp session, a SABR streaming restriction). OCR on dense text like code will be degraded; peek_frame images are still readable for large text. Re-ingesting later or updating yt-dlp may restore 720p.`,
        );
      }
      if (row.stage === 'done' && segments === 0) {
        notes.push(
          row.kind === 'local'
            ? 'Local file indexed (metadata only). Transcription of caption-less media (whisper_fallback) is not yet implemented.'
            : 'Video has no captions in any language. whisper_fallback transcription is not yet implemented, so transcript/search are empty for this video.',
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
        },
        captions: row.captions_lang
          ? { lang: row.captions_lang, auto: Boolean(row.captions_auto) }
          : null,
        error: row.error_code ? { code: row.error_code, detail: row.error_detail } : null,
        notes,
      });
    } catch (err) {
      return toToolError(err);
    }
  };
}

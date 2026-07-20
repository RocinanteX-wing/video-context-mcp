import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import { VcmError } from '../errors.js';
import type { IngestManager } from '../pipeline/ingest.js';

export interface Deps {
  db: Database.Database;
  config: Config;
  ingest: IngestManager;
}

export interface VideoRow {
  id: string;
  kind: string;
  source_url: string;
  title: string | null;
  channel: string | null;
  duration_s: number | null;
  captions_lang: string | null;
  captions_auto: number | null;
  ingested_at: string | null;
  stage: string;
  error_code: string | null;
  error_detail: string | null;
  opts_json: string;
}

export function textResult(text: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text }] };
}

export function jsonResult(obj: unknown): { content: { type: 'text'; text: string }[] } {
  return textResult(JSON.stringify(obj, null, 1));
}

export function getVideoRow(db: Database.Database, videoId: string): VideoRow {
  const row = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId) as VideoRow | undefined;
  if (!row) {
    throw new VcmError(
      'NOT_INGESTED',
      `No video with id "${videoId}" in the index. Call ingest_video with the URL first, or list_videos to see what is available.`,
    );
  }
  return row;
}

/** Gate tools that need a finished ingest; explains how to proceed otherwise. */
export function requireDone(row: VideoRow, ingest: IngestManager): void {
  if (row.stage === 'done') return;
  if (row.stage === 'error') {
    throw new VcmError(
      'STAGE_NOT_READY',
      `Ingest of ${row.id} failed [${row.error_code}]: ${row.error_detail ?? 'unknown'}. Fix the cause and re-run ingest_video with force=true.`,
    );
  }
  const running = ingest.isRunning(row.id);
  throw new VcmError(
    'STAGE_NOT_READY',
    `Video ${row.id} is still ingesting (stage=${row.stage}${running ? '' : ', stalled'}). Poll get_ingest_status and retry when stage=done.`,
  );
}

export function segmentCount(db: Database.Database, videoId: string): number {
  const r = db.prepare('SELECT COUNT(*) AS n FROM segments WHERE video_id = ?').get(videoId) as {
    n: number;
  };
  return r.n;
}

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

const DETAIL_MAX = 300;

/**
 * Ingest-state note for partial or stale results, or null when the video is
 * fully ingested with no warnings. Tools serve whatever data exists and
 * append this so the agent knows what it is looking at — a mid-ingest video's
 * transcript is usable the moment its rows land, without waiting for frames.
 */
export function ingestStateNote(row: VideoRow, ingest: IngestManager): string | null {
  const detail = (row.error_detail ?? 'unknown').slice(0, DETAIL_MAX);
  if (row.stage === 'done') {
    return row.error_code ? `Note: ingest completed with warnings: ${detail}` : null;
  }
  if (row.stage === 'error') {
    return `Note: the last ingest FAILED [${row.error_code}]: ${detail}. Any data shown is from an earlier successful ingest. Re-run ingest_video with force=true.`;
  }
  const running = ingest.isRunning(row.id);
  return `Note: ingest in progress (stage=${row.stage}${running ? '' : ' — stalled; re-run ingest_video with force=true'}); results may be partial.`;
}

export function segmentCount(db: Database.Database, videoId: string): number {
  const r = db.prepare('SELECT COUNT(*) AS n FROM segments WHERE video_id = ?').get(videoId) as {
    n: number;
  };
  return r.n;
}

export interface FrameRow {
  id: number;
  video_id: string;
  ts_ms: number;
  path: string;
  width: number;
  height: number;
  class: string | null;
}

/** Nearest indexed keyframe to a timestamp; throws with guidance if none exist. */
export function nearestFrame(db: Database.Database, videoId: string, tsMs: number): FrameRow {
  const frame = db
    .prepare('SELECT * FROM frames WHERE video_id = ? ORDER BY ABS(ts_ms - ?) LIMIT 1')
    .get(videoId, tsMs) as FrameRow | undefined;
  if (!frame) {
    throw new VcmError(
      'STAGE_NOT_READY',
      `No keyframes indexed for ${videoId}. Visual indexing may have been skipped (visual=false), failed (check get_ingest_status), or is still running. Re-ingest with force=true to retry.`,
    );
  }
  return frame;
}

/** OCR blocks of a frame with bboxes normalized to 0..1 of the frame. */
export function frameOcrBlocks(
  db: Database.Database,
  frame: FrameRow,
): { text: string; bbox: [number, number, number, number]; conf: number }[] {
  const rows = db
    .prepare('SELECT text, bbox_json, conf FROM ocr_blocks WHERE frame_id = ? ORDER BY id')
    .all(frame.id) as { text: string; bbox_json: string | null; conf: number }[];
  return rows.map((r) => {
    const px = (r.bbox_json ? JSON.parse(r.bbox_json) : [0, 0, 0, 0]) as number[];
    const n = (v: number, d: number) => Math.round((v / d) * 1000) / 1000;
    return {
      text: r.text,
      bbox: [
        n(px[0] ?? 0, frame.width),
        n(px[1] ?? 0, frame.height),
        n(px[2] ?? 0, frame.width),
        n(px[3] ?? 0, frame.height),
      ] as [number, number, number, number],
      conf: r.conf,
    };
  });
}

export function imageContent(base64: string): { type: 'image'; data: string; mimeType: string } {
  return { type: 'image', data: base64, mimeType: 'image/jpeg' };
}

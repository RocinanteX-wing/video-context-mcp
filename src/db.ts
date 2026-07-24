import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const SQLITE_BUSY_TIMEOUT_MS = 5000;

export type Stage =
  | 'pending'
  | 'setup'
  | 'metadata'
  | 'transcript'
  | 'whisper'
  | 'frames'
  | 'ocr'
  | 'embed'
  | 'done'
  | 'error';

/** Ordered pipeline stages (whisper/frames/ocr/embed are conditional). */
export const PIPELINE_STAGES: Stage[] = [
  'metadata',
  'transcript',
  'whisper',
  'frames',
  'ocr',
  'embed',
];

const SCHEMA_V1 = `
CREATE TABLE videos (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  source_url TEXT NOT NULL,
  title TEXT,
  channel TEXT,
  duration_s REAL,
  captions_lang TEXT,
  captions_auto INTEGER,
  ingested_at TEXT,
  stage TEXT NOT NULL DEFAULT 'pending',
  error_code TEXT,
  error_detail TEXT,
  opts_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE jobs (
  video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  progress_pct REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE segments (
  id INTEGER PRIMARY KEY,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'captions'
);
CREATE INDEX idx_segments_video ON segments(video_id, start_ms);

CREATE TABLE chapters (
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  start_ms INTEGER NOT NULL,
  title TEXT NOT NULL
);
CREATE INDEX idx_chapters_video ON chapters(video_id, start_ms);

-- Phase 2 tables, created up front so the schema is stable.
CREATE TABLE frames (
  id INTEGER PRIMARY KEY,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  ts_ms INTEGER NOT NULL,
  path TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  scene_score REAL,
  class TEXT
);
CREATE INDEX idx_frames_video ON frames(video_id, ts_ms);

CREATE TABLE ocr_blocks (
  id INTEGER PRIMARY KEY,
  frame_id INTEGER NOT NULL REFERENCES frames(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  bbox_json TEXT,
  conf REAL
);

CREATE VIRTUAL TABLE segments_fts USING fts5(
  text,
  content='segments',
  content_rowid='id',
  tokenize='porter unicode61'
);
CREATE TRIGGER segments_ai AFTER INSERT ON segments BEGIN
  INSERT INTO segments_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER segments_ad AFTER DELETE ON segments BEGIN
  INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER segments_au AFTER UPDATE ON segments BEGIN
  INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO segments_fts(rowid, text) VALUES (new.id, new.text);
END;
`;

export function openDb(cacheDir: string): Database.Database {
  mkdirSync(cacheDir, { recursive: true });
  const db = new Database(join(cacheDir, 'index.sqlite'), { timeout: SQLITE_BUSY_TIMEOUT_MS });
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

const SCHEMA_V2 = `
CREATE VIRTUAL TABLE ocr_fts USING fts5(
  text,
  content='ocr_blocks',
  content_rowid='id',
  tokenize='porter unicode61'
);
CREATE TRIGGER ocr_ai AFTER INSERT ON ocr_blocks BEGIN
  INSERT INTO ocr_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER ocr_ad AFTER DELETE ON ocr_blocks BEGIN
  INSERT INTO ocr_fts(ocr_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER ocr_au AFTER UPDATE ON ocr_blocks BEGIN
  INSERT INTO ocr_fts(ocr_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO ocr_fts(rowid, text) VALUES (new.id, new.text);
END;
`;

function migrate(db: Database.Database): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version < 1) {
    db.transaction(() => {
      db.exec(SCHEMA_V1);
      db.pragma('user_version = 1');
    })();
  }
  if (version < 2) {
    db.transaction(() => {
      db.exec(SCHEMA_V2);
      db.pragma('user_version = 2');
    })();
  }
  if (version < 3) {
    // External-content FTS tables only index rows written AFTER their triggers
    // exist — rebuild so rows that predate a migration become searchable.
    db.transaction(() => {
      db.exec(`
        INSERT INTO segments_fts(segments_fts) VALUES('rebuild');
        INSERT INTO ocr_fts(ocr_fts) VALUES('rebuild');
      `);
      db.pragma('user_version = 3');
    })();
  }
  if (version < 4) {
    // NULL = never embedded (semantic search unavailable for the video).
    db.transaction(() => {
      db.exec('ALTER TABLE videos ADD COLUMN embedded_count INTEGER');
      db.pragma('user_version = 4');
    })();
  }
  if (version < 5) {
    db.transaction(() => {
      db.exec('ALTER TABLE jobs ADD COLUMN progress_detail TEXT');
      db.pragma('user_version = 5');
    })();
  }
  if (version < 6) {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE videos ADD COLUMN last_accessed_at TEXT;
        ALTER TABLE videos ADD COLUMN asset_bytes INTEGER;
        ALTER TABLE videos ADD COLUMN vector_bytes INTEGER NOT NULL DEFAULT 0;
        CREATE INDEX idx_videos_lru
          ON videos(stage, last_accessed_at, ingested_at);

        CREATE TABLE cache_gc (
          video_id TEXT PRIMARY KEY,
          title TEXT,
          reason TEXT NOT NULL,
          files_pending INTEGER NOT NULL DEFAULT 1,
          vectors_pending INTEGER NOT NULL DEFAULT 1,
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at TEXT NOT NULL,
          claimed_by TEXT,
          lease_until_ms INTEGER
        );
      `);
      db.pragma('user_version = 6');
    })();
  }
  if (version < 7) {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE jobs ADD COLUMN owner_id TEXT;
        ALTER TABLE jobs ADD COLUMN lease_until_ms INTEGER;
      `);
      db.pragma('user_version = 7');
    })();
  }
  if (version < 8) {
    db.transaction(() => {
      db.exec('ALTER TABLE videos ADD COLUMN upload_date TEXT');
      db.pragma('user_version = 8');
    })();
  }
}

/**
 * Mark videos that were mid-ingest when a previous server process died.
 * Called once at startup, before any new jobs begin.
 */
export function markInterruptedJobs(db: Database.Database, nowMs = Date.now()): number {
  return db.transaction(() => {
    const res = db
      .prepare(
        `UPDATE videos AS v
         SET stage = 'error',
             error_code = 'INGEST_INTERRUPTED',
             error_detail = 'The ingest owner exited or its lease expired. Re-run ingest_video with force=true.'
         WHERE v.stage NOT IN ('done', 'error')
           AND NOT EXISTS (
             SELECT 1 FROM jobs j
             WHERE j.video_id = v.id AND j.lease_until_ms > ?
           )`,
      )
      .run(nowMs);
    db.prepare(
      `UPDATE jobs
       SET stage = 'error', progress_pct = 0, progress_detail = NULL,
           owner_id = NULL, lease_until_ms = NULL, updated_at = ?
       WHERE video_id IN (
         SELECT id FROM videos
         WHERE stage = 'error' AND error_code = 'INGEST_INTERRUPTED'
       )`,
    ).run(new Date(nowMs).toISOString());
    return res.changes;
  })();
}

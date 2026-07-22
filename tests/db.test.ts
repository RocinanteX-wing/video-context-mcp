import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { markInterruptedJobs, openDb } from '../src/db.js';

describe('db', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vcm-db-'));
    db = openDb(dir);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function insertVideo(id: string, stage = 'done'): void {
    db.prepare("INSERT INTO videos (id, kind, source_url, stage) VALUES (?, 'youtube', ?, ?)").run(
      id,
      `https://www.youtube.com/watch?v=${id}`,
      stage,
    );
  }

  it('migrates a fresh database and is idempotent on reopen', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(6);
    db.close();
    db = openDb(dir); // second open must not re-run DDL
    expect(db.pragma('user_version', { simple: true })).toBe(6);
    const columns = db.pragma('table_info(jobs)') as { name: string }[];
    expect(columns.some((column) => column.name === 'progress_detail')).toBe(true);
    const videoColumns = db.pragma('table_info(videos)') as { name: string }[];
    expect(videoColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['last_accessed_at', 'asset_bytes', 'vector_bytes']),
    );
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cache_gc'").get(),
    ).toBeDefined();
  });

  it('upgrades an existing v4 database through cache lifecycle v6', () => {
    db.close();
    rmSync(join(dir, 'index.sqlite'), { force: true });
    const legacy = new Database(join(dir, 'index.sqlite'));
    legacy.exec(`
      CREATE TABLE videos (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, source_url TEXT NOT NULL,
        title TEXT, channel TEXT, duration_s REAL, captions_lang TEXT,
        captions_auto INTEGER, ingested_at TEXT, stage TEXT NOT NULL DEFAULT 'pending',
        error_code TEXT, error_detail TEXT, opts_json TEXT NOT NULL DEFAULT '{}',
        embedded_count INTEGER
      );
      CREATE TABLE jobs (
        video_id TEXT PRIMARY KEY, stage TEXT NOT NULL,
        progress_pct REAL NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
      );
    `);
    legacy.pragma('user_version = 4');
    legacy.close();

    db = openDb(dir);
    expect(db.pragma('user_version', { simple: true })).toBe(6);
    const columns = db.pragma('table_info(jobs)') as { name: string }[];
    expect(columns.some((column) => column.name === 'progress_detail')).toBe(true);
    const videoColumns = db.pragma('table_info(videos)') as { name: string }[];
    expect(videoColumns.some((column) => column.name === 'last_accessed_at')).toBe(true);
  });

  it('FTS rebuild makes pre-trigger rows searchable (migration v3 mechanism)', () => {
    insertVideo('vidRebuild01');
    const frameId = db
      .prepare(
        "INSERT INTO frames (video_id, ts_ms, path, width, height) VALUES ('vidRebuild01', 0, '/x/f.jpg', 100, 100)",
      )
      .run().lastInsertRowid;
    db.prepare(
      "INSERT INTO ocr_blocks (frame_id, text, conf) VALUES (?, 'searchable words', 90)",
    ).run(frameId);
    // Simulate a row that predates the FTS triggers by deleting its index entry.
    const blockId = (
      db.prepare('SELECT id FROM ocr_blocks WHERE frame_id = ?').get(frameId) as {
        id: number;
      }
    ).id;
    db.prepare(
      "INSERT INTO ocr_fts(ocr_fts, rowid, text) VALUES ('delete', ?, 'searchable words')",
    ).run(blockId);
    expect(
      db.prepare('SELECT rowid FROM ocr_fts WHERE ocr_fts MATCH ?').all('searchable'),
    ).toHaveLength(0);
    db.exec("INSERT INTO ocr_fts(ocr_fts) VALUES('rebuild')");
    expect(
      db.prepare('SELECT rowid FROM ocr_fts WHERE ocr_fts MATCH ?').all('searchable'),
    ).toHaveLength(1);
  });

  it('ocr_fts follows ocr_blocks inserts and cascade deletes (v2)', () => {
    insertVideo('vid00000003');
    const frameId = db
      .prepare(
        "INSERT INTO frames (video_id, ts_ms, path, width, height, class) VALUES ('vid00000003', 5000, '/x/f.jpg', 1280, 720, 'code')",
      )
      .run().lastInsertRowid;
    db.prepare('INSERT INTO ocr_blocks (frame_id, text, bbox_json, conf) VALUES (?, ?, ?, 90)').run(
      frameId,
      'const server = express()',
      '[0,0,100,20]',
    );
    const hit = db
      .prepare(
        'SELECT f.ts_ms FROM ocr_fts JOIN ocr_blocks b ON b.id = ocr_fts.rowid JOIN frames f ON f.id = b.frame_id WHERE ocr_fts MATCH ?',
      )
      .get('express') as { ts_ms: number } | undefined;
    expect(hit?.ts_ms).toBe(5000);

    db.prepare('DELETE FROM videos WHERE id = ?').run('vid00000003'); // cascades frames → ocr_blocks
    expect(
      db.prepare('SELECT rowid FROM ocr_fts WHERE ocr_fts MATCH ?').all('express'),
    ).toHaveLength(0);
  });

  it('FTS index follows segment inserts and deletes', () => {
    insertVideo('vid00000001');
    db.prepare(
      "INSERT INTO segments (video_id, start_ms, end_ms, text) VALUES ('vid00000001', 0, 1000, 'the redis cache layer')",
    ).run();
    const hit = db
      .prepare(
        'SELECT s.video_id FROM segments_fts JOIN segments s ON s.id = segments_fts.rowid WHERE segments_fts MATCH ?',
      )
      .get('redis') as { video_id: string } | undefined;
    expect(hit?.video_id).toBe('vid00000001');

    db.prepare('DELETE FROM videos WHERE id = ?').run('vid00000001'); // cascades to segments
    const gone = db
      .prepare('SELECT rowid FROM segments_fts WHERE segments_fts MATCH ?')
      .all('redis');
    expect(gone).toHaveLength(0);
  });

  it('porter stemming matches word variants', () => {
    insertVideo('vid00000002');
    db.prepare(
      "INSERT INTO segments (video_id, start_ms, end_ms, text) VALUES ('vid00000002', 0, 1000, 'configuring the caches')",
    ).run();
    const hits = db
      .prepare('SELECT rowid FROM segments_fts WHERE segments_fts MATCH ?')
      .all('cache configure');
    expect(hits.length).toBe(1);
  });

  it('marks mid-ingest videos as interrupted on startup', () => {
    insertVideo('vidDone0001', 'done');
    insertVideo('vidStuck001', 'transcript');
    const changed = markInterruptedJobs(db);
    expect(changed).toBe(1);
    const row = db
      .prepare('SELECT stage, error_code FROM videos WHERE id = ?')
      .get('vidStuck001') as {
      stage: string;
      error_code: string;
    };
    expect(row.stage).toBe('error');
    expect(row.error_code).toBe('INGEST_INTERRUPTED');
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
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
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    db.close();
    db = openDb(dir); // second open must not re-run DDL
    expect(db.pragma('user_version', { simple: true })).toBe(1);
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

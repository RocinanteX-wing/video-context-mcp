/**
 * Deterministic IngestManager tests (no network): generational re-ingest
 * preservation and atomic transcript replacement.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { resolveRef } from '../src/ids.js';
import { IngestManager } from '../src/pipeline/ingest.js';

const WHISPER_VTT = `WEBVTT

00:00:01.000 --> 00:00:04.000
brand new whisper transcript
`;

describe('IngestManager', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vcm-ing-'));
    db = openDb(dir);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function seedDoneVideo(id: string, source: string): void {
    db.prepare(
      `INSERT INTO videos (id, kind, source_url, title, captions_lang, captions_auto, stage)
       VALUES (?, 'local', ?, 'old title', 'en', 0, 'done')`,
    ).run(id, source);
    db.prepare(
      "INSERT INTO segments (video_id, start_ms, end_ms, text, source) VALUES (?, 0, 1000, 'precious old transcript', 'captions')",
    ).run(id);
    db.prepare("INSERT INTO chapters (video_id, start_ms, title) VALUES (?, 0, 'old chapter')").run(
      id,
    );
  }

  it('force re-ingest failure preserves the last good index', async () => {
    const file = join(dir, 'video.mp4');
    writeFileSync(file, 'fake video bytes for hashing');
    const ref = resolveRef(file);
    seedDoneVideo(ref.id, file);

    // ffprobe is unfindable → metadata stage hard-fails.
    const config = loadConfig({
      VCM_CACHE_DIR: dir,
      VCM_FFPROBE_BIN: '/nonexistent/vcm-test-ffprobe',
    });
    const mgr = new IngestManager(db, config);
    const res = mgr.start(file, { force: true, visual: false });
    expect(res.videoId).toBe(ref.id);
    await mgr.drain();

    const row = db
      .prepare('SELECT stage, error_code, title, captions_lang FROM videos WHERE id = ?')
      .get(ref.id) as { stage: string; error_code: string; title: string; captions_lang: string };
    expect(row.stage).toBe('error');
    expect(row.error_code).toBe('BINARY_MISSING');
    // The previous generation is untouched.
    expect(row.title).toBe('old title');
    expect(row.captions_lang).toBe('en');
    const seg = db.prepare('SELECT text FROM segments WHERE video_id = ?').get(ref.id) as {
      text: string;
    };
    expect(seg.text).toBe('precious old transcript');
    const ch = db.prepare('SELECT title FROM chapters WHERE video_id = ?').get(ref.id) as {
      title: string;
    };
    expect(ch.title).toBe('old chapter');
  });

  it('applyTranscript atomically replaces segments and reconciles caption metadata', () => {
    const id = 'vidSwapTest1';
    seedDoneVideo(id, 'https://www.youtube.com/watch?v=vidSwapTest1');
    const config = loadConfig({ VCM_CACHE_DIR: dir });
    const mgr = new IngestManager(db, config);

    const n = mgr.applyTranscript(id, WHISPER_VTT, 'whisper', null);
    expect(n).toBe(1);

    const segs = db
      .prepare('SELECT text, source FROM segments WHERE video_id = ? ORDER BY start_ms')
      .all(id) as { text: string; source: string }[];
    expect(segs).toEqual([{ text: 'brand new whisper transcript', source: 'whisper' }]);

    // Stale caption metadata is cleared on the captions→whisper transition.
    const row = db
      .prepare('SELECT captions_lang, captions_auto FROM videos WHERE id = ?')
      .get(id) as { captions_lang: string | null; captions_auto: number | null };
    expect(row.captions_lang).toBeNull();
    expect(row.captions_auto).toBeNull();

    // FTS follows the swap: old text gone, new text searchable.
    expect(
      db.prepare('SELECT rowid FROM segments_fts WHERE segments_fts MATCH ?').all('precious'),
    ).toHaveLength(0);
    expect(
      db.prepare('SELECT rowid FROM segments_fts WHERE segments_fts MATCH ?').all('whisper'),
    ).toHaveLength(1);
  });
});

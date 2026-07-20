/**
 * Network-gated end-to-end test: ingest a real, captioned YouTube video and
 * exercise timeline → transcript → search. Run with `just e2e` (sets VCM_E2E=1).
 * Requires yt-dlp on PATH and network access; skipped otherwise.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { IngestManager } from '../src/pipeline/ingest.js';

// "Me at the zoo" — first YouTube video, 19s, stable, has captions.
const VIDEO = 'jNQXAC9IVRw';

describe.skipIf(!process.env.VCM_E2E)('e2e: real YouTube ingest', () => {
  let dir: string;
  let db: ReturnType<typeof openDb>;
  let ingest: IngestManager;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vcm-e2e-'));
    const config = loadConfig({ ...process.env, VCM_CACHE_DIR: dir });
    db = openDb(dir);
    ingest = new IngestManager(db, config);
  });

  afterAll(() => {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('ingests metadata and transcript end-to-end', { timeout: 120_000 }, async () => {
    const start = ingest.start(VIDEO);
    expect(start.videoId).toBe(VIDEO);
    await ingest.drain();

    const row = db.prepare('SELECT * FROM videos WHERE id = ?').get(VIDEO) as {
      stage: string;
      title: string;
      duration_s: number;
      error_detail: string | null;
    };
    expect(row.error_detail).toBeNull();
    expect(row.stage).toBe('done');
    expect(row.title.toLowerCase()).toContain('zoo');
    expect(row.duration_s).toBeGreaterThan(10);

    const segs = db.prepare('SELECT COUNT(*) AS n FROM segments WHERE video_id = ?').get(VIDEO) as {
      n: number;
    };
    expect(segs.n).toBeGreaterThan(0);

    const hit = db
      .prepare(
        'SELECT s.start_ms FROM segments_fts JOIN segments s ON s.id = segments_fts.rowid WHERE segments_fts MATCH ? AND s.video_id = ?',
      )
      .get('elephants', VIDEO);
    expect(hit).toBeDefined();
  });
});

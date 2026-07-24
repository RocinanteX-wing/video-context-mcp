/**
 * Network-gated end-to-end test: ingest a real, captioned YouTube video and
 * exercise timeline → transcript → search. Run with `just e2e` (sets VCM_E2E=1).
 * Uses the managed yt-dlp bootstrap and network access; skipped otherwise.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CacheManager } from '../src/cache.js';
import { type Config, loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { IngestManager } from '../src/pipeline/ingest.js';
import * as searchVideos from '../src/tools/search-videos.js';

// "Me at the zoo" — first YouTube video, 19s, stable, has captions.
const VIDEO = 'jNQXAC9IVRw';

describe.skipIf(!process.env.VCM_E2E)('e2e: real YouTube ingest', () => {
  let dir: string;
  let db: ReturnType<typeof openDb>;
  let ingest: IngestManager;
  let cache: CacheManager;
  let config: Config;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vcm-e2e-'));
    config = loadConfig({ ...process.env, VCM_CACHE_DIR: dir });
    db = openDb(dir);
    cache = new CacheManager(db, config);
    ingest = new IngestManager(db, config, cache);
  });

  afterAll(() => {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('ingests metadata, transcript, and embeddings end-to-end', { timeout: 180_000 }, async () => {
    const start = ingest.start(VIDEO, { visual: false, embed: true });
    expect(start.videoId).toBe(VIDEO);
    await ingest.drain();

    const row = db.prepare('SELECT * FROM videos WHERE id = ?').get(VIDEO) as {
      stage: string;
      title: string;
      duration_s: number;
      upload_date: string | null;
      embedded_count: number | null;
      error_detail: string | null;
    };
    expect(row.error_detail).toBeNull();
    expect(row.stage).toBe('done');
    expect(row.title.toLowerCase()).toContain('zoo');
    expect(row.duration_s).toBeGreaterThan(10);
    expect(row.upload_date).toBe('2005-04-24');
    expect(row.embedded_count).toBeGreaterThan(0);

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

    const searched = await searchVideos.handler({ db, config, ingest, cache })({
      query: 'elephants',
      video_id: VIDEO,
    });
    const searchText = searched.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
    expect(searchText).toContain(VIDEO);
    expect(searchText).not.toContain('semantic search unavailable');

    const released = await cache.releaseVideo(VIDEO);
    expect(released.cleanupPending).toBe(false);
    expect(db.prepare('SELECT id FROM videos WHERE id = ?').get(VIDEO)).toBeUndefined();
    expect(
      db.prepare('SELECT rowid FROM segments_fts WHERE segments_fts MATCH ?').all('elephants'),
    ).toHaveLength(0);
    expect(existsSync(join(dir, VIDEO))).toBe(false);
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CacheCleanupOps, CacheManager } from '../src/cache.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import type { VcmError } from '../src/errors.js';

const MIB = 1024 ** 2;

describe('cache lifecycle', () => {
  let dir: string;
  let db: Database.Database;
  let cleanup: CacheCleanupOps;
  let cache: CacheManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vcm-cache-lifecycle-'));
    db = openDb(dir);
    cleanup = {
      removeVideoDir: vi.fn(async () => undefined),
      deleteVectors: vi.fn(async () => undefined),
      optimizeVectors: vi.fn(async () => undefined),
    };
    const config = loadConfig({
      VCM_CACHE_DIR: dir,
      VCM_MAX_CACHE_GB: String((1000 * MIB) / 1024 ** 3),
    });
    cache = new CacheManager(db, config, cleanup);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function insertVideo(id: string, assetMb: number, lastAccessedAt: string, stage = 'done'): void {
    db.prepare(
      `INSERT INTO videos
         (id, kind, source_url, title, stage, ingested_at, last_accessed_at, asset_bytes)
       VALUES (?, 'youtube', ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      `https://www.youtube.com/watch?v=${id}`,
      id,
      stage,
      lastAccessedAt,
      lastAccessedAt,
      assetMb * MIB,
    );
  }

  it('evicts whole videos by LRU until the 90% low-water mark', async () => {
    insertVideo('oldVideo001', 450, '2025-01-01T00:00:00.000Z');
    insertVideo('midVideo001', 450, '2025-02-01T00:00:00.000Z');
    insertVideo('newVideo001', 450, '2025-03-01T00:00:00.000Z');

    const report = await cache.maintain({ reason: 'manual' });

    expect(report.released.map((video) => video.videoId)).toEqual(['oldVideo001']);
    expect(report.afterBytes).toBe(900 * MIB);
    expect(db.prepare('SELECT id FROM videos ORDER BY id').all()).toEqual([
      { id: 'midVideo001' },
      { id: 'newVideo001' },
    ]);
    expect(cleanup.deleteVectors).toHaveBeenCalledWith('oldVideo001', expect.anything());
    expect(db.prepare('SELECT * FROM cache_gc').all()).toHaveLength(0);
  });

  it('dry-runs without mutation and protects the just-completed oversized video', async () => {
    insertVideo('oldVideo002', 400, '2025-01-01T00:00:00.000Z');
    insertVideo('hugeVideo01', 1200, '2025-03-01T00:00:00.000Z');

    const preview = await cache.maintain({
      reason: 'manual',
      protectIds: ['hugeVideo01'],
      dryRun: true,
    });
    expect(preview.candidates.map((video) => video.videoId)).toEqual(['oldVideo002']);
    expect(preview.unresolvedOverageBytes).toBe(200 * MIB);
    expect(db.prepare('SELECT id FROM videos').all()).toHaveLength(2);
    expect(cleanup.removeVideoDir).not.toHaveBeenCalled();

    const applied = await cache.maintain({
      reason: 'post_ingest',
      protectIds: ['hugeVideo01'],
    });
    expect(applied.released.map((video) => video.videoId)).toEqual(['oldVideo002']);
    expect(applied.unresolvedOverageBytes).toBe(200 * MIB);
    expect(cache.warning('hugeVideo01')).toContain('video alone exceeds');
  });

  it('uses actual query access to refresh LRU order', async () => {
    insertVideo('wasOld00001', 600, '2025-01-01T00:00:00.000Z');
    insertVideo('wasNew00001', 600, '2025-02-01T00:00:00.000Z');
    cache.touchVideo('wasOld00001', true);

    const preview = await cache.maintain({ reason: 'manual', dryRun: true });
    expect(preview.candidates.map((video) => video.videoId)).toEqual(['wasNew00001']);
  });

  it('makes deletion logically immediate and retries failed physical cleanup', async () => {
    insertVideo('retryVideo01', 10, '2025-01-01T00:00:00.000Z');
    cleanup.removeVideoDir = vi.fn(async () => {
      throw new Error('permission denied');
    });

    const first = await cache.releaseVideo('retryVideo01');
    expect(first.cleanupPending).toBe(true);
    expect(db.prepare('SELECT id FROM videos WHERE id = ?').get('retryVideo01')).toBeUndefined();
    expect(db.prepare('SELECT files_pending, vectors_pending FROM cache_gc').get()).toEqual({
      files_pending: 1,
      vectors_pending: 0,
    });

    cleanup.removeVideoDir = vi.fn(async () => undefined);
    db.prepare(
      'UPDATE cache_gc SET claimed_by = NULL, lease_until_ms = NULL WHERE video_id = ?',
    ).run('retryVideo01');
    const retried = await cache.releaseVideo('retryVideo01');
    expect(retried.alreadyReleased).toBe(true);
    expect(retried.cleanupPending).toBe(false);
    expect(db.prepare('SELECT * FROM cache_gc').all()).toHaveLength(0);
  });

  it('refuses to release an active ingest', async () => {
    insertVideo('activeVid001', 10, '2025-01-01T00:00:00.000Z', 'frames');
    await expect(cache.releaseVideo('activeVid001')).rejects.toMatchObject<Partial<VcmError>>({
      code: 'STAGE_NOT_READY',
    });
    expect(db.prepare('SELECT id FROM videos WHERE id = ?').get('activeVid001')).toBeDefined();
  });

  it('excludes shared runtimes and models from the video quota', () => {
    const runtime = join(dir, 'runtime');
    const transformers = join(dir, 'transformers');
    mkdirSync(runtime, { recursive: true });
    mkdirSync(transformers, { recursive: true });
    writeFileSync(join(runtime, 'tool'), Buffer.alloc(2048));
    writeFileSync(join(transformers, 'model'), Buffer.alloc(4096));

    const snapshot = cache.snapshot(true);
    expect(snapshot.videoBytes).toBe(0);
    expect(snapshot.sharedBytes).toBe(6144);
    expect(snapshot.totalPhysicalBytes).toBeGreaterThan(snapshot.sharedBytes);
  });
});

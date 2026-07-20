/**
 * ffmpeg-gated integration tests: real frame extraction on a synthetic
 * two-scene video, opening-frame capture, and OCR-independent frame rows
 * (missing tesseract must degrade to unclassified frames, not zero frames).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { resolveRef } from '../src/ids.js';
import { extractFrames } from '../src/pipeline/frames.js';
import { IngestManager } from '../src/pipeline/ingest.js';

function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasFfmpeg())('visual pipeline (real ffmpeg)', () => {
  let dir: string;
  let db: Database.Database;
  let videoPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vcm-vis-'));
    db = openDb(dir);
    videoPath = join(dir, 'two-scene.mp4');
    // 6s red then 6s blue — one hard scene cut at t=6.
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=red:s=320x240:d=6:r=10',
      '-f',
      'lavfi',
      '-i',
      'color=blue:s=320x240:d=6:r=10',
      '-filter_complex',
      '[0:v][1:v]concat=n=2:v=1:a=0',
      '-pix_fmt',
      'yuv420p',
      videoPath,
    ]);
  });

  afterAll(() => {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('captures the opening frame AND the scene cut', { timeout: 60_000 }, async () => {
    const config = loadConfig({
      VCM_CACHE_DIR: dir,
      VCM_MIN_FRAME_GAP_S: '2',
      VCM_MAX_FRAMES: '10',
    });
    const videoDir = join(dir, 'extract-test');
    const frames = await extractFrames(videoPath, videoDir, config, 12);
    expect(frames.length).toBeGreaterThanOrEqual(2);
    // Opening frame at (or effectively at) t=0 — the scene filter alone would miss it.
    expect(frames[0]!.tsMs).toBeLessThanOrEqual(500);
    // The cut to blue at ~6s is captured.
    expect(frames.some((f) => f.tsMs > 5000 && f.tsMs < 7500)).toBe(true);
  });

  it(
    'missing tesseract degrades to unclassified frames, not zero frames',
    { timeout: 120_000 },
    async () => {
      const config = loadConfig({
        VCM_CACHE_DIR: dir,
        VCM_MIN_FRAME_GAP_S: '2',
        VCM_TESSERACT_BIN: '/nonexistent/vcm-test-tesseract',
      });
      const mgr = new IngestManager(db, config);
      const ref = resolveRef(videoPath);
      mgr.start(videoPath, { visual: true });
      await mgr.drain();

      const row = db
        .prepare('SELECT stage, error_code, error_detail FROM videos WHERE id = ?')
        .get(ref.id) as { stage: string; error_code: string; error_detail: string };
      expect(row.stage).toBe('done');
      expect(row.error_code).toBe('BINARY_MISSING');
      expect(row.error_detail).toContain('tesseract');

      const frames = db
        .prepare('SELECT ts_ms, class FROM frames WHERE video_id = ? ORDER BY ts_ms')
        .all(ref.id) as { ts_ms: number; class: string | null }[];
      expect(frames.length).toBeGreaterThanOrEqual(2);
      expect(frames[0]!.ts_ms).toBeLessThanOrEqual(500);
      expect(frames.every((f) => f.class === null)).toBe(true);
    },
  );
});

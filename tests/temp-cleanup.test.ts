import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanupStaleCacheTemps } from '../src/temp-cleanup.js';

describe('stale cache temp cleanup', () => {
  it('removes abandoned downloads while preserving fresh and completed cache entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vcm-temp-cleanup-'));
    const now = Date.now();
    const old = new Date(now - 10_000);
    const fresh = new Date(now - 100);
    const paths = {
      staleStage: join(dir, 'runtime', '.staging', 'artifact-old'),
      freshStage: join(dir, 'runtime', '.staging', 'artifact-fresh'),
      staleModel: join(dir, 'models', 'ggml.bin.download.100.1'),
      freshModel: join(dir, 'models', 'ggml.bin.download.200.1'),
      completedModel: join(dir, 'models', 'ggml.bin'),
      stalePointer: join(dir, 'runtime', 'active', 'ytdlp.json.100.id.tmp'),
    };

    try {
      for (const path of [
        join(paths.staleStage, 'download'),
        join(paths.freshStage, 'download'),
        paths.staleModel,
        paths.freshModel,
        paths.completedModel,
        paths.stalePointer,
      ]) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, 'partial');
      }
      for (const path of [join(paths.staleStage, 'download'), paths.staleStage]) {
        utimesSync(path, old, old);
      }
      utimesSync(join(paths.freshStage, 'download'), fresh, fresh);
      utimesSync(paths.freshStage, fresh, fresh);
      utimesSync(paths.staleModel, old, old);
      utimesSync(paths.stalePointer, old, old);

      const report = cleanupStaleCacheTemps(dir, now, 5_000);

      expect(report).toEqual({
        runtimeStagingRemoved: 1,
        modelDownloadsRemoved: 1,
        activePointersRemoved: 1,
        failures: 0,
      });
      expect(existsSync(paths.staleStage)).toBe(false);
      expect(existsSync(paths.staleModel)).toBe(false);
      expect(existsSync(paths.stalePointer)).toBe(false);
      expect(existsSync(paths.freshStage)).toBe(true);
      expect(existsSync(paths.freshModel)).toBe(true);
      expect(existsSync(paths.completedModel)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

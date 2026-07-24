import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FeatureExtractionPipeline } from '@huggingface/transformers';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import {
  DEFAULT_EMBED_ARTIFACT,
  type EmbeddingCacheHealth,
  buildEmbedDocs,
  createEmbeddingModelLoader,
  deleteVideoVectors,
  inspectEmbeddingCache,
  isEmbeddingParseFailure,
  loadEmbedFrames,
  optimizeVectors,
  removeInvalidEmbeddingArtifact,
  replaceVideoVectors,
  searchVectors,
} from '../src/pipeline/embed.js';

function cacheHealth(state: EmbeddingCacheHealth['state']): EmbeddingCacheHealth {
  return {
    state,
    model: DEFAULT_EMBED_ARTIFACT.model,
    revision: DEFAULT_EMBED_ARTIFACT.revision,
    path: '/tmp/model_quantized.onnx',
    expectedSize: DEFAULT_EMBED_ARTIFACT.size,
    actualSize: state === 'not_cached' ? null : DEFAULT_EMBED_ARTIFACT.size,
    sha256: state === 'verified' ? DEFAULT_EMBED_ARTIFACT.sha256 : null,
    remediation: state === 'verified' ? null : 'retry',
  };
}

describe('buildEmbedDocs', () => {
  it('builds speech docs from segments and screen docs from OCR-rich frames', () => {
    const docs = buildEmbedDocs(
      [
        { id: 1, start_ms: 0, text: 'hello world of video search' },
        { id: 2, start_ms: 5000, text: '   ' }, // whitespace-only → dropped
      ],
      [
        { id: 10, ts_ms: 1000, ocrText: 'const server = express(); app.listen(3000)' },
        { id: 11, ts_ms: 2000, ocrText: 'LIVE' }, // below screen threshold → dropped
        { id: 12, ts_ms: 3000, ocrText: null },
      ],
    );
    expect(docs).toEqual([
      { id: 'seg-1', kind: 'speech', ts_ms: 0, text: 'hello world of video search' },
      {
        id: 'frame-10',
        kind: 'screen',
        ts_ms: 1000,
        text: 'const server = express(); app.listen(3000)',
      },
    ]);
  });

  it('caps document length', () => {
    const docs = buildEmbedDocs([{ id: 1, start_ms: 0, text: 'x'.repeat(5000) }], []);
    expect(docs[0]!.text.length).toBe(1000);
  });

  it('loads OCR blocks in deterministic insertion order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vcm-embed-frames-'));
    const db = openDb(dir);
    try {
      db.prepare(
        "INSERT INTO videos (id, kind, source_url, stage) VALUES ('embedFrame01', 'youtube', 'https://example.test', 'done')",
      ).run();
      db.prepare(
        "INSERT INTO frames (id, video_id, ts_ms, path) VALUES (20, 'embedFrame01', 2000, '/f2.jpg'), (10, 'embedFrame01', 1000, '/f1.jpg')",
      ).run();
      db.prepare(
        "INSERT INTO ocr_blocks (id, frame_id, text) VALUES (30, 10, 'second line'), (15, 10, 'first line')",
      ).run();

      expect(loadEmbedFrames(db, 'embedFrame01')).toEqual([
        { id: 10, ts_ms: 1000, ocrText: 'first line second line' },
        { id: 20, ts_ms: 2000, ocrText: null },
      ]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deletes and compacts one video without affecting another', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vcm-lance-delete-'));
    const config = loadConfig({ VCM_CACHE_DIR: dir });
    try {
      await replaceVideoVectors(
        'vectorVid01',
        [{ id: 'seg-1', kind: 'speech', ts_ms: 0, text: 'first video' }],
        [[1, 0, 0]],
        config,
      );
      await replaceVideoVectors(
        'vectorVid02',
        [{ id: 'seg-2', kind: 'speech', ts_ms: 0, text: 'second video' }],
        [[0, 1, 0]],
        config,
      );

      expect(await searchVectors([1, 0, 0], 5, config, 'vectorVid01')).toHaveLength(1);
      await deleteVideoVectors('vectorVid01', config);
      await optimizeVectors(config);
      expect(await searchVectors([1, 0, 0], 5, config, 'vectorVid01')).toHaveLength(0);
      expect(await searchVectors([0, 1, 0], 5, config, 'vectorVid02')).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('embedding model cache', () => {
  it('reports missing and truncated default artifacts without loading ONNX', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vcm-embed-health-'));
    const config = loadConfig({ VCM_CACHE_DIR: dir });
    const path = join(
      dir,
      'transformers',
      DEFAULT_EMBED_ARTIFACT.model,
      DEFAULT_EMBED_ARTIFACT.revision,
      DEFAULT_EMBED_ARTIFACT.relativePath,
    );
    try {
      expect(await inspectEmbeddingCache(config)).toMatchObject({
        state: 'not_cached',
        path,
        expectedSize: DEFAULT_EMBED_ARTIFACT.size,
      });
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'truncated model');
      expect(await inspectEmbeddingCache(config)).toMatchObject({
        state: 'invalid',
        path,
        actualSize: 15,
      });
      await removeInvalidEmbeddingArtifact(config);
      expect(await inspectEmbeddingCache(config)).toMatchObject({ state: 'not_cached', path });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never follows cache-internal symlinks while recovering an artifact', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vcm-embed-symlink-'));
    const outside = mkdtempSync(join(tmpdir(), 'vcm-embed-outside-'));
    const config = loadConfig({ VCM_CACHE_DIR: dir });
    const revisionDir = join(
      dir,
      'transformers',
      DEFAULT_EMBED_ARTIFACT.model,
      DEFAULT_EMBED_ARTIFACT.revision,
    );
    const outsideModel = join(outside, 'model_quantized.onnx');
    try {
      mkdirSync(revisionDir, { recursive: true });
      writeFileSync(outsideModel, 'must survive');
      symlinkSync(outside, join(revisionDir, 'onnx'), 'dir');
      expect(await inspectEmbeddingCache(config)).toMatchObject({ state: 'invalid' });
      await expect(removeInvalidEmbeddingArtifact(config)).rejects.toThrow('symbolic link');
      expect(existsSync(outsideModel)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('single-flights concurrent first loads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vcm-embed-loader-'));
    const config = loadConfig({ VCM_CACHE_DIR: dir });
    const fakePipeline = (() => undefined) as unknown as FeatureExtractionPipeline;
    let initializeCount = 0;
    let acquireCount = 0;
    let releaseCount = 0;
    let resolveInitialize!: (pipeline: FeatureExtractionPipeline) => void;
    const initialize = new Promise<FeatureExtractionPipeline>((resolve) => {
      resolveInitialize = resolve;
    });
    const loader = createEmbeddingModelLoader({
      initialize: async () => {
        initializeCount++;
        return initialize;
      },
      inspect: async () => cacheHealth('verified'),
      removeInvalid: async () => undefined,
      acquire: async () => {
        acquireCount++;
        return { release: () => releaseCount++ };
      },
    });

    const first = loader(config);
    const second = loader(config);
    await vi.waitFor(() => expect(initializeCount).toBe(1));
    resolveInitialize(fakePipeline);
    expect(await Promise.all([first, second])).toEqual([fakePipeline, fakePipeline]);
    expect(acquireCount).toBe(1);
    expect(releaseCount).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('removes an invalid artifact and retries one protobuf load failure', async () => {
    const config = loadConfig({ VCM_CACHE_DIR: '/tmp/vcm-embed-recovery-test' });
    const fakePipeline = (() => undefined) as unknown as FeatureExtractionPipeline;
    let state: EmbeddingCacheHealth['state'] = 'verified';
    let initializeCount = 0;
    let removeCount = 0;
    const loader = createEmbeddingModelLoader({
      initialize: async () => {
        initializeCount++;
        if (initializeCount === 1) {
          state = 'invalid';
          throw new Error('Protobuf parsing failed.');
        }
        state = 'verified';
        return fakePipeline;
      },
      inspect: async () => cacheHealth(state),
      removeInvalid: async () => {
        removeCount++;
        state = 'not_cached';
      },
      acquire: async () => ({ release: () => undefined }),
    });

    expect(await loader(config)).toBe(fakePipeline);
    expect(initializeCount).toBe(2);
    expect(removeCount).toBe(1);
  });

  it('does not delete a checksum-valid artifact and clears rejected memoization', async () => {
    const config = loadConfig({ VCM_CACHE_DIR: '/tmp/vcm-embed-valid-retry-test' });
    let initializeCount = 0;
    let removeCount = 0;
    const loader = createEmbeddingModelLoader({
      initialize: async () => {
        initializeCount++;
        throw new Error('Load model failed: Protobuf parsing failed.');
      },
      inspect: async () => cacheHealth('verified'),
      removeInvalid: async () => {
        removeCount++;
      },
      acquire: async () => ({ release: () => undefined }),
    });

    await expect(loader(config)).rejects.toThrow('passed checksum validation');
    await expect(loader(config)).rejects.toThrow('passed checksum validation');
    expect(initializeCount).toBe(4);
    expect(removeCount).toBe(0);
    expect(isEmbeddingParseFailure(new Error('Protobuf parsing failed.'))).toBe(true);
  });
});

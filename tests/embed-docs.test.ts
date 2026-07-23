import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import {
  buildEmbedDocs,
  deleteVideoVectors,
  loadEmbedFrames,
  optimizeVectors,
  replaceVideoVectors,
  searchVectors,
} from '../src/pipeline/embed.js';

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

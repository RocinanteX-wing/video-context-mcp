import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  buildEmbedDocs,
  deleteVideoVectors,
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

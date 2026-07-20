import { describe, expect, it } from 'vitest';
import { buildEmbedDocs } from '../src/pipeline/embed.js';

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
});

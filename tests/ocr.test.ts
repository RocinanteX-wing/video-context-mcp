import { describe, expect, it } from 'vitest';
import { type OcrBlock, classifyFrame, parseTsv } from '../src/pipeline/ocr.js';

const HEADER =
  'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';

function tsvRow(
  level: number,
  block: number,
  par: number,
  line: number,
  word: number,
  left: number,
  top: number,
  w: number,
  h: number,
  conf: number,
  text: string,
): string {
  return [level, 1, block, par, line, word, left, top, w, h, conf, text].join('\t');
}

describe('parseTsv', () => {
  it('groups words into line blocks with union bboxes and mean conf', () => {
    const tsv = [
      HEADER,
      tsvRow(5, 1, 1, 1, 1, 100, 50, 80, 20, 90, 'const'),
      tsvRow(5, 1, 1, 1, 2, 190, 50, 60, 20, 80, 'x'),
      tsvRow(5, 1, 1, 2, 1, 100, 80, 120, 20, 85, 'return'),
    ].join('\n');
    const blocks = parseTsv(tsv);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ text: 'const x', bbox: [100, 50, 250, 70], conf: 85 });
    expect(blocks[1]!.text).toBe('return');
  });

  it('drops low-confidence words and junk lines', () => {
    const tsv = [
      HEADER,
      tsvRow(5, 1, 1, 1, 1, 0, 0, 10, 10, 12, 'noise'), // conf < 30
      tsvRow(5, 1, 1, 2, 1, 0, 0, 10, 10, 95, 'x'), // single char line
      tsvRow(4, 1, 1, 3, 0, 0, 0, 10, 10, -1, ''), // non-word row
    ].join('\n');
    expect(parseTsv(tsv)).toHaveLength(0);
  });
});

describe('classifyFrame', () => {
  const block = (text: string): OcrBlock => ({ text, bbox: [0, 0, 10, 10], conf: 90 });

  it('classifies code frames via code-token density', () => {
    expect(
      classifyFrame([
        block('const app = express();'),
        block('app.get("/", (req, res) => {'),
        block('  return res.json({ ok: true });'),
        block('});'),
      ]),
    ).toBe('code');
  });

  it('classifies prose-heavy frames as slide', () => {
    expect(
      classifyFrame([
        block('Distributed Systems in Practice'),
        block('Consistency models and why they matter for replication'),
        block('Agenda: linearizability, causal ordering, CRDTs'),
      ]),
    ).toBe('slide');
  });

  it('classifies near-empty frames as talking_head', () => {
    expect(classifyFrame([])).toBe('talking_head');
    expect(classifyFrame([block('LIVE')])).toBe('talking_head');
  });

  it('classifies sparse text as other', () => {
    expect(classifyFrame([block('Chapter 3: The Reckoning etc')])).toBe('other');
  });
});

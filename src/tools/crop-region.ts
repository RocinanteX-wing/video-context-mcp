import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { VcmError, toToolError } from '../errors.js';
import { cropFrame } from '../pipeline/frames.js';
import { formatMs, parseTimestamp } from '../utils/time.js';
import {
  type Deps,
  frameOcrBlocks,
  getVideoRow,
  imageContent,
  nearestFrame,
  requireDone,
} from './shared.js';

export const name = 'crop_region';

export const description =
  'Zoom into a sub-region of the keyframe nearest a timestamp (an IDE panel, a diagram, a ' +
  'terminal) for high-density inspection. Returns the cropped image (upscaled up to 2x) plus the ' +
  'OCR text falling inside the region. bbox is [x0,y0,x1,y1] normalized 0..1 — take it from ' +
  'peek_frame OCR output or estimate visually from the peeked frame.';

export const inputSchema = {
  video_id: z.string().describe('The video_id returned by ingest_video'),
  timestamp: z
    .union([z.string(), z.number()])
    .describe('Target time: seconds (90), MM:SS (1:30), or H:MM:SS'),
  bbox: z
    .array(z.number().min(0).max(1))
    .length(4)
    .describe('[x0, y0, x1, y1] normalized to the frame (0,0 = top-left)'),
};

function intersects(
  a: [number, number, number, number],
  b: [number, number, number, number],
): boolean {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

export function handler(deps: Deps) {
  return async (args: { video_id: string; timestamp: string | number; bbox: number[] }) => {
    try {
      const [x0, y0, x1, y1] = args.bbox as [number, number, number, number];
      if (x1 - x0 < 0.01 || y1 - y0 < 0.01) {
        throw new VcmError(
          'UNSUPPORTED_URL',
          'bbox must be [x0,y0,x1,y1] with x1>x0 and y1>y0 (normalized 0..1).',
        );
      }
      const row = getVideoRow(deps.db, args.video_id);
      requireDone(row, deps.ingest);
      const tsMs = parseTimestamp(args.timestamp);
      const frame = nearestFrame(deps.db, row.id, tsMs);

      const tmpPath = join(tmpdir(), `vcm-crop-${process.pid}-${frame.id}.jpg`);
      await cropFrame(
        frame.path,
        tmpPath,
        frame.width,
        frame.height,
        [x0, y0, x1, y1],
        deps.config,
      );
      const base64 = readFileSync(tmpPath).toString('base64');
      rmSync(tmpPath, { force: true });

      const inRegion = frameOcrBlocks(deps.db, frame).filter((b) =>
        intersects(b.bbox, [x0, y0, x1, y1]),
      );
      const lines = [
        `Crop [${x0},${y0},${x1},${y1}] of frame at [${formatMs(frame.ts_ms)}] · class=${frame.class ?? '?'}`,
        ...(inRegion.length > 0
          ? ['', 'OCR inside region:', ...inRegion.map((b) => `- "${b.text}" (conf=${b.conf})`)]
          : ['', 'No OCR text inside this region — read the image directly.']),
      ];
      return { content: [imageContent(base64), { type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      return toToolError(err);
    }
  };
}

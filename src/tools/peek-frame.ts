import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { toToolError } from '../errors.js';
import { reencodeFrame } from '../pipeline/frames.js';
import { formatMs, parseTimestamp } from '../utils/time.js';
import {
  type Deps,
  frameOcrBlocks,
  getVideoRow,
  imageContent,
  ingestStateNote,
  nearestFrame,
} from './shared.js';

export const name = 'peek_frame';

export const description =
  'Fetch the indexed keyframe nearest to a timestamp: the image itself (for you to look at) plus ' +
  'its OCR text with normalized bounding boxes and a rough class (code / slide / talking_head / ' +
  'other). Use after search_videos or the timeline points you at a moment. Set return_image=false ' +
  'for OCR text only (cheaper). For dense on-screen text, follow up with crop_region on a bbox.';

export const inputSchema = {
  video_id: z.string().describe('The video_id returned by ingest_video'),
  timestamp: z
    .union([z.string(), z.number()])
    .describe('Target time: seconds (90), MM:SS (1:30), or H:MM:SS'),
  return_image: z.boolean().optional().describe('Include the frame image (default true)'),
};

const PEEK_WIDTH = 1024;
const NEAR_TOLERANCE_MS = 15_000;
let tmpCounter = 0;

export function handler(deps: Deps) {
  return async (args: { video_id: string; timestamp: string | number; return_image?: boolean }) => {
    try {
      const row = getVideoRow(deps.db, args.video_id);
      deps.cache.touchVideo(row.id);
      const note = ingestStateNote(row, deps.ingest);
      const tsMs = parseTimestamp(args.timestamp);
      const frame = nearestFrame(deps.db, row.id, tsMs);
      const blocks = frameOcrBlocks(deps.db, frame);

      const lines: string[] = [];
      lines.push(
        `Frame at [${formatMs(frame.ts_ms)}] (requested [${formatMs(tsMs)}]) · class=${frame.class ?? '?'} · ${frame.width}x${frame.height}`,
      );
      if (Math.abs(frame.ts_ms - tsMs) > NEAR_TOLERANCE_MS) {
        lines.push(
          `Note: nearest keyframe is ${Math.round(Math.abs(frame.ts_ms - tsMs) / 1000)}s away — the screen likely did not change in between.`,
        );
      }
      if (blocks.length > 0) {
        lines.push('', 'OCR (text @ [x0,y0,x1,y1] normalized):');
        for (const b of blocks) {
          lines.push(`- "${b.text}" @ [${b.bbox.join(',')}] conf=${b.conf}`);
        }
      } else {
        lines.push('', 'No OCR text detected on this frame.');
      }
      if (note) lines.push('', note);

      const content: ({ type: 'text'; text: string } | ReturnType<typeof imageContent>)[] = [];
      if (args.return_image !== false) {
        if (frame.width > PEEK_WIDTH) {
          // Unique name: concurrent peeks of the same frame must not collide.
          const tmpPath = join(tmpdir(), `vcm-peek-${process.pid}-${++tmpCounter}.jpg`);
          try {
            await reencodeFrame(frame.path, tmpPath, PEEK_WIDTH, deps.config);
            content.push(imageContent(readFileSync(tmpPath).toString('base64')));
          } finally {
            rmSync(tmpPath, { force: true });
          }
        } else {
          content.push(imageContent(readFileSync(frame.path).toString('base64')));
        }
      }
      content.push({ type: 'text', text: lines.join('\n') });
      return { content };
    } catch (err) {
      return toToolError(err);
    }
  };
}

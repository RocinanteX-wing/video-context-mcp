import type Database from 'better-sqlite3';
import { z } from 'zod';

export const sourceKindSchema = z.enum(['youtube', 'local']);

export const sourceSchema = z.object({
  kind: sourceKindSchema,
  provider: z.string(),
  locator: z.string(),
});

export const transcriptCapabilitySchema = z.object({
  available: z.boolean(),
  source: z.enum(['captions', 'whisper']).nullable(),
  segment_count: z.number().int().nonnegative(),
});

export const capabilitiesSchema = z.object({
  metadata: z.boolean(),
  transcript: transcriptCapabilitySchema,
  chapters: z.boolean(),
  frames: z.object({ available: z.boolean(), count: z.number().int().nonnegative() }),
  ocr: z.object({ available: z.boolean(), block_count: z.number().int().nonnegative() }),
  semantic_search: z.object({
    available: z.boolean(),
    vector_count: z.number().int().nonnegative(),
  }),
});

export interface PublicSource {
  kind: 'youtube' | 'local';
  provider: string;
  locator: string;
}

export function publicSource(row: { kind: string; source_url: string }): PublicSource {
  const kind = row.kind === 'local' ? 'local' : 'youtube';
  return { kind, provider: kind, locator: row.source_url };
}

export function loadCapabilities(
  db: Database.Database,
  row: { id: string; title: string | null; embedded_count: number | null },
): z.infer<typeof capabilitiesSchema> {
  const segments = db
    .prepare('SELECT COUNT(*) AS n, MIN(source) AS source FROM segments WHERE video_id = ?')
    .get(row.id) as { n: number; source: 'captions' | 'whisper' | null };
  const chapters = db
    .prepare('SELECT COUNT(*) AS n FROM chapters WHERE video_id = ?')
    .get(row.id) as { n: number };
  const frames = db.prepare('SELECT COUNT(*) AS n FROM frames WHERE video_id = ?').get(row.id) as {
    n: number;
  };
  const ocr = db
    .prepare(
      'SELECT COUNT(*) AS n FROM ocr_blocks b JOIN frames f ON f.id = b.frame_id WHERE f.video_id = ?',
    )
    .get(row.id) as { n: number };
  const segmentCount = Number(segments.n);
  const frameCount = Number(frames.n);
  const ocrCount = Number(ocr.n);
  const vectorCount = row.embedded_count ?? 0;
  return {
    metadata: row.title !== null,
    transcript: {
      available: segmentCount > 0,
      source: segments.source,
      segment_count: segmentCount,
    },
    chapters: Number(chapters.n) > 0,
    frames: { available: frameCount > 0, count: frameCount },
    ocr: { available: ocrCount > 0, block_count: ocrCount },
    semantic_search: { available: vectorCount > 0, vector_count: vectorCount },
  };
}

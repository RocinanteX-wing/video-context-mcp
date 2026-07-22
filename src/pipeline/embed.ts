/**
 * Dense embeddings for hybrid search: Transformers.js (ONNX, local CPU) into
 * LanceDB beside the SQLite index. All imports of this module are dynamic —
 * the model runtime never loads unless embedding or semantic search is used.
 *
 * Storage is generational like everything else: a video's vectors are
 * replaced atomically per ingest, keyed by stable row ids (seg-N / frame-N).
 */
import { join } from 'node:path';
import type { FeatureExtractionPipeline } from '@huggingface/transformers';
import type * as lancedbT from '@lancedb/lancedb';
import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import { VcmError } from '../errors.js';

const TABLE = 'chunks';
const BATCH_SIZE = 16;
const MAX_DOC_CHARS = 1000;
const MIN_SCREEN_CHARS = 20;

export interface EmbedDoc {
  id: string;
  kind: 'speech' | 'screen';
  ts_ms: number;
  text: string;
}

export interface VectorHit {
  id: string;
  video_id: string;
  kind: 'speech' | 'screen';
  ts_ms: number;
  text: string;
}

export interface EmbedStats {
  count: number;
  vectorBytes: number;
}

/** Pure doc builder (unit-tested): what gets embedded for a video. */
export function buildEmbedDocs(
  segments: { id: number; start_ms: number; text: string }[],
  frames: { id: number; ts_ms: number; ocrText: string | null }[],
): EmbedDoc[] {
  const docs: EmbedDoc[] = [];
  for (const s of segments) {
    const text = s.text.trim().slice(0, MAX_DOC_CHARS);
    if (text) docs.push({ id: `seg-${s.id}`, kind: 'speech', ts_ms: s.start_ms, text });
  }
  for (const f of frames) {
    const text = (f.ocrText ?? '').trim().slice(0, MAX_DOC_CHARS);
    if (text.length >= MIN_SCREEN_CHARS) {
      docs.push({ id: `frame-${f.id}`, kind: 'screen', ts_ms: f.ts_ms, text });
    }
  }
  return docs;
}

let extractor: FeatureExtractionPipeline | null = null;
let extractorModel = '';
let extractorRevision = '';
let vectorMutationTail: Promise<void> = Promise.resolve();

function serializeVectorMutation<T>(fn: () => Promise<T>): Promise<T> {
  const result = vectorMutationTail.then(fn, fn);
  vectorMutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function loadExtractor(config: Config): Promise<FeatureExtractionPipeline> {
  if (
    extractor &&
    extractorModel === config.embedModel &&
    extractorRevision === config.embedRevision
  ) {
    return extractor;
  }
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = join(config.cacheDir, 'transformers');
  try {
    extractor = (await pipeline('feature-extraction', config.embedModel, {
      dtype: 'q8',
      revision: config.embedRevision,
    })) as FeatureExtractionPipeline;
    extractorModel = config.embedModel;
    extractorRevision = config.embedRevision;
    return extractor;
  } catch (err) {
    throw new VcmError(
      'EMBED_FAILED',
      `Could not load embedding model ${config.embedModel} (${err instanceof Error ? err.message.slice(0, 200) : err}). Semantic search is unavailable; FTS still works.`,
    );
  }
}

export async function warmEmbeddings(config: Config): Promise<void> {
  await loadExtractor(config);
}

export async function embedTexts(texts: string[], config: Config): Promise<number[][]> {
  const pipe = await loadExtractor(config);
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const tensor = await pipe(batch, { pooling: 'mean', normalize: true });
    out.push(...(tensor.tolist() as number[][]));
  }
  return out;
}

function assertSafeId(videoId: string): void {
  if (!/^[\w-]+$/.test(videoId)) {
    throw new VcmError('EMBED_FAILED', `Unsafe video id for vector store: ${videoId}`);
  }
}

async function connect(config: Config): Promise<lancedbT.Connection> {
  const lancedb = await import('@lancedb/lancedb');
  return lancedb.connect(join(config.cacheDir, 'lancedb'));
}

/** Replace a video's vectors with a freshly embedded generation. */
export async function replaceVideoVectors(
  videoId: string,
  docs: EmbedDoc[],
  vectors: number[][],
  config: Config,
): Promise<void> {
  return serializeVectorMutation(async () => {
    assertSafeId(videoId);
    const db = await connect(config);
    const rows = docs.map((d, i) => ({ ...d, video_id: videoId, vector: vectors[i]! }));
    const names = await db.tableNames();
    if (!names.includes(TABLE)) {
      if (rows.length > 0) await db.createTable(TABLE, rows);
      return;
    }
    const table = await db.openTable(TABLE);
    await table.delete(`video_id = '${videoId}'`);
    if (rows.length > 0) await table.add(rows);
  });
}

/** Remove a video's semantic rows. Safe to repeat and a no-op before first embed. */
export async function deleteVideoVectors(videoId: string, config: Config): Promise<void> {
  return serializeVectorMutation(async () => {
    assertSafeId(videoId);
    const db = await connect(config);
    const names = await db.tableNames();
    if (!names.includes(TABLE)) return;
    const table = await db.openTable(TABLE);
    await table.delete(`video_id = '${videoId}'`);
  });
}

/** Compact deleted rows and prune old table versions so disk is actually reclaimed. */
export async function optimizeVectors(config: Config): Promise<void> {
  return serializeVectorMutation(async () => {
    const db = await connect(config);
    const names = await db.tableNames();
    if (!names.includes(TABLE)) return;
    const table = await db.openTable(TABLE);
    await table.optimize({ cleanupOlderThan: new Date() });
  });
}

/** Cheap existence check so search never loads the model pointlessly. */
export async function hasVectors(config: Config): Promise<boolean> {
  try {
    const db = await connect(config);
    return (await db.tableNames()).includes(TABLE);
  } catch {
    return false;
  }
}

/** KNN over the vector table; empty when nothing was ever embedded. */
export async function searchVectors(
  queryVector: number[],
  limit: number,
  config: Config,
  videoId?: string,
): Promise<VectorHit[]> {
  const db = await connect(config);
  const names = await db.tableNames();
  if (!names.includes(TABLE)) return [];
  const table = await db.openTable(TABLE);
  let q = table.search(queryVector).limit(limit);
  if (videoId) {
    assertSafeId(videoId);
    q = q.where(`video_id = '${videoId}'`);
  }
  const rows = (await q.toArray()) as unknown as VectorHit[];
  return rows.map((r) => ({
    id: r.id,
    video_id: r.video_id,
    kind: r.kind,
    ts_ms: r.ts_ms,
    text: r.text,
  }));
}

/** Embed one video's transcript + screen text; returns the doc count. */
export async function embedVideo(
  db: Database.Database,
  videoId: string,
  config: Config,
): Promise<EmbedStats> {
  const segments = db
    .prepare('SELECT id, start_ms, text FROM segments WHERE video_id = ? ORDER BY start_ms')
    .all(videoId) as { id: number; start_ms: number; text: string }[];
  const frames = db
    .prepare(
      `SELECT f.id, f.ts_ms, (SELECT GROUP_CONCAT(b.text, ' ') FROM ocr_blocks b WHERE b.frame_id = f.id) AS ocrText
       FROM frames f WHERE f.video_id = ? ORDER BY f.ts_ms`,
    )
    .all(videoId) as { id: number; ts_ms: number; ocrText: string | null }[];

  const docs = buildEmbedDocs(segments, frames);
  if (docs.length === 0) {
    await replaceVideoVectors(videoId, [], [], config);
    return { count: 0, vectorBytes: 0 };
  }
  const vectors = await embedTexts(
    docs.map((d) => d.text),
    config,
  );
  await replaceVideoVectors(videoId, docs, vectors, config);
  const vectorBytes = vectors.reduce(
    (total, vector, index) =>
      total + vector.length * Float32Array.BYTES_PER_ELEMENT + Buffer.byteLength(docs[index]!.text),
    0,
  );
  return { count: docs.length, vectorBytes };
}

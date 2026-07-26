/**
 * Tool-handler tests against a seeded database: partial-result serving during
 * ingest, range validation, and no-frames guidance.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CacheManager } from '../src/cache.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { IngestManager } from '../src/pipeline/ingest.js';
import * as getIngestStatus from '../src/tools/get-ingest-status.js';
import * as getTranscript from '../src/tools/get-transcript.js';
import * as getVideoTimeline from '../src/tools/get-video-timeline.js';
import * as listVideos from '../src/tools/list-videos.js';
import * as peekFrame from '../src/tools/peek-frame.js';
import * as pruneCache from '../src/tools/prune-cache.js';
import * as repairEmbeddings from '../src/tools/repair-embeddings.js';
import { filterLiveVectorHits, loadLiveVideoTitles } from '../src/tools/search-videos.js';
import type { Deps } from '../src/tools/shared.js';

const VID = 'vidPartial01';

function text(res: { content: { type: string; text?: string }[] }): string {
  return res.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

describe('tool handlers on partial/seeded state', () => {
  let dir: string;
  let db: Database.Database;
  let deps: Deps;
  let embedCalls: number;
  let embedFailure: Error | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vcm-tools-'));
    db = openDb(dir);
    embedCalls = 0;
    embedFailure = null;
    const config = loadConfig({ VCM_CACHE_DIR: dir });
    const cache = new CacheManager(db, config, {
      removeVideoDir: async (path) => rmSync(path, { recursive: true, force: true }),
      deleteVectors: async () => undefined,
      optimizeVectors: async () => undefined,
    });
    deps = {
      db,
      config,
      ingest: new IngestManager(db, config, cache, {
        embedVideo: async () => {
          embedCalls++;
          if (embedFailure) throw embedFailure;
          return { count: 1, vectorBytes: 42 };
        },
      }),
      cache,
    };
    // Mid-ingest video: transcript landed, frames still processing.
    db.prepare(
      `INSERT INTO videos (id, kind, source_url, title, duration_s, captions_lang, captions_auto, stage)
       VALUES (?, 'youtube', 'https://www.youtube.com/watch?v=${VID}', 'Partial Video', 120, 'en', 1, 'frames')`,
    ).run(VID);
    db.prepare(
      "INSERT INTO segments (video_id, start_ms, end_ms, text, source) VALUES (?, 0, 4000, 'early words available now', 'captions')",
    ).run(VID);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('get_transcript serves partial results mid-ingest with a state note', async () => {
    expect(
      (
        db.prepare('SELECT last_accessed_at AS t FROM videos WHERE id = ?').get(VID) as {
          t: string | null;
        }
      ).t,
    ).toBeNull();
    const res = await getTranscript.handler(deps)({ video_id: VID });
    const out = text(res as never);
    expect(out).toContain('early words available now');
    expect(out).toContain('ingest in progress (stage=frames');
    expect((res as { isError?: boolean }).isError).toBeUndefined();
    expect(() =>
      z
        .object(getTranscript.outputSchema)
        .parse((res as { structuredContent: Record<string, unknown> }).structuredContent),
    ).not.toThrow();
    expect((res as { structuredContent: Record<string, unknown> }).structuredContent).toMatchObject(
      {
        video_id: VID,
        delivery: 'inline',
        segment_count: 1,
        truncated: false,
        file_path: null,
      },
    );
    expect(
      (
        db.prepare('SELECT last_accessed_at AS t FROM videos WHERE id = ?').get(VID) as {
          t: string | null;
        }
      ).t,
    ).not.toBeNull();
  });

  it('get_transcript materializes a complete local file and accounts for its lifecycle', async () => {
    db.prepare(
      "INSERT INTO segments (video_id, start_ms, end_ms, text, source) VALUES (?, 5000, 9000, 'later words', 'captions')",
    ).run(VID);

    const res = await getTranscript.handler(deps)({
      video_id: VID,
      start: 0,
      end: 10,
      delivery: 'file',
    });
    const structured = (res as { structuredContent: Record<string, unknown> }).structuredContent;
    expect(() => z.object(getTranscript.outputSchema).parse(structured)).not.toThrow();
    expect(structured).toMatchObject({
      video_id: VID,
      delivery: 'file',
      start_seconds: 0,
      end_seconds: 10,
      segment_count: 2,
      truncated: false,
    });
    const path = structured.file_path as string;
    expect(path).toBe(join(dir, VID, 'exports', 'transcript-0-10000.txt'));
    expect(readFileSync(path, 'utf8')).toBe(
      '[0:00] early words available now\n[0:05] later words\n',
    );
    expect(
      (
        db.prepare('SELECT asset_bytes AS n FROM videos WHERE id = ?').get(VID) as {
          n: number;
        }
      ).n,
    ).toBeGreaterThan(0);

    db.prepare("UPDATE videos SET stage = 'done' WHERE id = ?").run(VID);
    await deps.cache.releaseVideo(VID);
    expect(existsSync(path)).toBe(false);
  });

  it('keeps inline transcript output capped with a structured resume handle', async () => {
    const insert = db.prepare(
      "INSERT INTO segments (video_id, start_ms, end_ms, text, source) VALUES (?, ?, ?, ?, 'captions')",
    );
    insert.run(VID, 5000, 9000, 'a'.repeat(20_000));
    insert.run(VID, 10000, 14000, 'b'.repeat(20_000));

    const res = await getTranscript.handler(deps)({ video_id: VID });
    const structured = (res as { structuredContent: Record<string, unknown> }).structuredContent;
    expect(text(res as never)).toContain('[TRUNCATED at 0:10]');
    expect(structured).toMatchObject({
      delivery: 'inline',
      segment_count: 2,
      truncated: true,
      resume_at_seconds: 10,
      file_path: null,
    });
  });

  it('reports transcript export filesystem failures actionably', async () => {
    writeFileSync(join(dir, VID), 'blocks the per-video cache directory');
    const res = await getTranscript.handler(deps)({ video_id: VID, delivery: 'file' });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(text(res as never)).toContain('[CACHE_WRITE_FAILED]');
    expect(text(res as never)).toContain('VCM_CACHE_DIR');
  });

  it('get_video_timeline serves metadata mid-ingest with a state note', async () => {
    db.prepare('UPDATE videos SET channel = ?, upload_date = ? WHERE id = ?').run(
      'Example Channel',
      '2026-07-24',
      VID,
    );
    db.prepare('INSERT INTO chapters (video_id, start_ms, title) VALUES (?, 30000, ?)').run(
      VID,
      'Second act',
    );
    db.prepare(
      "INSERT INTO frames (video_id, ts_ms, path, width, height, class) VALUES (?, 1000, '/tmp/frame.jpg', 1280, 720, 'code')",
    ).run(VID);
    const res = await getVideoTimeline.handler(deps)({ video_id: VID });
    const out = text(res as never);
    expect(out).toContain('Partial Video');
    expect(out).toContain('ingest in progress');
    const structured = (res as { structuredContent: Record<string, unknown> }).structuredContent;
    expect(() => z.object(getVideoTimeline.outputSchema).parse(structured)).not.toThrow();
    expect(structured).toMatchObject({
      video_id: VID,
      title: 'Partial Video',
      source: {
        kind: 'youtube',
        provider: 'youtube',
        locator: `https://www.youtube.com/watch?v=${VID}`,
      },
      creator: 'Example Channel',
      published_at: '2026-07-24',
      duration_seconds: 120,
      capabilities: {
        metadata: true,
        transcript: { available: true, source: 'captions', segment_count: 1 },
        chapters: true,
        frames: { available: true, count: 1 },
        ocr: { available: false, block_count: 0 },
        semantic_search: { available: false, vector_count: 0 },
      },
      captions: { language: 'en', automatic: true },
      transcript: { source: 'captions', segment_count: 1 },
      chapters: [{ title: 'Second act', start_seconds: 30, timestamp: '0:30' }],
      frames: { total: 1, by_class: [{ class: 'code', count: 1 }] },
      stage: 'frames',
    });
    expect(structured.state_note).toContain('ingest in progress');
  });

  it('get_transcript rejects inverted ranges', async () => {
    const res = await getTranscript.handler(deps)({ video_id: VID, start: '2:00', end: '1:00' });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(text(res as never)).toContain('Invalid range');
  });

  it('repairs embeddings from stored text and preserves unrelated warnings', async () => {
    db.prepare(
      `UPDATE videos SET stage = 'done', embedded_count = NULL,
       error_code = 'VISUAL_FAILED',
       error_detail = '[VISUAL_FAILED] OCR unavailable | [EMBED_FAILED] model load failed'
       WHERE id = ?`,
    ).run(VID);

    const started = JSON.parse(
      text((await repairEmbeddings.handler(deps)({ video_id: VID })) as never),
    ) as Record<string, unknown>;
    expect(started).toMatchObject({
      video_id: VID,
      stage: 'embed',
      cached: false,
      already_running: false,
    });
    await deps.ingest.drain();

    const row = db
      .prepare(
        'SELECT stage, embedded_count, vector_bytes, error_code, error_detail FROM videos WHERE id = ?',
      )
      .get(VID) as Record<string, unknown>;
    expect(embedCalls).toBe(1);
    expect(row).toMatchObject({
      stage: 'done',
      embedded_count: 1,
      vector_bytes: 42,
      error_code: 'VISUAL_FAILED',
      error_detail: '[VISUAL_FAILED] OCR unavailable',
    });
  });

  it('does not rebuild healthy embeddings unless force=true', async () => {
    db.prepare("UPDATE videos SET stage = 'done', embedded_count = 1 WHERE id = ?").run(VID);
    const cached = JSON.parse(
      text((await repairEmbeddings.handler(deps)({ video_id: VID })) as never),
    ) as Record<string, unknown>;
    expect(cached).toMatchObject({ stage: 'done', cached: true });
    expect(embedCalls).toBe(0);

    await repairEmbeddings.handler(deps)({ video_id: VID, force: true });
    await deps.ingest.drain();
    expect(embedCalls).toBe(1);
  });

  it('keeps the video done and full-text-queryable when embedding repair fails', async () => {
    db.prepare("UPDATE videos SET stage = 'done', embedded_count = NULL WHERE id = ?").run(VID);
    embedFailure = new Error('simulated runtime failure');

    await repairEmbeddings.handler(deps)({ video_id: VID });
    await deps.ingest.drain();

    const row = db
      .prepare('SELECT stage, embedded_count, error_code, error_detail FROM videos WHERE id = ?')
      .get(VID) as Record<string, unknown>;
    expect(row).toMatchObject({
      stage: 'done',
      embedded_count: null,
      error_code: 'EMBED_FAILED',
    });
    expect(row.error_detail).toContain('repair_embeddings');
    expect(db.prepare('SELECT text FROM segments WHERE video_id = ?').get(VID)).toBeDefined();
    const status = JSON.parse(
      text((await getIngestStatus.handler(deps)({ video_id: VID })) as never),
    ) as { notes: string[] };
    expect(status.notes.join('\n')).toContain('Use repair_embeddings');
  });

  it('rejects embedding repair until ingestion is complete', async () => {
    const res = await repairEmbeddings.handler(deps)({ video_id: VID });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(text(res as never)).toContain('stage=frames');
    expect(embedCalls).toBe(0);
  });

  it('peek_frame explains missing keyframes actionably', async () => {
    const res = await peekFrame.handler(deps)({ video_id: VID, timestamp: 10 });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(text(res as never)).toContain('No keyframes indexed');
  });

  it('data from an earlier ingest stays served after a failed re-ingest', async () => {
    db.prepare(
      "UPDATE videos SET stage = 'error', error_code = 'NETWORK', error_detail = 'yt-dlp timed out' WHERE id = ?",
    ).run(VID);
    const res = await getTranscript.handler(deps)({ video_id: VID });
    const out = text(res as never);
    expect(out).toContain('early words available now');
    expect(out).toContain('last ingest FAILED [NETWORK]');
  });

  it('reports setup progress detail and split cache accounting', async () => {
    db.prepare(
      "INSERT INTO jobs (video_id, stage, progress_pct, progress_detail, updated_at) VALUES (?, 'setup', 3, 'Downloading FFmpeg', ?)",
    ).run(VID, new Date().toISOString());
    const status = await getIngestStatus.handler(deps)({ video_id: VID });
    const statusJson = JSON.parse(text(status as never)) as {
      progress_pct: number;
      progress_detail: string;
    };
    expect(statusJson).toMatchObject({ progress_pct: 3, progress_detail: 'Downloading FFmpeg' });

    const listed = await listVideos.handler(deps)();
    const listJson = JSON.parse(text(listed as never)) as Record<string, unknown>;
    expect(listJson).toHaveProperty('video_cache_gb');
    expect(listJson).toHaveProperty('runtime_cache_gb');
    expect(listJson).toHaveProperty('budget_gb');
    expect(listJson).toHaveProperty('cleanup_pending');

    const preview = await pruneCache.handler(deps)({});
    const previewJson = JSON.parse(text(preview as never)) as Record<string, unknown>;
    expect(previewJson).toMatchObject({ dry_run: true, candidate_count: 0 });
  });

  it('loads semantic-hit metadata only for live candidate videos', () => {
    const live = loadLiveVideoTitles(db, [
      { video_id: 'deleted0001' },
      { video_id: VID },
      { video_id: VID },
    ]);
    expect([...live]).toEqual([[VID, 'Partial Video']]);
  });

  it('applies prune_cache only when dry_run=false', async () => {
    deps.config.maxCacheGb = 1 / 1024;
    db.prepare(
      `INSERT INTO videos
         (id, kind, source_url, title, stage, ingested_at, last_accessed_at, asset_bytes)
       VALUES ('oldPrune001', 'youtube', 'https://example.test', 'Old', 'done', ?, ?, ?)`,
    ).run('2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', 2 * 1024 ** 2);

    const preview = JSON.parse(text((await pruneCache.handler(deps)({})) as never)) as Record<
      string,
      unknown
    >;
    expect(preview).toMatchObject({ dry_run: true, candidate_count: 1, released_count: 0 });
    expect(db.prepare('SELECT id FROM videos WHERE id = ?').get('oldPrune001')).toBeDefined();

    const applied = JSON.parse(
      text((await pruneCache.handler(deps)({ dry_run: false })) as never),
    ) as Record<string, unknown>;
    expect(applied).toMatchObject({ dry_run: false, released_count: 1 });
    expect(db.prepare('SELECT id FROM videos WHERE id = ?').get('oldPrune001')).toBeUndefined();
  });
});

describe('semantic cache cleanup filtering', () => {
  it('removes stale vector rows before ranking', () => {
    const hits = [
      { video_id: 'deleted0001', id: 'seg-1' },
      { video_id: 'liveVideo01', id: 'seg-2' },
    ];
    expect(filterLiveVectorHits(hits, new Set(['liveVideo01']), 8)).toEqual([hits[1]]);
  });
});

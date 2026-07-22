/**
 * Tool-handler tests against a seeded database: partial-result serving during
 * ingest, range validation, and no-frames guidance.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { filterLiveVectorHits } from '../src/tools/search-videos.js';
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

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vcm-tools-'));
    db = openDb(dir);
    const config = loadConfig({ VCM_CACHE_DIR: dir });
    const cache = new CacheManager(db, config, {
      removeVideoDir: async () => undefined,
      deleteVectors: async () => undefined,
      optimizeVectors: async () => undefined,
    });
    deps = { db, config, ingest: new IngestManager(db, config, cache), cache };
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
    expect(
      (
        db.prepare('SELECT last_accessed_at AS t FROM videos WHERE id = ?').get(VID) as {
          t: string | null;
        }
      ).t,
    ).not.toBeNull();
  });

  it('get_video_timeline serves metadata mid-ingest with a state note', async () => {
    const res = await getVideoTimeline.handler(deps)({ video_id: VID });
    const out = text(res as never);
    expect(out).toContain('Partial Video');
    expect(out).toContain('ingest in progress');
  });

  it('get_transcript rejects inverted ranges', async () => {
    const res = await getTranscript.handler(deps)({ video_id: VID, start: '2:00', end: '1:00' });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(text(res as never)).toContain('Invalid range');
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

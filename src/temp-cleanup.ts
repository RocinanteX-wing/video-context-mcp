import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const STALE_TEMP_MS = 60 * 60_000;

export interface TempCleanupReport {
  runtimeStagingRemoved: number;
  modelDownloadsRemoved: number;
  activePointersRemoved: number;
  failures: number;
}

function newestMtimeMs(path: string): number {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return stat.mtimeMs;
  let newest = stat.mtimeMs;
  for (const entry of readdirSync(path)) {
    newest = Math.max(newest, newestMtimeMs(join(path, entry)));
  }
  return newest;
}

function removeStaleEntries(
  root: string,
  matches: (name: string) => boolean,
  nowMs: number,
  staleMs: number,
): { removed: number; failures: number } {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch (err) {
    return {
      removed: 0,
      failures: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 0 : 1,
    };
  }

  let removed = 0;
  let failures = 0;
  for (const name of names) {
    if (!matches(name)) continue;
    const path = join(root, name);
    try {
      if (nowMs - newestMtimeMs(path) <= staleMs) continue;
      rmSync(path, { recursive: true, force: true });
      removed++;
    } catch {
      failures++;
    }
  }
  return { removed, failures };
}

/** Best-effort reclamation for interrupted downloads; never removes fresh work. */
export function cleanupStaleCacheTemps(
  cacheDir: string,
  nowMs = Date.now(),
  staleMs = STALE_TEMP_MS,
): TempCleanupReport {
  const staging = removeStaleEntries(
    join(cacheDir, 'runtime', '.staging'),
    () => true,
    nowMs,
    staleMs,
  );
  const models = removeStaleEntries(
    join(cacheDir, 'models'),
    (name) => name.includes('.download.'),
    nowMs,
    staleMs,
  );
  const active = removeStaleEntries(
    join(cacheDir, 'runtime', 'active'),
    (name) => name.endsWith('.tmp'),
    nowMs,
    staleMs,
  );
  return {
    runtimeStagingRemoved: staging.removed,
    modelDownloadsRemoved: models.removed,
    activePointersRemoved: active.removed,
    failures: staging.failures + models.failures + active.failures,
  };
}

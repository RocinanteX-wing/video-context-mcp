#!/usr/bin/env node
/**
 * video-context-mcp — model-agnostic MCP server that turns videos into an
 * interactive, queryable knowledge structure (transcript, keyframes, OCR,
 * search) any MCP client model can scrub lazily.
 *
 * stdout is reserved for the MCP stdio transport; all logs go to stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CacheManager } from './cache.js';
import { runCli } from './cli.js';
import { loadConfig } from './config.js';
import { markInterruptedJobs, openDb } from './db.js';
import { IngestManager } from './pipeline/ingest.js';
import * as cropRegion from './tools/crop-region.js';
import * as deleteVideo from './tools/delete-video.js';
import * as getIngestStatus from './tools/get-ingest-status.js';
import * as getTranscript from './tools/get-transcript.js';
import * as getVideoTimeline from './tools/get-video-timeline.js';
import * as ingestVideo from './tools/ingest-video.js';
import * as listVideos from './tools/list-videos.js';
import * as peekFrame from './tools/peek-frame.js';
import * as pruneCache from './tools/prune-cache.js';
import * as searchVideos from './tools/search-videos.js';
import type { Deps } from './tools/shared.js';
import { SERVER_NAME, VERSION } from './version.js';

export function buildServer(deps: Deps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: VERSION });
  for (const tool of [
    ingestVideo,
    getIngestStatus,
    getVideoTimeline,
    getTranscript,
    searchVideos,
    peekFrame,
    cropRegion,
    listVideos,
    deleteVideo,
    pruneCache,
  ]) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      // biome-ignore lint/suspicious/noExplicitAny: each tool validates via its own Zod schema
      tool.handler(deps) as any,
    );
  }
  return server;
}

async function main(): Promise<void> {
  const cliExit = await runCli(process.argv.slice(2));
  if (cliExit !== null) {
    process.exitCode = cliExit;
    return;
  }
  const config = loadConfig();
  const db = openDb(config.cacheDir);
  const interrupted = markInterruptedJobs(db);
  if (interrupted > 0) {
    console.error(`[${SERVER_NAME}] marked ${interrupted} interrupted ingest job(s) as error`);
  }
  const cache = new CacheManager(db, config);
  const ingest = new IngestManager(db, config, cache);
  const deps: Deps = { db, config, ingest, cache };
  const server = buildServer(deps);
  await server.connect(new StdioServerTransport());
  console.error(`[${SERVER_NAME}] v${VERSION} ready (cache: ${config.cacheDir})`);
  void cache.maintain({ reason: 'startup', protectIds: ingest.runningIds() }).catch((err) => {
    console.error(
      `[${SERVER_NAME}] startup cache maintenance failed: ${err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300)}`,
    );
  });
}

main().catch((err) => {
  console.error(`[${SERVER_NAME}] fatal:`, err);
  process.exit(1);
});

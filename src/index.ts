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
import { loadConfig } from './config.js';
import { markInterruptedJobs, openDb } from './db.js';
import { IngestManager } from './pipeline/ingest.js';
import * as deleteVideo from './tools/delete-video.js';
import * as getIngestStatus from './tools/get-ingest-status.js';
import * as getTranscript from './tools/get-transcript.js';
import * as getVideoTimeline from './tools/get-video-timeline.js';
import * as ingestVideo from './tools/ingest-video.js';
import * as listVideos from './tools/list-videos.js';
import * as searchVideos from './tools/search-videos.js';
import type { Deps } from './tools/shared.js';
import { SERVER_NAME, VERSION } from './version.js';

const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-v')) {
  console.log(`${SERVER_NAME} ${VERSION}`);
  process.exit(0);
}
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(
    `${SERVER_NAME} ${VERSION} — MCP server (stdio) for lazy, model-agnostic video understanding.

Usage: video-context-mcp            start the MCP server on stdio
       video-context-mcp --version  print version

Environment: VCM_CACHE_DIR, YTDLP_COOKIES_FILE, VCM_MAX_CACHE_GB,
             VCM_YTDLP_BIN, VCM_FFMPEG_BIN, VCM_FFPROBE_BIN
Requires yt-dlp (and ffmpeg for local files) on PATH.

Register in an MCP client config, e.g.:
  { "mcpServers": { "video-context": { "command": "video-context-mcp" } } }`,
  );
  process.exit(0);
}

export function buildServer(deps: Deps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: VERSION });
  for (const tool of [
    ingestVideo,
    getIngestStatus,
    getVideoTimeline,
    getTranscript,
    searchVideos,
    listVideos,
    deleteVideo,
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
  const config = loadConfig();
  const db = openDb(config.cacheDir);
  const interrupted = markInterruptedJobs(db);
  if (interrupted > 0) {
    console.error(`[${SERVER_NAME}] marked ${interrupted} interrupted ingest job(s) as error`);
  }
  const deps: Deps = { db, config, ingest: new IngestManager(db, config) };
  const server = buildServer(deps);
  await server.connect(new StdioServerTransport());
  console.error(`[${SERVER_NAME}] v${VERSION} ready (cache: ${config.cacheDir})`);
}

main().catch((err) => {
  console.error(`[${SERVER_NAME}] fatal:`, err);
  process.exit(1);
});

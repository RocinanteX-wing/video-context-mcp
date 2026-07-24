#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const VIDEO_ID = 'jNQXAC9IVRw';
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

if (process.argv.includes('--help')) {
  console.log('Usage: npm run demo [-- --prime]');
  console.log('Runs a real, network-gated MCP workflow in an isolated cache.');
  console.log('--prime retains the indexed video in VCM_DEMO_CACHE_DIR for GIF recording.');
  process.exit(0);
}

const temporaryCache = process.env.VCM_DEMO_CACHE_DIR === undefined;
const prime = process.argv.includes('--prime');
if (prime && temporaryCache) {
  throw new Error('--prime requires an explicit VCM_DEMO_CACHE_DIR');
}
const cacheDir = process.env.VCM_DEMO_CACHE_DIR ?? mkdtempSync(join(tmpdir(), 'vcm-demo-'));
const client = new Client({ name: 'video-context-demo', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(REPO, 'dist', 'index.js')],
  env: { ...process.env, VCM_CACHE_DIR: cacheDir },
  stderr: 'inherit',
});

const heading = (label) => console.log(`\n\u001b[1;36m${label}\u001b[0m`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function resultText(result) {
  return result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = resultText(result);
  if (result.isError) throw new Error(`${name}: ${text}`);
  return { result, text };
}

try {
  heading('Connect');
  await client.connect(transport);
  console.log('MCP server ready');

  heading('Ingest a video');
  const ingest = await call('ingest_video', {
    url_or_path: VIDEO_ID,
    visual: false,
    embed: false,
  });
  console.log(ingest.text);

  let lastStage;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const status = await call('get_ingest_status', { video_id: VIDEO_ID });
    const value = JSON.parse(status.text);
    if (value.stage !== lastStage) {
      console.log(`${String(value.progress_pct).padStart(3)}%  ${value.stage}`);
      lastStage = value.stage;
    }
    if (value.stage === 'done') break;
    if (value.stage === 'error') throw new Error(value.error?.detail ?? 'ingest failed');
    await sleep(400);
  }
  if (lastStage !== 'done') throw new Error('ingestion timed out after 120 seconds');

  heading('Orient with the timeline');
  console.log((await call('get_video_timeline', { video_id: VIDEO_ID })).text);

  heading('Read one transcript range');
  console.log((await call('get_transcript', { video_id: VIDEO_ID, start: 0, end: 20 })).text);

  heading('Search by concept');
  console.log((await call('search_videos', { query: 'elephants', video_id: VIDEO_ID })).text);

  if (prime) {
    heading('Demo cache primed');
    console.log('The recording run will reuse this completed index.');
  } else {
    heading('Release the working set');
    console.log((await call('delete_video', { video_id: VIDEO_ID })).text);
  }
} finally {
  await client.close().catch(() => undefined);
  if (temporaryCache) rmSync(cacheDir, { recursive: true, force: true });
}

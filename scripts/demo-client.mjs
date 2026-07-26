#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const VIDEO_ID = 'Sir59K8ZDPU';
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

if (process.argv.includes('--help')) {
  console.log('Usage: npm run demo [-- --prime]');
  console.log('Runs a real, network-gated agent investigation in an isolated cache.');
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
const thought = (text) => console.log(`\n• ${text}`);
const calling = (name) => console.log(`\n• Calling video-context.${name}`);
const called = (text) => console.log(`  └ ${text}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function resultText(result) {
  return result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

function contentKinds(result) {
  return result.content.map((item) => item.type).join(' + ');
}

function excerpt(value, max = 420) {
  const text = value.replaceAll(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = resultText(result);
  if (result.isError) throw new Error(`${name}: ${text}`);
  return { result, text };
}

try {
  thought('Connecting to the local video-context MCP server.');
  await client.connect(transport);
  called('MCP server ready');

  console.log(
    '\n› Can you verify whether a second refund could pass Pydantic validation but fail ontology',
  );
  console.log('  validation? Use the diagram around 18:43 and the refund example around 19:11.');
  console.log('  Give me a plain-English explanation with timestamps.');

  thought('I’ll locate the spoken example, then inspect the diagram it refers to.');
  calling('ingest_video');
  const ingest = await call('ingest_video', {
    url_or_path: VIDEO_ID,
    visual: true,
    embed: true,
  });
  const ingestData = JSON.parse(ingest.text);
  called(
    `{ video_id: "${ingestData.video_id}", stage: "${ingestData.stage}", cached: ${ingestData.cached} }`,
  );

  let lastStage;
  const deadline = Date.now() + 900_000;
  while (Date.now() < deadline) {
    const status = await call('get_ingest_status', { video_id: VIDEO_ID });
    const value = JSON.parse(status.text);
    if (value.stage !== lastStage) {
      called(
        `${String(value.progress_pct).padStart(3)}% ${value.stage}${value.progress_detail ? ` — ${value.progress_detail}` : ''}`,
      );
      lastStage = value.stage;
    }
    if (value.stage === 'done') break;
    if (value.stage === 'error') throw new Error(value.error?.detail ?? 'ingest failed');
    await sleep(400);
  }
  if (lastStage !== 'done') throw new Error('ingestion timed out after 15 minutes');

  thought('The index is ready. I’m searching for the concrete refund violation.');
  calling('search_videos');
  const search = await call('search_videos', {
    query: 'second refund same order payout support representative buyer',
    video_id: VIDEO_ID,
    limit: 6,
  });
  called(
    search.text
      .split('\n')
      .slice(0, 2)
      .map((line) => excerpt(line))
      .join('\n  └ '),
  );

  thought(
    'Now I’m reading the surrounding speech to distinguish type validity from domain validity.',
  );
  calling('get_transcript');
  const transcript = await call('get_transcript', {
    video_id: VIDEO_ID,
    start: '18:14',
    end: '19:29',
  });
  console.log(transcript.text);

  thought('The transcript points to the slide at 18:43, so I’m checking the visual evidence.');
  calling('peek_frame');
  const frame = await call('peek_frame', {
    video_id: VIDEO_ID,
    timestamp: '18:43',
  });
  called(`<${contentKinds(frame.result)}> ${excerpt(frame.text, 260)}`);

  heading('Answer');
  console.log(
    'A possible output is a second refund for an order that has already been refunded. It can pass\n' +
      'Pydantic because the fields are structurally valid: the order ID exists, the amount is a\n' +
      "positive number, and the reason is present. Pydantic does not know the order's history or\n" +
      'business relationships. The ontology adds the domain-consistency check: an order may have\n' +
      'at most one refund [18:14–19:29].',
  );

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

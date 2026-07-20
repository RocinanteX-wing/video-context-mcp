/**
 * Startup test required by the scaffold: the server must answer MCP
 * `initialize` and list its tools over a real stdio transport.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO = join(import.meta.dirname, '..');

describe('MCP server over stdio', () => {
  let client: Client;
  let cacheDir: string;

  beforeAll(async () => {
    cacheDir = mkdtempSync(join(tmpdir(), 'vcm-server-'));
    client = new Client({ name: 'vcm-test-client', version: '0.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(REPO, 'src', 'index.ts')],
      env: { ...process.env, VCM_CACHE_DIR: cacheDir },
      stderr: 'ignore',
    });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('responds to initialize with server info', () => {
    const info = client.getServerVersion();
    expect(info?.name).toBe('video-context-mcp');
  });

  it('lists all Phase 1 tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'crop_region',
      'delete_video',
      'get_ingest_status',
      'get_transcript',
      'get_video_timeline',
      'ingest_video',
      'list_videos',
      'peek_frame',
      'search_videos',
    ]);
  });

  it('list_videos works on an empty index', async () => {
    const res = await client.callTool({ name: 'list_videos', arguments: {} });
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    expect(JSON.parse(text).count).toBe(0);
  });

  it('ingest_video rejects garbage input with an actionable error', async () => {
    const res = await client.callTool({
      name: 'ingest_video',
      arguments: { url_or_path: 'not a video at all' },
    });
    expect(res.isError).toBe(true);
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain('UNSUPPORTED_URL');
  });
});

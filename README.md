# video-context-mcp

Model-agnostic MCP server that turns videos into an **interactive, queryable knowledge structure** — transcript, chapters, keyframes, OCR, and search — that any MCP client model (Claude, GPT, Gemini, local models) can **scrub lazily** instead of receiving a context-flooding dump of keyframes.

Most video tools for agents either lock you to one model provider or eagerly dump dozens of frames into context. `video-context-mcp` treats a video like a filesystem: ingest once, then let the agent pull exactly the slice it needs — a timeline overview, a transcript range, a search hit, (soon) a single frame at a timestamp.

## Requirements

- Node ≥ 20
- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) on PATH (YouTube ingestion)
- `ffmpeg`/`ffprobe` on PATH (local files; keyframes in Phase 2)

## Install & register

```bash
npm install -g @smallthinkingmachines/video-context-mcp
```

**Claude Code / Gemini-style JSON config:**

```json
{
  "mcpServers": {
    "video-context": { "command": "video-context-mcp" }
  }
}
```

**Codex (`~/.codex/config.toml`):**

```toml
[mcp_servers.video-context]
command = "video-context-mcp"
```

## Tools

| Tool | Purpose |
|---|---|
| `ingest_video` | Index a YouTube URL/ID or local file (async job, returns immediately) |
| `get_ingest_status` | Stage, progress, what's queryable, actionable errors |
| `get_video_timeline` | Compact overview: chapters + sampled transcript outline |
| `get_transcript` | Timestamped transcript, sliceable by range |
| `search_videos` | Full-text search across all ingested videos |
| `list_videos` / `delete_video` | Cache inventory and cleanup |

Typical agent flow: `ingest_video` → poll `get_ingest_status` → `get_video_timeline` → `search_videos("the thing I care about")` → `get_transcript(hit ± 30s)`.

## Configuration

All optional (see `.env.example`): `VCM_CACHE_DIR` (default `~/.cache/video-context-mcp`), `YTDLP_COOKIES_FILE` (for age-restricted/members-only videos or YouTube bot checks — export from a logged-in browser), `VCM_MAX_CACHE_GB`, `VCM_YTDLP_BIN`, `VCM_FFMPEG_BIN`, `VCM_FFPROBE_BIN`.

## Roadmap

- **Phase 1 (this release):** metadata + captions transcript + timeline + FTS search
- **Phase 2:** keyframes (ffmpeg scene detection), `peek_frame` / `crop_region` returning images the *client* model interprets (stays model-agnostic), tesseract OCR into search
- **Phase 3:** local whisper fallback for caption-less videos
- **Phase 4:** hybrid dense+lexical search across your video library
- **Phase 5 (experimental):** on-screen code diff reconstruction, diagram→Mermaid, deictic alignment

## Notes

Intended for personal research and note-taking on content you can legitimately access. Caption/metadata fetching uses `yt-dlp`; respect YouTube's Terms of Service and copyright. Cookies are user-supplied and never bundled.

## Development

```bash
just setup   # npm install
just ci      # lint + typecheck + test + build
just e2e     # network-gated end-to-end test against a real video
```

MIT © Small Thinking Machines

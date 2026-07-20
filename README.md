# video-context-mcp

Model-agnostic MCP server that turns videos into an **interactive, queryable knowledge structure** — transcript, chapters, keyframes, OCR, and search — that any MCP client model (Claude, GPT, Gemini, local models) can **scrub lazily** instead of receiving a context-flooding dump of keyframes.

Most video tools for agents either lock you to one model provider or eagerly dump dozens of frames into context. `video-context-mcp` treats a video like a filesystem: ingest once, then let the agent pull exactly the slice it needs — a timeline overview, a transcript range, a search hit, (soon) a single frame at a timestamp.

## Requirements

- Node ≥ 20
- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) on PATH (YouTube ingestion)
- `ffmpeg`/`ffprobe` on PATH (keyframe extraction, local files)
- `tesseract` on PATH (on-screen text OCR; visual indexing degrades gracefully without it)
- `whisper-cli` (whisper.cpp) on PATH for `whisper_fallback` ASR on caption-less videos — the ggml model auto-downloads (~148 MB) on first use, or point `VCM_WHISPER_MODEL` at your own

## Install & register

Not yet published to npm — install from source:

```bash
git clone https://github.com/smallthinkingmachines/video-context-mcp.git
cd video-context-mcp
npm install && npm run build
```

**Claude Code / Gemini-style JSON config:**

```json
{
  "mcpServers": {
    "video-context": {
      "command": "node",
      "args": ["/path/to/video-context-mcp/dist/index.js"]
    }
  }
}
```

**Codex (`~/.codex/config.toml`):**

```toml
[mcp_servers.video-context]
command = "node"
args = ["/path/to/video-context-mcp/dist/index.js"]
```

Once published to npm, `npm install -g @smallthinkingmachines/video-context-mcp` will provide a `video-context-mcp` binary you can use as the `command` directly.

## Tools

| Tool | Purpose |
|---|---|
| `ingest_video` | Index a YouTube URL/ID or local file (async job, returns immediately) |
| `get_ingest_status` | Stage, progress, what's queryable, actionable errors |
| `get_video_timeline` | Compact overview: chapters + sampled transcript outline |
| `get_transcript` | Timestamped transcript, sliceable by range |
| `search_videos` | Hybrid search (full-text + semantic, RRF-fused) over speech AND on-screen text |
| `peek_frame` | The keyframe image nearest a timestamp + its OCR text — *you* look at it |
| `crop_region` | Zoom into a bbox of a frame (IDE panel, diagram) for dense text |
| `list_videos` / `delete_video` | Cache inventory and cleanup |

Typical agent flow: `ingest_video` → poll `get_ingest_status` → `get_video_timeline` → `search_videos("the thing I care about")` → `get_transcript(hit ± 30s)`.

## Configuration

All optional (see `.env.example`): `VCM_CACHE_DIR` (default `~/.cache/video-context-mcp`), `YTDLP_COOKIES_FILE` (for age-restricted/members-only videos or YouTube bot checks — export from a logged-in browser), `VCM_MAX_CACHE_GB`, `VCM_YTDLP_BIN`, `VCM_FFMPEG_BIN`, `VCM_FFPROBE_BIN`.

## Roadmap

- **Phase 1 (shipped):** metadata + captions transcript + timeline + FTS search
- **Phase 2 (shipped):** keyframes (ffmpeg scene detection), `peek_frame` / `crop_region` returning images the *client* model interprets (stays model-agnostic), tesseract OCR into search. Known limitation: YouTube's SABR streaming experiment can cap downloads at 360p, degrading code OCR — surfaced as a note in `get_ingest_status`.
- **Phase 3 (shipped):** local whisper fallback — `ingest_video(…, whisper_fallback=true)` transcribes caption-less videos (and local files) with whisper.cpp; ASR failures downgrade to warnings without sinking the ingest
- **Phase 4 (this release):** hybrid dense+lexical search — ONNX embeddings (`Xenova/all-MiniLM-L6-v2` by default, ~25 MB auto-download, override via `VCM_EMBED_MODEL`) in LanceDB, fused with FTS5 by reciprocal rank. Paraphrase queries ("how do they avoid memory bugs") now match; degrades gracefully to FTS-only if the model is unavailable
- **Phase 5 (experimental):** on-screen code diff reconstruction, diagram→Mermaid, deictic alignment

## Notes

Intended for personal research and note-taking on content you can legitimately access. Caption/metadata fetching uses `yt-dlp`; respect YouTube's Terms of Service and copyright. Cookies are user-supplied and never bundled.

**Trust boundary:** the server trusts its MCP client. In particular, `ingest_video` will read any local file path the client asks for (by design — it's your agent indexing your files), and the cache is plain files on disk. Run it as a local stdio server for clients you control; do not expose it to untrusted clients or over the network without adding your own authorization layer.

## Development

```bash
just setup   # npm install
just ci      # lint + typecheck + test + build
just e2e     # network-gated end-to-end test against a real video
```

MIT © Small Thinking Machines

# MCP tool contract

The MCP responses are the public interface of `video-context-mcp`. SQLite tables,
LanceDB files, and the on-disk cache layout are internal implementation details
and may change between releases.

## Sources and IDs

`ingest_video` accepts a YouTube URL/ID or an existing local video path. The
returned `video_id` is stable for the source: YouTube IDs are used directly;
local files receive a content-derived `local-...` ID.

Metadata responses use this source shape:

```json
{
  "kind": "youtube",
  "provider": "youtube",
  "locator": "https://www.youtube.com/watch?v=..."
}
```

Local locators can contain absolute filesystem paths. Treat them as private
values when forwarding results outside the local MCP client.

## Capabilities

Ingest is incremental. A transcript may be queryable before visual indexing or
embeddings finish. Status and timeline responses report the available data:

```json
{
  "metadata": true,
  "transcript": {
    "available": true,
    "source": "captions",
    "segment_count": 120
  },
  "chapters": true,
  "frames": { "available": true, "count": 24 },
  "ocr": { "available": false, "block_count": 0 },
  "semantic_search": { "available": true, "vector_count": 120 }
}
```

An unavailable capability is a usable state, not necessarily an ingest error.
Use `get_ingest_status` for warnings and remediation. Full-text search remains
available when semantic embeddings fail; `repair_embeddings` can rebuild only
the vector index.

## Timestamps and result content

Structured results use numeric `*_seconds` fields. Human-readable timestamps
remain in text content for convenient agent responses. Frame tools return MCP
image content plus structured metadata describing the requested timestamp, the
actual nearest frame, dimensions, class, crop bounds, and OCR blocks.

All user-facing tools expose structured results while retaining compact text
content. Clients should prefer structured content for application logic and use
text content for model-facing summaries.

## Lifecycle

The cache is disposable working data. Save notes or other durable artifacts in
the client or application, then call `delete_video`. The source YouTube video or
local source file is never modified. Transcript files returned by
`get_transcript(delivery="file")` are also disposable and are removed with the
video or by cache eviction.

The SQLite database and physical cache directory are not a supported external
integration API. Use MCP tools for access to indexed data.

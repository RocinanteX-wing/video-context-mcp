# Project diagrams

These diagrams explain the shipped architecture and operating model of
`video-context-mcp`. The editable Mermaid sources live beside them in
[`assets/`](assets/); the article can reference this page or reuse the source
diagrams directly.

## Agent evidence loop

Use this to explain how an agent moves from a question to focused,
timestamped evidence.

```mermaid
flowchart LR
    Q[Agent question] --> I[ingest_video]
    I --> S[get_ingest_status]
    S --> T[get_video_timeline]
    T --> H[search_videos]
    H --> K{Evidence kind}
    K -->|speech| X[get_transcript<br/>targeted range]
    K -->|screen| F[peek_frame<br/>nearest keyframe]
    F --> C[crop_region<br/>optional zoom]
    X --> A[Answer with video_id<br/>and timestamps]
    C --> A
    S -. capabilities and warnings .-> H
```

Source: [`agent-evidence-loop.mmd`](assets/agent-evidence-loop.mmd)

## Incremental ingestion

Use this to explain why partially completed ingestion remains useful and how
optional visual, Whisper, and embedding stages behave.

```mermaid
flowchart LR
    P[pending] --> U[setup]
    U --> M[metadata]
    M --> T[transcript]
    T --> V{visual enabled?}
    V -->|yes| R[frames]
    V -->|no| E{embeddings enabled?}
    R --> O[ocr]
    O --> E
    E -->|yes| B[embed]
    E -->|no| D[done]
    B --> D
    T -. no captions + whisper fallback .-> W[whisper]
    W --> E
    B -. semantic failure .-> D
    P -. unrecoverable failure .-> X[error]
    M -. unrecoverable failure .-> X
    T -. unrecoverable failure .-> X

    D[done<br/>with capabilities and warnings]
```

Source: [`ingestion-state-machine.mmd`](assets/ingestion-state-machine.mmd)

## Multimodal index

Use this to show how speech and on-screen evidence become searchable without
putting a vision model inside the server.

```mermaid
flowchart TB
    V[Video source<br/>YouTube ID, URL, or local file] --> P[Ingestion pipeline]
    P --> M[Metadata and chapters]
    P --> S[Transcript segments]
    P --> K[Keyframes]
    K --> O[OCR blocks]
    S --> F[Full-text index]
    O --> F
    S --> E[Dense embeddings]
    O --> E
    F --> R[Reciprocal-rank fusion]
    E --> R
    R --> H[search_videos hits]
    K --> G[peek_frame image content]
    O --> G
    G --> L[Connected model interprets<br/>the visual evidence]
```

Source: [`multimodal-index.mmd`](assets/multimodal-index.mmd)

## Lazy context boundary

Use this to explain the project’s central design choice: index once, then
pull only the evidence the agent needs.

```mermaid
flowchart LR
    subgraph Eager[Context-flooding approach]
        V1[Video] --> D1[Dump every frame<br/>and transcript into prompt]
        D1 --> C1[Large, noisy context]
    end

    subgraph Lazy[video-context-mcp approach]
        V2[Video] --> I2[Index once]
        I2 --> O2[Cheap timeline overview]
        O2 --> Q2[Agent chooses next slice]
        Q2 --> T2[Transcript range]
        Q2 --> S2[Search hit]
        Q2 --> F2[Frame at timestamp]
        T2 --> C2[Only selected evidence enters context]
        S2 --> C2
        F2 --> C2
    end
```

Source: [`lazy-context-boundary.mmd`](assets/lazy-context-boundary.mmd)

## Capability fallbacks

Use this to explain how status reports what is available instead of treating
every missing optional capability as a total failure.

```mermaid
flowchart TB
    I[Ingest video] --> C[get_ingest_status]
    C --> T{Transcript available?}
    T -->|captions| TC[Query caption segments]
    T -->|no captions + fallback enabled| TW[Query Whisper segments]
    T -->|not available| TN[Report missing transcript<br/>with remediation]

    C --> V{Visual indexing available?}
    V -->|yes| VF[Use peek_frame<br/>and crop_region]
    V -->|no| VN[Text-only capabilities<br/>remain explicit]

    C --> E{Semantic vectors available?}
    E -->|yes| ES[Hybrid semantic + full-text search]
    E -->|no| EF[Full-text search remains usable]
    EF --> R[repair_embeddings<br/>without re-downloading video]
```

Source: [`capability-fallbacks.mmd`](assets/capability-fallbacks.mmd)

## Cache lifecycle

Use this to explain what is disposable, what is retained, and where durable
notes belong.

```mermaid
flowchart LR
    S[Source media] --> W[Temporary ingest workspace]
    W --> D[Derived working set]
    D --> N[Agent saves durable note<br/>outside the MCP cache]
    N --> X[delete_video]
    D --> L[LRU maintenance<br/>or prune_cache]
    X --> G[Released files and vectors]
    L --> G

    W -. removed after ingest .-> G
    R[Shared runtimes and models] --> K[Reusable cache artifacts]
    K -. not automatically evicted .-> R
```

Source: [`cache-lifecycle.mmd`](assets/cache-lifecycle.mmd)

## Pydantic versus ontology validation

Use this example when explaining the difference between local output shape and
domain consistency.

```mermaid
flowchart LR
    O[run_tool output<br/>refund order=123<br/>amount=25] --> P[Pydantic shape check]
    P -->|pass| Y{Ontology state check}
    Y -->|order 123 has no refund| A[Accept: structurally and<br/>semantically valid]
    Y -->|order 123 already refunded| R[Reject: duplicate refund]

    P -. sees types, fields,<br/>and local constraints .-> Q[Does not know order history<br/>or business relationships]
    Y -. enforces domain rules<br/>and cardinality .-> G[World-state guarantee]
```

Source: [`pydantic-vs-ontology.mmd`](assets/pydantic-vs-ontology.mmd)

The animated [`demo.gif`](assets/demo.gif) provides a concrete terminal
walkthrough of the final example.

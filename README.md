# Network Data Workbench (`wiredata-dev`)

> **Turn structured JSON network traffic from a running web application into persistent, queryable, traceable local datasets.**

A local-first Chromium DevTools extension (Manifest V3) for Chrome and Edge.

---

## Key Invariants

1. **Provenance-First**: Every base row and column retains exact `RFC 6901 JSON Pointer` lineage back to immutable response bodies.
2. **Immutable Captures**: Raw captured responses are never modified. Derived datasets are rebuildable from definition versions + raw captures.
3. **Strict Credential Redaction**: Authentication headers (`Authorization`, `Cookie`, `X-API-Key`, etc.), query parameters, and sensitive request body keys are redacted *before* persistence.
4. **Local-First**: Zero cloud backends, zero remote telemetry, zero accounts. Persistent filesystem storage using File System Access API + OPFS/IndexedDB WAL queue.
5. **Embedded DuckDB-WASM SQL**: Ingests dataset snapshots into high-performance relations, supports joins across endpoints, and exports Parquet/CSV.

---

## Monorepo Packages

```text
wiredata-dev/
├── apps/
│   ├── extension/          # Manifest V3 DevTools extension panel
│   └── fixture-app/        # Deterministic mock application for testing
├── packages/
│   ├── core/               # Pure data logic: JSON Pointers, candidates, typing, deduplication
│   ├── workspace/          # FileSystemDirectoryHandle & OPFS WAL persistence
│   ├── duckdb/             # DuckDB-WASM dedicated worker & SQL query client
│   └── ui/                 # Virtualized table, JSON tree viewer, provenance drawer
```

---

## Development & Usage

### 1. Install & Build
```bash
npm install
npm run build
npm test
```

### 2. Run Fixture App
```bash
npm run fixture
# Runs on http://localhost:5173
```

### 3. Load DevTools Extension in Chrome / Edge
1. Navigate to `chrome://extensions` (or `edge://extensions`).
2. Toggle on **Developer mode**.
3. Click **Load unpacked** and select `apps/extension/dist`.
4. Open DevTools on `http://localhost:5173` (or any web app) and navigate to the **Data** tab.

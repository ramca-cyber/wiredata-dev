# Chrome Web Store Submission & Reviewer Package

**Version:** 0.1.7  
**Package Artifact:** `release/wiredata-extension-v0.1.7.zip`  
**Live Privacy Policy:** `https://ramca-cyber.github.io/wiredata-dev/privacy.html`  
**Live Reviewer Test Page:** `https://ramca-cyber.github.io/wiredata-dev/reviewer-test.html`

---

## 1. Store Listing Metadata

### Item Title
```text
WireData - Network Data Workbench
```

### Summary / Short Description (Under 132 chars)
```text
Inspect, structure, and query local JSON network data and tables from web pages with SQL and 1-click exports.
```
*(Exact length: 110 characters)*

### Detailed Description
```text
WireData is a local-first developer productivity workbench that allows engineers and data analysts to inspect, structure, and query JSON API traffic and DOM tables from web applications they are actively developing or authorized to inspect.

Key Capabilities:
• Active-Tab Capture: Record fetch and XMLHttpRequest JSON responses on the inspected browser tab upon explicit user start.
• DOM Table & Grid Extractor: Capture visible HTML tables and virtualized grids directly into structured tabular datasets.
• In-Browser SQL with DuckDB: Run analytical SQL queries over captured data directly in your browser using local DuckDB-WASM.
• TypeScript & JSON Schema Generation: Automatically generate clean TypeScript interfaces and JSON Schemas from captured payloads.
• 1-Click Local Export: Export structured tables directly to CSV (spreadsheet formula protected), JSON, and JSONL formats.
• Local-First Privacy: All data processing, DuckDB querying, and storage stay entirely local on your machine. WireData does not send any captured data or telemetry to external servers.

How to Use:
1. Navigate to any web application tab you wish to inspect.
2. Click the WireData extension icon in your browser toolbar to open the Side Panel companion.
3. Click "Start Capture" to record live JSON API requests, or click "Scrape Table" to extract tabular data from the page.
4. Preview detected data collections, generate TypeScript types, or click "Workbench" to run SQL queries and export your data.
5. Click "Stop Capture" when finished.
```

---

## 2. Permission Justifications (CWS Dashboard)

Copy and paste these exact explanations into the Chrome Web Store Developer Dashboard permissions questionnaire:

### `activeTab`
```text
Used solely to provide temporary, user-gesture-driven access to the single active browser tab where the user explicitly opens the Side Panel or clicks capture. WireData does not request persistent host permissions (<all_urls>) or run in the background on arbitrary websites.
```

### `scripting`
```text
Used to inject the temporary in-page JSON network hook and DOM table extractor into the active browser tab only after the user explicitly initiates a capture or table scraping action.
```

### `sidePanel`
```text
Provides the companion user interface alongside the active browser tab, displaying real-time capture metrics, candidate collection previews, and quick export controls.
```

### `storage`
```text
Used to persist local workspace metadata, user-configured dataset definitions, and session state locally in the browser. No data is synchronized or uploaded externally.
```

---

## 3. Privacy Practices Tab (August 2026 CWS Policy Compliant)

Even though all processing is 100% client-side and never leaves the device, Chrome Web Store policy requires declaring user data categories processed by the extension.

### A. Data Usage Category Declarations

| Data Category | Declared? | Justification / Description |
| :--- | :---: | :--- |
| **Website Content** | **YES** | Intercepted JSON fetch/XHR API responses and extracted DOM table cell text are processed and stored strictly on the user's local device to enable developer inspection, schema inference, and SQL analysis. No data is transmitted to external servers. |
| **Web Browsing Activity** | **YES** | Request endpoint URLs and target page URLs are recorded locally to provide provenance tracking and route grouping. Query parameters containing sensitive credentials (tokens, keys, secrets) and URL hash fragments are automatically sanitized before local storage. |
| **Authentication Information** | **NO** | Authorization headers, Cookies, and session tokens are stripped and never stored. |
| **Personal Communications** | **NO** | Not handled or collected. |
| **Location / Financial** | **NO** | Not handled or collected. |

### B. Single Purpose Description
```text
WireData serves a single developer productivity purpose: inspecting, structuring, and locally querying JSON network traffic and tabular data from authorized web pages.
```

### C. Developer Data Certifications
Check the following mandatory certification checkboxes in the CWS dashboard:
- [x] **I certify that my extension does not sell user data to third parties.**
- [x] **I certify that my extension does not use or transfer user data for purposes unrelated to the item's single purpose.**
- [x] **I certify that my extension does not use or transfer user data to determine creditworthiness or for lending purposes.**

---

## 4. Instructions for the Chrome Web Store Reviewer

Provide these clear, step-by-step verification instructions in the reviewer notes field:

```text
Reviewer Testing Instructions for WireData:

WireData is a local-only developer workbench for inspecting JSON traffic and HTML tables. To test full functionality in under 2 minutes:

1. Open our public, static reviewer test suite:
   https://ramca-cyber.github.io/wiredata-dev/reviewer-test.html

2. Click the WireData extension icon in the browser toolbar to open the Side Panel.
   (Notice the target tab card immediately binds to the active reviewer page).

3. In the Side Panel, click "⏺ Start Capture".
   - Click the "Fetch Orders API (Page 1)", "Fetch Orders API (Page 2)", and "Fetch Products API" buttons on the test page.
   - Observe the live request counters and discovered candidate collections ("orders", "products") appearing in the Side Panel.
   - Click "TS" or "JSONL" on any collection to verify instant type generation and export.

4. Test DOM Table Scraping:
   - Click "📄 Scrape Table" in the Side Panel.
   - Observe the HTML table on the test page extracted cleanly into a structured dataset.

5. Test the Full Workbench & DuckDB SQL:
   - Click "Open Full Workbench" in the Side Panel header (or navigate to the Workbench tab).
   - Click "Datasets" to view the virtualized grid with column type badges.
   - Click "DuckDB SQL" and run: SELECT * FROM orders; to verify in-browser WebAssembly SQL execution.
   - Click "Export CSV" to verify safe spreadsheet download.

6. Local-Only Verification:
   - Check the DevTools Network tab during all operations: zero outbound requests are sent to external servers or telemetry endpoints. All data and DuckDB WASM run 100% locally.
```

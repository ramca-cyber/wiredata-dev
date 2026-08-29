# Chrome Web Store Submission & Reviewer Package

**Version:** 0.2.1  
**Package Artifact:** `release/wiredata-extension-v0.2.1.zip`  
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
Used solely to provide temporary, user-gesture-driven access to the single active browser tab where the user explicitly opens the Side Panel or clicks capture. WireData does not request persistent host permissions on install or run in the background on arbitrary websites.
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
Used only for chrome.storage.session to preserve ephemeral active-capture control state—active tab ID, session ID, origin, and capture status—across Manifest V3 service-worker suspension. Captured website content and datasets are not stored through this permission.
```

### `tabs`
```text
Used to detect the URL and hostname of the active browser tab when the side panel companion is opened, enabling domain-aware dataset grouping and provenance attribution.
```

### `optional_host_permissions` (`http://*/*`, `https://*/*`)
```text
Used on-demand only when the user explicitly clicks 'Start Capture' or 'Scrape Table' inside the side panel companion to request permission for the single active web page origin. Zero host permissions are requested upon initial extension installation.
```

---

## 3. Privacy Practices Tab (August 2026 CWS Policy Compliant)

Even though all processing is 100% client-side and never leaves the device, Chrome Web Store policy requires declaring user data categories processed locally by the extension.

### A. Data Usage Category Declarations

> [!TIP]
> **Dashboard Alignment Guidance:** Chrome Web Store defines data handling broadly to include response content processed locally on device. Because WireData allows developers to capture arbitrary JSON API responses from websites they inspect, those response payloads may legitimately contain fields related to authentication, billing/financial data, personal communications, or location returned by the target API.
> 
> When completing the Privacy Practices form in the Developer Dashboard, declare **Website Content** and **Web Browsing Activity** as primary categories. If the form prompts specifically for subcategories present in intercepted response traffic, disclose them with the justification that all captured data is processed and stored 100% locally on the user's device for developer inspection and is never transmitted off-device.

| Data Category | Suggested Dashboard Declaration | Justification / Description |
| :--- | :---: | :--- |
| **Website Content** | **YES** | Intercepted JSON fetch/XHR API responses and extracted DOM table cell text are processed and stored strictly on the user's local device to enable developer inspection, schema inference, and SQL analysis. No data is transmitted to external servers. Captured response payloads may contain arbitrary data returned by the inspected service. |
| **Web Browsing Activity** | **YES** | Request endpoint URLs and target page URLs are recorded locally to provide provenance tracking and route grouping. Query parameters containing sensitive credentials (tokens, keys, secrets) and URL hash fragments are automatically sanitized before local storage. |
| **Authentication Information** | Check CWS Dashboard prompt | Request headers (`Authorization`, `Cookie`), credentials, and request bodies are not stored or transmitted. Captured JSON API responses may contain response tokens returned by web endpoints; all processing and storage remain strictly local on the device. |
| **Personal Communications / Financial / Location** | Check CWS Dashboard prompt | Not targeted by the extension. Any arbitrary fields contained within captured API responses remain strictly on the user's device and under user control. |

### B. Remote Code Declaration
```text
Remote code: NO. All JavaScript, workers, WebAssembly, and DuckDB assets execute from files bundled inside the extension package. No executable code is downloaded from CDNs or external servers.
```

### C. Single Purpose Description
```text
WireData serves a single developer productivity purpose: inspecting, structuring, and locally querying JSON network traffic and tabular data from authorized web pages.
```

### D. Developer Data Certifications
Check the following mandatory certification checkboxes in the CWS dashboard:
- [x] **I certify that my extension does not sell user data to third parties.**
- [x] **I certify that my extension does not use or transfer user data for purposes unrelated to the item's single purpose.**
- [x] **I certify that my extension does not use or transfer user data to determine creditworthiness or for lending purposes.**

---

## 4. Instructions for the Chrome Web Store Reviewer (Under 500 Chars)

Paste this into the **"Notes for the reviewer"** field (exact length: 377 characters):

```text
Test: Open https://ramca-cyber.github.io/wiredata-dev/reviewer-test.html. Click toolbar W, then Start Capture; if Chrome asks for site access, click Allow. Click Generate JSON API Request; "orders" appears. Stop Capture -> Workbench -> Candidates -> Extract Combined Dataset -> DuckDB SQL -> Run Query. All processing and storage are local; WireData sends no data off-device.
```

---

### Detailed Reviewer Instructions (For Reference)

```text
Reviewer Testing Instructions for WireData:

WireData is a local-only developer workbench for inspecting JSON traffic and HTML tables. To test full functionality in under 2 minutes:

1. Open our public, static reviewer test suite:
   https://ramca-cyber.github.io/wiredata-dev/reviewer-test.html

2. Click the WireData extension icon in the browser toolbar to open the Side Panel.
   (Notice the target tab card immediately binds to the active reviewer page).

3. In the Side Panel, click "⏺ Start Capture".
   — Chrome may display a native domain access prompt: "Allow WireData to access data on [this site]?" Click **Allow**.
   — REC status appears once capture is active.

4. On the reviewer test page, click "🚀 Generate JSON API Request".
   - Notice the Side Panel immediately increments to 1 response and detects the "orders" collection.
   - Click "TS" or "JSONL" on the orders card to verify instant type generation and export.

5. Click "⏹ Stop Capture" in the Side Panel.

6. Click "Open Full SQL Workbench ↗" in the Side Panel (or open workbench.html).
   - In Workbench, switch to the "Candidates" tab and click "⚡ Extract Combined Dataset" to create the "orders" table.
   - Switch to the "DuckDB SQL" tab and click "Run Query (Ctrl+Enter)" to query SELECT * FROM orders; via DuckDB-WASM.
   - Click "Export CSV" to verify safe spreadsheet download.

7. Test DOM Table Scraping (Optional):
   - In the Side Panel, click "Scrape Now" under "🔲 Scrape HTML Table".
   - Observe the HTML table on the test page extracted cleanly into a structured dataset.

8. Local-Only Verification:
   The reviewer page's own requests are expected and are the traffic WireData captures. WireData sends no captured content, telemetry, or analytics to developer-controlled or third-party services. All data and DuckDB WASM run 100% locally.
```

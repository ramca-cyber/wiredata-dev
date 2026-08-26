/**
 * DOM Table / Grid Capture Adapter
 * One-shot (not continuous, unlike network capture): injects extractDomTable
 * into the active tab, converts the result into the same CapturedRequest /
 * candidate shape the network adapters produce, and hands it back for the
 * normal save/dataset/DuckDB pipeline to pick up unchanged.
 */

import {
  CandidateCollection,
  CapturedRequest,
  computeNormalizedRoute,
  detectCandidateCollections,
  generateULID,
  redactQueryParams,
  sha256,
  ULID,
} from '@wiredata/core';
import { extractDomTable, DomExtractionResult } from '../capture/hooks/dom-table-hook.js';

export interface DomCaptureOutcome {
  capture: CapturedRequest;
  body: { rows: Record<string, string>[] };
  candidates: CandidateCollection[];
  strategy: DomExtractionResult['strategy'];
  rowCount: number;
  incomplete: boolean;
  expectedRowCount?: number;
}

/**
 * Scrapes whatever table/grid is on the given tab right now and converts it
 * into a capture. Returns null if no table/grid was found on the page.
 *
 * Unlike network capture, this has no "immutable server response" to be
 * exact about — capture_mode: 'dom' says so explicitly, and the caller
 * should surface `incomplete`/`expectedRowCount` rather than let a partial
 * virtualized-grid scrape masquerade as a complete one.
 */
export async function captureTableFromActiveTab(
  sessionId: ULID,
  tabId: number,
  rootSelector?: string
): Promise<DomCaptureOutcome | null> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractDomTable,
    args: rootSelector ? [rootSelector] : [],
  });

  const result = results?.[0]?.result as DomExtractionResult | null | undefined;
  if (!result || result.rows.length === 0) return null;

  // Every scraped cell is stored exactly as extracted — text, untouched.
  // The immutable capture is this raw snapshot; whether "1,425,423,212"
  // should become a number is a per-column decision made later (confirmed
  // via a suggested ColumnParseRule, applied at dataset-build time), not
  // something baked into the capture before anyone's had a chance to see or
  // correct it.
  const rowObjects = result.rows.map(cells =>
    Object.fromEntries(result.headers.map((h, i) => [h || `column_${i + 1}`, cells[i] ?? '']))
  );
  const body = { rows: rowObjects };
  const bodyStr = JSON.stringify(body);
  const bodyHash = await sha256(bodyStr);
  // Sanitize the source URL — query params may contain credentials or tokens
  // (e.g. access_token=...). Pass through the same redactQueryParams logic used
  // by all other capture adapters before storing anything.
  const { sanitizedUrl } = redactQueryParams(result.sourceUrl);
  const normalizedRoute = computeNormalizedRoute('GET', sanitizedUrl);

  const capture: CapturedRequest = {
    capture_id: generateULID(),
    session_id: sessionId,
    capture_mode: 'dom',
    request: {
      url: sanitizedUrl,
      sanitized_url: sanitizedUrl,
      route_template: normalizedRoute,
      method: 'GET',
      query_parameters: [],
    },
    response: {
      status: 200,
      status_text: 'OK',
      mime_type: 'application/json',
      body_size: bodyStr.length,
      body_hash: bodyHash,
      body_object_ref: bodyHash,
    },
    timing: {
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: 0,
    },
    classification: {
      json_candidate: true,
      parse_status: 'parsed',
    },
  };

  const rawCandidates = detectCandidateCollections(body);
  const candidates = rawCandidates.map(c => ({
    ...c,
    suggested_name: c.suggested_name === 'rows' ? 'scraped_table' : c.suggested_name,
  }));

  return {
    capture,
    body,
    candidates,
    strategy: result.strategy,
    rowCount: result.rows.length,
    incomplete: result.incomplete,
    expectedRowCount: result.expectedRowCount,
  };
}

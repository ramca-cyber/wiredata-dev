/**
 * Chrome DevTools Network Adapter
 * Intercepts network entries, extracts JSON bodies, performs redaction and candidate detection.
 *
 * Capture contract (deliberately minimal — matches page-capture mode):
 *   - Sanitized request URL (credential-shaped query params redacted)
 *   - HTTP method, status code, MIME type, timing
 *   - GraphQL operation name (if applicable)
 *   - Parsed JSON response body only
 *
 * Intentionally NOT persisted: request/response headers, request bodies,
 * non-JSON responses. This keeps the privacy surface identical to page-capture
 * mode and simplifies the disclosure: "JSON API responses and request URLs."
 */

import {
  CapturedRequest,
  computeNormalizedRoute,
  detectCandidateCollections,
  detectSensitiveJsonPaths,
  extractGraphQLOperation,
  generateULID,
  redactQueryParams,
  sha256,
  ULID,
} from '@wiredata/core';

export type NetworkCaptureCallback = (
  capture: CapturedRequest,
  parsedBody?: unknown,
  candidates?: ReturnType<typeof detectCandidateCollections>,
  canonicalRawText?: string
) => void;

export class ChromeNetworkCaptureAdapter {
  private listener: ((request: any) => void) | null = null;

  constructor(private sessionId: ULID, private onCapture: NetworkCaptureCallback) {}

  start(): void {
    if (typeof chrome === 'undefined' || !chrome.devtools || !chrome.devtools.network) {
      console.warn('Chrome DevTools network API is not available in this context.');
      return;
    }

    this.listener = (harEntry: any) => {
      this.handleHarEntry(harEntry);
    };

    chrome.devtools.network.onRequestFinished.addListener(this.listener);
  }

  stop(): void {
    if (this.listener && typeof chrome !== 'undefined' && chrome.devtools?.network) {
      chrome.devtools.network.onRequestFinished.removeListener(this.listener);
      this.listener = null;
    }
  }

  private async handleHarEntry(harEntry: any): Promise<void> {
    const { request, response, time } = harEntry;
    const mimeType = response?.content?.mimeType || '';
    const isJsonMime = /json/i.test(mimeType);

    // Only capture JSON responses — keeps privacy surface minimal and matches
    // the page-capture adapter's behavior exactly.
    if (!isJsonMime) return;

    const { sanitizedUrl, params } = redactQueryParams(request.url || '');
    let graphqlOp: string | undefined;
    try {
      const parsed = new URL(request.url || '');
      graphqlOp = parsed.searchParams.get('operationName') || undefined;
    } catch {}
    const normalizedRoute = computeNormalizedRoute(request.method || 'GET', sanitizedUrl, graphqlOp);
    const captureId = generateULID();

    // Retrieve JSON response body
    harEntry.getContent(async (content: string, encoding: string) => {
      let rawJson: unknown = undefined;
      let sensitiveFields: string[] = [];
      let parseStatus: CapturedRequest['classification']['parse_status'] = 'parsed';
      let bodyHash = '';

      let rawText = '';
      if (!content) {
        parseStatus = 'body_unavailable';
      } else {
        try {
          if (encoding === 'base64') {
            const bytes = Uint8Array.from(atob(content), c => c.charCodeAt(0));
            rawText = new TextDecoder('utf-8').decode(bytes);
          } else {
            rawText = content;
          }
          bodyHash = await sha256(rawText);

          const bodyBytes = new TextEncoder().encode(rawText).byteLength;
          if (bodyBytes > 25 * 1024 * 1024) {
            parseStatus = 'skipped_large';
          } else {
            rawJson = JSON.parse(rawText);
            sensitiveFields = detectSensitiveJsonPaths(rawJson);
          }
        } catch {
          parseStatus = 'invalid_json';
        }
      }

      const capture: CapturedRequest = {
        capture_id: captureId,
        session_id: this.sessionId,
        capture_mode: 'devtools',
        request: {
          url: sanitizedUrl,
          sanitized_url: sanitizedUrl,
          route_template: normalizedRoute,
          method: request.method || 'GET',
          query_parameters: params,
          graphql_operation_name: graphqlOp,
        },
        response: {
          status: response.status,
          status_text: response.statusText,
          mime_type: mimeType,
          body_size: response.bodySize || (rawText ? new TextEncoder().encode(rawText).byteLength : content?.length || 0),
          body_hash: bodyHash,
          body_object_ref: bodyHash,
        },
        timing: {
          started_at: new Date(Date.now() - (time || 0)).toISOString(),
          completed_at: new Date().toISOString(),
          duration_ms: Math.round(time || 0),
        },
        classification: {
          json_candidate: parseStatus === 'parsed' && rawJson !== undefined,
          parse_status: parseStatus,
          sensitive_response_fields: sensitiveFields.length > 0 ? sensitiveFields : undefined,
        },
      };

      let candidates: ReturnType<typeof detectCandidateCollections> | undefined;
      if (rawJson !== undefined) {
        candidates = detectCandidateCollections(rawJson);
      }

      this.onCapture(capture, rawJson, candidates, rawText);
    });
  }
}

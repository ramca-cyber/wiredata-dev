/**
 * Chrome DevTools Network Adapter
 * Intercepts network entries, extracts JSON bodies, performs redaction and candidate detection
 */

import {
  CapturedRequest,
  computeNormalizedRoute,
  detectCandidateCollections,
  extractGraphQLOperation,
  generateULID,
  redactHeaders,
  redactJsonBody,
  redactQueryParams,
  sha256,
  ULID,
} from '@wiredata/core';

export type NetworkCaptureCallback = (
  capture: CapturedRequest,
  rawBody?: unknown,
  candidates?: ReturnType<typeof detectCandidateCollections>
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

    // Redaction
    const rawHeaders = (request.headers || []).map((h: any) => ({ name: h.name, value: h.value }));
    const respHeaders = (response.headers || []).map((h: any) => ({ name: h.name, value: h.value }));
    const sanitizedHeaders = redactHeaders(rawHeaders);
    const sanitizedRespHeaders = redactHeaders(respHeaders);
    const { sanitizedUrl, params } = redactQueryParams(request.url || '');

    // GraphQL operation extraction
    const rawReqBody = request.postData?.text;
    const sanitizedReqBody = rawReqBody ? String(redactJsonBody(rawReqBody)) : undefined;
    const graphqlOp = rawReqBody ? extractGraphQLOperation(rawReqBody) : undefined;
    const normalizedRoute = computeNormalizedRoute(request.method || 'GET', sanitizedUrl, graphqlOp);

    const captureId = generateULID();

    if (!isJsonMime) {
      // Non-JSON request
      const capture: CapturedRequest = {
        capture_id: captureId,
        session_id: this.sessionId,
        request: {
          url: request.url,
          sanitized_url: sanitizedUrl,
          route_template: normalizedRoute,
          method: request.method || 'GET',
          query_parameters: params,
          headers: sanitizedHeaders,
          body_sanitized: sanitizedReqBody,
          graphql_operation_name: graphqlOp,
        },
        response: {
          status: response.status,
          status_text: response.statusText,
          mime_type: mimeType,
          headers: sanitizedRespHeaders,
          body_size: response.bodySize || 0,
          body_hash: '',
          body_object_ref: '',
        },
        timing: {
          started_at: new Date(Date.now() - (time || 0)).toISOString(),
          completed_at: new Date().toISOString(),
          duration_ms: Math.round(time || 0),
        },
        classification: {
          json_candidate: false,
          parse_status: 'unsupported_mime',
        },
      };

      this.onCapture(capture);
      return;
    }

    // Retrieve JSON response body
    harEntry.getContent(async (content: string, encoding: string) => {
      let rawJson: unknown = undefined;
      let parseStatus: CapturedRequest['classification']['parse_status'] = 'parsed';
      let bodyHash = '';

      if (!content) {
        parseStatus = 'body_unavailable';
      } else {
        try {
          const decoded = encoding === 'base64' ? atob(content) : content;
          bodyHash = await sha256(decoded);

          // Check size threshold (25 MiB default limit)
          if (decoded.length > 25 * 1024 * 1024) {
            parseStatus = 'skipped_large';
          } else {
            rawJson = JSON.parse(decoded);
          }
        } catch {
          parseStatus = 'invalid_json';
        }
      }

      const capture: CapturedRequest = {
        capture_id: captureId,
        session_id: this.sessionId,
        request: {
          url: request.url,
          sanitized_url: sanitizedUrl,
          route_template: normalizedRoute,
          method: request.method || 'GET',
          query_parameters: params,
          headers: sanitizedHeaders,
          body_sanitized: sanitizedReqBody,
          graphql_operation_name: graphqlOp,
        },
        response: {
          status: response.status,
          status_text: response.statusText,
          mime_type: mimeType,
          headers: sanitizedRespHeaders,
          body_size: response.bodySize || content?.length || 0,
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
        },
      };

      let candidates: ReturnType<typeof detectCandidateCollections> | undefined;
      if (rawJson !== undefined) {
        candidates = detectCandidateCollections(rawJson);
      }

      this.onCapture(capture, rawJson, candidates);
    });
  }
}

/**
 * Page Network Capture Adapter (Page fetch/XHR JSON mode)
 * Subscribes to runtime messages from background service worker and emits normalized CapturedRequests.
 */

import {
  CandidateCollection,
  CapturedRequest,
  computeNormalizedRoute,
  detectCandidateCollections,
  detectSensitiveJsonPaths,
  generateULID,
  sha256,
  ULID,
} from '@wiredata/core';

export type OnPageCaptureCallback = (
  capture: CapturedRequest,
  rawBody: unknown,
  candidates: CandidateCollection[]
) => void;

export class PageNetworkCaptureAdapter {
  private isRunning = false;
  private messageListener: ((msg: any) => void) | null = null;

  constructor(
    private sessionId: ULID,
    private tabId: number,
    private tabUrl: string,
    private onCapture: OnPageCaptureCallback
  ) {}

  /**
   * Throws if the service worker fails to actually install the capture hook
   * (e.g. restricted page, expired activeTab grant, injection error). Callers
   * must not report capture as active until this resolves successfully —
   * the background service worker can be killed and restarted at any time,
   * so delivery below is via plain runtime messages rather than a long-lived
   * port, which would silently stop working across a worker restart.
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    this.messageListener = (msg: any) => {
      if (
        msg?.type === 'PAGE_CAPTURE_RECEIVED' &&
        msg.capturePayload &&
        msg.capturePayload.sessionId === this.sessionId
      ) {
        this.handlePayload(msg.capturePayload);
      }
    };
    chrome.runtime.onMessage.addListener(this.messageListener);

    // Send start signal to service worker and require confirmation
    let origin = '*';
    if (this.tabUrl) {
      try {
        origin = new URL(this.tabUrl).origin;
      } catch {}
    }
    const response = await chrome.runtime.sendMessage({
      type: 'START_TAB_CAPTURE',
      tabId: this.tabId,
      origin,
      sessionId: this.sessionId,
    });

    if (!response?.success) {
      chrome.runtime.onMessage.removeListener(this.messageListener);
      this.messageListener = null;
      throw new Error(response?.error || 'Failed to start capture on this tab.');
    }

    this.isRunning = true;
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.messageListener) {
      chrome.runtime.onMessage.removeListener(this.messageListener);
      this.messageListener = null;
    }

    await chrome.runtime.sendMessage({
      type: 'STOP_TAB_CAPTURE',
      tabId: this.tabId,
    });
  }

  private async handlePayload(p: any): Promise<void> {
    const normalizedRoute = computeNormalizedRoute(p.method, p.url, p.graphqlOperationName);

    if (p.parseStatus === 'skipped_large' || p.parseStatus === 'parse_error') {
      const capture: CapturedRequest = {
        capture_id: generateULID(),
        session_id: this.sessionId,
        capture_mode: 'page',
        request: {
          url: p.sanitized_url,
          sanitized_url: p.sanitized_url,
          route_template: normalizedRoute,
          method: p.method,
          query_parameters: [],
          graphql_operation_name: p.graphqlOperationName,
        },
        response: {
          status: p.status,
          status_text: p.statusText,
          mime_type: p.mimeType,
          headers: [{ name: 'Content-Type', value: p.mimeType, is_redacted: false }],
          body_size: p.bodySize || 0,
          body_hash: '',
          body_object_ref: '',
        },
        timing: {
          started_at: p.startedAt,
          completed_at: p.completedAt,
          duration_ms: p.durationMs,
        },
        classification: {
          json_candidate: false,
          parse_status: p.parseStatus,
        },
      };
      this.onCapture(capture, undefined, []);
      return;
    }

    const rawText = p.rawText !== undefined ? p.rawText : JSON.stringify(p.body);
    const hash = await sha256(rawText);
    const sensitiveFields = p.body ? detectSensitiveJsonPaths(p.body) : [];

    const capture: CapturedRequest = {
      capture_id: generateULID(),
      session_id: this.sessionId,
      capture_mode: 'page',
      request: {
        url: p.sanitized_url,
        sanitized_url: p.sanitized_url,
        route_template: normalizedRoute,
        method: p.method,
        query_parameters: [],
        headers: undefined, // Zero request headers collected
        body_sanitized: undefined, // Zero request bodies collected
        graphql_operation_name: p.graphqlOperationName,
      },
      response: {
        status: p.status,
        status_text: p.statusText,
        mime_type: p.mimeType,
        headers: [{ name: 'Content-Type', value: p.mimeType, is_redacted: false }],
        body_size: p.bodySize || new TextEncoder().encode(rawText).byteLength,
        body_hash: hash,
        body_object_ref: hash,
      },
      timing: {
        started_at: p.startedAt,
        completed_at: p.completedAt,
        duration_ms: p.durationMs,
      },
      classification: {
        json_candidate: true,
        parse_status: 'parsed',
        sensitive_response_fields: sensitiveFields.length > 0 ? sensitiveFields : undefined,
      },
    };

    const candidates = p.body ? detectCandidateCollections(p.body) : [];
    this.onCapture(capture, p.body, candidates);
  }
}

/**
 * Page Network Capture Adapter (Page fetch/XHR JSON mode)
 * Subscribes to runtime messages from background service worker and emits normalized CapturedRequests.
 */

import {
  CandidateCollection,
  CapturedRequest,
  computeNormalizedRoute,
  detectCandidateCollections,
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
  private port: chrome.runtime.Port | null = null;
  private isRunning = false;

  constructor(
    private sessionId: ULID,
    private tabId: number,
    private tabUrl: string,
    private onCapture: OnPageCaptureCallback
  ) {}

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    // Connect UI port to background worker
    this.port = chrome.runtime.connect({ name: 'wiredata_ui_channel' });
    this.port.onMessage.addListener(async msg => {
      if (msg.type === 'PAGE_CAPTURE_RECEIVED' && msg.capturePayload) {
        await this.handlePayload(msg.capturePayload);
      }
    });

    // Send start signal to service worker
    const origin = new URL(this.tabUrl).origin;
    await chrome.runtime.sendMessage({
      type: 'START_TAB_CAPTURE',
      tabId: this.tabId,
      origin,
      sessionId: this.sessionId,
    });
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.port) {
      this.port.disconnect();
      this.port = null;
    }

    await chrome.runtime.sendMessage({
      type: 'STOP_TAB_CAPTURE',
      tabId: this.tabId,
    });
  }

  private async handlePayload(p: any): Promise<void> {
    const jsonStr = JSON.stringify(p.body);
    const hash = await sha256(jsonStr);
    const normalizedRoute = computeNormalizedRoute(p.method, p.url, p.graphqlOperationName);

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
        body_size: jsonStr.length,
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
      },
    };

    const candidates = detectCandidateCollections(p.body);
    this.onCapture(capture, p.body, candidates);
  }
}

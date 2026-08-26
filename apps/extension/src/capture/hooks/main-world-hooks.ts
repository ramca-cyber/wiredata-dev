/**
 * MAIN-World Fetch and XMLHttpRequest Reversible Capture Hooks
 * Clones JSON responses, discards request headers, and extracts GraphQL operationName.
 *
 * IMPORTANT: These functions are injected via chrome.scripting.executeScript({ func }),
 * which serializes each function with Function.prototype.toString() and re-evaluates it
 * standalone in the target page's MAIN world. Any reference to a module-level helper,
 * constant, or import is undefined in that context and throws a ReferenceError at runtime.
 * Every exported function below MUST be fully self-contained: no closures over anything
 * declared outside its own body.
 */

declare global {
  interface Window {
    __WIREDATA_HOOK_STATE__?: {
      originalFetch: typeof window.fetch | null;
      originalXhrOpen: typeof XMLHttpRequest.prototype.open | null;
      originalXhrSend: typeof XMLHttpRequest.prototype.send | null;
      sessionId: string;
      tabId: number;
    };
  }
}

export function installPageCaptureHook(sessionId: string, tabId: number): void {
  const FETCH_SENTINEL = '__WIREDATA_FETCH_WRAPPER__';
  const XHR_SENTINEL = '__WIREDATA_XHR_WRAPPER__';

  function isJsonMime(mime: string | null): boolean {
    if (!mime) return false;
    const lower = mime.toLowerCase();
    return (
      lower.includes('application/json') ||
      lower.includes('application/problem+json') ||
      lower.includes('+json') ||
      lower.includes('text/json')
    );
  }

  function sanitizeUrl(rawUrl: string): string {
    try {
      const parsed = new URL(rawUrl, window.location.origin);
      const SENSITIVE_PARAMS = ['token', 'auth', 'key', 'secret', 'password', 'apikey', 'api_key', 'access_token'];
      parsed.searchParams.forEach((_val, key) => {
        if (SENSITIVE_PARAMS.some(p => key.toLowerCase().includes(p))) {
          parsed.searchParams.set(key, '[REDACTED]');
        }
      });
      return parsed.toString();
    } catch {
      return rawUrl;
    }
  }

  function extractGraphQLOperationFromUrl(url: string): string | undefined {
    try {
      const parsed = new URL(url, window.location.origin);
      return parsed.searchParams.get('operationName') || undefined;
    } catch {
      return undefined;
    }
  }

  if (window.__WIREDATA_HOOK_STATE__) {
    window.__WIREDATA_HOOK_STATE__.sessionId = sessionId;
    window.__WIREDATA_HOOK_STATE__.tabId = tabId;
    return;
  }

  const state = {
    originalFetch: window.fetch,
    originalXhrOpen: XMLHttpRequest.prototype.open,
    originalXhrSend: XMLHttpRequest.prototype.send,
    sessionId,
    tabId,
  };
  window.__WIREDATA_HOOK_STATE__ = state;

  // 1. Hook window.fetch
  const nativeFetch = window.fetch;
  const wrappedFetch: typeof window.fetch = async function (this: any, input: RequestInfo | URL, init?: RequestInit) {
    const startedAt = new Date().toISOString();
    const startTime = performance.now();
    const method = (init?.method || (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const sanitized = sanitizeUrl(rawUrl);
    const sanitizedPageUrl = sanitizeUrl(window.location.href);
    const graphqlOp = extractGraphQLOperationFromUrl(rawUrl);

    const response = await nativeFetch.apply(this, [input, init]);

    try {
      const contentType = response.headers.get('content-type');
      if (isJsonMime(contentType)) {
        const clone = response.clone();
        clone.json().then(jsonBody => {
          const durationMs = Math.round(performance.now() - startTime);
          window.postMessage(
            {
              source: 'WIREDATA_PAGE_HOOK',
              type: 'PAGE_CAPTURE',
              payload: {
                sessionId: state.sessionId,
                tabId: state.tabId,
                method,
                url: sanitized,
                sanitized_url: sanitized,
                pageUrl: sanitizedPageUrl,
                status: response.status,
                statusText: response.statusText,
                mimeType: contentType || 'application/json',
                graphqlOperationName: graphqlOp,
                body: jsonBody,
                startedAt,
                completedAt: new Date().toISOString(),
                durationMs,
              },
            },
            '*'
          );
        }).catch(() => {});
      }
    } catch {}

    return response;
  };

  (wrappedFetch as any)[FETCH_SENTINEL] = true;
  window.fetch = wrappedFetch;

  // 2. Hook XMLHttpRequest
  const nativeXhrOpen = XMLHttpRequest.prototype.open;
  const nativeXhrSend = XMLHttpRequest.prototype.send;

  const XHR_DATA = '__wiredata_xhr_data__';

  XMLHttpRequest.prototype.open = function (this: any, method: string, url: string | URL, ...rest: any[]) {
    const rawUrl = typeof url === 'string' ? url : url.toString();
    this[XHR_DATA] = {
      method: method.toUpperCase(),
      rawUrl,
      sanitizedUrl: sanitizeUrl(rawUrl),
      startedAt: new Date().toISOString(),
      startTime: performance.now(),
    };
    return nativeXhrOpen.apply(this, [method, url, ...rest] as any);
  };
  (XMLHttpRequest.prototype.open as any)[XHR_SENTINEL] = true;

  XMLHttpRequest.prototype.send = function (this: any, body?: Document | XMLHttpRequestBodyInit | null) {
    const data = this[XHR_DATA];
    if (data) {
      data.graphqlOp = extractGraphQLOperationFromUrl(data.rawUrl);

      this.addEventListener('load', function (this: XMLHttpRequest) {
        try {
          const contentType = this.getResponseHeader('content-type');
          if (isJsonMime(contentType)) {
            // responseType 'json' already parses to an object on .response;
            // responseText throws for that responseType, so branch on it.
            const jsonBody =
              this.responseType === 'json'
                ? this.response
                : this.responseText
                ? JSON.parse(this.responseText)
                : undefined;

            if (jsonBody !== undefined) {
              const durationMs = Math.round(performance.now() - data.startTime);
              window.postMessage(
                {
                  source: 'WIREDATA_PAGE_HOOK',
                  type: 'PAGE_CAPTURE',
                  payload: {
                    sessionId: state.sessionId,
                    tabId: state.tabId,
                    method: data.method,
                    url: data.sanitizedUrl,
                    sanitized_url: data.sanitizedUrl,
                    pageUrl: sanitizeUrl(window.location.href),
                    status: this.status,
                    statusText: this.statusText,
                    mimeType: contentType || 'application/json',
                    graphqlOperationName: data.graphqlOp,
                    body: jsonBody,
                    startedAt: data.startedAt,
                    completedAt: new Date().toISOString(),
                    durationMs,
                  },
                },
                '*'
              );
            }
          }
        } catch {}
      });
    }

    return nativeXhrSend.apply(this, [body] as any);
  };
  (XMLHttpRequest.prototype.send as any)[XHR_SENTINEL] = true;
}

export function uninstallPageCaptureHook(): void {
  const FETCH_SENTINEL = '__WIREDATA_FETCH_WRAPPER__';
  const XHR_SENTINEL = '__WIREDATA_XHR_WRAPPER__';

  const state = window.__WIREDATA_HOOK_STATE__;
  if (!state) return;

  // Restore fetch only if our wrapper is still the installed head
  if (window.fetch && (window.fetch as any)[FETCH_SENTINEL] === true) {
    if (state.originalFetch) {
      window.fetch = state.originalFetch;
    }
  }

  // Restore XHR only if our wrapper is still the installed head
  if (
    XMLHttpRequest.prototype.open &&
    (XMLHttpRequest.prototype.open as any)[XHR_SENTINEL] === true
  ) {
    if (state.originalXhrOpen) {
      XMLHttpRequest.prototype.open = state.originalXhrOpen;
    }
  }

  if (
    XMLHttpRequest.prototype.send &&
    (XMLHttpRequest.prototype.send as any)[XHR_SENTINEL] === true
  ) {
    if (state.originalXhrSend) {
      XMLHttpRequest.prototype.send = state.originalXhrSend;
    }
  }

  delete window.__WIREDATA_HOOK_STATE__;
}

/**
 * WireData Manifest V3 Background Service Worker
 * Coordinates activeTab capture sessions, sidePanel lifecycle, and toolbar badges.
 * Ephemeral session registry stored in chrome.storage.session so it survives
 * the service worker being killed and restarted after ~30s of inactivity.
 *
 * Delivery to UI surfaces (side panel / workbench) uses chrome.runtime.sendMessage
 * broadcasts rather than long-lived ports: a port held open in a worker-global Set
 * is lost the moment the worker is terminated and restarted, silently dropping any
 * capture that arrives afterward. Plain runtime messages have no such dependency —
 * if nothing is listening, the send simply fails and is ignored.
 *
 * NOTE: installPageCaptureHook and uninstallPageCaptureHook are NOT imported.
 * They are defined here as standalone functions and passed directly to
 * chrome.scripting.executeScript({ func }), which serializes them via
 * Function.prototype.toString() and re-evaluates them in the target page's
 * MAIN world. They must be fully self-contained — no closures, no imports.
 */

/**
 * MAIN-World fetch + XHR hook — serialized and injected into the page's JS context.
 * Must be 100% self-contained: no imports, no closures over anything outside this function.
 */
function installPageCaptureHook(sessionId: string, tabId: number): void {
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
      parsed.searchParams.forEach((_val: string, key: string) => {
        if (SENSITIVE_PARAMS.some(p => key.toLowerCase().includes(p))) {
          parsed.searchParams.set(key, '[REDACTED]');
        }
      });
      return parsed.toString();
    } catch {
      return rawUrl;
    }
  }

  function extractGraphQLOperation(body: unknown): string | undefined {
    if (!body) return undefined;
    if (typeof body === 'string') {
      try { return (JSON.parse(body) as any).operationName || undefined; } catch { return undefined; }
    }
    if (typeof body === 'object' && body !== null) {
      return (body as any).operationName || undefined;
    }
    return undefined;
  }

  const w = window as any;
  if (w.__WIREDATA_HOOK_STATE__) {
    w.__WIREDATA_HOOK_STATE__.sessionId = sessionId;
    w.__WIREDATA_HOOK_STATE__.tabId = tabId;
    return;
  }

  const state = {
    originalFetch: window.fetch,
    originalXhrOpen: XMLHttpRequest.prototype.open,
    originalXhrSend: XMLHttpRequest.prototype.send,
    sessionId,
    tabId,
  };
  w.__WIREDATA_HOOK_STATE__ = state;

  // 1. Hook window.fetch
  const nativeFetch = window.fetch;
  const wrappedFetch = async function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    const startedAt = new Date().toISOString();
    const startTime = performance.now();
    const method = ((init?.method) || (typeof input === 'object' && 'method' in input ? (input as Request).method : 'GET')).toUpperCase();
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const sanitized = sanitizeUrl(rawUrl);
    const sanitizedPageUrl = sanitizeUrl(window.location.href);
    const graphqlOp = extractGraphQLOperation(init?.body);

    const response = await nativeFetch.apply(this, [input, init] as Parameters<typeof fetch>);

    try {
      const contentType = response.headers.get('content-type');
      if (isJsonMime(contentType)) {
        response.clone().json().then((jsonBody: unknown) => {
          const durationMs = Math.round(performance.now() - startTime);
          window.postMessage({ source: 'WIREDATA_PAGE_HOOK', type: 'PAGE_CAPTURE', payload: {
            sessionId: state.sessionId, tabId: state.tabId, method,
            url: sanitized, sanitized_url: sanitized, pageUrl: sanitizedPageUrl,
            status: response.status, statusText: response.statusText,
            mimeType: contentType || 'application/json', graphqlOperationName: graphqlOp,
            body: jsonBody, startedAt, completedAt: new Date().toISOString(), durationMs,
          }}, '*');
        }).catch(() => {});
      }
    } catch {}

    return response;
  };
  (wrappedFetch as any)[FETCH_SENTINEL] = true;
  window.fetch = wrappedFetch as typeof fetch;

  // 2. Hook XMLHttpRequest
  const nativeXhrOpen = XMLHttpRequest.prototype.open;
  const nativeXhrSend = XMLHttpRequest.prototype.send;
  const XHR_KEY = '__wiredata_xhr_data__';

  XMLHttpRequest.prototype.open = function (this: any, method: string, url: string | URL, ...rest: any[]) {
    const rawUrl = typeof url === 'string' ? url : url.toString();
    this[XHR_KEY] = { method: method.toUpperCase(), rawUrl, sanitizedUrl: sanitizeUrl(rawUrl), startedAt: new Date().toISOString(), startTime: performance.now() };
    return nativeXhrOpen.apply(this, [method, url, ...rest] as any);
  };
  (XMLHttpRequest.prototype.open as any)[XHR_SENTINEL] = true;

  XMLHttpRequest.prototype.send = function (this: any, body?: Document | XMLHttpRequestBodyInit | null) {
    const data = this[XHR_KEY];
    if (data) {
      data.graphqlOp = extractGraphQLOperation(body);
      this.addEventListener('load', function (this: XMLHttpRequest) {
        try {
          const contentType = this.getResponseHeader('content-type');
          if (isJsonMime(contentType)) {
            const jsonBody = this.responseType === 'json' ? this.response
              : this.responseText ? JSON.parse(this.responseText) : undefined;
            if (jsonBody !== undefined) {
              const durationMs = Math.round(performance.now() - data.startTime);
              window.postMessage({ source: 'WIREDATA_PAGE_HOOK', type: 'PAGE_CAPTURE', payload: {
                sessionId: state.sessionId, tabId: state.tabId, method: data.method,
                url: data.sanitizedUrl, sanitized_url: data.sanitizedUrl,
                pageUrl: sanitizeUrl(window.location.href),
                status: this.status, statusText: this.statusText,
                mimeType: contentType || 'application/json', graphqlOperationName: data.graphqlOp,
                body: jsonBody, startedAt: data.startedAt, completedAt: new Date().toISOString(), durationMs,
              }}, '*');
            }
          }
        } catch {}
      });
    }
    return nativeXhrSend.apply(this, [body] as any);
  };
  (XMLHttpRequest.prototype.send as any)[XHR_SENTINEL] = true;
}

/** Reverses fetch and XHR hooks — must also be fully self-contained. */
function uninstallPageCaptureHook(): void {
  const FETCH_SENTINEL = '__WIREDATA_FETCH_WRAPPER__';
  const XHR_SENTINEL = '__WIREDATA_XHR_WRAPPER__';
  const w = window as any;
  const state = w.__WIREDATA_HOOK_STATE__;
  if (!state) return;
  if (window.fetch && (window.fetch as any)[FETCH_SENTINEL] === true && state.originalFetch) {
    window.fetch = state.originalFetch;
  }
  if (XMLHttpRequest.prototype.open && (XMLHttpRequest.prototype.open as any)[XHR_SENTINEL] === true && state.originalXhrOpen) {
    XMLHttpRequest.prototype.open = state.originalXhrOpen;
  }
  if (XMLHttpRequest.prototype.send && (XMLHttpRequest.prototype.send as any)[XHR_SENTINEL] === true && state.originalXhrSend) {
    XMLHttpRequest.prototype.send = state.originalXhrSend;
  }
  delete w.__WIREDATA_HOOK_STATE__;
}

interface EphemeralSession {
  activeTabId: number | null;
  activeOrigin: string | null;
  activeSessionId: string | null;
  isCapturing: boolean;
}

const DEFAULT_SESSION: EphemeralSession = {
  activeTabId: null,
  activeOrigin: null,
  activeSessionId: null,
  isCapturing: false,
};

async function getSession(): Promise<EphemeralSession> {
  try {
    const data = await chrome.storage.session.get('wiredata_active_session');
    return data?.wiredata_active_session || { ...DEFAULT_SESSION };
  } catch {
    return { ...DEFAULT_SESSION };
  }
}

async function setSession(session: EphemeralSession): Promise<void> {
  try {
    await chrome.storage.session.set({ wiredata_active_session: session });
  } catch {}
}

/**
 * Broadcasts to any listening extension surface (side panel, workbench tab).
 * No-op safely if nothing is currently listening — the worker never depends
 * on a durable connection to deliver this.
 */
function broadcastToUI(message: any): void {
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch {}
}

async function stopCaptureForTab(tabId: number): Promise<void> {
  const session = await getSession();
  if (session.activeTabId === tabId && session.isCapturing) {
    // 1. Uninstall hook from page
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: uninstallPageCaptureHook,
      });
    } catch {}

    // 2. Clear badge
    try {
      await chrome.action.setBadgeText({ text: '', tabId });
    } catch {}

    // 3. Clear session
    await setSession({ ...DEFAULT_SESSION });

    // 4. Notify UI
    broadcastToUI({ type: 'CAPTURE_STATUS_CHANGED', isCapturing: false, tabId });
  }
}

// 1. On install/update: set panel to open automatically on action click.
// This is the most reliable path — Chrome handles the open internally
// without requiring the onClicked listener. The onClicked handler below
// is kept as defense-in-depth for pre-116 fallback paths.
chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  } catch {}
});

// 2. Action click: also explicitly open side panel (belt-and-suspenders).
chrome.action.onClicked.addListener(async tab => {
  if (tab.id) {
    try {
      await chrome.sidePanel.open({ tabId: tab.id });
    } catch (err) {
      console.warn('Side panel open error:', err);
    }
  }
});

// 2. Chrome 142+ Side Panel onClosed authoritative stop event
if ((chrome.sidePanel as any)?.onClosed) {
  (chrome.sidePanel as any).onClosed.addListener(async ({ tabId }: { tabId: number }) => {
    await stopCaptureForTab(tabId);
  });
}

// 3. Tab close listener
chrome.tabs.onRemoved.addListener(async tabId => {
  await stopCaptureForTab(tabId);
});

// 4. Tab navigation / origin change listener
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const session = await getSession();
  if (session.activeTabId !== tabId || !session.isCapturing) return;

  // Reinject as early as possible once the page has committed to a new
  // document, rather than waiting for 'complete' — by 'complete' many SPAs
  // have already fired their initial fetch/XHR calls and we'd miss them.
  // injectImmediately races the page's own scripts; it cannot guarantee a
  // pre-load hook, but it gets far closer than waiting for full load.
  if (changeInfo.status === 'loading' && tab.url) {
    try {
      const newOrigin = new URL(tab.url).origin;
      if (session.activeOrigin && newOrigin !== session.activeOrigin) {
        await stopCaptureForTab(tabId);
        return;
      }
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: installPageCaptureHook,
        args: [session.activeSessionId || '', tabId],
        injectImmediately: true,
      });
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['bridge.js'],
        injectImmediately: true,
      });
    } catch {}
    return;
  }

  if (changeInfo.status === 'complete' && tab.url) {
    try {
      const newOrigin = new URL(tab.url).origin;
      if (session.activeOrigin && newOrigin !== session.activeOrigin) {
        // Navigated to a different origin -> stop capture immediately
        await stopCaptureForTab(tabId);
      } else {
        // Same-origin: reinject as a fallback in case the early 'loading'
        // injection above didn't get a chance to run (e.g. worker was cold).
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: installPageCaptureHook,
            args: [session.activeSessionId || '', tabId],
          });
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ['bridge.js'],
          });
        } catch {}
      }
    } catch {
      await stopCaptureForTab(tabId);
    }
  }
});

// 5. Runtime message handling
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_SESSION_STATE') {
    getSession().then(sendResponse);
    return true;
  }

  if (message.type === 'START_TAB_CAPTURE') {
    const { tabId, origin, sessionId } = message;
    (async () => {
      // Stop any previously active capture (possibly on a different tab)
      // before starting a new one, so a stale hook/badge never survives
      // a switch to a new capture target.
      const existing = await getSession();
      if (existing.isCapturing && existing.activeTabId !== null && existing.activeTabId !== tabId) {
        await stopCaptureForTab(existing.activeTabId);
      }

      // 1. Inject MAIN-world hook
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: installPageCaptureHook,
        args: [sessionId, tabId],
      });

      // 2. Inject isolated content bridge
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['bridge.js'],
      });

      // 3. Set badge
      await chrome.action.setBadgeText({ text: 'REC', tabId });
      await chrome.action.setBadgeBackgroundColor({ color: '#ef4444', tabId });

      // 4. Save session in memory storage
      const newSession: EphemeralSession = {
        activeTabId: tabId,
        activeOrigin: origin,
        activeSessionId: sessionId,
        isCapturing: true,
      };
      await setSession(newSession);

      broadcastToUI({ type: 'CAPTURE_STATUS_CHANGED', isCapturing: true, tabId });
      sendResponse({ success: true });
    })().catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  if (message.type === 'STOP_TAB_CAPTURE') {
    const { tabId } = message;
    stopCaptureForTab(tabId).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === 'WIREDATA_PAGE_CAPTURE_EVENT') {
    const payload = message.payload;
    (async () => {
      const session = await getSession();
      // Strict tab and origin validation: reject from any other tab
      if (
        session.isCapturing &&
        session.activeTabId === sender.tab?.id &&
        session.activeSessionId === payload.sessionId
      ) {
        broadcastToUI({
          type: 'PAGE_CAPTURE_RECEIVED',
          capturePayload: payload,
          senderTab: sender.tab,
        });
      }
    })();
  }

  return undefined;
});

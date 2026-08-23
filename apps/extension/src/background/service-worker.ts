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
 */

import { installPageCaptureHook, uninstallPageCaptureHook } from '../capture/hooks/main-world-hooks.js';

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

// 1. Action click opens side panel on current tab
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

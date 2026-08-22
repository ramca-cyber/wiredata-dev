/**
 * WireData Manifest V3 Background Service Worker
 * Coordinates activeTab capture sessions, sidePanel lifecycle, and toolbar badges.
 * Ephemeral session registry stored in chrome.storage.session.
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

// Connected Side Panel / Workbench UI ports
const connectedPorts = new Set<chrome.runtime.Port>();

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

async function broadcastToUI(message: any) {
  for (const port of connectedPorts) {
    try {
      port.postMessage(message);
    } catch {
      connectedPorts.delete(port);
    }
  }
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
  if (!changeInfo.url && changeInfo.status !== 'complete') return;

  const session = await getSession();
  if (session.activeTabId === tabId && session.isCapturing) {
    if (tab.url) {
      try {
        const newOrigin = new URL(tab.url).origin;
        if (session.activeOrigin && newOrigin !== session.activeOrigin) {
          // Navigated to a different origin -> stop capture immediately
          await stopCaptureForTab(tabId);
        } else if (changeInfo.status === 'complete') {
          // Same-origin reload/navigation -> reinject hook
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
  }
});

// 5. Port connections from Side Panel or Workbench
chrome.runtime.onConnect.addListener(port => {
  if (port.name === 'wiredata_ui_channel') {
    connectedPorts.add(port);
    port.onDisconnect.addListener(() => {
      connectedPorts.delete(port);
    });
  }
});

// 6. Runtime message handling
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_SESSION_STATE') {
    getSession().then(sendResponse);
    return true;
  }

  if (message.type === 'START_TAB_CAPTURE') {
    const { tabId, origin, sessionId } = message;
    (async () => {
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
});

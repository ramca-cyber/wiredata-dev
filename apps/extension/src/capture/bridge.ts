/**
 * Isolated World Content Bridge
 * Listens for MAIN-world capture messages and relays them securely to the background service worker.
 */

window.addEventListener('message', event => {
  // Only accept messages from current window
  if (event.source !== window) return;

  const data = event.data;
  if (!data || data.source !== 'WIREDATA_PAGE_HOOK' || data.type !== 'PAGE_CAPTURE') {
    return;
  }

  try {
    chrome.runtime.sendMessage({
      type: 'WIREDATA_PAGE_CAPTURE_EVENT',
      payload: data.payload,
    }).catch(() => {});
  } catch {}
});

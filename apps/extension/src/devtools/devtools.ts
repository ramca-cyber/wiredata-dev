/**
 * DevTools Bootstrap Script
 * Registers the "Data" panel in Chromium DevTools
 */

if (typeof chrome !== 'undefined' && chrome.devtools && chrome.devtools.panels) {
  chrome.devtools.panels.create(
    'Data',
    '',
    'panel.html',
    (panel) => {
      // Panel created
    }
  );
}

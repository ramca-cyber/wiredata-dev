/**
 * Automated Deep Chrome Smoke Test on Production ZIP
 * 
 * 1. Extracts the exact release ZIP artifact into a clean directory.
 * 2. Launches real headless Chrome with --load-extension.
 * 3. Connects via Chrome DevTools Protocol (CDP):
 *    - Verifies the MV3 extension is registered and discovers its extension ID (fails closed if missing).
 *    - Opens `workbench.html` and `sidepanel.html` targets.
 *    - Connects to target WebSockets, listens for Runtime exceptions, console.error calls, and CSP errors.
 *    - Asserts DuckDB is in ACTIVE state in Workbench.
 *    - Verifies DOM mounting and absence of runtime errors.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import AdmZip from 'adm-zip';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const rootPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const version = rootPkg.version;
const zipPath = path.join(rootDir, 'release', `wiredata-extension-v${version}.zip`);
const smokeDir = path.join(rootDir, 'release', 'smoke-test-unpacked');

console.log(`\n🧪 Starting Deep Chrome Smoke Test on ZIP artifact v${version}...`);

if (!fs.existsSync(zipPath)) {
  console.error(`❌ ZIP package not found at: ${zipPath}`);
  process.exit(1);
}

// 1. Clean and extract exact ZIP
if (fs.existsSync(smokeDir)) {
  fs.rmSync(smokeDir, { recursive: true, force: true });
}
fs.mkdirSync(smokeDir, { recursive: true });

console.log(`📦 Extracting ${path.basename(zipPath)} to isolated smoke directory...`);
const zip = new AdmZip(zipPath);
zip.extractAllTo(smokeDir, true);

// Verify manifest in extracted folder
const manifestPath = path.join(smokeDir, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error(`❌ Extracted package missing manifest.json`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
console.log(`  ✓ Unpacked manifest.json verified: "${manifest.name}" v${manifest.version}`);

// 2. Find Chrome executable
function findChrome() {
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) {
    return process.env.CHROME_BIN;
  }
  const possiblePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];

  for (const p of possiblePaths) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

const chromeBin = findChrome();
if (!chromeBin) {
  console.warn(`⚠️ Chrome executable not detected on standard paths. Skipping live browser invocation.`);
  console.log(`✅ Static ZIP unpacked verification completed successfully.`);
  process.exit(0);
}

console.log(`🌐 Using Chrome binary: ${chromeBin}`);

// 3. Launch Chrome with isolated profile and loaded extension
const tempUserDataDir = path.join(rootDir, 'release', 'smoke-temp-profile');
if (fs.existsSync(tempUserDataDir)) {
  try { fs.rmSync(tempUserDataDir, { recursive: true, force: true }); } catch {}
}
fs.mkdirSync(tempUserDataDir, { recursive: true });

const chromeArgs = [
  `--user-data-dir=${tempUserDataDir}`,
  `--disable-extensions-except=${smokeDir}`,
  `--load-extension=${smokeDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--headless=new',
  '--remote-debugging-port=9222',
  'about:blank',
];

console.log(`🚀 Launching Chrome instance with --load-extension...`);
const chromeProcess = spawn(chromeBin, chromeArgs, { stdio: 'pipe' });

const cleanup = () => {
  try { chromeProcess.kill('SIGTERM'); } catch {}
  setTimeout(() => {
    try { fs.rmSync(tempUserDataDir, { recursive: true, force: true }); } catch {}
  }, 1000);
};

// CDP WebSocket Helper using Node native WebSocket
function inspectTargetWs(wsUrl, pageName, { requireDuckDb = false } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const errors = [];
    let msgId = 1;
    const pending = new Map();

    function send(method, params = {}) {
      return new Promise((res, rej) => {
        const id = msgId++;
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`Timeout inspecting ${pageName}`));
    }, 10000);

    ws.onopen = async () => {
      try {
        await send('Runtime.enable');
        await send('Log.enable');

        // Allow React and DuckDB client time to complete in-browser initialization
        let readyState = null;
        for (let attempt = 0; attempt < 20; attempt++) {
          await new Promise(r => setTimeout(r, 250));

          const evalRes = await send('Runtime.evaluate', {
            expression: `JSON.stringify({
              title: document.title,
              hasRootChildren: (document.getElementById('root')?.childElementCount || 0) > 0,
              bodyTextLength: document.body.innerText.length,
              duckdbState: document.querySelector('[data-testid="duckdb-status"]')?.getAttribute('data-state') || null,
              hasErrorElements: !!document.querySelector('.error-banner')
            })`,
            returnByValue: true,
          });

          const state = JSON.parse(evalRes.result?.value || '{}');
          if (requireDuckDb) {
            if (state.duckdbState === 'active') {
              readyState = state;
              break;
            }
          } else if (state.hasRootChildren) {
            readyState = state;
            break;
          }
        }

        clearTimeout(timeout);
        ws.close();

        if (errors.length > 0) {
          reject(new Error(`Runtime/Console errors on ${pageName}: ${errors.join('; ')}`));
        } else if (!readyState || !readyState.hasRootChildren) {
          reject(new Error(`${pageName} mounted empty #root element or failed to render`));
        } else if (requireDuckDb && readyState.duckdbState !== 'active') {
          reject(new Error(`${pageName} DuckDB status is '${readyState.duckdbState}', expected 'active'`));
        } else {
          resolve(readyState);
        }
      } catch (err) {
        clearTimeout(timeout);
        ws.close();
        reject(err);
      }
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.id && pending.has(data.id)) {
        const { res, rej } = pending.get(data.id);
        pending.delete(data.id);
        if (data.error) rej(new Error(data.error.message));
        else res(data.result);
      }

      if (data.method === 'Runtime.exceptionThrown') {
        const desc = data.params?.exceptionDetails?.text || 'Uncaught exception';
        const stack = data.params?.exceptionDetails?.exception?.description || '';
        errors.push(`${desc} ${stack}`);
      }

      if (data.method === 'Runtime.consoleAPICalled' && data.params?.type === 'error') {
        const msg = (data.params.args || []).map(a => a.value || a.description || '').join(' ');
        errors.push(`Console.error: ${msg}`);
      }

      if (data.method === 'Log.entryAdded' && data.params?.entry?.level === 'error') {
        errors.push(`Log Error: ${data.params.entry.text}`);
      }
    };

    ws.onerror = (e) => {
      clearTimeout(timeout);
      reject(new Error(`WebSocket error on ${pageName}: ${e.message || 'connection failed'}`));
    };
  });
}

// Main Smoke Test Workflow
async function runSmokeTest() {
  const cdpBase = 'http://127.0.0.1:9222';
  let targets = [];

  // 1. Wait for CDP endpoint
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${cdpBase}/json/list`);
      if (res.ok) {
        targets = await res.json();
        break;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }

  if (targets.length === 0) {
    throw new Error('Chrome CDP did not become responsive within 6 seconds.');
  }

  console.log(`  ✓ Chrome CDP responsive. Inspecting targets...`);

  // 2. Discover Extension ID from service worker or loaded targets
  let extensionId = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    const currentTargets = await (await fetch(`${cdpBase}/json/list`)).json();
    for (const t of currentTargets) {
      const match = t.url?.match(/chrome-extension:\/\/([a-z0-9]+)/);
      if (match) {
        extensionId = match[1];
        console.log(`  ✓ Discovered loaded WireData extension target: ${t.url} (ID: ${extensionId})`);
        break;
      }
    }
    if (extensionId) break;
    await new Promise(r => setTimeout(r, 300));
  }

  // Fails closed unconditionally if extension ID was not found
  if (!extensionId) {
    throw new Error('WireData extension target not found in Chrome CDP. Extension failed to load.');
  }

  // 3. Test Workbench Page with DuckDB Active Assertion
  console.log(`\n📄 Testing Workbench Page (chrome-extension://${extensionId}/workbench.html)...`);
  const wbTargetRes = await fetch(`${cdpBase}/json/new?chrome-extension://${extensionId}/workbench.html`, { method: 'PUT' });
  const wbTarget = await wbTargetRes.json();
  
  if (!wbTarget.webSocketDebuggerUrl) {
    throw new Error('Failed to create CDP debugger for workbench.html');
  }

  const wbState = await inspectTargetWs(wbTarget.webSocketDebuggerUrl, 'workbench.html', { requireDuckDb: true });
  console.log(`  ✓ workbench.html rendered cleanly (Title: "${wbState.title}", DuckDB State: "${wbState.duckdbState}")`);

  // 4. Test Side Panel Page
  console.log(`\n📱 Testing Side Panel Page (chrome-extension://${extensionId}/sidepanel.html)...`);
  const spTargetRes = await fetch(`${cdpBase}/json/new?chrome-extension://${extensionId}/sidepanel.html`, { method: 'PUT' });
  const spTarget = await spTargetRes.json();
  
  if (!spTarget.webSocketDebuggerUrl) {
    throw new Error('Failed to create CDP debugger for sidepanel.html');
  }

  const spState = await inspectTargetWs(spTarget.webSocketDebuggerUrl, 'sidepanel.html', { requireDuckDb: false });
  console.log(`  ✓ sidepanel.html rendered cleanly without exceptions (Title: "${spState.title}", text length: ${spState.bodyTextLength} chars)`);

  console.log(`\n✅ Deep Chrome Smoke Test PASSED: Release ZIP v${version} installed, verified DuckDB ACTIVE, rendered UI pages, and ran with zero runtime exceptions or console errors.\n`);
}

runSmokeTest()
  .then(() => {
    cleanup();
    process.exit(0);
  })
  .catch((err) => {
    cleanup();
    console.error(`\n❌ Deep Chrome Smoke Test FAILED: ${err.message}\n`);
    process.exit(1);
  });

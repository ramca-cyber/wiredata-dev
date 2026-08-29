/**
 * Automated Screenshot Capture for ramwise.dev Portfolio Blog Post
 * Captures clean, high-resolution screenshots of WireData:
 * 1. Side Panel companion with live collection discovery & types
 * 2. Full SQL Data Workbench with DuckDB analytical queries
 * 3. Datasets & Schema Explorer with provenance metadata
 * 4. TypeScript / JSON Schema instant generation modal
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import AdmZip from 'adm-zip';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const outDir = path.join(rootDir, 'blog', 'assets');
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const rootPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const version = rootPkg.version;
const zipPath = path.join(rootDir, 'release', `wiredata-extension-v${version}.zip`);
const smokeDir = path.join(rootDir, 'release', 'smoke-test-unpacked');

console.log(`\n📸 Starting Screenshot Capture for ramwise.dev Blog Post (v${version})...`);

if (!fs.existsSync(zipPath)) {
  console.error(`❌ ZIP package not found at: ${zipPath}. Run npm run package first.`);
  process.exit(1);
}

// 1. Extract ZIP
if (fs.existsSync(smokeDir)) {
  fs.rmSync(smokeDir, { recursive: true, force: true });
}
fs.mkdirSync(smokeDir, { recursive: true });
const zip = new AdmZip(zipPath);
zip.extractAllTo(smokeDir, true);

// 2. Find Chrome
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
  console.error('❌ Chrome executable not found.');
  process.exit(1);
}

const tempUserDataDir = path.join(rootDir, 'release', 'blog-temp-profile');
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
  '--no-sandbox',
  '--disable-gpu',
  '--headless=new',
  '--remote-debugging-port=9223',
  'about:blank',
];

const chromeProcess = spawn(chromeBin, chromeArgs, { stdio: 'pipe' });

const cleanup = () => {
  try { chromeProcess.kill('SIGTERM'); } catch {}
  setTimeout(() => {
    try { fs.rmSync(tempUserDataDir, { recursive: true, force: true }); } catch {}
  }, 1000);
};

// CDP WebSocket Helper
function connectWs(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let msgId = 1;
    const pending = new Map();

    function send(method, params = {}) {
      return new Promise((res, rej) => {
        const id = msgId++;
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    ws.onopen = () => {
      resolve({ ws, send });
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.id && pending.has(data.id)) {
        const { res, rej } = pending.get(data.id);
        pending.delete(data.id);
        if (data.error) rej(new Error(data.error.message));
        else res(data.result);
      }
    };

    ws.onerror = (err) => reject(err);
  });
}

async function captureScreenshots() {
  const cdpBase = 'http://127.0.0.1:9223';
  let targets = [];

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
    throw new Error('Chrome CDP did not become responsive on port 9223.');
  }

  const baseUrl = 'http://localhost:8081';
  console.log(`  ✓ Using local server at: ${baseUrl}`);

  // -------------------------------------------------------------
  // SCREENSHOT 2: Workbench - Captures View (1440 x 900)
  // -------------------------------------------------------------
  console.log('📊 Capturing Screenshot 2: Workbench UI & Captures...');
  const wbTargetRes = await fetch(`${cdpBase}/json/new`, { method: 'PUT' });
  const wbTarget = await wbTargetRes.json();
  const { ws: wbWs, send: wbSend } = await connectWs(wbTarget.webSocketDebuggerUrl);

  await wbSend('Page.enable');
  await wbSend('Runtime.enable');
  await wbSend('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await wbSend('Page.navigate', { url: `${baseUrl}/workbench.html` });
  await new Promise(r => setTimeout(r, 2000));

  // Click Load Sample Data button
  await wbSend('Runtime.evaluate', {
    expression: `
      (async () => {
        for (let i = 0; i < 20; i++) {
          const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent && b.textContent.includes('Load Sample Data'));
          if (btn) {
            btn.click();
            break;
          }
          await new Promise(r => setTimeout(r, 100));
        }
      })();
    `
  });
  await new Promise(r => setTimeout(r, 1500));

  const wbShot1 = await wbSend('Page.captureScreenshot', { format: 'png' });
  const wbFile1 = path.join(outDir, '02-wiredata-workbench-captures.png');
  fs.writeFileSync(wbFile1, Buffer.from(wbShot1.data, 'base64'));
  console.log(`  ✓ Saved: ${wbFile1}`);

  // -------------------------------------------------------------
  // SCREENSHOT 3: DuckDB Analytical SQL Runner with Results (1440 x 900)
  // -------------------------------------------------------------
  console.log('⚡ Capturing Screenshot 3: DuckDB SQL Query Results...');
  await wbSend('Runtime.evaluate', {
    expression: `
      (async () => {
        // 1. Click Candidates tab
        const candBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent && b.textContent.includes('Candidates'));
        if (candBtn) {
          candBtn.click();
          await new Promise(r => setTimeout(r, 800));
          // Click Extract Combined Dataset
          const extractBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent && b.textContent.includes('Extract Combined'));
          if (extractBtn) {
            extractBtn.click();
            await new Promise(r => setTimeout(r, 1000));
          }
        }

        // 2. Click SQL Workspace tab
        const sqlTab = Array.from(document.querySelectorAll('button')).find(b => b.textContent && b.textContent.includes('SQL Workspace'));
        if (sqlTab) {
          sqlTab.click();
          await new Promise(r => setTimeout(r, 1000));
          
          // Set an interesting SQL query in textarea
          const ta = document.querySelector('textarea');
          if (ta) {
            ta.value = "SELECT status, count(*) AS total_orders, round(avg(total_amount), 2) AS avg_amount, round(sum(total_amount), 2) AS gross_sales\\nFROM orders\\nGROUP BY status\\nORDER BY gross_sales DESC;";
            ta.dispatchEvent(new Event('input', { bubbles: true }));
          }

          // Click Run SQL
          const runBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent && b.textContent.includes('Run SQL'));
          if (runBtn) {
            runBtn.click();
          }
        }
      })();
    `
  });
  await new Promise(r => setTimeout(r, 3000));

  const wbShot2 = await wbSend('Page.captureScreenshot', { format: 'png' });
  const wbFile2 = path.join(outDir, '03-wiredata-duckdb-sql.png');
  fs.writeFileSync(wbFile2, Buffer.from(wbShot2.data, 'base64'));
  console.log(`  ✓ Saved: ${wbFile2}`);

  // -------------------------------------------------------------
  // SCREENSHOT 4: Datasets Explorer Table (1440 x 900)
  // -------------------------------------------------------------
  console.log('📁 Capturing Screenshot 4: Datasets Explorer Table...');
  await wbSend('Runtime.evaluate', {
    expression: `
      (async () => {
        // Find sidebar dataset button
        const allElements = Array.from(document.querySelectorAll('*'));
        const orderBtn = allElements.find(el => el.textContent === 'orders' && el.parentElement?.textContent?.includes('300'));
        if (orderBtn) {
          orderBtn.click();
        } else {
          const dsBtn = Array.from(document.querySelectorAll('button, div')).find(el => el.textContent && el.textContent.includes('orders') && el.textContent.includes('300'));
          if (dsBtn) dsBtn.click();
        }
      })();
    `
  });
  await new Promise(r => setTimeout(r, 2000));

  const wbShot3 = await wbSend('Page.captureScreenshot', { format: 'png' });
  const wbFile3 = path.join(outDir, '04-wiredata-datasets-explorer.png');
  fs.writeFileSync(wbFile3, Buffer.from(wbShot3.data, 'base64'));
  console.log(`  ✓ Saved: ${wbFile3}`);
  wbWs.close();

  // -------------------------------------------------------------
  // SCREENSHOT 1: Side Panel Companion UI (440 x 780)
  // -------------------------------------------------------------
  console.log('📱 Capturing Screenshot 1: Side Panel UI with Discovered Collections...');
  const spTargetRes = await fetch(`${cdpBase}/json/new`, { method: 'PUT' });
  const spTarget = await spTargetRes.json();
  const { ws: spWs, send: spSend } = await connectWs(spTarget.webSocketDebuggerUrl);

  await spSend('Page.enable');
  await spSend('Runtime.enable');
  await spSend('Emulation.setDeviceMetricsOverride', {
    width: 440,
    height: 780,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await spSend('Page.navigate', { url: `${baseUrl}/sidepanel.html` });
  await new Promise(r => setTimeout(r, 2000));

  await spSend('Runtime.evaluate', {
    expression: `
      (async () => {
        for (let i = 0; i < 20; i++) {
          if (document.getElementById('root')?.childElementCount > 0) break;
          await new Promise(r => setTimeout(r, 100));
        }

        // Simulate click on start capture or render cards
        const buttons = Array.from(document.querySelectorAll('button'));
        const startBtn = buttons.find(b => b.textContent && b.textContent.includes('Start Capture'));
        if (startBtn) {
          startBtn.click();
        }
      })();
    `
  });
  await new Promise(r => setTimeout(r, 1500));

  const spShot = await spSend('Page.captureScreenshot', { format: 'png' });
  const spFile = path.join(outDir, '01-wiredata-sidepanel.png');
  fs.writeFileSync(spFile, Buffer.from(spShot.data, 'base64'));
  console.log(`  ✓ Saved: ${spFile}`);
  spWs.close();
  console.log('\n🎉 All portfolio screenshots captured successfully in blog/assets/!\n');
}

captureScreenshots()
  .then(() => {
    cleanup();
    process.exit(0);
  })
  .catch((err) => {
    cleanup();
    console.error(`\n❌ Error capturing screenshots: ${err.message}\n`);
    process.exit(1);
  });

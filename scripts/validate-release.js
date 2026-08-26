/**
 * Automated Release Package Validator
 * Validates that the generated extension ZIP and dist folder strictly satisfy
 * Chrome Web Store Manifest V3 guidelines, file structure, and runtime integrity.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const rootPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const version = rootPkg.version;
const zipPath = path.join(rootDir, 'release', `wiredata-extension-v${version}.zip`);
const distDir = path.join(rootDir, 'apps', 'extension', 'dist');

console.log(`\n🔍 Validating WireData Extension Release Package v${version}...`);

const errors = [];
const warnings = [];

// 1. Verify ZIP existence
if (!fs.existsSync(zipPath)) {
  errors.push(`Release ZIP does not exist: ${zipPath}`);
  console.error(`❌ ${errors[0]}`);
  process.exit(1);
}

const stats = fs.statSync(zipPath);
console.log(`📦 Release ZIP found: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

// 2. Open and inspect ZIP entries
const zip = new AdmZip(zipPath);
const entries = zip.getEntries().map(e => e.entryName.replace(/\\/g, '/'));

console.log(`📋 Total ZIP entries: ${entries.length}`);

// Required critical files
const requiredFiles = [
  'manifest.json',
  'sidepanel.html',
  'workbench.html',
  'devtools.html',
  'panel.html',
  'service-worker.js',
  'bridge.js',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-48.png',
  'icons/icon-128.png',
  'duckdb/duckdb-mvp.wasm',
  'duckdb/duckdb-browser-mvp.worker.js',
];

for (const req of requiredFiles) {
  if (!entries.includes(req)) {
    errors.push(`Missing required file in ZIP: ${req}`);
  } else {
    console.log(`  ✓ Found ${req}`);
  }
}

// 3. Inspect manifest.json
const manifestEntry = zip.getEntry('manifest.json');
if (manifestEntry) {
  try {
    const manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
    
    if (manifest.manifest_version !== 3) {
      errors.push(`manifest_version must be 3, found: ${manifest.manifest_version}`);
    }
    if (manifest.version !== version) {
      errors.push(`manifest version (${manifest.version}) does not match package.json (${version})`);
    }
    if (manifest.description && manifest.description.length > 132) {
      errors.push(`manifest description length (${manifest.description.length}) exceeds Chrome Web Store limit of 132 chars`);
    }
    if (manifest.permissions?.includes('unlimitedStorage')) {
      errors.push(`manifest.json still contains unnecessary unlimitedStorage permission`);
    }
    if (manifest.background?.type === 'module') {
      errors.push(`manifest.json background service worker must not have type: "module"`);
    }
    if (manifest.content_security_policy?.extension_pages) {
      const csp = manifest.content_security_policy.extension_pages;
      if (csp.includes('blob:')) {
        errors.push(`manifest content_security_policy.extension_pages contains illegal 'blob:' directive`);
      }
      if (csp.includes('unsafe-eval') && !csp.includes('wasm-unsafe-eval')) {
        errors.push(`manifest CSP contains disallowed 'unsafe-eval'`);
      }
    }
    console.log(`  ✓ manifest.json validated (MV3, version ${manifest.version}, permissions: [${manifest.permissions?.join(', ')}])`);
  } catch (e) {
    errors.push(`Failed to parse manifest.json: ${e.message}`);
  }
}

// 4. Inspect HTML files for dev-mode leftovers and missing asset links
const htmlFiles = ['sidepanel.html', 'workbench.html', 'devtools.html', 'panel.html'];
for (const htmlFile of htmlFiles) {
  const entry = zip.getEntry(htmlFile);
  if (!entry) continue;
  
  const content = entry.getData().toString('utf8');
  
  // Check for dev-mode /src/ paths
  if (content.includes('/src/')) {
    errors.push(`${htmlFile} contains unbuilt source reference (/src/...)`);
  }
  
  // Check for crossorigin attribute
  if (content.includes('crossorigin')) {
    warnings.push(`${htmlFile} contains crossorigin attribute which may trigger extension resource loading errors`);
  }
  
  // Extract script src and link href
  const scriptMatches = [...content.matchAll(/src=["']([^"']+)["']/g)].map(m => m[1]);
  for (const src of scriptMatches) {
    const cleanSrc = src.startsWith('/') ? src.slice(1) : src;
    if (!entries.includes(cleanSrc)) {
      errors.push(`${htmlFile} references missing script: ${src}`);
    }
  }
}

// 5. Inspect service-worker.js format
const swEntry = zip.getEntry('service-worker.js');
if (swEntry) {
  const swContent = swEntry.getData().toString('utf8').trim();
  if (swContent.includes('import ') || swContent.startsWith('export ')) {
    errors.push(`service-worker.js contains ES module keywords (must be classic IIFE bundle)`);
  } else {
    console.log(`  ✓ service-worker.js is a valid classic bundle`);
  }
}

// Summary output
console.log('\n--- Validation Results ---');
if (warnings.length > 0) {
  console.log(`⚠️ Warnings (${warnings.length}):`);
  for (const w of warnings) console.log(`   - ${w}`);
}

if (errors.length > 0) {
  console.error(`❌ Errors (${errors.length}):`);
  for (const err of errors) console.error(`   - ${err}`);
  process.exit(1);
} else {
  console.log(`✅ All package checks passed! Package is ready for Chrome Web Store submission.\n`);
}

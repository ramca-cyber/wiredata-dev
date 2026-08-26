import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { copyFileSync, existsSync, mkdirSync, createReadStream } from 'fs';

/**
 * Chrome extension pages are served from chrome-extension://id/ — the extension
 * resource loader does NOT handle CORS-mode fetches. Vite adds `crossorigin` to
 * every <script type="module"> and <link rel="modulepreload"> it generates, which
 * causes Chrome to attempt a CORS fetch that fails, resulting in a blank
 * chrome-error://chromewebdata/ error page instead of the side panel UI.
 * This plugin strips `crossorigin` from all generated HTML.
 */
function removeCrossoriginPlugin() {
  return {
    name: 'remove-crossorigin',
    transformIndexHtml(html: string): string {
      return html.replace(/ crossorigin/g, '');
    },
  };
}

function copyManifestPlugin() {
  return {
    name: 'copy-manifest',
    closeBundle() {
      if (existsSync(resolve(__dirname, 'manifest.json'))) {
        copyFileSync(
          resolve(__dirname, 'manifest.json'),
          resolve(__dirname, 'dist/manifest.json')
        );
      }
    },
  };
}

/**
 * Serves (dev) / copies (build) the DuckDB-WASM MVP bundle straight from
 * node_modules, under /duckdb/*. Self-hosting is required, not optional:
 * fetching these from jsDelivr never actually initializes (confirmed — it
 * throws "duckdb is not initialized" even with zero CSP in play), and even
 * if it did, a cross-origin worker script violates the packaged extension's
 * CSP (script-src 'self') and the project's own zero-cloud-backend
 * invariant. The MVP variant needs no COOP/COEP headers, unlike eh/coi.
 *
 * The 39MB wasm binary is never committed to the repo — it's copied from
 * node_modules at build time and served from there in dev.
 */
function duckdbAssetsPlugin() {
  const ASSETS = ['duckdb-mvp.wasm', 'duckdb-browser-mvp.worker.js'];
  const sourceDir = resolve(__dirname, '../../node_modules/@duckdb/duckdb-wasm/dist');

  return {
    name: 'duckdb-assets',
    configureServer(server: any) {
      server.middlewares.use((req: any, res: any, next: any) => {
        const match = ASSETS.find(a => req.url === `/duckdb/${a}`);
        if (!match) return next();
        res.setHeader('Content-Type', match.endsWith('.wasm') ? 'application/wasm' : 'application/javascript');
        createReadStream(resolve(sourceDir, match)).pipe(res);
      });
    },
    closeBundle() {
      const outDir = resolve(__dirname, 'dist/duckdb');
      mkdirSync(outDir, { recursive: true });
      for (const asset of ASSETS) {
        copyFileSync(resolve(sourceDir, asset), resolve(outDir, asset));
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  // When building the service-worker and bridge as separate classic (IIFE)
  // scripts, we use the SW_BUILD env var. Normal build handles HTML pages.
  const isSwBuild = mode === 'sw';

  if (isSwBuild) {
    const target = process.env.SW_TARGET ?? 'service-worker';
    const outputName = target === 'bridge' ? 'bridge.js' : 'service-worker.js';
    const inputFile = target === 'bridge'
      ? resolve(__dirname, 'src/capture/bridge.ts')
      : resolve(__dirname, 'src/background/service-worker.ts');

    // Build service-worker.js and bridge.js as plain IIFE scripts.
    // IIFE requires a single entry (inlineDynamicImports). These must NOT use
    // ES module syntax because:
    //   - service-worker: manifest.json has no "type":"module" — Chrome
    //     loads it as a classic script.
    //   - bridge.js: injected via chrome.scripting.executeScript({files:['bridge.js']})
    //     into a content-script (isolated) world — must be a classic script.
    return {
      plugins: [copyManifestPlugin(), duckdbAssetsPlugin()],
      build: {
        outDir: 'dist',
        emptyOutDir: false, // Don't wipe HTML build output
        rollupOptions: {
          input: inputFile,
          output: {
            format: 'iife',
            entryFileNames: outputName,
            inlineDynamicImports: true,
            name: 'WireData',
          },
        },
      },
    };
  }

  // Default: build the multi-page HTML app (sidepanel, workbench, devtools, panel).
  // removeCrossoriginPlugin() strips the `crossorigin` attribute Vite adds to every
  // generated <script type="module"> and <link rel="modulepreload">. Without this,
  // Chrome extension pages show chrome-error://chromewebdata/ because the CORS-mode
  // fetch of chrome-extension:// resources fails silently.
  return {
    plugins: [react(), copyManifestPlugin(), duckdbAssetsPlugin(), removeCrossoriginPlugin()],
    build: {
      outDir: 'dist',
      // Disable the modulePreload polyfill — it adds its own crossorigin attributes
      // and is not needed (all Chrome versions that support MV3 support modulepreload).
      modulePreload: { polyfill: false },
      rollupOptions: {
        input: {
          sidepanel: resolve(__dirname, 'sidepanel.html'),
          workbench: resolve(__dirname, 'workbench.html'),
          devtools: resolve(__dirname, 'devtools.html'),
          panel: resolve(__dirname, 'panel.html'),
        },
        output: {
          entryFileNames: 'assets/[name]-[hash].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  };
});

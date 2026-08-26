import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { copyFileSync, existsSync, mkdirSync, createReadStream } from 'fs';

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

  // Default: build the multi-page HTML app (sidepanel, workbench, devtools, panel)
  // using ES modules with modulepreload — correct for extension pages.
  return {
    plugins: [react(), copyManifestPlugin(), duckdbAssetsPlugin()],
    build: {
      outDir: 'dist',
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

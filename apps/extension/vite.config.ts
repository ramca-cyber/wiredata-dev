import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { copyFileSync, existsSync } from 'fs';

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

export default defineConfig({
  plugins: [react(), copyManifestPlugin()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        devtools: resolve(__dirname, 'devtools.html'),
        panel: resolve(__dirname, 'panel.html'),
      },
    },
  },
});

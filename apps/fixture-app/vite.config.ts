import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { handleMockRequest } from './src/mock-server';

function mockApiPlugin(): Plugin {
  return {
    name: 'mock-api-plugin',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url || '';
        if (url.startsWith('/api/') || url.startsWith('/graphql')) {
          let body = '';
          req.on('data', chunk => (body += chunk));
          req.on('end', async () => {
            try {
              const response = await handleMockRequest({
                method: req.method || 'GET',
                url,
                body,
                headers: req.headers as Record<string, string>,
              });

              res.statusCode = response.status;
              for (const [k, v] of Object.entries(response.headers)) {
                res.setHeader(k, v);
              }
              res.end(response.body);
            } catch (err: any) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), mockApiPlugin()],
  server: {
    port: 5173,
  },
});

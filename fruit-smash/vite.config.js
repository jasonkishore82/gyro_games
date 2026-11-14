import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import controllerPlugin from './server/controllerPlugin.js';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), controllerPlugin({ certDir: path.join(root, '.cert') })],
  server: { host: true, port: 5275, strictPort: true },
  preview: { host: true, port: 5275, strictPort: true },
  build: {
    rollupOptions: {
      input: {
        main: path.join(root, 'index.html'),
        controller: path.join(root, 'controller.html'),
      },
    },
  },
});

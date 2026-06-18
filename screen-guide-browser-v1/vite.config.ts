import { defineConfig } from 'vite';
import { resolve } from 'path';
import { copyFileSync, existsSync } from 'fs';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/background.ts'),
        content: resolve(__dirname, 'src/content.ts'),
        panel: resolve(__dirname, 'src/panel.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name].[ext]',
      },
    },
  },
  plugins: [
    {
      name: 'copy-extension-files',
      closeBundle() {
        copyFileSync('src/manifest.json', 'dist/manifest.json');
        const driverCss = 'node_modules/driver.js/dist/driver.css';
        if (existsSync(driverCss)) copyFileSync(driverCss, 'dist/driver.css');
      },
    },
  ],
});

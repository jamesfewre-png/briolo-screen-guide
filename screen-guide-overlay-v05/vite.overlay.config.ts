import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './',
  root: 'src/ui/overlay',
  build: {
    outDir: '../../../dist/overlay',
    emptyOutDir: true,
  },
})

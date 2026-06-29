import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react()],
    // pin the dev server to a fixed, app-specific port (next to the TTS port 51273) so it
    // doesn't drift across 3000/5173 and won't collide with other tools' default ports
    server: {
      port: 51280,
      strictPort: true
    },
    // PDF editor (@pdf-editor/core, vendored under src/renderer/src/pdf-editor): MuPDF ships its
    // own WASM — let Vite serve it as an asset instead of pre-bundling, and emit the engine worker
    // as an ES module (it's spawned via new Worker(new URL(...), { type: 'module' }))
    optimizeDeps: { exclude: ['mupdf'] },
    worker: { format: 'es' }
  }
})

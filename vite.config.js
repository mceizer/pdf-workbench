import { defineConfig } from 'vite'

// mupdf är ESM-only, använder top-level await och laddar en stor WASM-binär.
// - worker.format 'es': mupdf kräver ESM (inte IIFE)
// - target esnext: mupdf använder top-level await (kräver es2022+)
// - exclude mupdf från pre-bundling så WASM-fetchen fungerar
//
// base: GitHub Pages serverar projekt-repos från /<repo-namn>/, inte roten.
// Vite måste känna till detta annars pekar asset-/worker-/WASM-länkarna fel.
// Vi läser repo-namnet ur miljövariabeln VITE_BASE som Actions-arbetsflödet
// sätter. Lokalt (npm run dev / build utan variabeln) faller den tillbaka
// till '/' så att utveckling fungerar oförändrat.
export default defineConfig({
  base: process.env.VITE_BASE || '/',
  worker: {
    format: 'es'
  },
  esbuild: {
    target: 'esnext'
  },
  build: {
    target: 'esnext'
  },
  optimizeDeps: {
    exclude: ['mupdf'],
    esbuildOptions: { target: 'esnext' }
  },
  server: {
    fs: { allow: ['..'] }
  }
})

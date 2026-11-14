/**
 * Tarayici cuzdan koprusunu paketler → public/wallet.js
 *
 * Ayri adim cunku hedef tarayici; sunucu derlemesi Node icin.
 */
import { build } from 'esbuild'
import { statSync } from 'node:fs'

await build({
  entryPoints: [new URL('./wallet.ts', import.meta.url).pathname],
  outfile: new URL('../public/wallet.js', import.meta.url).pathname,
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: ['es2020'],
  minify: true,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
  alias: { util: 'util/' },
  inject: [new URL('./shims.mjs', import.meta.url).pathname],
})
const kb = (statSync(new URL('../public/wallet.js', import.meta.url)).size / 1024).toFixed(0)
console.log(`  public/wallet.js ${kb} KB`)

/**
 * Sunucu derlemesi.
 *
 * Node'un tip siyirma modu `.js` importlarini `.ts`'e cozemiyor; cok dosyali
 * bir sunucu bu yuzden kaynaktan calistirilamiyor.
 */
import { build } from 'esbuild'
import { statSync, cpSync, readdirSync } from 'node:fs'

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/server.mjs',
  bundle: true, platform: 'node', target: 'node20', format: 'esm',
  // @bide/protocol bir workspace paketi ve KAYNAK TypeScript. Disarida
  // birakilirsa calisma aninda .ts cozumleyemez; bundle'a katilmali.

  // ESM ciktisinda `require` YOKTUR. Bagimliliklarimizin bir kismi (NEAR
  // kutuphane zinciri) hala CommonJS ve calisma aninda `require('util')` cagiriyor.
  // Bu banner olmadan sunucu ILK SATIRDA oluyor:
  //
  //   Error: Dynamic require of "util" is not supported
  //
  // Gelistirirken gorunmuyordu cunku `tsx` ile kaynaktan calisiyorduk;
  // yalnizca paketlenmis halde ortaya cikiyor.
  banner: {
    js: [
      "import { createRequire as __bideCreateRequire } from 'node:module'",
      "import { fileURLToPath as __bideFileURLToPath } from 'node:url'",
      "import { dirname as __bideDirname } from 'node:path'",
      'const require = __bideCreateRequire(import.meta.url)',
      // Bazi CJS paketleri bunlari da bekliyor.
      'const __filename = __bideFileURLToPath(import.meta.url)',
      'const __dirname = __bideDirname(__filename)',
    ].join('\n'),
  },
})
// Statik site derlenmiyor, kopyalaniyor: derleme adimi olmayan bes HTML
// dosyasi icin bundler kurmak, bakimi olan bir sey eklemek olurdu.
await import('./web/build.mjs')
cpSync('public', 'dist/public', { recursive: true })
const n = readdirSync('dist/public', { recursive: true }).filter((f) => String(f).includes('.')).length
console.log(`  dist/server.mjs  ${(statSync('dist/server.mjs').size / 1024).toFixed(1)} KB`)
console.log(`  dist/public      ${n} dosya`)

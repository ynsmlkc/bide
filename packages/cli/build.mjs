/**
 * Derleme.
 *
 * Neden bundler: shim'in HIZLI olmasi gerekiyor (gunde ~13.700 cagri,
 * calisma aninda tip siyirmak maliyeti ikiye katliyor — ADR-003 olcumu).
 * Daemon icin hiz onemsiz (bir kez baslar) ama cok dosyayi birlestirmek
 * gerekiyor; Node'un tip siyirma modu `.js` importlarini `.ts`'e cozemiyor.
 */
import { build } from 'esbuild'
import { chmodSync, readFileSync } from 'node:fs'

/**
 * Surum `package.json`'dan gomuluyor — elle yazilan bir sabit kacinilmaz
 * olarak eskiyor ve sessizce yanlis surum bildiren bir istemci uretiyor
 * (bkz. `src/version.ts`).
 */
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

const targets = [
  { in: 'src/shim/statusline.ts', out: 'dist/statusline.mjs' },
  { in: 'src/shim/hook.ts', out: 'dist/hook.mjs' },
  { in: 'src/daemon/entry.ts', out: 'dist/daemon.mjs' },
  { in: 'src/cli/main.ts', out: 'dist/bide.mjs' },
]

for (const t of targets) {
  await build({
    entryPoints: [t.in],
    outfile: t.out,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    define: { __BIDE_VERSION__: JSON.stringify(version) },
    // Shim'in kucuk kalmasi onemli: her cagrida parse ediliyor.
    minify: t.out.includes('statusline') || t.out.includes('hook'),
    // NEAR kutuphane zincirindeki bazi CJS paketler (`depd`) calisma aninda
    // `require('path')` cagiriyor; ESM ciktisinda `require` yok.
    ...(t.out.endsWith('bide.mjs') ? {
      banner: { js: "import { createRequire as __bideCreateRequire } from 'node:module'\nconst require = __bideCreateRequire(import.meta.url)" },
    } : {}),
    // Banner EKLEMIYORUZ: kaynak dosyalarda zaten shebang var ve esbuild
    // onu koruyor. Banner eklemek ikincisini uretip dosyayi bozuyor.
  })
  chmodSync(t.out, 0o755)
}

/**
 * Cuzdan koprusu (`bide login` sayfasi icin). Sunucu paketinin derledigi
 * `public/wallet.js`'in aynisi; yoksa once o derlenir.
 */
{
  const { existsSync, copyFileSync } = await import('node:fs')
  const src = new URL('../server/public/wallet.js', import.meta.url)
  if (!existsSync(src)) await import('../server/web/build.mjs')
  copyFileSync(src, new URL('./dist/wallet.js', import.meta.url))
  targets.push({ in: '', out: 'dist/wallet.js' })
}

const { statSync } = await import('node:fs')
for (const t of targets) {
  console.log(`  ${t.out.padEnd(22)} ${(statSync(t.out).size / 1024).toFixed(1)} KB`)
}

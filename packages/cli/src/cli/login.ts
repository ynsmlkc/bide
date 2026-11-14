/**
 * `bide login` / `logout` / `whoami` — ADR-010 (revize), ADR-014.
 *
 * Kimlik cuzdandir. GitHub yok, e-posta yok, sifre yok. `publisherId` dogrudan
 * NEAR hesap adinin kendisi: kazanci alacak hesap ile kimlik ayni sey, ikisini
 * ayirmak gereksiz bir eslesme katmani olurdu.
 *
 * Akis:
 *   bide login  → 127.0.0.1'de gecici sunucu + tarayici
 *   tarayici     → NEAR cuzdaniyla (Meteor, HOT, Intear, Sender) NEP-413 imzasi
 *   yerel sunucu → Bide sunucusuna proxy, token'i diske yazar
 *
 * Tarayici olmayan ortamlar icin `--near-credentials <hesap>`: NEAR CLI'nin
 * zaten diskte tuttugu anahtarla (`~/.near-credentials`) mesaj yerelde
 * imzalanir. Anahtar dosyadan okunur, bu surecten disari cikmaz ve sunucuya
 * yalnizca imza gider.
 *
 * Ozel anahtar HICBIR ZAMAN bu surece girmez. Terminale secret key sordurmak
 * en kolay yoldu ve kabul edilemezdi: kullanicidan cuzdanini teslim etmesini
 * isteyen bir arac, ne kadar iyi niyetli olursa olsun, phishing'i normallestirir.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  loadCredentials, saveCredentials, clearCredentials, credentialsPath, shortAddress,
  type Credentials,
} from '../credentials.js'
import { out, ok, warn, info, fail, dim, bold, green, orange } from './output.js'
import { loginPage } from './login-page.js'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KeyPair, type KeyPairString } from '@near-js/crypto'
import { KeyPairSigner } from '@near-js/signers'

const LOGIN_TIMEOUT_MS = 5 * 60_000

/**
 * Giristen sonra sayfanin istege bagli siralama adimi icin acik kaldigi sure.
 * Kullanici kaydeder ya da atlarsa sunucu hemen kapanir; sayfayi kapatip
 * giderse terminal en fazla bu kadar bekler.
 */
export const PROFILE_WINDOW_MS = 3 * 60_000

/**
 * Sunucu adresi.
 *
 * Kendi alan adimiz: Railway'deki ayni sunucuya bakar. Yayina cikmadan
 * once `api.bide.dev` yaziyordu ve o adres HIC VAR OLMADI — paket boyle
 * yayinlansaydi `bide login` herkeste "sunucuya ulasilamadi" derdi.
 *
 * NEP-413 imzasi sunucunun kendi `BIDE_HOME_DOMAIN`'i (recipient) ile
 * kuruluyor, istemcinin hangi adresten geldigine bakilmiyor. `--server` ya da
 * `BIDE_SERVER` ile ezilebiliyor.
 */
const DEFAULT_SERVER = 'https://bide-production.up.railway.app'

export interface LoginOptions {
  readonly serverUrl: string
  /** Tarayici acilmasin — CI ve baglantisiz ortamlar icin. */
  readonly noBrowser?: boolean
  /** NEAR CLI anahtariyla yerel imza: `~/.near-credentials/<ag>/<hesap>.json`. */
  readonly nearCredentials?: string
  readonly openImpl?: (url: string) => void
  readonly fetchImpl?: typeof fetch
}

export function parseLoginArgs(argv: readonly string[]): LoginOptions {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  return {
    serverUrl: (flag('server') ?? process.env['BIDE_SERVER'] ?? DEFAULT_SERVER)
      .replace(/\/+$/, ''),
    noBrowser: argv.includes('--no-browser'),
    ...(flag('near-credentials') ? { nearCredentials: flag('near-credentials')! } : {}),
  }
}

/* ─────────────────────────── login ─────────────────────────── */

/**
 * Giristen sonra daemon'i yeni kimlikle yeniden baslatan islev.
 *
 * Disaridan veriliyor cunku daemon'in dosya yolunu `main.ts` cozuyor;
 * burada cozmeye kalkmak iki yerde ayni mantigi tutmak olurdu.
 */
export type DaemonYeniden = () => Promise<{ pid: number } | { error: string } | null>

export async function cmdLogin(
  argv: readonly string[],
  daemonYeniden?: DaemonYeniden,
): Promise<void> {
  const opts = parseLoginArgs(argv)
  const existing = loadCredentials()
  if (existing && !argv.includes('--force')) {
    warn(`already logged in: ${bold(shortAddress(existing.publisherId))}`)
    info(`to switch to a different wallet: ${dim('bide login --force')}`)
    return
  }

  const result = opts.nearCredentials
    ? await loginWithKeyFile(opts, opts.nearCredentials)
    : await runLoginServer(opts)
  saveCredentials({
    serverUrl: opts.serverUrl,
    token: result.token,
    tokenId: result.tokenId,
    publisherId: result.publisherId,
    loggedInAt: Date.now(),
  })

  out()
  ok(`logged in — ${bold(result.publisherId)}`)
  info(dim(`token stored in ${credentialsPath()} (only you can read it)`))
  out()
  info(`earnings will go to this address. Track them with ${dim('bide balance')}.`)
  if (opts.nearCredentials) {
    info(`optional: join the public leaderboard with ${dim('bide profile')}.`)
  } else {
    info(`optional: join the public leaderboard in the browser — or later with ${dim('bide profile')}.`)
    info(dim('the page stays open for a few minutes; Ctrl-C to finish now'))
  }

  /**
   * Daemon'i BIZ yeniden baslatiyoruz.
   *
   * Kimlik dosyadan yalnizca ACILISTA okunuyor. Onceden burada "daemon
   * calisiyorsa `bide restart` yap" diye bir dipnot vardi ve bu YETMIYOR:
   * kullanici cuzdanini degistirip yeniden giris yapiyor, ekranda "giris
   * yapildi" goruyor, reklam donmeye devam ediyor — ama kazanc ESKI
   * cuzdana yaziliyor. Fark etmesinin bir yolu yok.
   *
   * Kullaniciya birakilan bir adim degil; sessizce yanlis hesaba para
   * yazan bir durum. O yuzden otomatik.
   */
  if (daemonYeniden) await kimligiTazele(daemonYeniden)
}

/**
 * Daemon'i yeni kimlikle yeniden baslatir ve sonucu kullaniciya bildirir.
 *
 * Ayri islev cunku `cmdLogin`'in tamami tarayici ve yerel sunucu
 * gerektiriyor; bu davranisin kendisi ise tek basina test edilebilmeli.
 */
export async function kimligiTazele(daemonYeniden: DaemonYeniden): Promise<void> {
  const r = await daemonYeniden()
  if (r === null) return                      // daemon zaten calismiyordu

  if ('error' in r) {
    // Basarisizlik SESSIZ GECILMEZ: kullanici ne yapacagini bilmeli, cunku
    // bu haliyle kazanci eski cuzdana yazilmaya devam eder.
    out()
    warn('could not restart the daemon with the new identity')
    info(dim(r.error))
    info(`manually: ${bold('bide restart')} — until you do, earnings go to the OLD wallet`)
    return
  }
  ok(`daemon running with the new identity (pid ${r.pid})`)
}

interface LoginResult {
  readonly token: string
  readonly tokenId: string
  readonly publisherId: string
}

/**
 * Tek kullanimlik yerel sunucu.
 *
 * Yalnizca 127.0.0.1'e baglanir — `0.0.0.0` olsa ayni agdaki herkes bu
 * sayfayi acip kendi cuzdanini baglayabilirdi. Ayrica her istek `nonce`
 * tasimak zorunda: makinede calisan baska bir program sayfanin adresini
 * tahmin etse bile isteklerini gecemez.
 */
export function runLoginServer(opts: LoginOptions): Promise<LoginResult> {
  const nonce = randomBytes(16).toString('hex')
  const f = opts.fetchImpl ?? fetch
  // Port isletim sisteminden geliyor (0 = bos bir tane ver). Sayfada
  // gostermek icin yakaliyoruz; istekler zaten `listen`'dan sonra geliyor.
  let port = 0

  return new Promise<LoginResult>((resolve, reject) => {
    let settled = false
    /**
     * Giristen sonra elde tutulan token — yalnizca siralama adimindaki
     * istekleri Bide sunucusuna iletmek icin. Tarayiciya ASLA gitmez.
     */
    let token: string | null = null
    let closing = false

    // Sunucuyu kapatmadan once cevabin gitmesini bekle; hemen kapatirsak
    // tarayici son ekrani goremeden baglanti duser.
    const closeSoon = (): void => {
      if (closing) return
      closing = true
      setTimeout(() => server.close(), 150).unref()
    }

    /** Giris sonucunu bir kez bildirir. Sunucuyu KAPATMAZ (bkz. `/verify`). */
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const finish = (fn: () => void): void => { settle(fn); closeSoon() }

    const timer = setTimeout(() => {
      finish(() => reject(new Error('timed out — the browser flow was not completed')))
    }, LOGIN_TIMEOUT_MS)
    timer.unref()

    const json = (res: ServerResponse, code: number, body: unknown): void => {
      const s = JSON.stringify(body)
      res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) })
      res.end(s)
    }

    const server = createServer((req, res) => {
      void handle(req, res).catch((e: unknown) => {
        json(res, 500, { message: e instanceof Error ? e.message : String(e) })
      })
    })

    async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const url = req.url ?? '/'

      if (req.method === 'GET' && (url === '/' || url.startsWith('/?'))) {
        const html = loginPage({ nonce, port, serverUrl: opts.serverUrl })
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': Buffer.byteLength(html),
          // Script YALNIZCA bu sayfadan ve yerel `/wallet.js`'ten — ucuncu
          // taraf script yuklenemez. Cuzdan koprusu NEAR RPC'ye ve cuzdanin
          // kendi servisine baglaniyor; token zaten tarayiciya hic gelmiyor.
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; " +
            "script-src 'self' 'unsafe-inline'; connect-src 'self' https: wss:; " +
            "img-src data: https:; frame-src https:",
          'cache-control': 'no-store',
        })
        res.end(html)
        return
      }

      // NEAR Wallet Selector koprusu — sitenin `/wallet.js` dosyasinin aynisi,
      // paketle birlikte geliyor. Disaridan indirilmiyor.
      if (req.method === 'GET' && url === '/wallet.js') {
        const js = walletBundle()
        if (!js) { json(res, 404, { message: 'wallet bridge missing from this build' }); return }
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': js.length, 'cache-control': 'no-store' })
        res.end(js)
        return
      }

      if (req.method !== 'POST') { json(res, 404, { message: 'not found' }); return }
      if (req.headers['x-bide-nonce'] !== nonce) { json(res, 403, { message: 'invalid session' }); return }

      const body = await readJson(req)

      if (url === '/challenge') {
        // Ag bilgisi (testnet/mainnet) cuzdan koprusu icin; challenge ile ayni turda.
        const [r, chain] = await Promise.all([
          f(`${opts.serverUrl}/v1/auth/challenge`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
          }),
          f(`${opts.serverUrl}/v1/chain`).then((x) => x.json()).catch(() => null) as Promise<{ network?: string } | null>,
        ])
        const ch = await r.json().catch(() => ({ message: 'could not read the server response' })) as Record<string, unknown>
        json(res, r.status, r.ok ? { ...ch, network: chain?.network ?? 'testnet' } : ch)
        return
      }

      if (url === '/verify') {
        const r = await f(`${opts.serverUrl}/v1/auth/verify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            accountId: body?.['accountId'], publicKey: body?.['publicKey'],
            signature: body?.['signature'], nonce: body?.['nonce'],
          }),
        })
        const payload = (await r.json().catch(() => null)) as LoginResult | null
        if (!r.ok || !payload?.token) {
          json(res, r.status === 200 ? 502 : r.status, payload ?? { message: 'verification failed' })
          return
        }
        // Token'i tarayiciya GERI GONDERME — sayfaya yalnizca adres doner.
        json(res, 200, { publisherId: payload.publisherId })
        // Giris bitti: kimlik hemen kaydedilsin, daemon yeni kimlikle
        // baslasin. Sunucu ise siralama adimi icin bir sure daha acik kalir.
        token = payload.token
        settle(() => resolve(payload))
        setTimeout(closeSoon, PROFILE_WINDOW_MS).unref()
        return
      }

      /**
       * Istege bagli siralama adimi — giristen SONRA, ayni sayfada.
       *
       * Sayfa Bide sunucusuna dogrudan gitmiyor (CSP `connect-src 'self'`);
       * istekler buradan, elde tutulan token'la iletiliyor. Ulke tahmini de
       * bu yuzden dogru calisiyor: istek kullanicinin kendi makinesinden
       * cikiyor.
       */
      if (url === '/profile/get' || url === '/profile/save') {
        if (!token) { json(res, 409, { message: 'log in first' }); return }
        const save = url === '/profile/save'
        const r = await f(`${opts.serverUrl}/v1/me/profile`, {
          method: save ? 'PUT' : 'GET',
          headers: { authorization: `Bearer ${token}`, ...(save ? { 'content-type': 'application/json' } : {}) },
          ...(save ? { body: JSON.stringify({
            nickname: body?.['nickname'], country: body?.['country'] ?? null, listed: body?.['listed'],
          }) } : {}),
          signal: AbortSignal.timeout(15_000),
        })
        json(res, r.status, await r.json().catch(() => ({ message: 'could not read the server response' })))
        if (save && r.ok) closeSoon()
        return
      }

      if (url === '/profile/skip') {
        json(res, 200, { ok: true })
        closeSoon()
        return
      }

      json(res, 404, { message: 'not found' })
    }

    server.on('error', (e) => finish(() => reject(e)))

    // Port 0 = isletim sistemi bos bir port versin. Sabit port secmek,
    // makinede zaten calisan bir seyle carpismak demekti.
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (typeof addr === 'string' || addr === null) {
        finish(() => reject(new Error('could not start the local server')))
        return
      }
      port = addr.port
      const url = `http://127.0.0.1:${port}/`

      out()
      out(`  ${orange('◆')} ${bold('Connect your wallet')}`)
      out()
      info(`open in your browser: ${green(url)}`)
      info(dim('complete it within 5 minutes · Ctrl-C to cancel'))
      out()

      if (!opts.noBrowser) (opts.openImpl ?? openBrowser)(url)
    })
  })
}

/**
 * Cuzdan koprusu paketi. Derlenmis CLI'da `dist/wallet.js` (build.mjs
 * kopyalar); gelistirmede sunucu paketinin `public/wallet.js`'i.
 */
let walletJs: Buffer | null | undefined
function walletBundle(): Buffer | null {
  if (walletJs !== undefined) return walletJs
  const here = dirname(fileURLToPath(import.meta.url))
  for (const p of [join(here, 'wallet.js'), join(here, '../../../server/public/wallet.js')]) {
    if (existsSync(p)) return (walletJs = readFileSync(p))
  }
  return (walletJs = null)
}

/* ─────────────────────────── anahtar dosyasiyla giris ─────────────────────────── */

/**
 * NEAR CLI anahtar dosyasini bulur. Tam yol da, yalnizca hesap adi da olur:
 * `alice.testnet` → `~/.near-credentials/testnet/alice.testnet.json`.
 */
export function credentialsFileFor(arg: string, network: string, home = homedir()): string {
  if (arg.includes('/') || arg.endsWith('.json')) return arg.replace(/^~(?=\/)/, home)
  return join(home, '.near-credentials', network, `${arg}.json`)
}

/**
 * Tarayicisiz giris: NEP-413 mesaji NEAR CLI'nin anahtariyla YEREL imzalanir.
 *
 * Kullanicidan anahtar ISTENMIYOR: NEAR CLI ile hesap acmis ya da giris
 * yapmis birinin anahtari zaten bu dosyada. Anahtar bu surecten disari
 * cikmaz; sunucuya yalnizca imza ve acik anahtar gider. Sunucu da anahtarin
 * o hesabin TAM ERISIMLI anahtari oldugunu zincirden dogrular.
 */
export async function loginWithKeyFile(opts: LoginOptions, arg: string): Promise<LoginResult> {
  const f = opts.fetchImpl ?? fetch
  const chain = await f(`${opts.serverUrl}/v1/chain`).then((r) => r.json()).catch(() => null) as { network?: string } | null
  const network = chain?.network ?? 'testnet'
  const path = credentialsFileFor(arg, network)
  if (!existsSync(path)) {
    throw new Error(`no NEAR CLI key at ${path} — log in with NEAR CLI first, or drop --near-credentials to use a browser wallet`)
  }
  const file = JSON.parse(readFileSync(path, 'utf8')) as { account_id?: string; private_key?: string; secret_key?: string }
  const accountId = file.account_id ?? arg.replace(/\.json$/, '').split('/').pop()!
  const secret = file.private_key ?? file.secret_key
  if (!secret) throw new Error(`${path} has no private_key`)
  const kp = KeyPair.fromString(secret as KeyPairString)

  const r = await f(`${opts.serverUrl}/v1/auth/challenge`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })
  const ch = await r.json().catch(() => null) as { message?: string; nonce?: string; recipient?: string; hint?: string } | null
  if (!r.ok || !ch?.message || !ch.nonce || !ch.recipient) {
    throw new Error(`could not get a challenge: ${ch?.hint ?? `HTTP ${r.status}`}`)
  }

  const signed = await new KeyPairSigner(kp).signNep413Message(
    ch.message, accountId, ch.recipient, new Uint8Array(Buffer.from(ch.nonce, 'base64')),
  )
  const v = await f(`${opts.serverUrl}/v1/auth/verify`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      accountId, publicKey: signed.publicKey.toString(),
      signature: Buffer.from(signed.signature).toString('base64'), nonce: ch.nonce,
    }),
  })
  const payload = await v.json().catch(() => null) as (LoginResult & { hint?: string; message?: string }) | null
  if (!v.ok || !payload?.token) throw new Error(`verification failed: ${payload?.hint ?? payload?.message ?? `HTTP ${v.status}`}`)
  return { token: payload.token, tokenId: payload.tokenId, publisherId: payload.publisherId }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    // Istekler kucuk; sinir olmadan tek bir istek bellegi doldurabilir.
    if (size > 256 * 1024) throw new Error('body too large')
    chunks.push(c as Buffer)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> }
  catch { return null }
}

export function openBrowser(
  url: string,
  cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open',
): void {
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    // Tarayici acilamazsa SORUN DEGIL: URL zaten ekranda yazili.
    // Komut yoksa (SSH, sunucu, WSL'de xdg-open kurulu degil) spawn ATMAZ,
    // sonradan 'error' olayi yayar; dinleyici yoksa surec coker.
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.on('error', () => { /* sessiz */ })
    child.unref()
  } catch { /* sessiz */ }
}

/* ─────────────────────────── logout / whoami ─────────────────────────── */

/**
 * Token'i sunucuda iptal eder ve yerel kimligi siler. Sunucuya ulasilamasa da
 * yerel kimlik silinir; `false` kullaniciya bunu soylemek icindir. 401 zaten
 * gecersiz demek, iptal basarili sayilir.
 */
export async function forgetLogin(c: Credentials, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  let revoked = false
  try {
    const res = await fetchImpl(`${c.serverUrl}/v1/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${c.token}` },
      signal: AbortSignal.timeout(5_000),
    })
    revoked = res.ok || res.status === 401
  } catch { /* ag yok: asagida yine siliniyor */ }
  clearCredentials()
  return revoked
}

export interface LogoutDaemon {
  /** Calisiyorduysa `true`. */
  readonly stop: () => Promise<boolean>
  readonly start: () => Promise<unknown>
}

/**
 * Sira onemli: daemon kapanirken bekleyen gosterimleri token'la gonderir, bu
 * yuzden once durur, sonra token iptal edilir. Kimlik yalnizca acilista
 * okundugu icin daemon ancak yeniden baslayinca reklami birakir.
 */
export async function cmdLogout(daemon?: LogoutDaemon, fetchImpl: typeof fetch = fetch): Promise<void> {
  const c = loadCredentials()
  if (!c) { warn('not logged in'); return }

  const wasRunning = (await daemon?.stop()) ?? false
  const revoked = await forgetLogin(c, fetchImpl)
  if (wasRunning) await daemon?.start()

  ok(`logged out — ${shortAddress(c.publisherId)}`)
  if (!revoked) warn('could not reach the server — the token stays valid there until it is revoked')
  info(dim('no ads and no earnings until you log in again; your balance stays with your wallet'))
}

export function cmdWhoami(): void {
  const c = loadCredentials()
  if (!c) fail('BID-2001', 'Not logged in', '`bide login` to connect your wallet')
  out()
  out(`  ${bold(c.publisherId)}`)
  info(dim(`server ${c.serverUrl}`))
  info(dim(`logged in ${new Date(c.loggedInAt).toLocaleString()}`))
  out()
}

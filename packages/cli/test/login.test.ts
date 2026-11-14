/**
 * `bide login` — yerel imzalama akisi.
 *
 * Test edilen sey "tarayici acildi mi" degil; yerel sunucunun DISARIYA ne
 * verdigi. Bu surec kisa omurlu ama makinede bir port aciyor: ne servis
 * ettigi, kime servis ettigi ve neyi geri vermedigi onemli.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runLoginServer, parseLoginArgs, kimligiTazele, openBrowser, cmdLogout, forgetLogin } from '../src/cli/login.js'
import { saveCredentials, loadCredentials, clearCredentials } from '../src/credentials.js'

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'bide-login-'))
  dirs.push(d)
  return d
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const GOOD = 'alice.testnet'
const SIGNED = { accountId: GOOD, publicKey: 'ed25519:pk', signature: 'c2ln', nonce: 'bm9uY2U=' }

/** Bide sunucusunu taklit eder — cagrilari kaydeder. */
function fakeServer(over: { verify?: unknown; verifyStatus?: number } = {}) {
  const calls: { path: string; body: any }[] = []
  const impl = (async (url: any, init: any) => {
    const path = String(url)
    if (path.endsWith('/v1/chain')) {
      return new Response(JSON.stringify({ network: 'testnet' }), { status: 200 })
    }
    const body = JSON.parse(String(init.body))
    calls.push({ path, body })
    if (path.endsWith('/v1/auth/challenge')) {
      return new Response(JSON.stringify({
        message: 'Sign in to Bide', nonce: 'bm9uY2U=', recipient: 'api.example.test', expiresAt: 9e12,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(
      JSON.stringify(over.verify ?? { token: 'bid_gizli_token', tokenId: 't1', publisherId: GOOD }),
      { status: over.verifyStatus ?? 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof fetch
  return { impl, calls }
}

/** Tarayicinin yapacagini yapar: sayfayi al, nonce ile POST at. */
async function browse(url: string) {
  const page = await fetch(url)
  const html = await page.text()
  const nonce = /const NONCE = "([0-9a-f]+)"/.exec(html)?.[1]
  // DIKKAT: varsayilan parametre `undefined`'da devreye girer. Nonce'suz
  // istegi test edebilmek icin acik bir `null` gerekiyor — bu tam olarak
  // testi ilk yazdigimda dusurdugum tuzak: `undefined` gecince nonce YINE
  // gidiyordu ve test guvenligi degil kendini dogruluyordu.
  const post = (path: string, body: unknown, useNonce: string | null | undefined = nonce) =>
    fetch(url.replace(/\/$/, '') + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(useNonce ? { 'x-bide-nonce': useNonce } : {}) },
      body: JSON.stringify(body),
    })
  return { html, nonce, post, status: page.status }
}

/** Sunucuyu baslatir ve URL'sini verir — `openImpl` tarayici yerine gecer. */
function start(fetchImpl: typeof fetch) {
  let resolveUrl!: (u: string) => void
  const url = new Promise<string>((r) => { resolveUrl = r })
  const done = runLoginServer({
    serverUrl: 'https://api.example.test',
    fetchImpl,
    openImpl: (u) => resolveUrl(u),
  })
  // Reddedilirse test cokmesin; bilerek bitmeyen testler var.
  done.catch(() => {})
  return { url, done }
}

describe('runLoginServer', () => {
  it('imzali NEP-413 mesaji dogrulaninca token doner', async () => {
    const srv = fakeServer()
    const { url, done } = start(srv.impl)
    const u = await url

    const b = await browse(u)
    expect(b.status).toBe(200)
    expect(b.nonce).toMatch(/^[0-9a-f]{32}$/)

    const ch = await (await b.post('/challenge', {})).json() as Record<string, unknown>
    // Cuzdan koprusu icin ag bilgisi challenge ile birlikte gelir.
    expect(ch).toMatchObject({ message: 'Sign in to Bide', recipient: 'api.example.test', network: 'testnet' })
    const vr = await b.post('/verify', SIGNED)
    expect(vr.status).toBe(200)

    const result = await done
    expect(result.token).toBe('bid_gizli_token')
    expect(result.publisherId).toBe(GOOD)
    expect(srv.calls.map((c) => c.path.split('/v1')[1])).toEqual(['/auth/challenge', '/auth/verify'])
    // Imza alanlari Bide sunucusuna aynen gider.
    expect(srv.calls[1]!.body).toEqual(SIGNED)
  })

  /**
   * En onemlisi. Sayfa tarayicida calisiyor; token'i oraya gondermek onu
   * eklentilerin, gecmisin ve kopyala-yapistir kazalarinin menziline sokardi.
   * Tarayicinin token'i BILMESI GEREKMIYOR — yalnizca CLI'nin bilmesi lazim.
   */
  it('token TARAYICIYA geri gonderilmez', async () => {
    const srv = fakeServer()
    const { url, done } = start(srv.impl)
    const b = await browse(await url)

    const vr = await b.post('/verify', SIGNED)
    const body = await vr.text()

    expect(body).not.toContain('bid_gizli_token')
    expect(JSON.parse(body)).toEqual({ publisherId: GOOD })
    expect((await done).token).toBe('bid_gizli_token')     // CLI biliyor
  })

  it('nonce\'suz istek reddedilir', async () => {
    const srv = fakeServer()
    const { url } = start(srv.impl)
    const b = await browse(await url)

    const r = await b.post('/verify', SIGNED, null)
    expect(r.status).toBe(403)
    expect(srv.calls).toHaveLength(0)          // Bide sunucusuna hic gidilmedi
  })

  it('yanlis nonce reddedilir', async () => {
    const srv = fakeServer()
    const { url } = start(srv.impl)
    const b = await browse(await url)

    const r = await b.post('/challenge', {}, 'f'.repeat(32))
    expect(r.status).toBe(403)
    expect(srv.calls).toHaveLength(0)
  })

  it('yalnizca 127.0.0.1 dinlenir — ag uzerinden erisilemez', async () => {
    const srv = fakeServer()
    const { url } = start(srv.impl)
    const u = await url
    expect(u).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    expect(u).not.toContain('0.0.0.0')
  })

  it('sunucu dogrulamayi reddederse akis bitmez, hata sayfaya doner', async () => {
    const srv = fakeServer({ verify: { code: 'BID_2002', message: 'imza dogrulanamadi' }, verifyStatus: 401 })
    const { url, done } = start(srv.impl)
    const b = await browse(await url)

    const r = await b.post('/verify', { ...SIGNED, signature: 'kotu' })
    expect(r.status).toBe(401)

    // Sunucu HALA acik: kullanici tekrar deneyebilmeli. Ilk hatada kapatmak,
    // yanlis cuzdani secen birini bastan basa zorlardi.
    const ikinci = await b.post('/challenge', {})
    expect(ikinci.status).toBe(200)

    let bitti = false
    void done.then(() => { bitti = true }, () => { bitti = true })
    await new Promise((r2) => setTimeout(r2, 30))
    expect(bitti).toBe(false)
  })

  it('sayfa ucuncu taraf script yukleyemez (CSP)', async () => {
    const { url } = start(fakeServer().impl)
    const res = await fetch(await url)
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("default-src 'none'")
    // Script yalnizca sayfanin kendisi ve yerel /wallet.js.
    expect(csp).toMatch(/script-src 'self' 'unsafe-inline';/)
    await res.text()
  })

  it('cuzdan koprusu yerelden servis edilir', async () => {
    const { url } = start(fakeServer().impl)
    const r = await fetch((await url) + 'wallet.js')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('javascript')
    expect(await r.text()).toContain('BideWallet')
  })

  it('devasa govde bellegi doldurmaz', async () => {
    const srv = fakeServer()
    const { url } = start(srv.impl)
    const b = await browse(await url)
    const r = await b.post('/challenge', { pad: 'x'.repeat(300_000) })
    expect(r.status).toBe(500)
    expect(srv.calls).toHaveLength(0)
  })

  it('GET disi ve bilinmeyen yollar 404', async () => {
    const { url } = start(fakeServer().impl)
    const u = await url
    expect((await fetch(u + 'baska')).status).toBe(404)
  })
})

describe('parseLoginArgs', () => {
  it('--server bayragi ortam degiskenini ezer', () => {
    process.env['BIDE_SERVER'] = 'https://ortam.test'
    expect(parseLoginArgs(['--server', 'https://bayrak.test']).serverUrl).toBe('https://bayrak.test')
    expect(parseLoginArgs([]).serverUrl).toBe('https://ortam.test')
    delete process.env['BIDE_SERVER']
  })

  it('sondaki slash temizlenir — yoksa `//v1/...` olusur', () => {
    expect(parseLoginArgs(['--server', 'https://a.test///']).serverUrl).toBe('https://a.test')
  })

  it('--no-browser taninir', () => {
    expect(parseLoginArgs(['--no-browser']).noBrowser).toBe(true)
  })
})

describe('credentials', () => {
  it('dosya yalnizca sahibi tarafindan okunabilir (0600)', () => {
    const p = join(tmp(), 'creds.json')
    saveCredentials({ serverUrl: 'https://a.test', token: 'bid_x', publisherId: GOOD, tokenId: 't', loggedInAt: 1 }, p)
    expect(statSync(p).mode & 0o777).toBe(0o600)
    expect(readFileSync(p, 'utf8')).toContain('bid_x')
  })

  it('eksik alanli dosya "giris yapilmamis" sayilir', () => {
    const p = join(tmp(), 'creds.json')
    saveCredentials({ serverUrl: 'https://a.test', token: '', publisherId: GOOD, tokenId: 't', loggedInAt: 1 }, p)
    expect(loadCredentials(p)).toBeNull()
  })

  it('bozuk JSON cokmez, null doner', () => {
    const d = tmp()
    const p = join(d, 'creds.json')
    require('node:fs').writeFileSync(p, '{ yarim')
    expect(loadCredentials(p)).toBeNull()
  })

  it('olmayan dosya null doner, silme false', () => {
    const p = join(tmp(), 'yok.json')
    expect(loadCredentials(p)).toBeNull()
    expect(clearCredentials(p)).toBe(false)
  })

  it('gidis donus bozulmaz', () => {
    const p = join(tmp(), 'creds.json')
    const c = { serverUrl: 'https://a.test', token: 'bid_x', publisherId: GOOD, tokenId: 't1', loggedInAt: 42 }
    saveCredentials(c, p)
    expect(loadCredentials(p)).toEqual(c)
    expect(clearCredentials(p)).toBe(true)
    expect(loadCredentials(p)).toBeNull()
  })
})

/** Sayfa dogru portu gosteriyor mu — kullanici adresi oradan okuyor. */
describe('giris sayfasi', () => {
  it('kendi portunu gosterir', async () => {
    const { url } = start(fakeServer().impl)
    const u = await url
    const port = new URL(u).port
    const html = await (await fetch(u)).text()
    expect(html).toContain(`127.0.0.1:${port}`)
  })
})

/**
 * Giristen sonra daemon yeni kimligi ALMALI.
 *
 * Gercekte yasandi: kullanici cuzdanini degistirip yeniden giris yapti,
 * "giris yapildi" gordu, reklam donmeye devam etti — ama daemon eski
 * kimlikle calistigi icin kazanc ESKI cuzdana yaziliyordu. Kimlik dosyadan
 * yalnizca acilista okunuyor.
 *
 * Onceden burada "daemon calisiyorsa `bide restart` yap" diye bir dipnot
 * vardi. Dipnot, sessizce yanlis hesaba para yazan bir durumu cozmez.
 */
describe('giristen sonra daemon kimligi', () => {
  const yakala = () => {
    const satirlar: string[] = []
    const orijinal = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((s: string) => { satirlar.push(String(s)); return true }) as typeof process.stdout.write
    return { satirlar, bitir: () => { process.stdout.write = orijinal } }
  }

  it('daemon calisiyorsa yeniden baslatilir', async () => {
    let cagrildi = 0
    const c = yakala()
    await kimligiTazele(async () => { cagrildi++; return { pid: 4242 } })
    c.bitir()
    expect(cagrildi).toBe(1)
    expect(c.satirlar.join('')).toContain('4242')
  })

  it('daemon calismiyorsa hicbir sey soylenmez', async () => {
    const c = yakala()
    await kimligiTazele(async () => null)
    c.bitir()
    expect(c.satirlar.join('')).toBe('')
  })

  /**
   * En onemlisi: basarisizlik SESSIZ GECILEMEZ. Kullanici bu durumda
   * kazancinin eski cuzdana gittigini bilmeli.
   */
  it('yeniden baslatilamazsa UYARIR ve ne yapacagini soyler', async () => {
    const c = yakala()
    await kimligiTazele(async () => ({ error: 'port mesgul' }))
    c.bitir()
    const cikti = c.satirlar.join('')
    expect(cikti).toContain('port mesgul')
    expect(cikti).toContain('bide restart')
    expect(cikti).toContain('OLD')          // sonucunu acikca yazar
  })

  it('basarisizlikta sessizce basarili gibi davranmaz', async () => {
    const c = yakala()
    await kimligiTazele(async () => ({ error: 'x' }))
    c.bitir()
    expect(c.satirlar.join('')).not.toContain('running with the new identity')
  })
})

/**
 * Istege bagli siralama adimi — giristen SONRA ayni sayfada.
 *
 * Korunan: token tarayiciya gitmez (istekler yerel surecten iletilir),
 * giristen once profil uclari kapali, kaydetme/atlama sunucuyu kapatir,
 * giris sonucu siralama adimini BEKLEMEZ (kimlik hemen kaydedilir).
 */
describe('siralama adimi', () => {
  function profileServer(profile: unknown = null) {
    const calls: { path: string; method: string; auth: string | null; body: any }[] = []
    const impl = (async (url: any, init: any = {}) => {
      const path = String(url)
      const method = init.method ?? 'GET'
      const body = init.body ? JSON.parse(String(init.body)) : null
      calls.push({ path, method, auth: (init.headers ?? {})['authorization'] ?? null, body })
      const reply = (o: unknown, status = 200) =>
        new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
      if (path.endsWith('/v1/auth/challenge')) return reply({ message: 'Sign in to Bide', nonce: 'bm9uY2U=', recipient: 'api.example.test', expiresAt: 9e12 })
      if (path.endsWith('/v1/auth/verify')) return reply({ token: 'bid_gizli_token', tokenId: 't1', publisherId: GOOD })
      if (path.endsWith('/v1/me/profile') && method === 'GET') return reply({ profile, suggestedCountry: 'TR' })
      if (path.endsWith('/v1/me/profile') && method === 'PUT') return reply({ profile: body })
      return reply({ message: 'not found' }, 404)
    }) as unknown as typeof fetch
    return { impl, calls }
  }

  async function loggedIn(srv: ReturnType<typeof profileServer>) {
    const { url, done } = start(srv.impl)
    const b = await browse(await url)
    await b.post('/challenge', {})
    await b.post('/verify', SIGNED)
    return { b, done }
  }

  it('giristen once profil uclari kapali', async () => {
    const { url } = start(profileServer().impl)
    const b = await browse(await url)
    expect((await b.post('/profile/get', {})).status).toBe(409)
    expect((await b.post('/profile/save', { nickname: 'ada', listed: true })).status).toBe(409)
  })

  it('giris sonucu siralama adimini beklemez', async () => {
    const { done } = await loggedIn(profileServer())
    await expect(done).resolves.toMatchObject({ publisherId: GOOD })
  })

  it('profil yerel surecten token ile okunur; token sayfaya donmez', async () => {
    const srv = profileServer({ nickname: 'ada', country: null, listed: false })
    const { b } = await loggedIn(srv)
    const r = await b.post('/profile/get', {})
    const text = await r.text()
    expect(JSON.parse(text)).toEqual({ profile: { nickname: 'ada', country: null, listed: false }, suggestedCountry: 'TR' })
    expect(text).not.toContain('bid_gizli_token')
    const call = srv.calls.find((c) => c.path.endsWith('/v1/me/profile'))!
    expect(call).toMatchObject({ method: 'GET', auth: 'Bearer bid_gizli_token' })
  })

  it('kaydetme PUT gonderir ve sunucuyu kapatir', async () => {
    const srv = profileServer()
    const { b } = await loggedIn(srv)
    const r = await b.post('/profile/save', { nickname: 'ada', country: 'TR', listed: true, extra: 'drop me' })
    expect(r.status).toBe(200)
    expect(srv.calls.at(-1)).toMatchObject({ method: 'PUT', body: { nickname: 'ada', country: 'TR', listed: true } })
    await new Promise((res) => setTimeout(res, 300))
    await expect(b.post('/profile/get', {})).rejects.toThrow()
  })

  it('atlamak sunucuyu kapatir ve Bide sunucusuna profil yazmaz', async () => {
    const srv = profileServer()
    const { b } = await loggedIn(srv)
    expect((await b.post('/profile/skip', {})).status).toBe(200)
    expect(srv.calls.some((c) => c.method === 'PUT')).toBe(false)
    await new Promise((res) => setTimeout(res, 300))
    await expect(b.post('/profile/get', {})).rejects.toThrow()
  })

  it('sayfa ulke kodlarini ve gizli siralama kutusunu tasir; kutu isaretsiz', async () => {
    const { url } = start(profileServer().impl)
    const b = await browse(await url)
    expect(b.html).toContain('id="profilebox"')
    expect(b.html).toMatch(/class="manual hide" id="profilebox"/)
    expect(b.html).toContain('"TR"')
    expect(b.html).not.toMatch(/id="p-listed"[^>]*checked/)
  })
})

describe('openBrowser', () => {
  /**
   * SSH, sunucu ya da WSL'de xdg-open yok. spawn bunu sonradan 'error'
   * olayiyla bildirir; dinleyici olmadan `bide login` cokuyordu.
   */
  it('tarayici acici yoksa surec cokmez', async () => {
    const hatalar: unknown[] = []
    const yakala = (e: unknown): void => { hatalar.push(e) }
    process.on('uncaughtException', yakala)
    try {
      openBrowser('http://127.0.0.1:1/', 'bide-olmayan-tarayici-acici')
      await new Promise((r) => setTimeout(r, 200))
    } finally {
      process.off('uncaughtException', yakala)
    }
    expect(hatalar).toEqual([])
  })
})

describe('bide logout', () => {
  const eski = process.env['BIDE_CREDENTIALS']
  const kimlik = { token: 'bid_x', publisherId: GOOD, serverUrl: 'https://bide.test', loggedInAt: 1 }
  const kur = (): string => {
    const path = join(tmp(), 'credentials.json')
    process.env['BIDE_CREDENTIALS'] = path
    saveCredentials(kimlik as any, path)
    return path
  }
  afterEach(() => {
    if (eski === undefined) delete process.env['BIDE_CREDENTIALS']
    else process.env['BIDE_CREDENTIALS'] = eski
  })

  it('once daemon durur, sonra token iptal edilir, sonra daemon yeniden baslar', async () => {
    kur()
    const sira: string[] = []
    const fetchImpl = (async (url: any, init: any) => {
      sira.push(`iptal ${String(url)} ${init.headers.authorization}`)
      expect(loadCredentials(), 'iptal aninda kimlik henuz silinmedi').not.toBeNull()
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    await cmdLogout({
      stop: async () => { sira.push('dur'); return true },
      start: async () => { sira.push('basla'); expect(loadCredentials()).toBeNull() },
    }, fetchImpl)
    expect(sira).toEqual(['dur', 'iptal https://bide.test/v1/logout Bearer bid_x', 'basla'])
  })

  it('calismayan daemon baslatilmaz', async () => {
    kur()
    let basladi = false
    await cmdLogout({
      stop: async () => false,
      start: async () => { basladi = true },
    }, (async () => new Response('{}')) as typeof fetch)
    expect(basladi).toBe(false)
  })

  it('sunucuya ulasilamazsa yerel kimlik yine silinir ama false doner', async () => {
    kur()
    const r = await forgetLogin(kimlik as any, (async () => { throw new Error('ag yok') }) as typeof fetch)
    expect(r).toBe(false)
    expect(loadCredentials()).toBeNull()
  })

  it('401 zaten gecersiz demek: iptal basarili sayilir', async () => {
    kur()
    const r = await forgetLogin(kimlik as any, (async () => new Response('{}', { status: 401 })) as typeof fetch)
    expect(r).toBe(true)
  })

  it('500 iptal sayilmaz', async () => {
    kur()
    const r = await forgetLogin(kimlik as any, (async () => new Response('{}', { status: 500 })) as typeof fetch)
    expect(r).toBe(false)
  })
})


/**
 * Tarayicisiz giris — NEAR CLI anahtar dosyasiyla yerel NEP-413 imzasi.
 *
 * Sunucuya giden imza GERCEKTEN dogrulanabilir olmali: burada sunucunun
 * kullandigi `nep413Hash` ile kontrol ediliyor.
 */
describe('anahtar dosyasiyla giris', () => {
  it('mesaji yerelde imzalar; sunucuya anahtar DEGIL imza gider', async () => {
    const { KeyPair } = await import('@near-js/crypto')
    const { nep413Hash } = await import('@bide/payments')
    const { writeFileSync, mkdirSync } = await import('node:fs')
    const { loginWithKeyFile, credentialsFileFor } = await import('../src/cli/login.js')

    const home = tmp()
    const kp = KeyPair.fromRandom('ed25519')
    const path = credentialsFileFor('alice.testnet', 'testnet', home)
    mkdirSync(join(home, '.near-credentials', 'testnet'), { recursive: true })
    writeFileSync(path, JSON.stringify({ account_id: 'alice.testnet', public_key: kp.getPublicKey().toString(), private_key: kp.toString() }))

    const nonce = Buffer.alloc(32, 7).toString('base64')
    const sent: any[] = []
    const impl = (async (url: any, init: any = {}) => {
      const p = String(url)
      if (p.endsWith('/v1/chain')) return new Response(JSON.stringify({ network: 'testnet' }))
      if (p.endsWith('/v1/auth/challenge')) return new Response(JSON.stringify({ message: 'Sign in to Bide', nonce, recipient: 'bide.test' }))
      sent.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify({ token: 'bid_t', tokenId: 't', publisherId: 'alice.testnet' }))
    }) as unknown as typeof fetch

    const r = await loginWithKeyFile({ serverUrl: 'https://api.example.test', fetchImpl: impl }, path)
    expect(r.publisherId).toBe('alice.testnet')

    const body = sent[0]
    expect(JSON.stringify(body)).not.toContain(kp.toString())          // gizli anahtar gitmedi
    expect(body).toMatchObject({ accountId: 'alice.testnet', publicKey: kp.getPublicKey().toString(), nonce })
    const hash = nep413Hash({ message: 'Sign in to Bide', nonce: new Uint8Array(Buffer.from(nonce, 'base64')), recipient: 'bide.test' })
    expect(kp.getPublicKey().verify(hash, new Uint8Array(Buffer.from(body.signature, 'base64')))).toBe(true)
  })

  it('hesap adi standart NEAR CLI yoluna cozulur', async () => {
    const { credentialsFileFor } = await import('../src/cli/login.js')
    expect(credentialsFileFor('bob.testnet', 'testnet', '/h')).toBe('/h/.near-credentials/testnet/bob.testnet.json')
    expect(credentialsFileFor('/x/key.json', 'testnet', '/h')).toBe('/x/key.json')
  })

  it('anahtar dosyasi yoksa ne yapilacagini soyler', async () => {
    const { loginWithKeyFile } = await import('../src/cli/login.js')
    const impl = (async () => new Response(JSON.stringify({ network: 'testnet' }))) as unknown as typeof fetch
    await expect(loginWithKeyFile({ serverUrl: 'https://x.test', fetchImpl: impl }, '/yok/nope.json'))
      .rejects.toThrow(/no NEAR CLI key/)
  })
})

/**
 * Cuzdanla giris — ADR-010 (revize), NEP-413.
 *
 * Buradaki testlerin cogu "mutlu yol"u degil, REDDI kontrol ediyor: bir giris
 * sisteminde hata, yanlis kisiyi iceri almaktir. Dogru kisiyi iceri almamak
 * can sikici; yanlis kisiyi almak geri alinamaz.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { KeyPair } from '@near-js/crypto'
import { KeyPairSigner } from '@near-js/signers'
import { Nep413, type KeyPermissionLookup } from '@bide/payments'
import { fixedClock, cryptoIdGenerator } from '@bide/protocol'
import { WalletAuth, LOGIN_SCOPES, SCOPES_BY_ROLE, type VerifyInput } from '../src/http/wallet-auth.js'
import { hashToken } from '../src/http/auth.js'

const HOME = 'bide.test'

/** Zincir: hangi hesapta hangi anahtar, hangi izinle. */
let chain: Map<string, 'FullAccess' | 'FunctionCall'>
const onChain: KeyPermissionLookup = async (acc, pk) => chain.get(`${acc}|${pk}`) ?? null

function setup(over: { keyPermission?: KeyPermissionLookup; maxTotal?: number } = {}) {
  const issued: { publisherId: string; tokenHash: string; scopes: readonly string[] }[] = []
  const clock = fixedClock(1_700_000_000_000)
  const auth = new WalletAuth({
    clock,
    ids: cryptoIdGenerator(clock),
    nep413: new Nep413({ recipient: HOME, network: 'testnet' }, clock),
    keyPermission: over.keyPermission ?? onChain,
    hashToken,
    issueToken: (i) => {
      issued.push({ publisherId: i.publisherId, tokenHash: i.tokenHash, scopes: i.scopes })
      return { tokenId: `tok-${issued.length}` }
    },
    ...(over.maxTotal !== undefined ? { maxTotal: over.maxTotal } : {}),
  })
  return { auth, issued, clock }
}

/** Kullanicinin cuzdaninin yapacagi seyi yapar: NEP-413 mesajini imzalar. */
async function sign(
  c: { message: string; nonce: string; recipient: string },
  kp: KeyPair, accountId: string,
): Promise<VerifyInput> {
  const r = await new KeyPairSigner(kp).signNep413Message(
    c.message, accountId, c.recipient, new Uint8Array(Buffer.from(c.nonce, 'base64')),
  )
  return {
    accountId,
    publicKey: r.publicKey.toString(),
    signature: Buffer.from(r.signature).toString('base64'),
    nonce: c.nonce,
  }
}

describe('WalletAuth', () => {
  let user: KeyPair
  const ALICE = 'alice.testnet'
  beforeEach(() => {
    user = KeyPair.fromRandom('ed25519')
    chain = new Map([[`${ALICE}|${user.getPublicKey().toString()}`, 'FullAccess']])
  })

  it('gecerli imza token uretir ve publisherId hesap adinin kendisidir', async () => {
    const { auth, issued } = setup()
    const c = auth.challenge()
    expect(c.ok).toBe(true)
    if (!c.ok) return
    expect(c.recipient).toBe(HOME)

    const r = await auth.verify(await sign(c, user, ALICE))
    expect(r.ok).toBe(true)
    if (!r.ok) return

    // Kimlik = hesap. Ayri bir kullanici kimligi yok (ADR-010 revize).
    expect(r.publisherId).toBe(ALICE)
    expect(issued[0]!.publisherId).toBe(ALICE)
    expect(r.token).toMatch(/^bid_[0-9a-f]{48}$/)
  })

  it('ham token sunucuda SAKLANMAZ — yalnizca hash', async () => {
    const { auth, issued } = setup()
    const c = auth.challenge()
    if (!c.ok) return
    const r = await auth.verify(await sign(c, user, ALICE))
    if (!r.ok) return

    expect(issued[0]!.tokenHash).toBe(hashToken(r.token))
    expect(issued[0]!.tokenHash).not.toContain(r.token)
  })

  it('token yalnizca daemon kapsamlarini tasir — cuzdan degistiremez', async () => {
    expect(LOGIN_SCOPES).toEqual(['report:impressions', 'read:balance', 'withdraw:balance'])
    expect(LOGIN_SCOPES).not.toContain('manage:wallet')
  })

  it('reklamveren rolu ayri kapsam alir', async () => {
    const { auth, issued } = setup()
    const c = auth.challenge()
    if (!c.ok) return
    expect((await auth.verify(await sign(c, user, ALICE), 'advertiser')).ok).toBe(true)
    expect(issued[0]!.scopes).toEqual(SCOPES_BY_ROLE.advertiser)
  })

  it('BASKASININ hesabini iddia eden imza reddedilir', async () => {
    const { auth, issued } = setup()
    const c = auth.challenge()
    if (!c.ok) return

    // Saldirgan kendi anahtariyla imzaliyor ama kurbanin hesabini iddia ediyor.
    const r = await auth.verify(await sign(c, KeyPair.fromRandom('ed25519'), ALICE))
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.detail).toContain('anahtar_hesapta_yok')
    expect(issued).toHaveLength(0)
  })

  it('imza degistirilmisse reddedilir', async () => {
    const { auth } = setup()
    const c = auth.challenge()
    if (!c.ok) return
    const s = await sign(c, user, ALICE)
    const bozuk = Buffer.from(s.signature, 'base64'); bozuk[0]! ^= 1
    const r = await auth.verify({ ...s, signature: bozuk.toString('base64') })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.detail).toContain('imza_gecersiz')
  })

  it('function-call anahtari hesap sahibi yerine GECMEZ', async () => {
    chain.set(`${ALICE}|${user.getPublicKey().toString()}`, 'FunctionCall')
    const { auth, issued } = setup()
    const c = auth.challenge()
    if (!c.ok) return
    const r = await auth.verify(await sign(c, user, ALICE))
    expect(r.ok).toBe(false)
    expect(issued).toHaveLength(0)
  })

  it('ayni challenge IKI KEZ kullanilamaz', async () => {
    const { auth, issued } = setup()
    const c = auth.challenge()
    if (!c.ok) return
    const signed = await sign(c, user, ALICE)

    expect((await auth.verify(signed)).ok).toBe(true)
    // Replay: ayni imza tekrar gonderiliyor. Ikinci token URETILMEMELI.
    const again = await auth.verify(signed)
    expect(again.ok).toBe(false)
    expect(issued).toHaveLength(1)
  })

  it('es zamanli iki verify tek token uretir', async () => {
    const { auth, issued } = setup()
    const c = auth.challenge()
    if (!c.ok) return
    const signed = await sign(c, user, ALICE)
    const [a, b] = await Promise.all([auth.verify(signed), auth.verify(signed)])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    expect(issued).toHaveLength(1)
  })

  it('suresi dolmus challenge reddedilir', async () => {
    const { auth, clock } = setup()
    const c = auth.challenge()
    if (!c.ok) return
    const signed = await sign(c, user, ALICE)
    clock.advance(301_000)
    const r = await auth.verify(signed)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('suresi dolmus')
  })

  it('bu sunucunun uretmedigi challenge reddedilir', async () => {
    const { auth } = setup()
    const other = setup()
    const c = other.auth.challenge()
    if (!c.ok) return
    // Imza gecerli ama BU sunucu boyle bir challenge uretmedi.
    const r = await auth.verify(await sign(c, user, ALICE))
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('challenge bulunamadi')
  })

  it('baska bir uygulama icin imzalanmis mesaj kabul edilmez', async () => {
    const { auth } = setup()
    const c = auth.challenge()
    if (!c.ok) return
    // Ayni nonce, ama cuzdan "evil.example" icin imzalatildi.
    const r = await auth.verify(await sign({ ...c, recipient: 'evil.example' }, user, ALICE))
    expect(r.ok).toBe(false)
  })

  it('zincire ulasilamazsa giris BASARISIZ — sessizce gecmez', async () => {
    const { auth, issued } = setup({ keyPermission: async () => { throw new Error('rpc 503') } })
    const c = auth.challenge()
    if (!c.ok) return
    const r = await auth.verify(await sign(c, user, ALICE))
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('zincire ulasilamadi')
    expect(issued).toHaveLength(0)
  })

  it('zincir hatasi sonrasi ayni challenge ile tekrar denenebilir', async () => {
    let dustu = true
    const { auth } = setup({ keyPermission: async (a, p) => { if (dustu) throw new Error('rpc'); return onChain(a, p) } })
    const c = auth.challenge()
    if (!c.ok) return
    const signed = await sign(c, user, ALICE)
    expect((await auth.verify(signed)).ok).toBe(false)
    dustu = false
    expect((await auth.verify(signed)).ok).toBe(true)
  })

  it('bekleyen challenge toplami sinirli — dolunca "busy"', () => {
    const { auth } = setup({ maxTotal: 3 })
    for (let i = 0; i < 3; i++) expect(auth.challenge().ok).toBe(true)
    const r = auth.challenge()
    expect(r.ok).toBe(false)
    expect(!r.ok && r.busy).toBe(true)
  })

  it('suresi dolanlar toplanir — yer acilir', () => {
    const { auth, clock } = setup({ maxTotal: 2 })
    auth.challenge(); auth.challenge()
    clock.advance(400_000)
    expect(auth.challenge().ok).toBe(true)
    expect(auth.pendingCount()).toBe(1)
  })
})

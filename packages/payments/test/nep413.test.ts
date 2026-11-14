import { describe, it, expect } from 'vitest'
import { KeyPair } from '@near-js/crypto'
import { KeyPairSigner } from '@near-js/signers'
import { fixedClock } from '@bide/protocol'
import { Nep413, nep413Hash, type SignedMessage, type KeyPermissionLookup } from '../src/nep413.js'

const clock = fixedClock(1_700_000_000_000)
const auth = new Nep413({ recipient: 'bide.example', network: 'testnet' }, clock)
const kp = KeyPair.fromRandom('ed25519')
const PK = kp.getPublicKey().toString()

const fullAccess: KeyPermissionLookup = async (acc, pk) => (acc === 'alice.testnet' && pk === PK ? 'FullAccess' : null)

/** Cuzdanin yaptigini birebir yapar: NEAR'in referans imzalayicisi. */
async function walletSign(over: Partial<SignedMessage> = {}, callbackUrl?: string): Promise<SignedMessage> {
  const c = auth.challenge()
  const signer = new KeyPairSigner(kp)
  const nonce = new Uint8Array(Buffer.from(c.nonce, 'base64'))
  const r = await signer.signNep413Message(c.message, 'alice.testnet', c.recipient, nonce, callbackUrl)
  return {
    accountId: 'alice.testnet',
    publicKey: r.publicKey.toString(),
    signature: Buffer.from(r.signature).toString('base64'),
    nonce: c.nonce,
    message: c.message,
    recipient: c.recipient,
    ...(callbackUrl ? { callbackUrl } : {}),
    ...over,
  }
}

describe('NEP-413 ozeti', () => {
  it('referans imzalayiciyla AYNI ozeti uretir', async () => {
    const nonce = new Uint8Array(32).fill(7)
    const signer = new KeyPairSigner(kp)
    const r = await signer.signNep413Message('hi', 'alice.testnet', 'bide.example', nonce)
    const ours = nep413Hash({ message: 'hi', nonce, recipient: 'bide.example' })
    expect(kp.getPublicKey().verify(ours, r.signature)).toBe(true)
  })
})

describe('challenge', () => {
  it('32 baytlik rastgele nonce, alici ve son kullanma', () => {
    const a = auth.challenge(), b = auth.challenge()
    expect(Buffer.from(a.nonce, 'base64')).toHaveLength(32)
    expect(a.nonce).not.toBe(b.nonce)
    expect(a.recipient).toBe('bide.example')
    expect(a.expiresAt).toBe(1_700_000_000_000 + 300_000)
    expect(a.message).toMatch(/cannot move funds/)
  })
})

describe('dogrulama', () => {
  it('gecerli imza + tam erisimli anahtar → ok', async () => {
    const r = await auth.verify(await walletSign(), fullAccess)
    expect(r).toEqual({ ok: true, account: 'alice.testnet', publicKey: PK })
  })

  it('callbackUrl imzaya katilmissa da gecer', async () => {
    const r = await auth.verify(await walletSign({}, 'http://127.0.0.1:5555/cb'), fullAccess)
    expect(r.ok).toBe(true)
  })

  it('mesaj degistirilirse reddedilir', async () => {
    const r = await auth.verify(await walletSign({ message: 'baska bir sey' }), fullAccess)
    expect(r).toMatchObject({ ok: false, reason: 'imza_gecersiz' })
  })

  it('nonce degistirilirse reddedilir', async () => {
    const r = await auth.verify(await walletSign({ nonce: Buffer.alloc(32, 1).toString('base64') }), fullAccess)
    expect(r).toMatchObject({ ok: false, reason: 'imza_gecersiz' })
  })

  it('baska bir uygulama icin imzalanmis mesaj reddedilir', async () => {
    const r = await auth.verify(await walletSign({ recipient: 'evil.example' }), fullAccess)
    expect(r).toMatchObject({ ok: false, reason: 'yanlis_alici' })
  })

  it('anahtar o hesapta yoksa reddedilir — baskasinin adina giris yok', async () => {
    const r = await auth.verify(await walletSign({ accountId: 'bob.testnet' }), fullAccess)
    expect(r).toMatchObject({ ok: false, reason: 'anahtar_hesapta_yok' })
  })

  it('function-call anahtari hesap sahibi yerine GECMEZ', async () => {
    const r = await auth.verify(await walletSign(), async () => 'FunctionCall')
    expect(r).toMatchObject({ ok: false, reason: 'anahtar_tam_erisimli_degil' })
  })

  it('zincire ulasilamazsa hata YUKARI atilir — sessizce gecmez', async () => {
    const s = await walletSign()
    await expect(auth.verify(s, async () => { throw new Error('rpc dustu') })).rejects.toThrow('rpc dustu')
  })

  it('bozuk girdi gerekceyle reddedilir', async () => {
    const r = await auth.verify(await walletSign({ signature: 'AAAA' }), fullAccess)
    expect(r).toMatchObject({ ok: false, reason: 'gecersiz_girdi' })
  })
})

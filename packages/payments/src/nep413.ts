/**
 * Cuzdanla giris — NEP-413 (`signMessage`), ADR-014.
 *
 * Kullanicinin bir NEAR hesabini kontrol ettigini ispatlamanin standart yolu.
 *
 * Neden NEP-413 ve ham imza degil: NEP-413 imzalanan veriyi ozel bir on-ek
 * (`2^31 + 413`) ile baslatir. Bu on-ek gecerli bir transaction'in ilk
 * baytlari OLAMAZ, yani imza hicbir kosulda aga gonderilebilir bir isleme
 * donusemez. Sunucunun sectigi ham byte'lari imzalatmak bir "signing
 * oracle"dir: ele gecirilmis bir sunucu challenge yerine gercek bir odeme
 * transaction'inin hash'ini gonderip cuzdani bosaltabilirdi.
 *
 * Imza gecerli olsa da yetmez: imzalayan anahtar hesabin TAM ERISIMLI bir
 * anahtari olmali ve bu zincirden okunur. Sadece kontrat cagirabilen bir
 * function-call anahtari (orn. bir dApp'e verilmis oturum anahtari) hesap
 * sahibi yerine gecmez.
 */

import { createHash, randomBytes } from 'node:crypto'
import { PublicKey } from '@near-js/crypto'
import { serialize } from 'borsh'
import type { Clock } from '@bide/protocol'
import { isValidAccountId } from './address.js'

/** NEP-413 on-eki: 2^31 + 413. */
export const NEP413_TAG = 2_147_484_061

const PAYLOAD_SCHEMA = {
  struct: {
    message: 'string',
    nonce: { array: { type: 'u8', len: 32 } },
    recipient: 'string',
    callbackUrl: { option: 'string' },
  },
} as const

export interface Nep413Payload {
  readonly message: string
  readonly nonce: Uint8Array
  readonly recipient: string
  readonly callbackUrl?: string | null
}

/** Imzalanan 32 baytlik ozet: sha256(borsh(tag) || borsh(payload)). */
export function nep413Hash(p: Nep413Payload): Uint8Array {
  const tag = serialize('u32', NEP413_TAG)
  const body = serialize(PAYLOAD_SCHEMA, {
    message: p.message,
    nonce: Array.from(p.nonce),
    recipient: p.recipient,
    callbackUrl: p.callbackUrl ?? null,
  })
  return new Uint8Array(createHash('sha256').update(tag).update(body).digest())
}

export interface Nep413Config {
  /** Imzanin hangi uygulama icin oldugu. Cuzdan kullaniciya bunu gosterir. */
  readonly recipient: string
  /** Challenge omru. Kisa tutulur — replay penceresini daraltir. */
  readonly timeoutSec?: number
  /** 'testnet' | 'mainnet' — mesajda yazar, kullanici hangi agda oldugunu gorur. */
  readonly network: string
}

export interface ChallengeResult {
  readonly message: string
  /** 32 bayt, base64. */
  readonly nonce: string
  readonly recipient: string
  readonly expiresAt: number
}

export interface SignedMessage {
  readonly accountId: string
  /** `ed25519:...` */
  readonly publicKey: string
  /** base64 */
  readonly signature: string
  readonly nonce: string
  readonly message: string
  readonly recipient: string
  /** Bazi cuzdanlar imzaya callbackUrl'i de katar. */
  readonly callbackUrl?: string | null
}

export type VerifyFailure =
  | 'gecersiz_girdi'
  | 'imza_gecersiz'
  | 'anahtar_hesapta_yok'
  | 'anahtar_tam_erisimli_degil'
  | 'yanlis_alici'

export type VerifyResult =
  | { readonly ok: true; readonly account: string; readonly publicKey: string }
  | { readonly ok: false; readonly reason: VerifyFailure; readonly detail: string }

export const DEFAULT_TIMEOUT_SEC = 300

/** Hesabin zincirdeki anahtar izni. `null` → anahtar (ya da hesap) yok. */
export type KeyPermissionLookup = (accountId: string, publicKey: string) =>
  Promise<'FullAccess' | 'FunctionCall' | null>

export class Nep413 {
  constructor(private readonly cfg: Nep413Config, private readonly clock: Clock) {}

  get recipient(): string { return this.cfg.recipient }

  /** Challenge uretir. Nonce tek kullanimliktir; cagiran taraf saklar. */
  challenge(): ChallengeResult {
    const timeout = this.cfg.timeoutSec ?? DEFAULT_TIMEOUT_SEC
    const expiresAt = this.clock.now() + timeout * 1000
    const nonce = randomBytes(32)
    const message =
      `Sign in to Bide (${this.cfg.network}).\n` +
      `This signature only proves you own this account. It cannot move funds.\n` +
      `Expires: ${new Date(expiresAt).toISOString()}`
    return { message, nonce: nonce.toString('base64'), recipient: this.cfg.recipient, expiresAt }
  }

  /**
   * Imzali mesaji dogrular: once kriptografik imza, sonra zincirde anahtarin
   * hesaba ait ve tam erisimli oldugu.
   *
   * `async` ve gerekce donuyor: red sebebini kaybetmek kullaniciya
   * "gecersiz" demekten baska bir sey soyleyememek demek.
   */
  async verify(s: SignedMessage, lookup: KeyPermissionLookup): Promise<VerifyResult> {
    if (!isValidAccountId(s.accountId)) return { ok: false, reason: 'gecersiz_girdi', detail: 'hesap adi gecersiz' }
    if (s.recipient !== this.cfg.recipient) {
      return { ok: false, reason: 'yanlis_alici', detail: `beklenen ${this.cfg.recipient}, gelen ${s.recipient}` }
    }

    let pk: PublicKey, sig: Uint8Array, nonce: Uint8Array
    try {
      pk = PublicKey.fromString(s.publicKey)
      sig = new Uint8Array(Buffer.from(s.signature, 'base64'))
      nonce = new Uint8Array(Buffer.from(s.nonce, 'base64'))
    } catch (e) {
      return { ok: false, reason: 'gecersiz_girdi', detail: e instanceof Error ? e.message : String(e) }
    }
    if (nonce.length !== 32 || sig.length !== 64) {
      return { ok: false, reason: 'gecersiz_girdi', detail: 'nonce 32, imza 64 bayt olmali' }
    }

    // Cuzdanlar callbackUrl'i imzaya katma konusunda ayrisiyor; ikisini de
    // dene. Ikisi de AYNI mesaji, nonce'u ve aliciyi baglar.
    const variants = [null, ...(s.callbackUrl ? [s.callbackUrl] : [])]
    const valid = variants.some((callbackUrl) => {
      try {
        return pk.verify(nep413Hash({ message: s.message, nonce, recipient: s.recipient, callbackUrl }), sig)
      } catch { return false }
    })
    if (!valid) return { ok: false, reason: 'imza_gecersiz', detail: 'imza mesajla eslesmiyor' }

    // Zincire ULASILAMIYORSA hata yukari atilir — "goremiyorum" ile
    // "anahtar yok" ayni sey degil. Girisi tekrar denemek bedava; yanlis
    // kimlik baglamak geri alinamaz.
    const perm = await lookup(s.accountId, s.publicKey)
    if (perm === null) return { ok: false, reason: 'anahtar_hesapta_yok', detail: `${s.publicKey} ${s.accountId} hesabinda yok` }
    if (perm !== 'FullAccess') {
      return { ok: false, reason: 'anahtar_tam_erisimli_degil', detail: 'function-call anahtari hesap sahibi yerine gecmez' }
    }
    return { ok: true, account: s.accountId, publicKey: s.publicKey }
  }
}

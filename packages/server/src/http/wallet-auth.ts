/**
 * Cuzdanla giris — ADR-010, ADR-014.
 *
 * Akis (NEP-413 `signMessage`):
 *   1. Istemci challenge ister       → sunucu mesaj + 32 baytlik nonce uretir
 *   2. Kullanici cuzdaniyla imzalar  → cuzdan hesap adi, acik anahtar, imza dondurur
 *   3. Sunucu imzayi VE anahtarin o hesabin tam erisimli anahtari oldugunu
 *      zincirden dogrular, device token uretir
 *
 * Imza aga gonderilebilir bir islem DEGILDIR: NEP-413 on-eki bunu
 * yapisal olarak imkansiz kilar (bkz. payments/nep413.ts).
 *
 * `publisherId` hesap adinin KENDISIDIR. Ayri bir kullanici tablosu yok:
 * kimlik ile odeme hedefi ayni sey, ikisini ayirmak gereksiz bir eslesme
 * katmani yaratirdi.
 */

import { Nep413, NearRpc, type KeyPermissionLookup, type VerifyResult } from '@bide/payments'
import type { Clock, IdGenerator, TokenScope } from '@bide/protocol'

export interface PendingChallenge {
  readonly nonce: string
  readonly message: string
  readonly expiresAt: number
}

/**
 * Bellekteki toplam bekleyen challenge. Spam bellegi sinirsiz buyutmesin;
 * dolarsa yeni challenge "birazdan tekrar dene" alir. IP basina hiz siniri
 * (app.ts) tek bir kaynagin bu pencereyi doldurmasini yavaslatir.
 */
const MAX_TOTAL = 10_000

export interface WalletAuthDeps {
  readonly clock: Clock
  readonly ids: IdGenerator
  readonly nep413: Nep413
  /** Anahtarin hesaptaki izni — zincirden. `null` → anahtar ya da hesap yok. */
  readonly keyPermission: KeyPermissionLookup
  /** Uretilen token'i saklar; ham token DEGIL, hash'i saklanir. */
  readonly issueToken: (input: {
    publisherId: string
    tokenHash: string
    scopes: readonly TokenScope[]
    role: Role
  }) => { tokenId: string }
  readonly hashToken: (raw: string) => string
  /** Testler icin; varsayilan `MAX_TOTAL`. */
  readonly maxTotal?: number
}

/**
 * Rol basina kapsamlar.
 *
 * Ayni cuzdan hem yayinci hem reklamveren olabilir — ama AYNI ANDA DEGIL,
 * ayni token'la degil. Iki ayri giris, iki ayri token.
 *
 * Sebep: kapsam karistirmak, calinmis bir daemon token'inin kampanya
 * olusturup butce harcamasi demek. Daemon her makinede duruyor; panel
 * token'i yalnizca tarayicida.
 */
export type Role = 'publisher' | 'advertiser'

export const SCOPES_BY_ROLE: Record<Role, readonly TokenScope[]> = {
  publisher: ['report:impressions', 'read:balance', 'withdraw:balance'],
  advertiser: ['manage:campaigns', 'read:spend'],
}

/** Geriye donuk ad. */
export const LOGIN_SCOPES = SCOPES_BY_ROLE.publisher

export type ChallengeResult =
  | { readonly ok: true; readonly message: string; readonly nonce: string; readonly recipient: string; readonly expiresAt: number }
  | { readonly ok: false; readonly reason: string; readonly busy?: true }

export interface VerifyInput {
  readonly accountId: string
  readonly publicKey: string
  readonly signature: string
  readonly nonce: string
  /** Cuzdan imzaya katmis olabilir; yalnizca dogrulamada denenir. */
  readonly callbackUrl?: string | null
}

export type LoginResult =
  | { readonly ok: true; readonly token: string; readonly tokenId: string; readonly publisherId: string }
  | { readonly ok: false; readonly reason: string; readonly detail?: string }

export class WalletAuth {
  /** nonce → bekleyen challenge. */
  readonly #pending = new Map<string, PendingChallenge>()

  constructor(private readonly deps: WalletAuthDeps) {}

  get recipient(): string { return this.deps.nep413.recipient }

  challenge(): ChallengeResult {
    this.#gc()
    if (this.#pending.size >= (this.deps.maxTotal ?? MAX_TOTAL)) {
      return { ok: false, reason: 'cok fazla bekleyen giris — birazdan tekrar dene', busy: true }
    }
    const c = this.deps.nep413.challenge()
    this.#pending.set(c.nonce, { nonce: c.nonce, message: c.message, expiresAt: c.expiresAt })
    return { ok: true, message: c.message, nonce: c.nonce, recipient: c.recipient, expiresAt: c.expiresAt }
  }

  /** Imzali mesaji dogrular ve token uretir. */
  async verify(input: VerifyInput, role: Role = 'publisher'): Promise<LoginResult> {
    // Imzalanan mesaj, SU AN bekleyen challenge'lardan biri olmali.
    // Mesaj ve alici istemciden ALINMAZ — sunucunun urettigi kullanilir.
    // Kullanilan challenge silinir: onceki bir giristen kalan (ve ele
    // gecirilmis) imza ikinci bir token alamaz.
    const pending = this.#pending.get(input.nonce)
    if (!pending) {
      return { ok: false, reason: 'challenge bulunamadi (zaten kullanilmis ya da suresi dolmus olabilir)' }
    }
    if (pending.expiresAt < this.deps.clock.now()) {
      this.#pending.delete(input.nonce)
      return { ok: false, reason: 'challenge suresi dolmus' }
    }

    let result: VerifyResult
    try {
      result = await this.deps.nep413.verify({
        accountId: input.accountId,
        publicKey: input.publicKey,
        signature: input.signature,
        nonce: input.nonce,
        message: pending.message,
        recipient: this.deps.nep413.recipient,
        callbackUrl: input.callbackUrl ?? null,
      }, this.deps.keyPermission)
    } catch (e) {
      // Zincire ULASILAMIYORSA giris BASARISIZ olur. "Anahtar hesapta mi"
      // sorusu cevapsiz kalirsa imzayi kabul etmek, function-call anahtari
      // ya da silinmis bir anahtarla girise izin vermek olurdu.
      return {
        ok: false,
        reason: 'zincire ulasilamadi — birazdan tekrar dene',
        detail: e instanceof Error ? e.message : String(e),
      }
    }
    if (!result.ok) {
      return { ok: false, reason: 'imza dogrulanamadi', detail: `${result.reason}: ${result.detail}` }
    }

    // Tek kullanimlik. `await` sonrasi tekrar kontrol: ayni imzayla iki es
    // zamanli istek zinciri beklerken ikisi de buraya gelebilir.
    if (!this.#pending.delete(input.nonce)) {
      return { ok: false, reason: 'challenge bulunamadi (zaten kullanilmis ya da suresi dolmus olabilir)' }
    }

    // Ham token YALNIZCA burada, bir kez gorunur. Sunucu hash'ini saklar.
    const raw = `bid_${this.deps.ids.randomHex(24)}`
    const { tokenId } = this.deps.issueToken({
      publisherId: result.account,
      tokenHash: this.deps.hashToken(raw),
      scopes: SCOPES_BY_ROLE[role],
      role,
    })

    return { ok: true, token: raw, tokenId, publisherId: result.account }
  }

  /** Suresi dolmus challenge'lari at — bellek sinirsiz buyumesin. */
  #gc(): void {
    const now = this.deps.clock.now()
    for (const [k, p] of this.#pending) {
      if (p.expiresAt < now - 60_000) this.#pending.delete(k)
    }
  }

  pendingCount(): number { return this.#pending.size }
}

/**
 * Anahtarin hesaptaki izni, zincirden.
 *
 * Hesap ya da anahtar yoksa `null`. Diger hatalar YUKARI ATILIR: "dugum
 * dustu" ile "anahtar yok" ayni sey degil.
 */
export function rpcKeyPermission(rpc: NearRpc): KeyPermissionLookup {
  return async (accountId, publicKey) => {
    const k = await rpc.accessKey(accountId, publicKey)
    if (!k) return null
    return k.permission === 'FullAccess' ? 'FullAccess' : 'FunctionCall'
  }
}

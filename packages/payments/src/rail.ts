/**
 * Odeme rayi — §6.4.
 *
 * NEAR'a dokunan her sey bu arayuzun arkasinda. Sebebi test edilebilirlik:
 * `payments` her zaman mock rail ile birim test edilir, testnet yalnizca ayri
 * bir entegrasyon suite'inde kullanilir (§11).
 */

import type { Micros } from '@bide/protocol'

export interface DestinationStatus {
  readonly address: string
  /** Hesap zincirde var mi? Yanlis yazilmis bir hesap adina para gonderilmez. */
  readonly exists: boolean
  /**
   * USDC kontratinda kayitli mi (NEP-145 `storage_deposit`)?
   *
   * Kayitsiz hedef reddedilmez: odeme islemi `ft_transfer`'dan once ayni
   * transaction icinde depozitoyu biz yatiririz.
   */
  readonly registered: boolean
}

export interface PayoutItem {
  readonly publisherId: string
  readonly address: string
  readonly amount: Micros
}

export interface PayoutBatch {
  readonly batchId: string
  readonly items: readonly PayoutItem[]
}

/**
 * Submit sonucu.
 *
 * `hash` submit'ten ONCE biliniyor: NEAR'da transaction hash'i, imzalanan
 * govdenin sha256'sidir ve yerel hesaplanir. Bu yuzden "submit ettim ama
 * cevap gelmedi" durumunda bile mutabakat kurulabilir.
 */
export interface SubmissionReceipt {
  readonly batchId: string
  readonly txHash: string
  /** Imzali transaction, base64 borsh. Retry AYNI byte'lari gonderir, yeniden insa etmez. */
  readonly signedTx: string
  /** Erisim anahtarinin bu islemde kullandigi nonce. */
  readonly nonce: string
  /**
   * Tahmini son gecerlilik zamani — yalnizca ipucu.
   *
   * Kesin karar `reconcile`'da zincirden verilir (referans blok yasi ve
   * anahtar nonce'u). Bu deger bilincli olarak GENIS tutulur: erken bir
   * tahmin, hala gecebilecek bir islemi "olu" sayip ayni parayi iki kez
   * odetirdi.
   */
  readonly maxTime: number
  /** Islem icin ayrilan gaz (Tgas cinsinden degil, gas). Teshis icin. */
  readonly feeBid: bigint
  /** Hangi item hangi action indeksinde — kismi hata teshisi icin. */
  readonly opIndex: readonly { publisherId: string; index: number }[]
}

export type SettlementState =
  /** Zincirde ve BASARILI. Tek dogru "odendi" tanimi. */
  | 'settled'
  /** Zincire girdi ama `Failure` ile bitti. Gaz yandi, para gitmedi. */
  | 'failed'
  /** Henuz kesinlesmedi. AYNI imzali islem tekrar gonderilir. */
  | 'pending'
  /** Islem artik ASLA gecemez (referans blok suresi doldu ya da nonce tuketildi). Yeniden kurulabilir. */
  | 'expired'

export interface SettlementResult {
  readonly state: SettlementState
  readonly txHash: string
  /** Islemin dahil edildigi blok yuksekligi. */
  readonly ledger: number | null
  readonly feeCharged: bigint | null
  /** Basarisizsa hangi operasyon neden patladi. */
  readonly opResults: readonly { index: number; code: string }[]
}

export interface SourceAccountStatus {
  readonly address: string
  readonly usdcBalance: Micros
  /**
   * Harcanabilir NEAR (yocto) — depolama icin kilitli kisim dusulmus.
   *
   * USDC'si dolu ama gazi biten hesap SESSIZCE DURUR ve USDC alarmi susar.
   * Bu yuzden ayri izlenir.
   */
  readonly availableGas: bigint
  /** Erisim anahtarinin guncel nonce'u. */
  readonly nonce: string
}

export interface PaymentRail {
  /** Batch kurulmadan HEMEN once cagrilir — TOCTOU penceresi dar tutulur. */
  validateDestinations(addresses: readonly string[]): Promise<readonly DestinationStatus[]>
  sourceStatus(): Promise<SourceAccountStatus>

  /**
   * Zarfi kurar ve IMZALAR — aga hicbir sey YAZMAZ.
   *
   * Kurmak ile gondermek bilincli olarak ayri. Tek bir `submitBatch` cagrisi
   * olsaydi, cagiran defterine ancak gonderimden SONRA yazabilirdi; arada
   * dusen bir sunucu parayi zincirde gonderilmis ama defterde hala odenebilir
   * birakirdi — yani ayni para ikinci kez odenirdi.
   *
   * Bu ayrimla hash gonderimden ONCE biliniyor: ne olursa olsun neye
   * bakacagimizi biliyoruz.
   */
  prepare(batch: PayoutBatch): Promise<SubmissionReceipt>

  /**
   * Hazirlanmis zarfi aga gonderir.
   *
   * AYNI byte'lar. Tekrar cagrilabilir: ag ayni nonce'u ikinci kez
   * uygulamaz, dolayisiyla idempotenttir. Yeniden insa etmek bunu bozar.
   */
  send(receipt: SubmissionReceipt): Promise<void>

  reconcile(receipt: SubmissionReceipt): Promise<SettlementResult>
  now(): number
}

/**
 * Mock odeme rayi — §11 test stratejisi.
 *
 * `payments` HER ZAMAN bunun uzerinde birim test edilir; testnet yalnizca
 * ayri betiklerde. Sebebi: zincirde gorulen ariza modlarini (hesap yok, tx
 * zincire girdi ama Failure, zaman asimi) istedigimiz anda ve deterministik
 * olarak uretebilmek.
 */

import { type Micros, micros, ZERO } from '@bide/protocol'
import type {
  PaymentRail, PayoutBatch, SubmissionReceipt, SettlementResult,
  DestinationStatus, SourceAccountStatus,
} from '../src/rail.js'

export interface MockRailOptions {
  /** Adres → durum. Tanimsiz adres "hesap yok" sayilir. */
  destinations?: Record<string, Partial<DestinationStatus>>
  usdcBalance?: bigint
  availableGas?: bigint
  /** Bu adres batch'te varsa transaction TAMAMEN patlar (§8 tuzak #1). */
  failingAddress?: string
  /** Zarf KURULURKEN patlasin — hicbir sey gonderilmez. */
  throwOnPrepare?: boolean
  /** GONDERIM patlasin — zarf kurulmus, defter yazilmis olur. */
  throwOnSend?: boolean
  /** Mutabakat kac kez `pending` donsun. */
  pendingRounds?: number
  /** Zaman asimi senaryosu: hicbir zaman dahil edilmesin. */
  neverIncluded?: boolean
  /** Her `reconcile` cagrisinda saati bu kadar ilerlet — polling gercekci olsun. */
  advanceOnReconcile?: number
}

export class MockRail implements PaymentRail {
  #now = 1_700_000_000_000
  #seq = 1
  readonly submitted: SubmissionReceipt[] = []
  readonly resubmits: string[] = []
  /** Kurulmus zarflar — gonderilmis olanlar `submitted`'da. */
  readonly prepared: SubmissionReceipt[] = []
  #pendingLeft: number

  constructor(private readonly opts: MockRailOptions = {}) {
    this.#pendingLeft = opts.pendingRounds ?? 0
  }

  now(): number { return this.#now }
  advance(ms: number): void { this.#now += ms }

  async validateDestinations(addresses: readonly string[]): Promise<readonly DestinationStatus[]> {
    return addresses.map((address) => {
      const o = this.opts.destinations?.[address]
      return {
        address,
        exists: o?.exists ?? true,
        registered: o?.registered ?? true,
      }
    })
  }

  async sourceStatus(): Promise<SourceAccountStatus> {
    return {
      address: 'bide-treasury.testnet',
      usdcBalance: micros(this.opts.usdcBalance ?? 1_000_000_000_000n),
      availableGas: this.opts.availableGas ?? 10n ** 24n,
      nonce: String(this.#seq),
    }
  }

  async prepare(batch: PayoutBatch): Promise<SubmissionReceipt> {
    if (this.opts.throwOnPrepare) throw new Error('zarf kurulamadi')

    const receipt: SubmissionReceipt = {
      batchId: batch.batchId,
      // Hash gonderimden ONCE bilinir.
      txHash: `hash-${batch.batchId}`,
      signedTx: `tx-${batch.batchId}`,
      nonce: String(this.#seq++),
      maxTime: this.#now + 180_000,
      feeBid: BigInt(batch.items.length) * 1000n,
      opIndex: batch.items.map((it, index) => ({ publisherId: it.publisherId, index })),
    }
    this.prepared.push(receipt)
    return receipt
  }

  async send(receipt: SubmissionReceipt): Promise<void> {
    if (this.opts.throwOnSend) throw new Error('ag reddetti')
    this.submitted.push(receipt)
    this.resubmits.push(receipt.signedTx)
  }

  async reconcile(receipt: SubmissionReceipt): Promise<SettlementResult> {
    if (this.opts.advanceOnReconcile) this.#now += this.opts.advanceOnReconcile
    if (this.opts.neverIncluded) {
      return { state: 'pending', txHash: receipt.txHash, ledger: null, feeCharged: null, opResults: [] }
    }
    if (this.#pendingLeft > 0) {
      this.#pendingLeft--
      return { state: 'pending', txHash: receipt.txHash, ledger: null, feeCharged: null, opResults: [] }
    }

    const bad = this.opts.failingAddress
    const failingIndex = bad
      ? receipt.opIndex.findIndex((o) => this.#addressOf(o.publisherId) === bad)
      : -1

    if (failingIndex >= 0) {
      // Zincire GIRDI, gaz YANDI, ama odeme olmadi.
      return {
        state: 'failed',
        txHash: receipt.txHash,
        ledger: 4_107_913,
        feeCharged: receipt.feeBid,
        opResults: receipt.opIndex.map((o) => ({
          index: o.index,
          code: o.index === failingIndex ? 'FunctionCallError: Smart contract panicked: The account is not registered' : 'op_success',
        })),
      }
    }

    return {
      state: 'settled',
      txHash: receipt.txHash,
      ledger: 4_107_914,
      feeCharged: receipt.feeBid,
      opResults: receipt.opIndex.map((o) => ({ index: o.index, code: 'op_success' })),
    }
  }

  /** Test kolayligi: publisherId ile adres eslesmesi disaridan verilir. */
  addressMap: Record<string, string> = {}
  #addressOf(publisherId: string): string { return this.addressMap[publisherId] ?? '' }
}

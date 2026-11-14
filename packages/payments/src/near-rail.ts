/**
 * `PaymentRail`'in GERCEK uygulamasi — NEAR'a baglanir.
 *
 * Buraya kadarki her sey mock ray uzerinde calisti; burasi paranin fiilen
 * hareket ettigi yer. Zincire yazilan bir odeme geri cagirilamaz.
 *
 * Bir batch = TEK transaction, alicisi USDC kontrati, icinde her yayinci
 * icin bir `ft_transfer` action'i. NEAR'da ayni transaction'daki action'lar
 * tek bir receipt olarak calisir: biri patlarsa HEPSI geri alinir. Yani
 * batch ya tamamen odenir ya hic odenmez — "yarisi gitti" durumu yok.
 *
 * Uc kural:
 *
 *   1. ISLEM BIR KEZ IMZALANIR. Retry AYNI byte'lari gonderir; yeniden
 *      imzalamak yeni bir nonce ve yeni bir hash uretir ve ayni odemeyi
 *      IKI KEZ yapabilir.
 *   2. "GONDERDIM" ODENDI DEMEK DEGIL. Yalnizca kesinlesmis (`FINAL`) ve
 *      `SuccessValue` ile biten islem odendi demektir. Zincire girip
 *      `Failure` ile biten islem gaz yakar, para gondermez.
 *   3. USDC BAKIYESI YETMEZ. Gazi biten hesap sessizce durur ve USDC alarmi
 *      susar. Ikisi ayri izlenir.
 */

import { createHash } from 'node:crypto'
import { KeyPair, type KeyPairString } from '@near-js/crypto'
import {
  actionCreators, createTransaction, encodeTransaction, decodeSignedTransaction,
  SignedTransaction, Signature, type Action,
} from '@near-js/transactions'
import { baseDecode, baseEncode } from '@near-js/utils'
import { micros, type Micros } from '@bide/protocol'
import { NearRpc, RpcError } from './near-rpc.js'
import type {
  PaymentRail, PayoutBatch, DestinationStatus, SubmissionReceipt,
  SettlementResult, SourceAccountStatus,
} from './rail.js'

export interface NearRailConfig {
  readonly rpcUrl: string
  /** Odemeleri yapan hesap (sicak cuzdan), orn. `bide-treasury.testnet`. */
  readonly accountId: string
  /** O hesabin TAM ERISIMLI anahtari, `ed25519:...`. Yalnizca sunucuda, secret manager'dan. */
  readonly secretKey: string
  /**
   * Odenecek varlik — NEP-141 kontrat hesabi.
   *
   * Circle'in yerel USDC'si kullanilir. Adinda "usdc" gecen baska bir token
   * kontrati farkli bir varliktir; yanlis kontratla yapilan odeme
   * kullanicinin cuzdaninda "USDC" gorunur ama degersizdir.
   */
  readonly tokenContract: string
  readonly fetchImpl?: typeof fetch
}

/** `ft_transfer` icin gaz. Gercek tuketim ~3-5 Tgas. */
const FT_TRANSFER_GAS = 10_000_000_000_000n
/** `storage_deposit` icin gaz. */
const STORAGE_DEPOSIT_GAS = 10_000_000_000_000n
/** NEP-141 `ft_transfer` tam olarak 1 yocto ister — tam erisimli anahtar kaniti. */
const ONE_YOCTO = 1n
/**
 * Referans blok gecerlilik suresi (blok). Genesis'te `transaction_validity_period`.
 * Testnet ve mainnet'te 86400. Kesin karar zincirden okunur; bu yalnizca varsayilan.
 */
const DEFAULT_VALIDITY_BLOCKS = 86_400
/** `maxTime` ipucu: bilincli olarak genis — bkz. rail.ts `maxTime`. */
const MAX_TIME_HINT_MS = 72 * 3600_000

export class NearRail implements PaymentRail {
  readonly #rpc: NearRpc
  readonly #keyPair: KeyPair
  /** Ayni surecte arka arkaya kurulan islemler ayni nonce'u almasin. */
  #lastNonce = 0n
  #validityBlocks: number | null = null
  #storageMin: bigint | null = null

  constructor(private readonly cfg: NearRailConfig) {
    this.#rpc = new NearRpc({ url: cfg.rpcUrl, ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}) })
    this.#keyPair = KeyPair.fromString(cfg.secretKey as KeyPairString)
  }

  now(): number { return Date.now() }

  get accountId(): string { return this.cfg.accountId }
  get publicKey(): string { return this.#keyPair.getPublicKey().toString() }
  get rpc(): NearRpc { return this.#rpc }

  /* ───────────────────────── hedef kontrolu ───────────────────────── */

  /**
   * Batch kurulmadan HEMEN once cagrilir.
   *
   * Hesap yoksa reddedilir: NEAR'da var olmayan isimli bir hesaba
   * kayit + transfer yapmak mumkun ama o hesabi sonradan BASKASI
   * olusturabilir ve parayi alir. Yanlis yazilmis bir isme odeme yapilmaz.
   */
  async validateDestinations(addresses: readonly string[]): Promise<readonly DestinationStatus[]> {
    return Promise.all(addresses.map(async (address) => {
      // Dugum hatasi "hesap yok" DEGILDIR — yukari atilir. Ikisini
      // birlestirmek gecici bir kesinti yuzunden gercek bir alacakliyi
      // batch'ten dusurmek demek.
      const acc = await this.#rpc.account(address)
      if (!acc) return { address, exists: false, registered: false }
      return { address, exists: true, registered: await this.#registered(address) }
    }))
  }

  async #registered(address: string): Promise<boolean> {
    const r = await this.#rpc.view<{ total: string } | null>(
      this.cfg.tokenContract, 'storage_balance_of', { account_id: address },
    )
    return r !== null
  }

  async #storageDeposit(): Promise<bigint> {
    if (this.#storageMin !== null) return this.#storageMin
    const b = await this.#rpc.view<{ min: string }>(this.cfg.tokenContract, 'storage_balance_bounds')
    this.#storageMin = BigInt(b.min)
    return this.#storageMin
  }

  /* ───────────────────────── kaynak hesap ───────────────────────── */

  async sourceStatus(): Promise<SourceAccountStatus> {
    const [acc, key, usdc] = await Promise.all([
      this.#rpc.account(this.cfg.accountId),
      this.#rpc.accessKey(this.cfg.accountId, this.publicKey),
      this.#rpc.view<string>(this.cfg.tokenContract, 'ft_balance_of', { account_id: this.cfg.accountId }),
    ])
    if (!acc) throw new Error(`odeme hesabi zincirde yok: ${this.cfg.accountId}`)
    if (!key) throw new Error(`odeme anahtari ${this.cfg.accountId} hesabinda yok`)

    // Harcanabilir NEAR = bakiye − depolama icin kilitli kisim.
    // Depolama bayt basina 1e19 yocto (0.00001 NEAR) kilitler; ham bakiyeyi
    // kullanmak hesabin tek bir islemi bile odeyemeyecegini gizlerdi.
    const storageLocked = acc.storageUsage * 10_000_000_000_000_000_000n
    const available = acc.amount - storageLocked

    return {
      address: this.cfg.accountId,
      usdcBalance: micros(BigInt(usdc ?? '0')),
      availableGas: available < 0n ? 0n : available,
      nonce: key.nonce.toString(),
    }
  }

  /* ───────────────────────── gonderim ───────────────────────── */

  /** Kurar ve imzalar. Aga YAZMAZ — yalnizca nonce ve referans blok icin okur. */
  async prepare(batch: PayoutBatch): Promise<SubmissionReceipt> {
    if (batch.items.length === 0) throw new Error('bos batch gonderilemez')
    for (const it of batch.items) {
      if (it.amount <= 0n) throw new Error(`tutar > 0 olmali (${it.publisherId})`)
    }

    const key = await this.#rpc.accessKey(this.cfg.accountId, this.publicKey, 'optimistic')
    if (!key) throw new Error(`odeme anahtari ${this.cfg.accountId} hesabinda yok`)
    if (key.permission !== 'FullAccess') throw new Error('odeme anahtari tam erisimli degil — ft_transfer 1 yocto ister')

    // Nonce: zincirdekinden VE bu surecte son kullanilandan buyuk. NEAR
    // bosluga izin verir (yalnizca "oncekinden buyuk" sart), dolayisiyla
    // kurulup gonderilmeyen bir islem sonrakileri tikamaz.
    const nonce = (key.nonce > this.#lastNonce ? key.nonce : this.#lastNonce) + 1n
    this.#lastNonce = nonce

    const storage = await this.#storageDeposit()
    const actions: Action[] = []
    const opIndex: { publisherId: string; index: number }[] = []
    let gas = 0n

    for (const it of batch.items) {
      // Kayitsiz hedefin depozitosunu BIZ yatiriyoruz, ayni islemin icinde.
      // Kullanicidan "once USDC'yi aktiflestir" istemek ilk odemeyi
      // gereksiz yere zorlastirirdi.
      if (!(await this.#registered(it.address))) {
        actions.push(actionCreators.functionCall(
          'storage_deposit', { account_id: it.address, registration_only: true }, STORAGE_DEPOSIT_GAS, storage,
        ))
        gas += STORAGE_DEPOSIT_GAS
      }
      // Hangi item hangi action'da — bu esleme GONDERIMDEN ONCE sabitlenir.
      // Sonradan yeniden turetmek, batch patladiginda kimin yuzunden
      // patladigini bilememek demek.
      opIndex.push({ publisherId: it.publisherId, index: actions.length })
      actions.push(actionCreators.functionCall(
        'ft_transfer',
        { receiver_id: it.address, amount: it.amount.toString(), memo: `bide:${batch.batchId}`.slice(0, 64) },
        FT_TRANSFER_GAS, ONE_YOCTO,
      ))
      gas += FT_TRANSFER_GAS
    }

    const tx = createTransaction(
      this.cfg.accountId, this.#keyPair.getPublicKey(), this.cfg.tokenContract,
      nonce, actions, baseDecode(key.blockHash),
    )
    const hash = new Uint8Array(createHash('sha256').update(encodeTransaction(tx)).digest())
    const sig = this.#keyPair.sign(hash)
    const signed = new SignedTransaction({
      transaction: tx,
      signature: new Signature({ keyType: tx.publicKey.keyType, data: sig.signature }),
    })

    // Hash imzadan ONCE biliniyor ve simdi sabit. "Gonderdim ama cevap
    // gelmedi" durumunda bile ne aradigimizi biliyoruz.
    return {
      batchId: batch.batchId,
      txHash: baseEncode(hash),
      signedTx: Buffer.from(signed.encode()).toString('base64'),
      nonce: nonce.toString(),
      maxTime: this.now() + MAX_TIME_HINT_MS,
      feeBid: gas,
      opIndex,
    }
  }

  /**
   * Imzali islemi gonderir. AYNI byte'lar, her seferinde.
   *
   * Gonderim hatasi "odeme yapilmadi" DEMEK DEGIL: zaman asimi ya da baglanti
   * kopmasi, ag islemi kabul ettikten SONRA da olabilir. Belirsiz hatalar
   * YUTULUYOR — karar `reconcile`'a, yani zincire birakiliyor.
   *
   * Yalnizca ag islemi ACIKCA ve kalici olarak reddettiginde hata
   * firlatiliyor; o durumda odeme kesin yapilmadi.
   */
  async send(receipt: SubmissionReceipt): Promise<void> {
    try {
      // `INCLUDED`: ag islemi DOGRULAR (imza, anahtar, nonce, bakiye) ve gecersizse
      // hemen reddeder. `NONE` her seyi sessizce kabul ediyordu; kesin bir
      // red ancak gunler sonra referans blok suresi dolunca anlasilirdi.
      await this.#rpc.call('send_tx', { signed_tx_base64: receipt.signedTx, wait_until: 'INCLUDED' })
    } catch (e) {
      if (!(e instanceof RpcError) || e.transport) return
      const info = JSON.stringify(e.data ?? '')
      // `InvalidNonce` burada IYI haber olabilir: ayni islem zaten gecmis.
      // `reconcile` gercegi soyleyecek.
      if (/InvalidNonce/.test(info)) return
      if (e.causeName === 'INVALID_TRANSACTION' && !/Expired|TIMEOUT/i.test(info)) {
        throw new SubmitRejected(receipt, e.message)
      }
    }
  }

  /* ───────────────────────── mutabakat ───────────────────────── */

  /**
   * Zincire bakar ve TEK dogru cevabi verir.
   *
   * Bulunamayan islem iki seydir: ya henuz yolda, ya ASLA gecmeyecek. Ikincisi
   * ancak zincirden kanitlanirsa soylenir — referans blok gecerlilik
   * suresini asmissa ya da anahtarin nonce'u bu islemin nonce'unu gecmisse.
   * Kanit yoksa `pending`: yeniden kurmak CIFT ODEME demek.
   */
  async reconcile(receipt: SubmissionReceipt): Promise<SettlementResult> {
    const base = { txHash: receipt.txHash, ledger: null, feeCharged: null, opResults: [] }
    let r: any
    try {
      r = await this.#rpc.call('tx', {
        tx_hash: receipt.txHash, sender_account_id: this.cfg.accountId, wait_until: 'NONE',
      })
    } catch (e) {
      if (!(e instanceof RpcError) || e.causeName !== 'UNKNOWN_TRANSACTION') throw e
      return { ...base, state: (await this.#deadOnChain(receipt)) ? 'expired' : 'pending' }
    }

    // Yalnizca KESINLESMIS sonuc karar verir. Iyimser sonuc geri donebilir.
    const fin = String(r.final_execution_status ?? '')
    if (fin !== 'FINAL' || !r.status || typeof r.status !== 'object') {
      return { ...base, state: 'pending' }
    }

    const height = await this.#heightOf(r.transaction_outcome?.block_hash)
    const burnt = sumBurnt(r)

    if ('Failure' in r.status) {
      const idx = r.status.Failure?.ActionError?.index
      const kind = r.status.Failure?.ActionError?.kind
      const code = kind ? describeKind(kind) : 'tx_failed'
      return {
        state: 'failed', txHash: receipt.txHash, ledger: height, feeCharged: burnt,
        // Action indeksi → hangi yayinci. `storage_deposit` action'i ait oldugu
        // `ft_transfer`'in hemen onundedir.
        opResults: receipt.opIndex.map((o) => ({
          index: o.index,
          code: idx === o.index ? code : idx === o.index - 1 ? `storage_deposit: ${code}` : 'op_success',
        })),
      }
    }

    return {
      state: 'settled', txHash: receipt.txHash, ledger: height, feeCharged: burnt,
      opResults: receipt.opIndex.map((o) => ({ index: o.index, code: 'op_success' })),
    }
  }

  /** Bu islem artik ASLA dahil edilemez mi? Yalnizca zincir kaniti `true` dondurur. */
  async #deadOnChain(receipt: SubmissionReceipt): Promise<boolean> {
    const tx = decodeSignedTransaction(Buffer.from(receipt.signedTx, 'base64')).transaction
    const nonce = BigInt(tx.nonce)

    // 1. Anahtarin nonce'u bu islemin nonce'una ulasti ve islem yok:
    //    baska bir islem bu nonce'u (ya da buyugunu) tuketti, bu ASLA gecemez.
    const key = await this.#rpc.accessKey(this.cfg.accountId, this.publicKey)
    if (key && key.nonce >= nonce) {
      // Yarisi kapat: nonce tam o sirada bu islemle ilerlemis olabilir.
      try {
        await this.#rpc.call('tx', { tx_hash: receipt.txHash, sender_account_id: this.cfg.accountId, wait_until: 'NONE' })
        return false
      } catch (e) {
        if (!(e instanceof RpcError) || e.causeName !== 'UNKNOWN_TRANSACTION') throw e
        return true
      }
    }

    // 2. Referans blok gecerlilik suresini asti.
    const ref = await this.#rpc.blockByHash(baseEncode(Uint8Array.from(tx.blockHash as ArrayLike<number>)))
    const head = await this.#rpc.finalBlock()
    const validity = await this.#validity()
    if (ref === null) return true                    // blok GC'lenmis — suresi coktan dolmus
    return head.height - ref.height > validity
  }

  async #validity(): Promise<number> {
    if (this.#validityBlocks !== null) return this.#validityBlocks
    try {
      const g = await this.#rpc.call<any>('EXPERIMENTAL_genesis_config', [])
      this.#validityBlocks = Number(g.transaction_validity_period ?? DEFAULT_VALIDITY_BLOCKS)
    } catch {
      this.#validityBlocks = DEFAULT_VALIDITY_BLOCKS
    }
    return this.#validityBlocks
  }

  async #heightOf(blockHash: string | undefined): Promise<number | null> {
    if (!blockHash) return null
    try { return (await this.#rpc.blockByHash(blockHash))?.height ?? null } catch { return null }
  }
}

/** Ag tarafindan KESIN olarak reddedilmis gonderim. Odeme yapilmadi. */
export class SubmitRejected extends Error {
  constructor(readonly receipt: SubmissionReceipt, message: string) {
    super(message)
    this.name = 'SubmitRejected'
  }
}

/* ───────────────────────── yardimcilar ───────────────────────── */

function sumBurnt(r: any): bigint | null {
  try {
    let t = BigInt(r.transaction_outcome?.outcome?.tokens_burnt ?? 0)
    for (const o of r.receipts_outcome ?? []) t += BigInt(o.outcome?.tokens_burnt ?? 0)
    return t
  } catch { return null }
}

function describeKind(kind: unknown): string {
  if (typeof kind === 'string') return kind
  if (kind && typeof kind === 'object') {
    const k = Object.keys(kind)[0] ?? 'ActionError'
    const inner = (kind as any)[k]
    // FunctionCallError → ExecutionError("Smart contract panicked: ...") en yararli kisim.
    const msg = inner?.ExecutionError ?? inner?.MethodResolveError ?? null
    return msg ? `${k}: ${String(msg).slice(0, 120)}` : k
  }
  return 'ActionError'
}

/** NEAR tutari: yocto → "1.25" (gosterim icin). Float'a UGRAMAZ. */
export function formatNear(yocto: bigint): string {
  const whole = yocto / 10n ** 24n
  const frac = (yocto % 10n ** 24n).toString().padStart(24, '0').slice(0, 4).replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : `${whole}`
}

export type { Micros }

/**
 * Reklamveren para yatirma — ADR-021.
 *
 * Problem: hesabimiza USDC geliyor, BU PARA KIMIN?
 *
 * Klasik cozum memo'dur ve kotudur: kullanici yazmayi unutur, para sahipsiz
 * kalir, elle destek gerekir. Ikinci klasik cozum reklamveren basina ayri
 * hesaptir; temiz ama her hesap depolama icin NEAR kilitler ve hepsini
 * yonetmek gerekir.
 *
 * Bizim cozumumuz: odeme hesabinin kendisinde kucuk bir kontrat var
 * (`contracts/treasury`). Reklamveren USDC'yi `ft_transfer_call` ile
 * gonderir; USDC kontrati `ft_on_transfer`'i cagirir ve kontrat
 * `sender_id`'yi sirali bir kayda yazar. Burasi o kaydi okur. Eslesme
 * kendiliginden: `alice.testnet`'ten gelen para `alice.testnet`'in hesabina
 * yazilir. Reklamveren de cuzdaniyla giris yaptigi icin (ADR-010) kimlik
 * zaten ayni sey.
 *
 * Indexer YOK: kayit indeksi dogrudan bir imlec. Ucuncu taraf API'ye ya da
 * blok tarayiciya bagimlilik yok; tek kaynak zincirin kendisi.
 *
 * Bedeli: duz `ft_transfer` (`_call` olmadan) kayda dusmez ve borsadan
 * gonderilen para eslesmez. Panelde acikca yaziyor; bu paralar elle cozulur.
 */

import type { Clock } from '@bide/protocol'
import { micros, type Micros } from '@bide/protocol'
import type { NearRpc } from '@bide/payments'
import type { Ledger } from '../ledger/ledger.js'

/** Treasury kontratinin `deposits_from` cevabindaki tek kayit. */
export interface DepositRecord {
  readonly index: number
  readonly sender: string
  readonly amount: string
  readonly block_height: number
  readonly timestamp_ms: number
}

export interface DepositWatcherDeps {
  readonly clock: Clock
  readonly ledger: Ledger
  /** Kaydi okur. Gercekte `rpc.view(treasury, 'deposits_from', ...)`. */
  readonly fetchPage: (fromIndex: number, limit: number) => Promise<readonly DepositRecord[]>
  /** Bu hesap bir reklamverene ait mi? Degilse para bekletilir. */
  readonly isKnownAdvertiser: (address: string) => boolean
  readonly log: (m: string) => void
  /** Nereden devam edilecegi. Yeniden baslatmada kaldigi yerden. */
  readonly cursor: {
    readonly get: () => string | null
    readonly set: (c: string) => void
  }
  /** Tek turda en fazla kac sayfa okunsun (sayfa = 100 kayit). */
  readonly maxPages?: number
}

export interface DepositResult {
  readonly credited: number
  readonly unmatched: number
  readonly total: Micros
}

const PAGE = 100

/** Treasury kontratini okuyan `fetchPage`. */
export function treasuryPages(rpc: NearRpc, treasury: string): DepositWatcherDeps['fetchPage'] {
  return (fromIndex, limit) =>
    rpc.view<DepositRecord[]>(treasury, 'deposits_from', { from_index: fromIndex, limit })
}

export class DepositWatcher {
  #running = false

  constructor(private readonly deps: DepositWatcherDeps) {}

  /**
   * Kaydi tarar ve yeni yatirmalari deftere yazar.
   *
   * Imlec kayit indeksi: kontrat her yatirmaya sirali bir numara veriyor.
   * Zaman damgasina gore ilerlemek YANLIS olurdu — ayni blokta birden fazla
   * yatirma olabilir.
   */
  async poll(): Promise<DepositResult> {
    if (this.#running) return { credited: 0, unmatched: 0, total: micros(0n) }
    this.#running = true
    try {
      return await this.#poll()
    } finally {
      this.#running = false
    }
  }

  async #poll(): Promise<DepositResult> {
    let credited = 0, unmatched = 0
    let toplam = 0n
    let next = Number(this.deps.cursor.get() ?? '0')
    if (!Number.isSafeInteger(next) || next < 0) next = 0

    for (let page = 0; page < (this.deps.maxPages ?? 10); page++) {
      let kayitlar: readonly DepositRecord[]
      try {
        kayitlar = await this.deps.fetchPage(next, PAGE)
      } catch (e) {
        // Ag hatasi SESSIZ gecilmez ama akisi durdurmaz: bir sonraki turda
        // ayni imlecten devam edilir, hicbir yatirma atlanmaz.
        this.deps.log(`yatirma taramasi basarisiz: ${e instanceof Error ? e.message : String(e)}`)
        break
      }
      if (kayitlar.length === 0) break

      for (const d of kayitlar) {
        // Kontrat sirali indeks veriyor; bosluk ya da geri gitme bir
        // tutarsizliktir (yanlis kontrat, yeniden deploy). Durup bildir —
        // tahmin yurutmek parayi yanlis hesaba yazabilir.
        if (d.index !== next) {
          this.deps.log(`⚠ yatirma kaydi sira disi: beklenen ${next}, gelen ${d.index} — tarama durdu`)
          return { credited, unmatched, total: micros(toplam) }
        }
        next = d.index + 1

        let tutar: bigint
        try { tutar = BigInt(d.amount) } catch { tutar = 0n }
        if (tutar <= 0n) continue

        const gonderen = String(d.sender)
        if (!this.deps.isKnownAdvertiser(gonderen)) {
          // Taninmayan hesap. Para duruyor, kaybolmadi — ama kimin oldugunu
          // bilmedigimiz icin deftere yazamiyoruz. Imlec ilerledigi icin
          // bir daha bakilmayacak; elle cozulmesi gerekiyor.
          unmatched++
          this.deps.log(`⚠ eslesmeyen yatirma #${d.index}: ${d.amount} micro USDC ← ${gonderen}`)
          continue
        }

        // Idempotency: `topupId` kayit indeksi. Ayni kayit iki kez
        // taranirsa defter ikincisini reddeder (ADR-005).
        const topupId = `chain:deposit:${d.index}`
        try {
          this.deps.ledger.deposit({ advertiserId: gonderen, amount: micros(tutar), topupId })
          credited++
          toplam += tutar
          this.deps.log(`yatirma #${d.index}: ${d.amount} micro USDC → ${gonderen}`)
        } catch (e) {
          this.deps.log(`yatirma yazilamadi (${topupId}): ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      // Imlec SAYFA SONUNDA ilerletilir. Once ilerletseydik ve arada
      // patlasaydik, islenmemis yatirmalar atlanirdi.
      this.deps.cursor.set(String(next))
      if (kayitlar.length < PAGE) break
    }

    return { credited, unmatched, total: micros(toplam) }
  }
}

/** Imleci diskte tutar — yeniden baslatmada bastan taramamak icin. */
export function sqliteCursor(db: import('../store/db.js').Db, key = 'deposit_cursor') {
  return {
    get: (): string | null => {
      const r = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as any
      return r ? String(r.value) : null
    },
    set: (c: string): void => {
      db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, c)
    },
  }
}

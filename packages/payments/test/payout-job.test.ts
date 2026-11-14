/**
 * Odeme job'i testleri.
 *
 * Zincirde gorulen ariza modlarinin hepsi burada deterministik olarak
 * uretiliyor.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { fixedClock, micros, type Micros } from '@bide/protocol'
import { PayoutJob, type PayoutCandidate } from '../src/payout-job.js'
import { WalletStore } from '../src/wallet.js'
import { MockRail } from './mock-rail.js'
import type { PayoutItem, SubmissionReceipt } from '../src/rail.js'

const addr = (n: number) => `pub${n}.testnet`

let clock: ReturnType<typeof fixedClock>
let wallets: WalletStore
let rail: MockRail
let events: string[]
let batchSeq: number

function setup(opts: {
  rail?: ConstructorParameters<typeof MockRail>[0]
  candidates?: PayoutCandidate[]
  publishers?: number
  batchSize?: number
} = {}) {
  clock = fixedClock(1_700_000_000_000)
  wallets = new WalletStore({ clock, notify: () => {} })
  rail = new MockRail(opts.rail)
  events = []
  batchSeq = 0

  const n = opts.publishers ?? 3
  for (let i = 1; i <= n; i++) {
    wallets.bind(`p${i}`, addr(i), 'testnet')
    rail.addressMap[`p${i}`] = addr(i)
  }

  const candidates = opts.candidates
    ?? Array.from({ length: n }, (_, i) => ({ publisherId: `p${i + 1}`, payable: micros(50_000_000n) }))

  const job = new PayoutJob({
    clock, rail, wallets,
    candidates: () => candidates,
    threshold: micros(10_000_000n),
    batchSize: opts.batchSize ?? 10,
    newBatchId: () => `b${++batchSeq}`,
    onSubmit: (id, items, r) => events.push(`submit:${id}:${items.length}:${r.txHash}`),
    onSettled: (id, items) => events.push(`settled:${id}:${items.length}`),
    onFailed: (id, items, reason) => events.push(`failed:${id}:${reason}`),
    onSkipped: (p, reason) => events.push(`skip:${p}:${reason}`),
  })
  return job
}

describe('mutlu yol', () => {
  it('uygun herkes odenir', async () => {
    const r = await setup().run()
    expect(r.paid).toBe(3)
    expect(r.failed).toBe(0)
    expect(r.totalPaid).toBe(150_000_000n)
    expect(events).toContain('settled:b1:3')
  })

  it('kayit submit\'ten ONCE yazilir', async () => {
    await setup().run()
    // `submit` olayi `settled`'dan once gelmeli: cevap gelmese bile
    // "yolda" kaydi durmali.
    expect(events.findIndex((e) => e.startsWith('submit:')))
      .toBeLessThan(events.findIndex((e) => e.startsWith('settled:')))
  })

  it('esigin altindakiler hic denenmez', async () => {
    const r = await setup({
      candidates: [
        { publisherId: 'p1', payable: micros(50_000_000n) },
        { publisherId: 'p2', payable: micros(1_000_000n) },   // esigin altinda
      ],
    }).run()
    expect(r.paid).toBe(1)
    expect(rail.submitted[0]!.opIndex).toHaveLength(1)
  })
})

describe('tek bozuk hedef tum batch\'i dusurur', () => {
  it('zincirde olmayan hedef batch\'e HIC ALINMAZ', async () => {
    const r = await setup({
      rail: { destinations: { [addr(2)]: { exists: false } } },
    }).run()

    expect(r.skipped).toBe(1)
    expect(r.paid, 'digerleri odenmeli').toBe(2)
    expect(events).toContainEqual(expect.stringMatching(/skip:p2:hesap zincirde yok/))
  })

  it('USDC kaydi olmayan hedef DUSURULMEZ — depozitoyu rail yatirir', async () => {
    const r = await setup({
      rail: { destinations: { [addr(2)]: { registered: false } } },
    }).run()
    expect(r.skipped).toBe(0)
    expect(r.paid).toBe(3)
  })

  it('on kontrol atlanirsa TUM batch patlar', async () => {
    // Bu senaryo dogrulamanin neden batch kurulmadan HEMEN once yapildigini
    // gosteriyor: hedef arada bozulursa 3 masum publisher da odeme alamaz.
    const r = await setup({ rail: { failingAddress: addr(2) } }).run()

    expect(r.paid).toBe(0)
    expect(r.failed).toBe(3)
    expect(events).toContainEqual(expect.stringMatching(/failed:b1:tx basarisiz: p2=FunctionCallError/))
  })

  it('suclu operation INDEKSINDEN bulunur — op_index zorunlu', async () => {
    await setup({ rail: { failingAddress: addr(3) } }).run()
    const failed = events.find((e) => e.startsWith('failed:'))!
    expect(failed, 'suclu ismen raporlanmali').toContain('p3=FunctionCallError')
    expect(failed).not.toContain('p1=FunctionCallError')
  })
})

describe('patlayan tx de zincire girer', () => {
  it('basarisiz batch "odendi" SAYILMAZ', async () => {
    const r = await setup({ rail: { failingAddress: addr(1) } }).run()
    expect(r.paid).toBe(0)
    expect(events).not.toContainEqual(expect.stringMatching(/^settled:/))
    // Ters kayit yazilmali — para publisher'a donmeli.
    expect(events).toContainEqual(expect.stringMatching(/^failed:/))
  })
})

describe('hedef eleme', () => {
  const cases: [string, any, RegExp][] = [
    ['hesap yok', { exists: false }, /zincirde yok/],
  ]

  for (const [name, dest, pattern] of cases) {
    it(`${name} → dusurulur, sebebi bildirilir`, async () => {
      const r = await setup({ rail: { destinations: { [addr(2)]: dest } } }).run()
      expect(r.skipped).toBe(1)
      expect(events.find((e) => e.startsWith('skip:p2'))).toMatch(pattern)
    })
  }
})

describe('ADR-014 — bekleme suresindeki hesap odenmez', () => {
  it('adres degistirmis publisher batch\'ten dusurulur', async () => {
    const job = setup()
    wallets.bind('p2', addr(99), 'testnet')      // adres degisti → 72 saat

    const r = await job.run()
    expect(r.paid).toBe(2)
    expect(events.find((e) => e.startsWith('skip:p2'))).toMatch(/72 saat kaldi/)
  })

  it('bekleme dolunca odenir', async () => {
    const job = setup()
    wallets.bind('p2', addr(99), 'testnet')
    rail.addressMap['p2'] = addr(99)
    clock.advance(73 * 3600_000)

    expect((await job.run()).paid).toBe(3)
  })
})

describe('ADR-015 — sicak cuzdan', () => {
  it('NEAR (gaz) yetersizse HICBIR odeme yapilmaz', async () => {
    // USDC dolu ama gazi biten hesap sessizce durur; alarm ureten tek sey bu.
    const r = await setup({ rail: { availableGas: 1_000n } }).run()
    expect(r.batches).toBe(0)
    expect(r.paid).toBe(0)
    expect(r.alerts).toContainEqual(expect.stringMatching(/NEAR yetersiz/))
  })

  it('USDC yetersizse alarm uretilir', async () => {
    const r = await setup({ rail: { usdcBalance: 1_000_000n } }).run()
    expect(r.alerts).toContainEqual(expect.stringMatching(/USDC yetersiz/))
  })
})

describe('ADR-006 — batch boyutu', () => {
  it('10\'ar 10\'ar bolunur', async () => {
    const r = await setup({ publishers: 25, batchSize: 10 }).run()
    expect(r.batches).toBe(3)
    expect(r.paid).toBe(25)
    expect(rail.submitted.map((s) => s.opIndex.length)).toEqual([10, 10, 5])
  })

  it('kucuk batch patlama yaricapini sinirlar', async () => {
    // 25 hedeften biri bozuk. p15 ikinci batch'te (10-19 arasi), yani
    // yalnizca o batch duser. Tek buyuk batch olsaydi 25 kisi de odenmezdi.
    const r = await setup({
      publishers: 25, batchSize: 10,
      rail: { failingAddress: addr(15) },
    }).run()
    expect(r.paid, 'birinci ve ucuncu batch kurtulur').toBe(15)
    expect(r.failed, 'yalnizca ikinci batch').toBe(10)
  })
})

describe('belirsizlik ve zaman asimi', () => {
  it('gecici pending sonrasi AYNI imzali islem tekrar gonderilir', async () => {
    const r = await setup({ rail: { pendingRounds: 2 } }).run()
    expect(r.paid).toBe(3)
    // Ilk gonderim + iki yeniden gonderim. Ucu de AYNI byte'lar.
    expect(rail.resubmits, 'yeniden insa DEGIL, ayni byte\'lar').toEqual(['tx-b1', 'tx-b1', 'tx-b1'])
    // Zarf yalnizca BIR KEZ kuruldu. Yeniden kurmak yeni hash uretirdi.
    expect(rail.prepared, 'zarf tek kez kurulur').toHaveLength(1)
  })

  it('maxTime gecmeden ASLA yeni transaction kurulmaz', async () => {
    // `UNKNOWN_TRANSACTION` tek basina anlamsizdir; yeni nonce ile yeniden kurmak
    // cift odeme uretir.
    const r = await setup({ rail: { neverIncluded: true } }).run()
    expect(rail.prepared, 'ikinci zarf kurulmadi').toHaveLength(1)
    expect(r.paid).toBe(0)
  })

  it('maxTime gecince olu sayilir ve ters kayit yazilir', async () => {
    // Gercekte polling sirasinda zaman gecer; mock her reconcile'da saati
    // ilerletiyor.
    const r = await setup({ rail: { neverIncluded: true, advanceOnReconcile: 100_000 } }).run()
    expect(events).toContainEqual(expect.stringMatching(/failed:.*zaman asimina/))
    expect(r.paid).toBe(0)
  })
})

describe('zarf kurulamazsa', () => {
  it('hicbir kayit yazilmaz — aga zaten hicbir sey gitmedi', async () => {
    const r = await setup({ rail: { throwOnPrepare: true } }).run()
    expect(events).toHaveLength(0)
    expect(r.alerts).toContainEqual(expect.stringMatching(/hazirlanamadi/))
  })
})

describe('gonderim patlarsa', () => {
  /**
   * Zarf kuruldu, defter yazildi, sonra ag reddetti.
   *
   * Kayit SILINMEZ: hash elimizde, zincire sorulabilir. Hemen iade etmek,
   * "ag reddetti" iddiasi yanlissa cifte odeme uretirdi — karar zincirin.
   */
  it('kayit yazilmis kalir, karar zincire birakilir', async () => {
    const r = await setup({ rail: { throwOnSend: true } }).run()
    expect(events.some((e) => e.startsWith('submit:')), 'defter yazildi').toBe(true)
    expect(r.alerts).toContainEqual(expect.stringMatching(/gonderilemedi/))
  })
})

describe('cuzdan bagli degilse', () => {
  it('odeme denenmez', async () => {
    const job = setup({ candidates: [{ publisherId: 'bagli-degil', payable: micros(50_000_000n) }] })
    const r = await job.run()
    expect(r.skipped).toBe(1)
    expect(events[0]).toMatch(/cuzdan bagli degil/)
  })
})

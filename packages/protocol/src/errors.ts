/**
 * Hata taksonomisi.
 *
 * Kapali bir union; yeni kod eklemek bilincli bir karardir. CLI asla stack
 * trace basmaz — kullaniciya `BID-xxxx` kodu ve tek cumlelik aciklama gider.
 *
 * Kod araliklari:
 *   1xxx  istemci / kurulum
 *   2xxx  kimlik ve yetki
 *   3xxx  gosterim ingest
 *   4xxx  cuzdan ve adres
 *   5xxx  odeme ve ledger
 *   9xxx  sunucu / beklenmeyen
 */

export const ERROR_CODES = {
  // 1xxx — istemci
  BID_1001: 'Daemon calismiyor',
  BID_1002: 'Daemon soketine baglanilamadi',
  BID_1003: 'Claude Code settings.json bulunamadi',
  BID_1004: 'settings.json zaten baska bir statusLine iceriyor',
  BID_1005: 'Istemci surumu cok eski — guncelleme gerekli',
  BID_1006: 'Kurulum bozuk — `bide doctor` calistir',

  // 2xxx — kimlik
  BID_2001: 'Giris yapilmamis',
  BID_2002: 'Device token gecersiz veya iptal edilmis',
  BID_2003: 'Bu islem icin yetki yok',
  BID_2004: 'GitHub dogrulamasi tamamlanmadi',

  // 3xxx — gosterim
  BID_3001: 'Gosterim suresi esigin altinda',
  BID_3002: 'Nonce gecersiz veya suresi dolmus',
  BID_3003: 'Gosterim zaten kaydedilmis',
  BID_3004: 'Aktif kampanya yok',
  BID_3005: 'Render uzaktan kapatildi',

  // 4xxx — cuzdan
  BID_4001: 'Gecersiz NEAR hesabi',
  BID_4002: 'Hesap zincirde bulunamadi',
  BID_4003: 'Bu bir anahtar, hesap adi degil',
  BID_4004: 'Anahtar bu hesapta yok',
  BID_4005: 'Anahtar tam erisimli degil',
  BID_4006: 'Token kontratinin kendisi hedef olamaz',
  BID_4007: 'Bu adres baska bir hesaba bagli',
  BID_4008: 'Adres degisikligi bekleme suresinde',
  BID_4009: 'Desteklenmeyen adres tipi',
  BID_4010: 'Adres sahipligi dogrulanamadi',

  // 5xxx — odeme
  BID_5001: 'Bakiye odeme esiginin altinda',
  BID_5002: 'Odeme zaten islemde',
  BID_5003: 'Odeme gonderildi ama henuz onaylanmadi',
  BID_5004: 'Odeme basarisiz — ters kayit yazildi',
  BID_5005: 'Kampanya butcesi yetersiz',
  BID_5006: 'Ledger invariant ihlali',

  // 9xxx
  BID_9001: 'Sunucu hatasi',
  BID_9002: 'Hiz siniri asildi',
} as const

export type ErrorCode = keyof typeof ERROR_CODES

/** Tel uzerinden giden hata sekli. `v1` icinde bu sekil degismez. */
export interface ErrorEnvelope {
  readonly code: ErrorCode
  /** Kullaniciya gosterilecek tek cumle. */
  readonly message: string
  /** Kullanicinin ne yapmasi gerektigi. Varsa CLI bunu ikinci satira basar. */
  readonly hint?: string
  /** Yalnizca sunucu log'unda iz surmek icin. Kullaniciya gosterilmez. */
  readonly traceId?: string
}

export class BideError extends Error {
  override readonly name = 'BideError'
  readonly code: ErrorCode
  readonly hint: string | undefined
  readonly traceId: string | undefined

  constructor(code: ErrorCode, opts: { hint?: string; traceId?: string; cause?: unknown } = {}) {
    super(ERROR_CODES[code], opts.cause !== undefined ? { cause: opts.cause } : undefined)
    this.code = code
    this.hint = opts.hint
    this.traceId = opts.traceId
  }

  toEnvelope(): ErrorEnvelope {
    return {
      code: this.code,
      message: ERROR_CODES[this.code],
      ...(this.hint !== undefined ? { hint: this.hint } : {}),
      ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
    }
  }

  /** CLI ciktisi. Stack trace ASLA basilmaz. */
  toDisplayString(): string {
    return this.hint
      ? `${this.code}: ${this.message}\n  → ${this.hint}`
      : `${this.code}: ${this.message}`
  }
}

export const isErrorCode = (v: unknown): v is ErrorCode =>
  typeof v === 'string' && v in ERROR_CODES

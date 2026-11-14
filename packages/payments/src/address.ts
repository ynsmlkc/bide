/**
 * Hedef adres dogrulamasi — ADR-020.
 *
 * Zincir ustu odeme GERI ALINAMAZ. Yanlis hesaba giden para gitmistir.
 * Bu yuzden kontrollerin hepsi gecilmeden adres baglanmaz.
 *
 * Kontroller iki gruba ayriliyor:
 *   • Bicimsel — ag erisimi gerektirmez, aninda calisir
 *   • Zincir ustu — hesap var mi, token kontratinin kendisi mi, baska hesaba bagli mi
 */

export type AddressRejection =
  | 'gecersiz_bicim'
  | 'secret_key'
  | 'public_key'
  | 'hesap_yok'
  | 'token_kontrati'
  | 'baska_hesaba_bagli'

export interface AddressCheck {
  readonly ok: boolean
  readonly reason: AddressRejection | null
  /** Kullaniciya gosterilecek tek cumle. */
  readonly message: string | null
  /** Kullanicinin ne yapmasi gerektigi. */
  readonly hint: string | null
}

const OK: AddressCheck = { ok: true, reason: null, message: null, hint: null }
const fail = (reason: AddressRejection, message: string, hint?: string): AddressCheck =>
  ({ ok: false, reason, message, hint: hint ?? null })

/**
 * NEAR hesap kimligi kurali (nearcore `AccountId`):
 * 2-64 karakter, kucuk harf/rakam, ayiricilar `-` `_` `.`; ayirici ile
 * baslayamaz, bitemez, iki ayirici yan yana gelemez.
 * Implicit hesaplar (64 hex) ve ETH-implicit (`0x` + 40 hex) da bu kurala uyar.
 */
const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/

export function isValidAccountId(raw: string): boolean {
  return raw.length >= 2 && raw.length <= 64 && ACCOUNT_ID.test(raw)
}

/** Base58 alfabe — anahtar bicimlerini taniyabilmek icin. */
const B58 = /^[1-9A-HJ-NP-Za-km-z]+$/

/**
 * Bicimsel kontroller — ag erisimi YOK.
 *
 * Ayri durmasinin sebebi: kullanici adresi yazarken aninda geri bildirim
 * verebilmek ve zincire gereksiz sorgu atmamak.
 */
export function checkAddressFormat(raw: string): AddressCheck {
  const address = raw.trim()

  // EN ONEMLI KONTROL, EN BASTA.
  //
  // Kullanici kazara gizli anahtarini ya da kurtarma kelimelerini
  // yapistirabilir. Bu durumda:
  //   • hemen dur
  //   • degeri EKRANA BASMA
  //   • LOG'A YAZMA
  //   • hata mesajina KOYMA
  // Anahtar bir kez bir yere yazildiginda geri alinamaz.
  const body = address.replace(/^(ed25519|secp256k1):/, '')
  const looksLikeKey = /^(ed25519|secp256k1):/.test(address)
  if (looksLikeKey && B58.test(body) && body.length >= 80) {
    return fail('secret_key',
      'Bu bir GIZLI ANAHTAR. Adres degil.',
      'Ekrana veya bir dosyaya yapistirdiysan o anahtari ARTIK KULLANMA. ' +
      'Cuzdanindan anahtari dondur ve hesap adini gir (orn. alice.testnet).')
  }
  const words = address.split(/\s+/)
  if (words.length >= 12 && words.every((w) => /^[a-z]{3,8}$/.test(w))) {
    return fail('secret_key',
      'Bu bir KURTARMA IFADESI. Adres degil.',
      'Ekrana veya bir dosyaya yapistirdiysan o cuzdani ARTIK KULLANMA. ' +
      'Yeni bir cuzdan olustur ve hesap adini gir (orn. alice.testnet).')
  }

  if (looksLikeKey) {
    return fail('public_key',
      'Bu bir acik anahtar, hesap adi degil.',
      'Hesap adini gir (orn. alice.testnet ya da 64 karakterlik implicit hesap).')
  }

  if (!isValidAccountId(address)) {
    return fail('gecersiz_bicim',
      'Gecerli bir NEAR hesap adi degil.',
      'Kucuk harf, rakam, "-", "_" ve "." kullanilir; orn. alice.testnet.')
  }

  return OK
}

/** Zincirden okunan hesap durumu. `PaymentRail` doldurur. */
export interface OnChainAccount {
  readonly exists: boolean
}

export interface OnChainCheckInput {
  readonly address: string
  readonly account: OnChainAccount
  /** Odenen token kontrati. */
  readonly tokenContract: string
  /** Adres baska bir publisher'a bagli mi? */
  readonly boundToOther: boolean
}

/** Zincir ustu kontroller. */
export function checkAddressOnChain(input: OnChainCheckInput): AddressCheck {
  const { address, account } = input

  // Token kontratinin kendisine transfer, parayi kimsenin cekemeyecegi
  // bir yere kilitler.
  if (address === input.tokenContract) {
    return fail('token_kontrati',
      'Bu adres USDC kontratinin kendisi.',
      'Buraya gonderilen USDC kilitlenir. Kendi hesap adini gir.')
  }

  if (input.boundToOther) {
    // Ayni adresin N hesaba baglanabilmesi ADR-010'un sybil savunmasinda delik:
    // 500 hesap tek cuzdana odeme yapabilirdi.
    return fail('baska_hesaba_bagli',
      'Bu adres baska bir Bide hesabina bagli.',
      'Her adres yalnizca bir hesaba baglanabilir.')
  }

  if (!account.exists) {
    // Var olmayan isimli bir hesaba token kaydi yapilabilir ama o ismi
    // sonradan BASKASI alabilir. Yanlis yazilmis bir isme odeme yapilmaz.
    return fail('hesap_yok',
      'Bu hesap NEAR aginda bulunamadi.',
      'Hesap adini kontrol et; cuzdaninda gorunen adi aynen gir.')
  }

  return OK
}

/** Iki asamayi birlestirir. */
export function checkAddress(input: OnChainCheckInput): AddressCheck {
  const format = checkAddressFormat(input.address)
  return format.ok ? checkAddressOnChain(input) : format
}

/** Kullaniciya gosterilirken adresi kisalt. Isimli hesaplar zaten okunur; yalnizca uzunlar kisalir. */
export const shortAddress = (a: string): string =>
  a.length > 24 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a

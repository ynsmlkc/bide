import { describe, it, expect } from 'vitest'
import { KeyPair } from '@near-js/crypto'
import {
  checkAddressFormat, checkAddressOnChain, checkAddress, shortAddress, isValidAccountId,
} from '../src/address.js'

const ADDRESS = 'alice.testnet'
const TOKEN = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af'

const input = (over: Partial<Parameters<typeof checkAddressOnChain>[0]> = {}) => ({
  address: ADDRESS,
  account: { exists: true },
  tokenContract: TOKEN,
  boundToOther: false,
  ...over,
})

describe('bicimsel kontroller', () => {
  it('isimli hesap gecer', () => {
    expect(checkAddressFormat(ADDRESS).ok).toBe(true)
    expect(checkAddressFormat('bide-treasury.testnet').ok).toBe(true)
    expect(checkAddressFormat('a_b.c-d.near').ok).toBe(true)
  })

  it('implicit (64 hex) ve ETH-implicit hesap gecer', () => {
    expect(checkAddressFormat('a'.repeat(64)).ok).toBe(true)
    expect(checkAddressFormat('0x' + 'ab'.repeat(20)).ok).toBe(true)
  })

  it('bastaki/sondaki bosluk sorun degil', () => {
    expect(checkAddressFormat(`  ${ADDRESS}  `).ok).toBe(true)
  })

  it('GIZLI ANAHTAR yapistirilirsa durur ve degeri ifsa ETMEZ', () => {
    const secret = KeyPair.fromRandom('ed25519').toString()
    const r = checkAddressFormat(secret)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('secret_key')
    // Hata mesaji anahtarin kendisini ICERMEMELI — log'a, ekrana, hata
    // takip sistemine sizmasin.
    expect(r.message).not.toContain(secret)
    expect(r.hint).not.toContain(secret)
    expect(r.hint).toMatch(/ARTIK KULLANMA/)
  })

  it('KURTARMA IFADESI yapistirilirsa durur', () => {
    const phrase = 'abandon ability able about above absent absorb abstract absurd abuse access accident'
    const r = checkAddressFormat(phrase)
    expect(r.reason).toBe('secret_key')
    expect(r.message).not.toContain('abandon')
  })

  it('acik anahtar hesap adi yerine gecmez', () => {
    const pk = KeyPair.fromRandom('ed25519').getPublicKey().toString()
    const r = checkAddressFormat(pk)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('public_key')
  })

  it.each([
    ['buyuk harf', 'Alice.testnet'],
    ['ayiriciyla baslar', '-alice.testnet'],
    ['cift ayirici', 'alice..testnet'],
    ['tek karakter', 'a'],
    ['65 karakter', 'a'.repeat(65)],
    ['bosluk', 'alice testnet'],
    ['bos', ''],
  ])('%s reddedilir', (_, a) => {
    expect(checkAddressFormat(a).reason).toBe('gecersiz_bicim')
    expect(isValidAccountId(a)).toBe(false)
  })
})

describe('zincir ustu kontroller', () => {
  it('her sey yolundaysa gecer', () => {
    expect(checkAddressOnChain(input()).ok).toBe(true)
  })

  it('hesap yoksa reddedilir — yanlis yazilmis isme para gitmez', () => {
    const r = checkAddressOnChain(input({ account: { exists: false } }))
    expect(r.reason).toBe('hesap_yok')
    expect(r.hint).toBeTruthy()
  })

  it('token kontratinin kendisi reddedilir — para kilitlenirdi', () => {
    const r = checkAddressOnChain(input({ address: TOKEN }))
    expect(r.reason).toBe('token_kontrati')
  })

  it('baska hesaba bagli adres reddedilir — sybil savunmasi', () => {
    const r = checkAddressOnChain(input({ boundToOther: true }))
    expect(r.reason).toBe('baska_hesaba_bagli')
  })

  it('token kontrati kontrolu hesap kontrolunden ONCE — var olan kontrat hesabi da reddedilir', () => {
    const r = checkAddressOnChain(input({ address: TOKEN, account: { exists: true } }))
    expect(r.reason).toBe('token_kontrati')
  })
})

describe('checkAddress', () => {
  it('bicim hatasi zincir kontrolune hic gitmez', () => {
    const r = checkAddress(input({ address: 'NOPE', account: { exists: false } }))
    expect(r.reason).toBe('gecersiz_bicim')
  })

  it('bicim gecerse zincir kontrolu calisir', () => {
    expect(checkAddress(input({ account: { exists: false } })).reason).toBe('hesap_yok')
  })
})

describe('shortAddress', () => {
  it('okunur isimli hesap kisalmaz', () => {
    expect(shortAddress('alice.testnet')).toBe('alice.testnet')
  })
  it('implicit hesap kisalir', () => {
    expect(shortAddress('a'.repeat(64))).toBe('aaaaaa…aaaa')
  })
})

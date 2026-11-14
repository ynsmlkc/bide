/**
 * IPC — shim ile daemon arasindaki yerel protokol.
 */

import { describe, it, expect } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { socketPathFor, isNamedPipe, bideHome, encode, decode } from '../src/ipc.js'

describe('encode/decode', () => {
  it('gidis donus bozulmaz', () => {
    expect(decode(encode({ t: 'health' }))).toEqual({ t: 'health' })
  })

  /** Bozuk satiri atmak patlamaktan iyidir — bu yol her saniye kat ediliyor. */
  it('bozuk satir null doner, patlamaz', () => {
    expect(decode('{ yarim')).toBeNull()
  })
})

/**
 * Soket yolu uzunlugu.
 *
 * Gercek bir kurulumda bulundu: yol `sun_path` sinirini asinca `listen`
 * hata VERMIYOR, yolu sessizce kesiyor. Ardindan `chmod` beklenen yerde
 * dosya bulamayip ham bir `ENOENT` stack trace'i basiyor ve kullanici
 * neden kurulamadigini asla anlamiyor.
 */
describe('socketPathFor', () => {
  const LIMIT = process.platform === 'linux' ? 107 : 103

  it('normal ev dizininde alisildik yolu kullanir', () => {
    expect(socketPathFor('/Users/ali/.bide')).toBe('/Users/ali/.bide/bided.sock')
  })

  it('uzun yolda tmpdir altina duser ve SINIRIN ALTINDA kalir', () => {
    const uzun = `/Users/${'x'.repeat(140)}/.bide`
    const p = socketPathFor(uzun)

    expect(p).not.toContain('x'.repeat(140))
    expect(Buffer.byteLength(p)).toBeLessThanOrEqual(LIMIT)
    expect(p.endsWith('.sock')).toBe(true)
  })

  /**
   * DETERMINIZM sart. Shim ile daemon ayri sureclerdir ve ayni yolu bagimsiz
   * hesaplar; ayrisirlarsa shim bos doner ve hicbir reklam gorunmez.
   */
  it('ayni girdi HER ZAMAN ayni yolu verir', () => {
    const uzun = `/home/${'k'.repeat(140)}/.bide`
    expect(socketPathFor(uzun)).toBe(socketPathFor(uzun))
  })

  it('farkli ev dizinleri CAKISMAZ', () => {
    const a = socketPathFor(`/home/${'a'.repeat(140)}/.bide`)
    const b = socketPathFor(`/home/${'b'.repeat(140)}/.bide`)
    expect(a).not.toBe(b)
  })

  /** Sinir BYTE cinsinden: Turkce karakterler iki byte. */
  it('sinir karakter degil BYTE olarak olculur', () => {
    const turkce = `/Users/${'ş'.repeat(60)}/.bide`      // 60 karakter, 120 byte
    expect(turkce.length).toBeLessThan(LIMIT)
    expect(Buffer.byteLength(socketPathFor(turkce))).toBeLessThanOrEqual(LIMIT)
  })
})

/**
 * Windows: Node unix soket dosyasi dinleyemez, yerel IPC named pipe ile olur.
 * Gercek kurulumda bulundu — `bide init` her Windows makinesinde BID-1001
 * ile dusuyordu.
 */
describe('socketPathFor — Windows', () => {
  const win = (h: string) => socketPathFor(h, 'win32')

  it('named pipe verir, soket dosyasi DEGIL', () => {
    const p = win('C:\\Users\\90542\\.bide')
    expect(p.startsWith('\\\\.\\pipe\\bide-')).toBe(true)
    expect(isNamedPipe(p)).toBe(true)
  })

  /** Git Bash'ten gelen yol ile PowerShell'den gelen yol ayni pipe'a cikmali. */
  it('ayirac ve buyuk/kucuk harf farki AYNI pipe\'i verir', () => {
    expect(win('C:/Users/90542/.bide')).toBe(win('c:\\users\\90542\\.bide'))
  })

  it('farkli ev dizinleri CAKISMAZ', () => {
    expect(win('C:\\Users\\a\\.bide')).not.toBe(win('C:\\Users\\b\\.bide'))
  })

  it('unix yollari pipe sayilmaz', () => {
    expect(isNamedPipe('/Users/ali/.bide/bided.sock')).toBe(false)
    expect(isNamedPipe('C:\\Users\\a\\.bide\\bided.sock')).toBe(false)
  })
})

/** `HOME` Windows'ta tanimli degil; ev dizini ondan okunursa yol bozulur. */
describe('bideHome', () => {
  it('HOME olmadan da mutlak yol verir', () => {
    expect(bideHome({})).toBe(join(homedir(), '.bide'))
  })

  it('BIDE_HOME her seyi ezer', () => {
    expect(bideHome({ BIDE_HOME: '/tmp/x' })).toBe('/tmp/x')
  })
})

#!/usr/bin/env node
/**
 * Testnet'te bir reklamveren kurar: giris yapar, butce yatirir, kampanya acar.
 *
 * Amaci para kazanmak degil — testnet USDC'nin degeri yok. Amaci ZINCIRIN
 * KENDILIGINDEN donmesi: butce yatar, reklam gosterilir, kazanc deftere
 * yazilir, cekim zincire cikar.
 *
 * Reklamveren kimligi NEAR CLI anahtariyla gelir. Ayri bir cuzdan
 * uretmiyoruz: para GONDEREN HESABA gore eslesiyor (ADR-021), yani butceyi
 * yatiran hesap ile giris yapan hesap AYNI olmak zorunda.
 *
 *   node scripts/test-campaign.mjs <hesap.testnet>            # durumu goster
 *   node scripts/test-campaign.mjs <hesap.testnet> --apply    # gercekten kur
 *
 * Anahtar: ~/.near-credentials/testnet/<hesap>.json (NEAR CLI'nin standart yeri).
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../packages/cli/package.json', import.meta.url))
const { KeyPair } = require('@near-js/crypto')
const { KeyPairSigner } = require('@near-js/signers')
const req2 = createRequire(new URL('../packages/payments/package.json', import.meta.url))
const { actionCreators, createTransaction, encodeTransaction, SignedTransaction, Signature } = req2('@near-js/transactions')
const { baseDecode } = req2('@near-js/utils')

const API = process.env.BIDE_SERVER ?? 'https://bide-production.up.railway.app'
const RPC = process.env.BIDE_RPC ?? 'https://rpc.testnet.fastnear.com'
const UYGULA = process.argv.includes('--apply')
const HESAP = process.argv.slice(2).find((a) => !a.startsWith('--'))
if (!HESAP) { console.error('kullanim: node scripts/test-campaign.mjs <hesap.testnet> [--apply]'); process.exit(1) }

const cred = JSON.parse(readFileSync(join(homedir(), '.near-credentials', 'testnet', `${HESAP}.json`), 'utf8'))
const kp = KeyPair.fromString(cred.private_key)

const log = (...a) => console.log(...a)
const usd = (s) => '$' + (Number(BigInt(s)) / 1e6).toFixed(2)

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(data)}`)
  return data
}

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const j = await r.json()
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 300)}`)
  return j.result
}

async function view(contract, method, args) {
  const r = await rpc('query', {
    request_type: 'call_function', finality: 'final', account_id: contract, method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  })
  return JSON.parse(Buffer.from(r.result).toString() || 'null')
}

/**
 * NEP-413 girisi. Imzalanan sey bir islem DEGIL; on-eki geregi aga
 * gonderilemez. Bu imza para hareket ettiremez, yalnizca hesabin bize ait
 * oldugunu kanitlar.
 */
async function login(role) {
  const ch = await api('/v1/auth/challenge', { method: 'POST', body: {} })
  const s = await new KeyPairSigner(kp).signNep413Message(
    ch.message, HESAP, ch.recipient, new Uint8Array(Buffer.from(ch.nonce, 'base64')),
  )
  const { token } = await api('/v1/auth/verify', {
    method: 'POST',
    body: {
      accountId: HESAP, publicKey: s.publicKey.toString(),
      signature: Buffer.from(s.signature).toString('base64'), nonce: ch.nonce, role,
    },
  })
  return token
}

/** `ft_transfer_call` → treasury. Duz transfer DEGIL: treasury gondereni kaydeder. */
async function yatir(usdc, treasury, micros) {
  const pk = kp.getPublicKey().toString()
  const key = await rpc('query', { request_type: 'view_access_key', finality: 'optimistic', account_id: HESAP, public_key: pk })
  const tx = createTransaction(HESAP, kp.getPublicKey(), usdc, BigInt(key.nonce) + 1n, [
    actionCreators.functionCall('ft_transfer_call',
      { receiver_id: treasury, amount: String(micros), msg: '' }, 100_000_000_000_000n, 1n),
  ], baseDecode(key.block_hash))
  const hash = new Uint8Array(createHash('sha256').update(encodeTransaction(tx)).digest())
  const signed = new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: tx.publicKey.keyType, data: kp.sign(hash).signature }) })
  const r = await rpc('send_tx', { signed_tx_base64: Buffer.from(signed.encode()).toString('base64'), wait_until: 'FINAL' })
  if (r.status?.Failure) throw new Error(`islem basarisiz: ${JSON.stringify(r.status.Failure)}`)
  return r.transaction.hash
}

/* ──────────────────────────────────────────────────────────── */

const chain = await api('/v1/chain')
const bakiye = BigInt(await view(chain.usdc, 'ft_balance_of', { account_id: HESAP }) ?? '0')

log('\n  reklamveren  ' + HESAP)
log('  cuzdan       ' + usd(bakiye) + ' USDC\n')

const token = await login('advertiser')
const me = await api('/v1/advertiser/me', { token })

log('  sunucudaki bakiye   ' + usd(me.balanceMicros))
log('  harcanabilir        ' + usd(me.spendableMicros))
log('  kampanya sayisi     ' + me.campaigns.length)
log('  treasury            ' + (me.deposit?.address ?? '(kapali)'))

if (!UYGULA) {
  log('\n  (kuru calisma — gercekten kurmak icin --apply)\n')
  process.exit(0)
}

/* ── butce yatir ── */

// Cuzdandaki USDC'nin tamami, kurusa yuvarlanmis.
const yatirilacak = (bakiye / 10_000n) * 10_000n
if (yatirilacak > 0n) {
  log('\n  ' + usd(yatirilacak) + ' USDC yatiriliyor…')
  const hash = await yatir(chain.usdc, me.deposit.address, yatirilacak)
  log('  tx  ' + hash)

  // Sunucu treasury kaydini tariyor; kredi aninda gelmiyor.
  log('  defterde gorunmesi bekleniyor…')
  for (let i = 1; i <= 40; i++) {
    await new Promise((r) => setTimeout(r, 5000))
    const m = await api('/v1/advertiser/me', { token })
    if (BigInt(m.balanceMicros) > BigInt(me.balanceMicros)) {
      log('  ✓ yazildi — bakiye ' + usd(m.balanceMicros))
      break
    }
    if (i === 40) log('  ! 3 dakikada yazilmadi; sunucu loglarina bak')
  }
}

/* ── kampanya ── */

/**
 * Reklam metni. Bunun bir reklam OLDUGU ve testnet oldugu satirin kendisinde
 * yaziyor: statusline'da kaynagi belirsiz bir satir gostermek, reklami
 * icerik gibi sunmak olurdu.
 */
const kampanya = {
  brand: 'Bide',
  // Satir sinirinin 80 karakter oldugunu unutma: marka ve alan adi da
  // ayni satira giriyor, yalnizca bu metin degil.
  text: 'Test campaign — proving the payout loop on NEAR testnet',
  cta: 'near.org',
  // CPM = bin gosterim basina. 5 USDC/1000 → gosterim basina 0,005 USDC,
  // yarisi yayinciya: 0,0025 USDC.
  bidCpmMicros: String(5n * 1_000_000n),
}

const c = await api('/v1/advertiser/campaigns', { method: 'POST', token, body: kampanya })
log('\n  ✓ kampanya acildi  ' + c.id)
log('    ' + kampanya.brand + ' — ' + kampanya.text)
log('    teklif  ' + usd(kampanya.bidCpmMicros) + ' / 1000 gosterim\n')

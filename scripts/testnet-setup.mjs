#!/usr/bin/env node
/**
 * Bide treasury'yi NEAR testnet'te kurar.
 *
 *   node scripts/testnet-setup.mjs [hesap-adi.testnet]
 *
 * Yaptiklari:
 *   1. Yeni bir anahtar uretir ve testnet faucet servisiyle hesabi acar
 *      (hesap adi verilmezse `bide-treasury-<rastgele>.testnet`).
 *   2. Anahtari NEAR CLI'nin standart yerine yazar:
 *      ~/.near-credentials/testnet/<hesap>.json  (izin 600)
 *   3. `contracts/treasury` wasm'ini o hesaba deploy eder ve `new(token)`
 *      ile baslatir — ayni islemde.
 *   4. Hesabi USDC kontratina kaydeder (`storage_deposit`), yoksa USDC alamaz.
 *
 * Sonunda sunucu icin gereken ortam degiskenlerini yazdirir. Gizli anahtar
 * EKRANA BASILMAZ; dosyanin yolunu soyler.
 *
 * Once kontrati derle:  (cd contracts/treasury && cargo near build non-reproducible-wasm)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../packages/payments/package.json', import.meta.url))
const { KeyPair } = require('@near-js/crypto')
const {
  actionCreators, createTransaction, encodeTransaction, SignedTransaction, Signature,
} = require('@near-js/transactions')
const { baseDecode } = require('@near-js/utils')

const RPC = process.env.BIDE_RPC ?? 'https://rpc.testnet.fastnear.com'
const USDC = process.env.BIDE_USDC_CONTRACT ?? '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WASM = join(ROOT, 'contracts/treasury/target/near/bide_treasury.wasm')

const account = process.argv[2] ?? `bide-treasury-${randomBytes(3).toString('hex')}.testnet`
if (!/^[a-z0-9_-]+\.testnet$/.test(account)) {
  console.error('hesap adi `<ad>.testnet` bicminde olmali')
  process.exit(1)
}
if (!existsSync(WASM)) {
  console.error(`wasm yok: ${WASM}\nonce: (cd contracts/treasury && cargo near build non-reproducible-wasm)`)
  process.exit(1)
}

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const j = await r.json()
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 400)}`)
  return j.result
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ── 1. hesap ── */

const credPath = join(homedir(), '.near-credentials', 'testnet', `${account}.json`)
let kp
if (existsSync(credPath)) {
  kp = KeyPair.fromString(JSON.parse(readFileSync(credPath, 'utf8')).private_key)
  console.log(`✓ mevcut anahtar kullaniliyor: ${credPath}`)
} else {
  kp = KeyPair.fromRandom('ed25519')
  const res = await fetch('https://helper.testnet.near.org/account', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newAccountId: account, newAccountPublicKey: kp.getPublicKey().toString() }),
  })
  if (!res.ok) {
    console.error(`faucet hesabi acamadi (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`)
    console.error('alternatif: https://near-faucet.io ya da NEAR CLI `near account create-account sponsor-by-faucet-service`')
    process.exit(1)
  }
  mkdirSync(dirname(credPath), { recursive: true })
  writeFileSync(credPath, JSON.stringify({
    account_id: account,
    public_key: kp.getPublicKey().toString(),
    private_key: kp.toString(),
  }, null, 2), { mode: 0o600 })
  console.log(`✓ hesap acildi: ${account}`)
  console.log(`  anahtar: ${credPath}`)
  // Hesabin zincirde gorunmesini bekle.
  for (let i = 0; i < 20; i++) {
    try { await rpc('query', { request_type: 'view_account', finality: 'final', account_id: account }); break }
    catch { await sleep(1500) }
  }
}

/* ── islem gonderici ── */

async function send(receiverId, actions) {
  const pk = kp.getPublicKey().toString()
  const key = await rpc('query', { request_type: 'view_access_key', finality: 'optimistic', account_id: account, public_key: pk })
  const tx = createTransaction(account, kp.getPublicKey(), receiverId, BigInt(key.nonce) + 1n, actions, baseDecode(key.block_hash))
  const hash = new Uint8Array(createHash('sha256').update(encodeTransaction(tx)).digest())
  const signed = new SignedTransaction({
    transaction: tx,
    signature: new Signature({ keyType: tx.publicKey.keyType, data: kp.sign(hash).signature }),
  })
  const r = await rpc('send_tx', { signed_tx_base64: Buffer.from(signed.encode()).toString('base64'), wait_until: 'FINAL' })
  if (r.status?.Failure) throw new Error(`islem basarisiz: ${JSON.stringify(r.status.Failure).slice(0, 400)}`)
  return r.transaction.hash
}

/* ── 2. deploy + init ── */

let initialized = false
try {
  const r = await rpc('query', {
    request_type: 'call_function', finality: 'final', account_id: account,
    method_name: 'token', args_base64: Buffer.from('{}').toString('base64'),
  })
  initialized = JSON.parse(Buffer.from(r.result).toString()) === USDC
} catch { /* kontrat yok */ }

if (initialized) {
  console.log('✓ treasury zaten kurulu')
} else {
  const h = await send(account, [
    actionCreators.deployContract(new Uint8Array(readFileSync(WASM))),
    actionCreators.functionCall('new', { token: USDC }, 30_000_000_000_000n, 0n),
  ])
  console.log(`✓ treasury deploy edildi ve baslatildi — tx ${h}`)
}

/* ── 3. USDC kaydi ── */

const reg = await rpc('query', {
  request_type: 'call_function', finality: 'final', account_id: USDC,
  method_name: 'storage_balance_of', args_base64: Buffer.from(JSON.stringify({ account_id: account })).toString('base64'),
})
if (JSON.parse(Buffer.from(reg.result).toString() || 'null') === null) {
  const h = await send(USDC, [
    actionCreators.functionCall('storage_deposit', { account_id: account, registration_only: true },
      10_000_000_000_000n, 1_250_000_000_000_000_000_000n),
  ])
  console.log(`✓ USDC kontratina kayit — tx ${h}`)
} else {
  console.log('✓ USDC kaydi zaten var')
}

console.log(`
Sunucu ortam degiskenleri:

  BIDE_NETWORK=testnet
  BIDE_TREASURY_ACCOUNT=${account}
  BIDE_TREASURY_KEY=<${credPath} icindeki private_key>

Treasury'ye test USDC'si: https://faucet.circle.com  (NEAR Testnet, adres: ${account})
Gezgin: https://testnet.nearblocks.io/address/${account}
`)

#!/usr/bin/env node
/**
 * NEAR testnet'te uctan uca: giris → yatirma → cekim, gercek USDC ile.
 *
 *   node scripts/testnet-e2e.mjs <treasury.testnet>
 *
 * Onkosul: `node scripts/testnet-setup.mjs` calismis ve treasury'de USDC var.
 *
 * Adimlar:
 *   1. Treasury altinda bir reklamveren test hesabi acar (`adv.<treasury>`),
 *      2 NEAR ve 5 USDC gonderir. Anahtar ~/.near-credentials'a yazilir.
 *   2. Bide sunucusunu bu treasury ile yerelde baslatir (bellekte, gecici).
 *   3. Reklamveren NEP-413 ile giris yapar.
 *   4. 3 USDC'yi `ft_transfer_call` ile treasury'ye yatirir; treasury
 *      kontrati gondereni kaydeder, sunucu kayittan okuyup deftere yazar.
 *   5. Reklamveren 2 USDC ceker: sunucu NearRail ile gercek bir
 *      `ft_transfer` gonderir ve zincirden kesinlesmesini bekler.
 *
 * Her islemin NearBlocks baglantisi yazdirilir.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const req = createRequire(join(ROOT, 'packages/cli/package.json'))
const { KeyPair } = req('@near-js/crypto')
const { KeyPairSigner } = req('@near-js/signers')
const req2 = createRequire(join(ROOT, 'packages/payments/package.json'))
const { actionCreators, createTransaction, encodeTransaction, SignedTransaction, Signature } = req2('@near-js/transactions')
const { baseDecode } = req2('@near-js/utils')

const RPC = process.env.BIDE_RPC ?? 'https://rpc.testnet.fastnear.com'
const USDC = process.env.BIDE_USDC_CONTRACT ?? '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af'
const T = process.argv[2]
if (!T) { console.error('kullanim: node scripts/testnet-e2e.mjs <treasury.testnet>'); process.exit(1) }
const ADV = `adv.${T}`
const PORT = 8798
const API = `http://127.0.0.1:${PORT}`
const TX = (h) => `https://testnet.nearblocks.io/txns/${h}`
const dir = join(homedir(), '.near-credentials', 'testnet')
const keyOf = (acc) => KeyPair.fromString(JSON.parse(readFileSync(join(dir, `${acc}.json`), 'utf8')).private_key)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const usd = (m) => `$${(Number(m) / 1e6).toFixed(2)}`

/* ── zincir ── */

async function rpc(method, params) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(RPC, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000),
      })
      const j = await r.json()
      if (j.error) throw Object.assign(new Error(`${method}: ${JSON.stringify(j.error).slice(0, 400)}`), { rpc: true })
      return j.result
    } catch (e) {
      if (e.rpc || i >= 5) throw e
      await sleep(3000)               // ag gidip geliyor; tekrar dene
    }
  }
}

async function send(signer, kp, receiverId, actions) {
  const key = await rpc('query', { request_type: 'view_access_key', finality: 'optimistic', account_id: signer, public_key: kp.getPublicKey().toString() })
  const tx = createTransaction(signer, kp.getPublicKey(), receiverId, BigInt(key.nonce) + 1n, actions, baseDecode(key.block_hash))
  const h = new Uint8Array(createHash('sha256').update(encodeTransaction(tx)).digest())
  const st = new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: tx.publicKey.keyType, data: kp.sign(h).signature }) })
  const r = await rpc('send_tx', { signed_tx_base64: Buffer.from(st.encode()).toString('base64'), wait_until: 'FINAL' })
  if (r.status?.Failure) throw new Error(`islem basarisiz: ${JSON.stringify(r.status.Failure)}`)
  return r.transaction.hash
}

async function balance(acc) {
  const r = await rpc('query', {
    request_type: 'call_function', finality: 'final', account_id: USDC, method_name: 'ft_balance_of',
    args_base64: Buffer.from(JSON.stringify({ account_id: acc })).toString('base64'),
  })
  return BigInt(JSON.parse(Buffer.from(r.result).toString()))
}

/* ── 1. test hesabi ── */

const tkp = keyOf(T)
if (!existsSync(join(dir, `${ADV}.json`))) {
  const kp = KeyPair.fromRandom('ed25519')
  writeFileSync(join(dir, `${ADV}.json`), JSON.stringify({ account_id: ADV, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }, null, 2), { mode: 0o600 })
  const h = await send(T, tkp, ADV, [
    actionCreators.createAccount(),
    actionCreators.transfer(2_000_000_000_000_000_000_000_000n),
    actionCreators.addKey(kp.getPublicKey(), actionCreators.fullAccessKey()),
  ])
  console.log(`1. test hesabi acildi: ${ADV}\n   ${TX(h)}`)
} else {
  console.log(`1. test hesabi mevcut: ${ADV}`)
}
if ((await balance(ADV)) < 3_000_000n) {
  const h = await send(T, tkp, USDC, [
    actionCreators.functionCall('storage_deposit', { account_id: ADV, registration_only: true }, 10_000_000_000_000n, 1_250_000_000_000_000_000_000n),
    actionCreators.functionCall('ft_transfer', { receiver_id: ADV, amount: '5000000' }, 10_000_000_000_000n, 1n),
  ])
  console.log(`   5 USDC gonderildi: ${TX(h)}`)
}
const advKp = keyOf(ADV)

/* ── 2. sunucu ── */

const server = spawn(process.execPath, [join(ROOT, 'packages/server/dist/server.mjs')], {
  env: {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1',
    BIDE_NETWORK: 'testnet', BIDE_RPC: RPC, BIDE_USDC_CONTRACT: USDC,
    BIDE_TREASURY_ACCOUNT: T, BIDE_TREASURY_KEY: tkp.toString(),
    BIDE_DEPOSIT_INTERVAL_MS: '4000', BIDE_ACCESS_LOG: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const logs = []
server.stdout.on('data', (d) => logs.push(String(d)))
server.stderr.on('data', (d) => logs.push(String(d)))
const stop = () => { try { server.kill() } catch {} }
process.on('exit', stop)

async function api(path, { method = 'GET', body, token } = {}) {
  const r = await fetch(API + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const d = await r.json().catch(() => null)
  if (!r.ok) throw new Error(`${path} → ${r.status} ${JSON.stringify(d)}`)
  return d
}

for (let i = 0; i < 40; i++) {
  try { await api('/health'); break } catch { await sleep(500) }
  if (i === 39) { console.error(logs.join('')); throw new Error('sunucu acilmadi') }
}
console.log(`2. sunucu acik: ${API} (treasury ${T})`)

try {
  /* ── 3. giris ── */
  const ch = await api('/v1/auth/challenge', { method: 'POST', body: {} })
  const s = await new KeyPairSigner(advKp).signNep413Message(ch.message, ADV, ch.recipient, new Uint8Array(Buffer.from(ch.nonce, 'base64')))
  const { token } = await api('/v1/auth/verify', {
    method: 'POST',
    body: { accountId: ADV, publicKey: s.publicKey.toString(), signature: Buffer.from(s.signature).toString('base64'), nonce: ch.nonce, role: 'advertiser' },
  })
  console.log(`3. NEP-413 giris basarili: ${ADV}`)

  /* ── 4. yatirma ── */
  const before = BigInt((await api('/v1/advertiser/me', { token })).balanceMicros)
  const dh = await send(ADV, advKp, USDC, [
    actionCreators.functionCall('ft_transfer_call', { receiver_id: T, amount: '3000000', msg: '' }, 100_000_000_000_000n, 1n),
  ])
  console.log(`4. 3 USDC ft_transfer_call ile yatirildi: ${TX(dh)}`)
  let credited = before
  for (let i = 0; i < 30 && credited === before; i++) {
    await sleep(4000)
    credited = BigInt((await api('/v1/advertiser/me', { token })).balanceMicros)
  }
  if (credited === before) throw new Error('yatirma deftere yazilmadi')
  console.log(`   treasury kaydi okundu, sunucu bakiyesi ${usd(before)} → ${usd(credited)}`)

  /* ── 5. cekim ── */
  const walletBefore = await balance(ADV)
  const w = await api('/v1/advertiser/withdraw', { method: 'POST', token, body: { amountMicros: '2000000' } })
  console.log(`5. 2 USDC cekim — durum: ${w.state ?? 'gonderildi'}\n   ${TX(w.txHash)}`)
  let walletAfter = walletBefore
  for (let i = 0; i < 20 && walletAfter === walletBefore; i++) { await sleep(3000); walletAfter = await balance(ADV) }
  console.log(`   cuzdan USDC ${usd(walletBefore)} → ${usd(walletAfter)}`)
  console.log(walletAfter - walletBefore === 2_000_000n ? '\n✓ uctan uca basarili' : '\n! cekim zincirde henuz gorunmedi — sunucu loglarina bak')
} catch (e) {
  console.error('\n✗', e.message)
  console.error('--- sunucu logu ---\n' + logs.join('').split('\n').filter((l) => !l.startsWith('{')).slice(-30).join('\n'))
  process.exitCode = 1
} finally {
  stop()
}

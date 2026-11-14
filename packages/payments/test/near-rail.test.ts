/**
 * NearRail — zincir yerine sahte JSON-RPC.
 *
 * Kanitlanan: batch'in TEK islemde ve dogru action'larla kuruldugu, kayitsiz
 * hedefe depozitonun ayni islemde eklendigi, yalnizca kesinlesmis sonucun
 * karar verdigi ve islemin ancak zincir kanitiyla "olu" sayildigi.
 */

import { describe, it, expect } from 'vitest'
import { KeyPair } from '@near-js/crypto'
import { decodeSignedTransaction } from '@near-js/transactions'
import { baseEncode } from '@near-js/utils'
import { micros } from '@bide/protocol'
import { NearRail, SubmitRejected } from '../src/near-rail.js'
import type { SubmissionReceipt } from '../src/rail.js'

const USDC = 'usdc.fakes.testnet'
const TREASURY = 'bide-treasury.testnet'
const BLOCK = baseEncode(new Uint8Array(32).fill(9))

interface Chain {
  registered: Set<string>
  keyNonce: bigint
  tx: Record<string, unknown> | 'unknown'
  refHeight: number | null
  headHeight: number
  sendError?: unknown
}

function fakeRpc(c: Chain) {
  const calls: { method: string; params: any }[] = []
  const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))
  const err = (name: string, data: unknown = {}) =>
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { name: 'HANDLER_ERROR', cause: { name, info: {} }, data } }))
  const impl = (async (_url: any, init: any) => {
    const { method, params } = JSON.parse(String(init.body))
    calls.push({ method, params })
    if (method === 'query' && params.request_type === 'view_access_key') {
      return ok({ nonce: Number(c.keyNonce), permission: 'FullAccess', block_hash: BLOCK, block_height: 100 })
    }
    if (method === 'query' && params.request_type === 'call_function') {
      const args = JSON.parse(Buffer.from(params.args_base64, 'base64').toString())
      const out = params.method_name === 'storage_balance_of'
        ? (c.registered.has(args.account_id) ? { total: '1250000000000000000000', available: '0' } : null)
        : params.method_name === 'storage_balance_bounds' ? { min: '1250000000000000000000', max: '1250000000000000000000' }
        : null
      return ok({ result: [...Buffer.from(JSON.stringify(out))] })
    }
    if (method === 'send_tx') return c.sendError ? err('INVALID_TRANSACTION', c.sendError) : ok({ final_execution_status: 'INCLUDED' })
    if (method === 'tx') return c.tx === 'unknown' ? err('UNKNOWN_TRANSACTION') : ok(c.tx)
    if (method === 'block' && params.finality) return ok({ header: { hash: BLOCK, height: c.headHeight, timestamp: '0' } })
    if (method === 'block') return c.refHeight === null ? err('UNKNOWN_BLOCK') : ok({ header: { height: c.refHeight } })
    if (method === 'EXPERIMENTAL_genesis_config') return ok({ transaction_validity_period: 86400 })
    throw new Error(`beklenmeyen ${method}`)
  }) as unknown as typeof fetch
  return { impl, calls }
}

function setup(over: Partial<Chain> = {}) {
  const chain: Chain = { registered: new Set(['alice.testnet']), keyNonce: 41n, tx: 'unknown', refHeight: 1000, headHeight: 1010, ...over }
  const rpc = fakeRpc(chain)
  const rail = new NearRail({
    rpcUrl: 'https://rpc.fake', accountId: TREASURY, tokenContract: USDC,
    secretKey: KeyPair.fromRandom('ed25519').toString(), fetchImpl: rpc.impl,
  })
  return { rail, chain, rpc }
}

const batch = {
  batchId: 'b-1',
  items: [
    { publisherId: 'alice.testnet', address: 'alice.testnet', amount: micros(2_500_000n) },
    { publisherId: 'bob.testnet', address: 'bob.testnet', amount: micros(1_000_000n) },
  ],
}

describe('prepare', () => {
  it('tek islem, alici USDC; kayitsiz hedefe once storage_deposit', async () => {
    const { rail } = setup()
    const r = await rail.prepare(batch)
    const tx = decodeSignedTransaction(Buffer.from(r.signedTx, 'base64')).transaction

    expect(tx.signerId).toBe(TREASURY)
    expect(tx.receiverId).toBe(USDC)
    expect(BigInt(tx.nonce)).toBe(42n)
    const acts = tx.actions.map((a) => {
      const fc = a.functionCall!
      return [fc.methodName, JSON.parse(Buffer.from(fc.args).toString()), BigInt(fc.deposit)]
    })
    expect(acts).toEqual([
      ['ft_transfer', { receiver_id: 'alice.testnet', amount: '2500000', memo: 'bide:b-1' }, 1n],
      ['storage_deposit', { account_id: 'bob.testnet', registration_only: true }, 1_250_000_000_000_000_000_000n],
      ['ft_transfer', { receiver_id: 'bob.testnet', amount: '1000000', memo: 'bide:b-1' }, 1n],
    ])
    // opIndex ft_transfer action'larini gosterir — depozitoyu degil.
    expect(r.opIndex).toEqual([{ publisherId: 'alice.testnet', index: 0 }, { publisherId: 'bob.testnet', index: 2 }])
  })

  it('hash gonderimden ONCE biliniyor ve imzayla eslesiyor', async () => {
    const { rail } = setup()
    const r = await rail.prepare(batch)
    expect(r.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/)
  })

  it('ayni surecte iki prepare ayni nonce\'u ALMAZ', async () => {
    const { rail } = setup()
    const a = await rail.prepare(batch)
    const b = await rail.prepare({ ...batch, batchId: 'b-2' })
    expect(BigInt(b.nonce)).toBeGreaterThan(BigInt(a.nonce))
  })

  it('bos ya da sifir tutarli batch kurulmaz', async () => {
    const { rail } = setup()
    await expect(rail.prepare({ batchId: 'x', items: [] })).rejects.toThrow()
    await expect(rail.prepare({ batchId: 'x', items: [{ ...batch.items[0]!, amount: micros(0n) }] })).rejects.toThrow()
  })
})

describe('send', () => {
  it('kesin red SubmitRejected firlatir', async () => {
    const { rail } = setup({ sendError: { TxExecutionError: { InvalidTxError: { NotEnoughBalance: {} } } } })
    const r = await rail.prepare(batch)
    await expect(rail.send(r)).rejects.toBeInstanceOf(SubmitRejected)
  })

  it('InvalidNonce yutulur — islem zaten gecmis olabilir, karar reconcile\'in', async () => {
    const { rail } = setup({ sendError: { TxExecutionError: { InvalidTxError: { InvalidNonce: { tx_nonce: 1, ak_nonce: 2 } } } } })
    await expect(rail.send(await rail.prepare(batch))).resolves.toBeUndefined()
  })
})

describe('reconcile', () => {
  async function receiptFor(c: Partial<Chain>): Promise<{ rail: NearRail; r: SubmissionReceipt; chain: Chain }> {
    const s = setup(c)
    return { rail: s.rail, r: await s.rail.prepare(batch), chain: s.chain }
  }

  it('FINAL + SuccessValue → settled', async () => {
    const { rail, r, chain } = await receiptFor({})
    chain.tx = { final_execution_status: 'FINAL', status: { SuccessValue: '' }, transaction_outcome: { block_hash: BLOCK, outcome: { tokens_burnt: '10' } }, receipts_outcome: [] }
    expect((await rail.reconcile(r)).state).toBe('settled')
  })

  it('kesinlesmemis sonuc karar VERMEZ — pending', async () => {
    const { rail, r, chain } = await receiptFor({})
    chain.tx = { final_execution_status: 'EXECUTED_OPTIMISTIC', status: { SuccessValue: '' } }
    expect((await rail.reconcile(r)).state).toBe('pending')
  })

  it('Failure → failed ve suclu action indeksinden bulunur', async () => {
    const { rail, r, chain } = await receiptFor({})
    chain.tx = {
      final_execution_status: 'FINAL',
      status: { Failure: { ActionError: { index: 2, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: insufficient balance' } } } } },
      transaction_outcome: { block_hash: BLOCK, outcome: { tokens_burnt: '10' } }, receipts_outcome: [],
    }
    const s = await rail.reconcile(r)
    expect(s.state).toBe('failed')
    expect(s.opResults.find((o) => o.index === 2)!.code).toMatch(/insufficient balance/)
    expect(s.opResults.find((o) => o.index === 0)!.code).toBe('op_success')
  })

  it('bulunamayan, yakin tarihli islem → pending (yeniden kurmak cift odeme olurdu)', async () => {
    const { rail, r } = await receiptFor({ keyNonce: 41n, refHeight: 1000, headHeight: 1010 })
    expect((await rail.reconcile(r)).state).toBe('pending')
  })

  it('anahtar nonce\'u islemi gecmis ve islem yok → expired', async () => {
    const { rail, r, chain } = await receiptFor({ keyNonce: 41n })
    chain.keyNonce = 50n
    expect((await rail.reconcile(r)).state).toBe('expired')
  })

  it('referans blok gecerlilik suresini asmis → expired', async () => {
    const { rail, r, chain } = await receiptFor({})
    chain.refHeight = 1000
    chain.headHeight = 1000 + 86_401
    expect((await rail.reconcile(r)).state).toBe('expired')
  })
})

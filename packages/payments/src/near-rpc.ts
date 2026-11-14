/**
 * NEAR JSON-RPC — ince bir sarmalayici.
 *
 * Bilincli olarak kucuk: yalnizca kullandigimiz uc noktalar var. Her hata
 * `RpcError` olarak firlatilir ve `name`/`cause` alanlari KORUNUR, cunku
 * "islem bulunamadi" ile "dugum cevap vermedi" arasindaki fark para
 * kararlarini degistiriyor (bkz. `near-rail.ts`).
 */

export class RpcError extends Error {
  constructor(
    message: string,
    /** RPC hata turu, orn. `HANDLER_ERROR`, `REQUEST_VALIDATION_ERROR`. */
    readonly kind: string | null,
    /** `cause.name`, orn. `UNKNOWN_TRANSACTION`, `UNKNOWN_ACCOUNT`, `INVALID_TRANSACTION`. */
    readonly causeName: string | null,
    /** Ham `data`/`cause.info` — teshis icin. */
    readonly data: unknown,
    /** HTTP veya ag seviyesinde mi patladi? O zaman sonuc BELIRSIZDIR. */
    readonly transport: boolean,
  ) {
    super(message)
    this.name = 'RpcError'
  }
}

export interface NearRpcOptions {
  readonly url: string
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
}

export interface AccessKeyView {
  readonly nonce: bigint
  readonly permission: 'FullAccess' | { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } }
  readonly blockHash: string
  readonly blockHeight: number
}

export interface AccountView {
  readonly amount: bigint
  readonly locked: bigint
  readonly storageUsage: bigint
}

export class NearRpc {
  #id = 0
  constructor(private readonly opts: NearRpcOptions) {}

  get url(): string { return this.opts.url }

  async call<T = any>(method: string, params: unknown): Promise<T> {
    const f = this.opts.fetchImpl ?? fetch
    let res: Response
    try {
      res = await f(this.opts.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.#id, method, params }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
      })
    } catch (e) {
      throw new RpcError(`rpc ${method}: ${e instanceof Error ? e.message : String(e)}`, null, null, null, true)
    }
    if (!res.ok) {
      throw new RpcError(`rpc ${method}: HTTP ${res.status}`, null, null, null, true)
    }
    const body = (await res.json()) as { result?: T; error?: any }
    if (body.error) {
      const e = body.error
      // Ayrinti bazen `cause.info`'da, bazen (bos `info` ile) `data`'da geliyor.
      const info = e.cause?.info
      const detail = info && typeof info === 'object' && Object.keys(info).length > 0 ? info : (e.data ?? info ?? null)
      throw new RpcError(
        `rpc ${method}: ${e.cause?.name ?? e.name ?? 'hata'} ${JSON.stringify(detail ?? '').slice(0, 300)}`,
        e.name ?? null, e.cause?.name ?? null, detail, false,
      )
    }
    // `query` bazi hatalari `result.error` icinde dondurur (eski bicim).
    const r = body.result as any
    if (r && typeof r === 'object' && typeof r.error === 'string') {
      const name = /does not exist/.test(r.error) ? 'UNKNOWN_ACCOUNT' : 'QUERY_ERROR'
      throw new RpcError(`rpc ${method}: ${r.error}`, 'HANDLER_ERROR', name, r.error, false)
    }
    return body.result as T
  }

  /** Salt okunur kontrat cagrisi. Argumanlar ve sonuc JSON. */
  async view<T = unknown>(contract: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
    const r = await this.call<{ result: number[] }>('query', {
      request_type: 'call_function',
      finality: 'final',
      account_id: contract,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    })
    const text = Buffer.from(r.result).toString('utf8')
    return (text === '' ? null : JSON.parse(text)) as T
  }

  /** Hesap yoksa `null`. Diger hatalar YUKARI atilir — "dugum dustu" hesap yok demek degil. */
  async account(accountId: string): Promise<AccountView | null> {
    try {
      const r = await this.call<any>('query', { request_type: 'view_account', finality: 'final', account_id: accountId })
      return { amount: BigInt(r.amount), locked: BigInt(r.locked), storageUsage: BigInt(r.storage_usage) }
    } catch (e) {
      if (isUnknownAccount(e)) return null
      throw e
    }
  }

  /** Anahtar bu hesapta yoksa `null`. */
  async accessKey(accountId: string, publicKey: string, finality: 'final' | 'optimistic' = 'final'): Promise<AccessKeyView | null> {
    try {
      const r = await this.call<any>('query', {
        request_type: 'view_access_key', finality, account_id: accountId, public_key: publicKey,
      })
      return { nonce: BigInt(r.nonce), permission: r.permission, blockHash: r.block_hash, blockHeight: r.block_height }
    } catch (e) {
      if (isUnknownAccount(e) || (e instanceof RpcError && e.causeName === 'UNKNOWN_ACCESS_KEY')) return null
      if (e instanceof RpcError && typeof e.data === 'string' && /access key .* does not exist/i.test(e.data)) return null
      throw e
    }
  }

  async finalBlock(): Promise<{ hash: string; height: number; timestampMs: number }> {
    const r = await this.call<any>('block', { finality: 'final' })
    return { hash: r.header.hash, height: r.header.height, timestampMs: Math.floor(Number(r.header.timestamp) / 1e6) }
  }

  /** Blok GC'lenmisse ya da hic yoksa `null`. */
  async blockByHash(hash: string): Promise<{ height: number } | null> {
    try {
      const r = await this.call<any>('block', { block_id: hash })
      return { height: r.header.height }
    } catch (e) {
      if (e instanceof RpcError && (e.causeName === 'UNKNOWN_BLOCK' || e.causeName === 'GARBAGE_COLLECTED_BLOCK')) return null
      throw e
    }
  }
}

export const isUnknownAccount = (e: unknown): boolean =>
  e instanceof RpcError && e.causeName === 'UNKNOWN_ACCOUNT'

export const RPC = {
  testnet: 'https://rpc.testnet.fastnear.com',
  mainnet: 'https://rpc.mainnet.fastnear.com',
} as const

/** Circle'in NEAR uzerindeki yerel USDC'si (NEP-141, 6 ondalik). */
export const USDC_CONTRACT = {
  testnet: '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af',
  mainnet: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
} as const

export const EXPLORER = {
  testnet: 'https://testnet.nearblocks.io',
  mainnet: 'https://nearblocks.io',
} as const

/**
 * Tarayici cuzdan koprusu — `window.BideWallet`.
 *
 * NEAR Wallet Selector'in ince bir sarmalayicisi. Hem sitenin panelleri hem
 * `bide login`'in yerel sayfasi bunu kullanir; esbuild ile `public/wallet.js`
 * olarak paketlenir ve sitenin KENDI adresinden servis edilir — sayfalar
 * calisma aninda ucuncu taraf bir CDN'den script yuklemez.
 *
 * Bilincli olarak modal kutuphanesi YOK: cuzdan listesi sayfanin kendi
 * dugmeleri. Hem paket kucuk kaliyor hem sayfalar kendi gorunumunu koruyor.
 *
 * Ozel anahtar bu koda HIC girmez. Imzayi cuzdan atar; biz yalnizca imzali
 * mesaji (NEP-413) ya da cuzdanin gonderdigi islemin sonucunu aliriz.
 */

import { setupWalletSelector, type WalletSelector, type Wallet } from '@near-wallet-selector/core'
import { setupMeteorWallet } from '@near-wallet-selector/meteor-wallet'
import { setupHotWallet } from '@near-wallet-selector/hot-wallet'
import { setupIntearWallet } from '@near-wallet-selector/intear-wallet'
import { setupSender } from '@near-wallet-selector/sender'

type Network = 'testnet' | 'mainnet'

export interface WalletInfo {
  readonly id: string
  readonly name: string
  readonly iconUrl: string
  readonly available: boolean
  readonly signMessage: boolean
}

let selector: WalletSelector | null = null
let selectorNetwork: Network | null = null

async function getSelector(network: Network): Promise<WalletSelector> {
  if (selector && selectorNetwork === network) return selector
  selector = await setupWalletSelector({
    network,
    modules: [
      setupMeteorWallet(),
      setupHotWallet(),
      setupIntearWallet(),
      setupSender(),
    ],
  })
  selectorNetwork = network
  return selector
}

/** Secilebilir cuzdanlar. `available=false` → eklenti kurulu degil. */
async function list(network: Network): Promise<WalletInfo[]> {
  const s = await getSelector(network)
  return s.store.getState().modules.map((m) => ({
    id: m.id,
    name: m.metadata.name,
    iconUrl: m.metadata.iconUrl,
    available: m.metadata.available !== false,
    // Wallet Selector bu bilgiyi metadata'da vermiyor; denemeden bilemeyiz.
    signMessage: true,
  }))
}

async function wallet(network: Network, id: string): Promise<Wallet> {
  return (await getSelector(network)).wallet(id)
}

export interface Challenge {
  readonly message: string
  /** 32 bayt, base64. */
  readonly nonce: string
  readonly recipient: string
}

export interface Signed {
  readonly accountId: string
  readonly publicKey: string
  readonly signature: string
}

/**
 * NEP-413 imzasi. Islem DEGIL — aga hicbir sey gitmez, ucret yok.
 *
 * Cuzdan bir hesap secmeyi kendisi ister; giris yapilmis olmasi gerekmez.
 */
async function signMessage(network: Network, walletId: string, c: Challenge): Promise<Signed> {
  const w = await wallet(network, walletId)
  if (!w.signMessage) throw new Error(`${w.metadata.name} does not support message signing — pick another wallet`)
  const nonce = Uint8Array.from(atob(c.nonce), (ch) => ch.charCodeAt(0))
  // Selector `Buffer` tipini istiyor ama yalnizca bayt olarak kullaniyor.
  const r = await w.signMessage({ message: c.message, recipient: c.recipient, nonce: nonce as unknown as Buffer })
  if (!r) throw new Error('the wallet redirected instead of returning a signature — try another wallet')
  return { accountId: r.accountId, publicKey: r.publicKey, signature: r.signature }
}

export interface FunctionCall {
  readonly receiverId: string
  readonly methodName: string
  readonly args: Record<string, unknown>
  /** gas, string (bigint metni) */
  readonly gas: string
  /** yoctoNEAR, string */
  readonly deposit: string
}

/**
 * Tek bir kontrat cagrisi — reklamverenin USDC yatirmasi icin.
 *
 * Islemi cuzdan kurar ve kullaniciya gosterir; kullanici onaylamadan hicbir
 * sey gonderilmez. `expectedAccount` verilirse cuzdanda baska bir hesap
 * secilmisse islem baslamaz: yatirma, giris yapilan hesaptan gelmezse
 * kimseye yazilamaz.
 */
async function call(network: Network, walletId: string, fc: FunctionCall, expectedAccount?: string): Promise<{ txHash: string | null; accountId: string }> {
  const w = await wallet(network, walletId)
  const accounts = await w.signIn({ contractId: fc.receiverId, methodNames: [], accounts: [] } as never)
  const accountId = accounts[0]?.accountId
  if (!accountId) throw new Error('the wallet did not return an account')
  if (expectedAccount && accountId !== expectedAccount) {
    throw new Error(`the wallet is on ${accountId}, but you are signed in as ${expectedAccount} — switch accounts in the wallet`)
  }
  const outcome = await w.signAndSendTransaction({
    signerId: accountId,
    receiverId: fc.receiverId,
    actions: [{
      type: 'FunctionCall',
      params: { methodName: fc.methodName, args: fc.args, gas: fc.gas, deposit: fc.deposit },
    }],
  } as never)
  const hash = (outcome as { transaction?: { hash?: string } } | undefined)?.transaction?.hash ?? null
  return { txHash: hash, accountId }
}

const api = { list, signMessage, call }
;(globalThis as unknown as { BideWallet: typeof api }).BideWallet = api
export default api

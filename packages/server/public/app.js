/* Bide — tarayici tarafi ortak islevler.
 *
 * Cerceve yok, derleme adimi yok. Bes sayfalik bir site icin React
 * getirmek, indirilecek 40 KB'i 200 KB yapardi ve tek kazanci bizim
 * rahatimiz olurdu.
 *
 * Cuzdan koprusu (`/wallet.js`, NEAR Wallet Selector) yalnizca cuzdan
 * gereken anda yukleniyor; landing ve siralama sayfalari onu hic indirmez.
 */

/* ─────────────────────────── para ─────────────────────────── */

/**
 * Micro metnini dolara cevirir. BigInt, float DEGIL.
 *
 * 1 USDC = 1.000.000 micro. `parseFloat` ile bolmek 2^53 ustunde
 * sessizce yuvarlar ve kullanicinin bakiyesini degistirir.
 */
export function usd(micros) {
  const v = BigInt(micros);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / 1000000n;
  const frac = (a % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + '$' + whole.toString() + (frac ? '.' + frac : '');
}

/** "40.25" → 40250000n. Float'a hic ugramaz. */
export function toMicros(text) {
  const m = /^(\d*)(?:\.(\d{0,6}))?$/.exec(String(text).trim());
  if (!m || (!m[1] && !m[2])) return null;
  return BigInt(m[1] || '0') * 1000000n + BigInt((m[2] || '').padEnd(6, '0'));
}

export const short = (a) => (a && a.length > 24 ? a.slice(0, 6) + '…' + a.slice(-4) : a || '');

/* ─────────────────────────── sunucu ─────────────────────────── */

const TOKEN_KEY = 'bide.token';
const ROLE_KEY = 'bide.role';
const ADDR_KEY = 'bide.address';

export const session = {
  get token() { return localStorage.getItem(TOKEN_KEY); },
  get role() { return localStorage.getItem(ROLE_KEY); },
  get address() { return localStorage.getItem(ADDR_KEY); },
  save(token, role, address) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(ROLE_KEY, role);
    localStorage.setItem(ADDR_KEY, address);
  },
  clear() { [TOKEN_KEY, ROLE_KEY, ADDR_KEY].forEach((k) => localStorage.removeItem(k)); },
};

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.hint || body?.message || `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

/**
 * Sunucu cagrisi.
 *
 * Site sunucuyla AYNI adreste duruyor, bu yuzden yol goreli ve CORS yok.
 * Ayri bir alan adina koysaydik her uc icin CORS basliklari gerekirdi ve
 * cerez/kimlik islerinin hepsi zorlasirdi.
 */
export async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'x-bide-client-version': '0.1.1' };
  if (body) headers['content-type'] = 'application/json';
  if (auth && session.token) headers.authorization = `Bearer ${session.token}`;

  let res;
  try {
    res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    // Ag hatasi ile sunucu hatasini AYIRIYORUZ: kullaniciya "tekrar dene"
    // demekle "oturumun dustu" demek farkli seyler.
    throw new ApiError(0, { message: 'Cannot reach the server' });
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

/** Token'i sunucuda iptal eder, sonra yerelden siler. Sunucuya ulasilamasa da cikis olur. */
export async function signOut() {
  await api('/v1/logout', { method: 'POST' }).catch(() => {});
  session.clear();
}

/* ─────────────────────────── zincir ─────────────────────────── */

/**
 * Agin ozeti — sunucudan, bir kez. Ag adi, USDC kontrati, treasury hesabi,
 * blok gezgini. Sayfalar bunlari koda gommek yerine buradan okur; testnet
 * ile mainnet arasindaki fark yalnizca sunucu ayari olur.
 */
let chainP = null;
export function chain() {
  chainP ??= api('/v1/chain', { auth: false }).then((c) => {
    explorer.base = c.explorer || explorer.base;
    return c;
  }).catch((e) => { chainP = null; throw e; });
  return chainP;
}

/* ─────────────────────────── cuzdan ─────────────────────────── */

/**
 * NEAR Wallet Selector koprusu (`/wallet.js`, `window.BideWallet`).
 *
 * Yalnizca cuzdan gerektiginde yukleniyor: paket buyuk ve sayfalarin cogu
 * (landing, siralama) ona hic ihtiyac duymuyor. Kendi adresimizden
 * servis ediliyor — ucuncu taraf CDN yok.
 *
 * NOT: CLI'nin `login-page.ts` sayfasi da ayni dosyayi kullaniyor; ikisi
 * ayni API'ye bagli.
 */
let walletP = null;
function walletBridge() {
  walletP ??= new Promise((resolve, reject) => {
    if (window.BideWallet) return resolve(window.BideWallet);
    const s = document.createElement('script');
    s.src = '/wallet.js';
    s.onload = () => (window.BideWallet ? resolve(window.BideWallet) : reject(new Error('wallet bridge did not load')));
    s.onerror = () => { walletP = null; reject(new Error('could not load the wallet bridge')); };
    document.head.appendChild(s);
  });
  return walletP;
}

/**
 * Cuzdan secici — kucuk bir diyalog, sayfanin kendi stiliyle.
 *
 * Kurulu olmayan eklentiler listede kalir ama soluk: kullanici hangi
 * cuzdanin desteklendigini gorur ve kurabilir.
 */
export async function pickWallet(network, title = 'Choose a NEAR wallet') {
  const W = await walletBridge();
  const wallets = await W.list(network);
  return new Promise((resolve, reject) => {
    const d = document.createElement('dialog');
    d.className = 'wallet-picker';
    d.innerHTML = `<form method="dialog"><p class="wp-title"></p><div class="wp-list"></div>
      <button value="cancel" class="wp-cancel">Cancel</button></form>`;
    d.querySelector('.wp-title').textContent = title;
    const list = d.querySelector('.wp-list');
    for (const w of wallets) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'wp-item' + (w.available ? '' : ' off');
      b.innerHTML = '<img alt=""><span></span><em></em>';
      b.querySelector('img').src = w.iconUrl;
      b.querySelector('span').textContent = w.name;
      b.querySelector('em').textContent = w.available ? '' : 'not installed';
      b.onclick = () => { done = true; d.close(); d.remove(); resolve(w.id); };
      list.appendChild(b);
    }
    let done = false;
    d.addEventListener('close', () => { if (!done) { d.remove(); reject(new Error('cancelled')); } });
    document.body.appendChild(d);
    d.showModal();
  });
}

/* ─────────────────────────── giris (NEP-413) ─────────────────────────── */

/**
 * Cuzdanla giris. Sifre yok, hesap yok — NEAR hesabi kimligin kendisi.
 *
 * Uc adim: sunucudan bir challenge iste, cuzdana imzalat, imzayi geri
 * gonder. Sunucu imzayi ve anahtarin o hesaba ait oldugunu zincirden
 * dogrularsa token verir.
 *
 * Imzalanan sey bir islem DEGIL, NEP-413 mesaji: on-eki geregi aga
 * gonderilemez. Yani bu imza hicbir zaman para hareket ettiremez, yalnizca
 * "bu hesap benim"i kanitlar.
 *
 * `onStep` her adimda dugmenin yazisini degistiriyor. Cuzdan penceresi
 * acilmadan once kullanicinin ne bekledigini bilmesi gerekiyor.
 */
export async function login(role, onStep = () => {}) {
  const c = await chain();
  onStep('Choose a wallet…');
  const walletId = await pickWallet(c.network);

  onStep('Preparing…');
  const challenge = await api('/v1/auth/challenge', { method: 'POST', auth: false, body: {} });

  onStep('Sign in your wallet…');
  const W = await walletBridge();
  const signed = await W.signMessage(c.network, walletId, challenge);

  onStep('Verifying…');
  // Rolu SUNUCU dogruluyor; buradaki deger yalnizca hangi yetkilerin
  // istendigini soyluyor, kendi kendine yetki vermiyor.
  const { token, publisherId } = await api('/v1/auth/verify', {
    method: 'POST', auth: false,
    body: { ...signed, nonce: challenge.nonce, role },
  });

  session.save(token, role, publisherId);
  return { address: publisherId, role };
}

/* ─────────────────── yatirma (yalnizca reklamveren) ─────────────────── */

/**
 * USDC yatirma: cuzdanda `ft_transfer_call` → treasury.
 *
 * Duz bir transfer DEGIL: `_call` treasury kontratinin `ft_on_transfer`'ini
 * tetikler ve kontrat gondereni kaydeder. Sunucu o kayittan okur; para giris
 * yapilan hesaptan gelmezse kimseye yazilamaz, o yuzden cuzdan baska bir
 * hesaptaysa islem baslamaz.
 */
export async function deposit(amountMicros, onStep = () => {}) {
  const c = await chain();
  if (!c.treasury) throw new Error('deposits are not open on this server');
  onStep('Choose a wallet…');
  const walletId = await pickWallet(c.network, 'Deposit USDC from…');
  onStep('Confirm in your wallet…');
  const W = await walletBridge();
  return W.call(c.network, walletId, {
    receiverId: c.usdc,
    methodName: 'ft_transfer_call',
    args: { receiver_id: c.treasury, amount: String(amountMicros), msg: '' },
    gas: '100000000000000',
    deposit: '1',
  }, session.address);
}

/* ─────────────────────────── kucuk yardimcilar ─────────────────────────── */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function show(el, on) { el?.classList.toggle('hidden', !on); }

/**
 * Onay isareti — yazi tipi glifi degil, cizilmis SVG.
 *
 * `✓` karakteri her isletim sisteminde farkli boyutta ve kalinlikta
 * geliyor; macOS'ta ince, Windows'ta kalin, Linux'ta bazen hic yok.
 * Cizersek her yerde ayni.
 */
const TICK = `<svg class="tick" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8.5l3.6 3.6L13.5 4.7"/></svg>`;

export function copyButton(btn, text) {
  btn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(text()); } catch { /* izin yok */ }
    const tag = btn.querySelector('.tag') || btn;
    if (tag.dataset.busy) return;              // ust uste tiklamada etiketi kaybetme
    tag.dataset.busy = '1';
    tag.dataset.before = tag.textContent;

    tag.innerHTML = TICK;
    tag.classList.add('done');
    setTimeout(() => {
      tag.textContent = tag.dataset.before;
      tag.classList.remove('done');
      delete tag.dataset.busy;
    }, 1600);
  });
}

/** Blok gezgini baglantilari. Taban adres `/v1/chain`'den gelir. */
export const explorer = {
  base: 'https://testnet.nearblocks.io',
  tx(h) { return `${this.base}/txns/${h}`; },
  account(a) { return `${this.base}/address/${a}`; },
};

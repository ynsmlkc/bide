/**
 * `bide login` sirasinda tarayicida acilan sayfa.
 *
 * Neden tarayici? Cunku ozel anahtari GORMEK ISTEMIYORUZ (ADR-014). Imzayi
 * kullanicinin NEAR cuzdani (Meteor, HOT, Intear, Sender) atar; biz yalnizca
 * imzali NEP-413 mesajini aliriz. Terminalden "secret key'ini yapistir" demek
 * en kolay yol olurdu ve en kotu karar olurdu.
 *
 * Sayfa 127.0.0.1'de, tek kullanimlik bir portta servis edilir. Disaridan
 * erisilemez; challenge/verify cagrilarini yerel surec Bide sunucusuna
 * proxy'ler. Cuzdan koprusu (`/wallet.js`) de yerel surecten gelir — sayfa
 * ucuncu taraf script yuklemez.
 */

import { COUNTRY_CODES } from '@bide/protocol'

export interface LoginPageOpts {
  readonly nonce: string
  readonly port: number
  /** Siralama adimindaki "sitede gor" baglantisi icin. */
  readonly serverUrl?: string
}

/** Sayfaya gomulen ulke kodlari; adlari tarayici `Intl.DisplayNames` ile uretir. */
const CODES = JSON.stringify([...COUNTRY_CODES].sort())

export function loginPage(opts: LoginPageOpts): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bide — connect your NEAR wallet</title>
<style>
  /* Sitenin (landing) dili: sicak koyu zemin, Geist, tek turuncu vurgu,
     urunun kendisi — terminal penceresi — sahnenin ortasinda. CSP disariya
     izin vermedigi icin font yuklenmiyor; Geist kuruluysa o, yoksa sistem. */
  *, *::before, *::after { box-sizing: border-box }
  :root {
    --bg:#12110f; --bg2:#181714; --bg3:#1e1c19; --panel:#0e0d0c;
    --ink:#efeae3; --ink2:#a39c92; --muted:#8a847b; --faint:#6a655e; --dim:#4f4b45;
    --line:rgba(239,234,227,0.07); --line2:rgba(239,234,227,0.12);
    --accent:oklch(0.74 0.16 52); --accent-hi:oklch(0.8 0.14 52);
    --err:#c9695a; --ok:#8fae7f;
    --sans:'Geist',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;
    --mono:'Geist Mono',ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,monospace;
  }
  html { color-scheme: dark }
  body {
    margin:0; min-height:100vh; display:grid; grid-template-rows:auto 1fr auto;
    font-family:var(--sans); font-size:16px; line-height:1.5; letter-spacing:-0.005em;
    background:var(--bg); color:var(--ink);
    -webkit-font-smoothing:antialiased; font-variant-numeric:tabular-nums;
  }
  a { color:var(--ink); text-decoration:none }
  a:hover { color:var(--accent) }
  :focus-visible { outline:2px solid var(--accent); outline-offset:3px }
  ::selection { background:oklch(0.74 0.16 52 / 0.3) }

  header, footer {
    display:flex; align-items:center; justify-content:space-between; gap:10px 24px; flex-wrap:wrap;
    padding:12px clamp(16px,4vw,48px);
  }
  header { border-bottom:1px solid var(--line) }
  footer { border-top:1px solid var(--line); font-family:var(--mono); font-size:12px; color:var(--faint) }
  .brand { display:flex; align-items:center; gap:8px; font-weight:600; font-size:16px; letter-spacing:-0.02em }
  .brand i { color:var(--accent); font-style:normal; font-size:17px }
  .chip {
    display:inline-flex; align-items:center; gap:8px; height:28px; padding:0 12px; border-radius:999px;
    border:1px solid var(--line2); font-family:var(--mono); font-size:12px; color:var(--ink2); white-space:nowrap;
  }
  .chip i { width:6px; height:6px; border-radius:50%; background:var(--accent); display:block;
    box-shadow:0 0 0 3px oklch(0.74 0.16 52 / 0.18) }

  main { display:grid; place-items:center; padding:clamp(28px,5vw,64px) clamp(16px,4vw,48px) }
  .stage {
    width:100%; max-width:1080px; display:grid; grid-template-columns:minmax(0,0.85fr) minmax(0,1.15fr);
    gap:10px; padding:10px; background:var(--bg2); border:1px solid var(--line); border-radius:10px;
  }
  .copy { padding:clamp(20px,2.6vw,36px); display:flex; flex-direction:column; gap:22px }
  .kicker { margin:0; font-family:var(--mono); font-size:13px; color:var(--muted); display:flex; align-items:center; gap:10px }
  .kicker i { color:var(--accent); font-style:normal }
  h1 { margin:0; font-weight:500; font-size:clamp(30px,3.6vw,44px); line-height:1.06; letter-spacing:-0.035em; text-wrap:balance }
  h1 .soft { color:var(--faint) }
  .lede { margin:0; max-width:46ch; font-size:15px; line-height:1.6; color:var(--ink2); text-wrap:pretty }
  .lede b { color:var(--ink); font-weight:500 }

  .facts-l { margin:auto 0 0; padding:0; list-style:none; display:grid; gap:12px; border-top:1px solid var(--line); padding-top:20px }
  .facts-l li { display:grid; grid-template-columns:18px 1fr; gap:10px; font-size:14px; line-height:1.5; color:var(--muted) }
  .facts-l li i { color:var(--accent); font-style:normal; font-family:var(--mono) }
  .facts-l li b { color:var(--ink); font-weight:500 }

  /* Sahne: gunes isigi + terminal penceresi */
  .scene {
    position:relative; overflow:hidden; border-radius:6px; background:#0b0a09; isolation:isolate;
    display:grid; align-content:end; gap:14px; padding:clamp(18px,3.4vw,44px); min-height:520px;
  }
  .scene::before {
    content:''; position:absolute; inset:0; z-index:-1; pointer-events:none;
    background:
      radial-gradient(ellipse 36% 30% at 50% 0%, oklch(0.86 0.13 70 / 0.55) 0%, oklch(0.74 0.16 52 / 0.32) 34%, oklch(0.58 0.12 40 / 0.12) 62%, transparent 100%),
      repeating-linear-gradient(0deg, rgba(239,234,227,0.025) 0 1px, transparent 1px 13px);
  }
  .scene.on::before { animation:breathe 6s ease-in-out infinite }
  @keyframes breathe { 50% { opacity:.72 } }

  .win {
    width:100%; background:rgba(20,19,17,0.94); backdrop-filter:blur(6px);
    border:1px solid rgba(239,234,227,0.1); border-radius:10px; overflow:hidden; font-family:var(--mono);
    box-shadow:0 1px 0 rgba(255,255,255,0.04) inset, 0 40px 80px -24px rgba(0,0,0,0.75), 0 0 0 1px rgba(0,0,0,0.4);
  }
  .win-bar { position:relative; display:flex; align-items:center; justify-content:space-between; height:36px; padding:0 14px; border-bottom:1px solid var(--line) }
  .dots { display:flex; gap:7px }
  .dots i { width:10px; height:10px; border-radius:50%; background:#34312d; display:block }
  .win-bar .title { position:absolute; left:50%; transform:translateX(-50%); font-size:12px; color:var(--faint); white-space:nowrap }
  #status { font-size:12px; color:var(--faint) }
  .log { padding:18px; font-size:13px; line-height:1.85; min-height:200px; display:grid; align-content:start; gap:1px }
  .log div { white-space:pre-wrap; word-break:break-all }
  @keyframes blink { 0%,49%{opacity:1} 50%,100%{opacity:.15} }
  .caret { animation:blink 1.1s steps(1) infinite }

  .addr { border-top:1px solid var(--line); background:rgba(8,7,6,0.6); padding:14px 18px; display:grid; gap:8px; font-size:12.5px }
  .addr .k { color:var(--faint); font-size:11.5px; letter-spacing:.08em; text-transform:uppercase }
  .addr .v { color:var(--ink); word-break:break-all; line-height:1.6 }
  .facts { display:flex; flex-wrap:wrap; gap:6px 20px; color:var(--faint) }
  .facts span { white-space:nowrap }
  .facts em { font-style:normal; color:var(--ink2) }

  button { -webkit-appearance:none; appearance:none; background-image:none; font-family:var(--sans); cursor:pointer; border:1px solid var(--line2); background:transparent; color:var(--ink) }
  button:disabled { cursor:default }
  .primary {
    position:relative; z-index:1; width:100%; display:flex; align-items:center; justify-content:center; gap:10px;
    height:46px; padding:0 20px; border-radius:999px; font-size:15px; font-weight:500;
    background:var(--ink); border-color:var(--ink); color:var(--bg); transition:background 150ms, border-color 150ms;
  }
  .primary:hover:not(:disabled) { background:#fff; border-color:#fff }
  .primary:disabled { cursor:progress; opacity:.85 }
  .primary.quiet { background:transparent; border-color:var(--line2); color:var(--ink2) }
  .linkish { padding:0; border:0; background:none; color:var(--muted); font-size:13.5px; border-bottom:1px solid var(--line2) }
  .linkish:hover { color:var(--ink) }
  #nowallet { font-size:13.5px; color:var(--ink2) }
  #nowallet a { border-bottom:1px solid var(--line2) }

  .manual { border:1px solid var(--line); border-radius:10px; padding:16px; display:grid; gap:12px; background:rgba(20,19,17,0.94) }
  .manual p { margin:0; font-size:14px; line-height:1.6; color:var(--muted) }
  .manual .kicker { font-size:12px }
  .manual input, .manual select {
    width:100%; height:40px; padding:0 12px; border:1px solid var(--line2); border-radius:6px;
    background:var(--panel); color:var(--ink); font-family:var(--mono); font-size:13px;
  }
  .manual code { display:block; font-family:var(--mono); font-size:11.5px; line-height:1.6; color:var(--ink2);
    word-break:break-all; background:var(--panel); border:1px solid var(--line); border-radius:6px; padding:10px 12px; max-height:140px; overflow:auto }
  .manual textarea { width:100%; padding:10px 12px; border:1px solid var(--line2); border-radius:6px; resize:vertical;
    background:var(--panel); color:var(--ink); font-family:var(--mono); font-size:12px }
  .manual .primary { width:auto; height:38px; padding:0 18px; font-size:14px; justify-self:start }
  .manual label.check { display:flex; align-items:center; gap:10px; font-size:14px; color:var(--ink2); cursor:pointer }
  .manual label.check input { width:auto; height:auto; accent-color:var(--accent) }
  .pbtns { display:flex; flex-wrap:wrap; gap:12px 18px; align-items:center }
  .pbtns .primary { width:auto; height:38px; padding:0 18px; font-size:14px }

  .hide { display:none !important }
  @media (max-width: 860px) {
    .stage { grid-template-columns:minmax(0,1fr) }
    .scene { min-height:0 }
  }
  @media (prefers-reduced-motion: reduce) { .caret, .scene.on::before { animation:none } }
</style></head>
<body>

<header>
  <span class="brand"><i>✶</i>bide</span>
  <span class="chip"><i></i>local · 127.0.0.1:${opts.port}</span>
</header>

<main>
  <div class="stage">
    <div class="copy">
      <p class="kicker"><i>✶</i>step 2 of 3 · identity</p>
      <h1>Connect your wallet. <span class="soft">Then get back to work.</span></h1>
      <p class="lede">Your earnings go to this NEAR account. You sign a <b>message, not a transaction</b> (NEP-413) — it can never be sent to the network, it moves nothing and it costs nothing.</p>

      <ul class="facts-l">
        <li><i>·</i><span><b>Your key stays in your wallet.</b> It never enters this page or the CLI.</span></li>
        <li><i>·</i><span><b>This page runs on your machine.</b> The account goes straight to the CLI.</span></li>
        <li><i>·</i><span>No setup for USDC: if your account is not registered with the USDC contract yet, Bide pays that deposit on your first payout.</span></li>
      </ul>
    </div>

    <div class="scene" id="scene">
      <div class="win">
        <div class="win-bar">
          <span class="dots"><i></i><i></i><i></i></span>
          <span class="title">bide login</span>
          <span id="status">ready</span>
        </div>
        <div class="log" id="log"></div>

        <div class="addr hide" id="addrbox">
          <span class="k">Connected account</span>
          <span class="v" id="addr"></span>
          <div class="facts">
            <span>network <em id="net">testnet</em></span>
            <span>asset <em>USDC</em></span>
            <span>chain <em>NEAR</em></span>
          </div>
        </div>
      </div>

      <div class="manual" id="walletbox">
        <p>Pick your NEAR wallet:</p>
        <div id="wallets" style="display:grid; gap:8px"></div>
      </div>
      <button id="toggle-manual" class="linkish" style="justify-self:start">Using NEAR CLI instead?</button>

      <div class="manual hide" id="manualbox">
        <p>If you already use NEAR CLI, close this page and run:</p>
        <code>bide login --force --near-credentials &lt;your-account&gt;</code>
        <p>The message is signed locally with the key in <b>~/.near-credentials</b>. Only the signature is sent.</p>
      </div>

      <!-- Istege bagli siralama adimi: yalnizca giristen SONRA gorunur.
           Kutu varsayilan ISARETSIZ — kazanci herkese acmak kullanicinin
           bilerek verdigi bir karar olmali. -->
      <div class="manual hide" id="profilebox">
        <p class="kicker"><i>✶</i>step 3 of 3 · optional</p>
        <p style="color:var(--ink)">Join the public leaderboard and the world map?</p>
        <p>Only a nickname and a country are shown, never your wallet address. Earnings from your own campaigns don't count. Change or leave any time with <b>bide profile</b>.</p>
        <input id="p-nick" maxlength="20" placeholder="nickname — 3–20 letters, digits, _ . -" autocomplete="off" spellcheck="false">
        <select id="p-country"><option value="">Don't show a country</option></select>
        <p id="p-guess" class="hide" style="font-size:12.5px"></p>
        <label class="check"><input type="checkbox" id="p-listed"> Show me on the leaderboard</label>
        <div class="pbtns">
          <button id="p-save" class="primary">Save</button>
          <button id="p-skip" class="linkish">Skip for now</button>
        </div>
        <p id="p-msg" class="hide"></p>
      </div>
    </div>
  </div>
</main>

<footer>
  <span>✶ bide — NEAR</span>
  <span>Ctrl-C in the terminal to close</span>
</footer>

<script>
const NONCE = ${JSON.stringify(opts.nonce)}
const $ = (id) => document.getElementById(id)
const DIM = 'var(--faint)', SOFT = 'var(--muted)', INK = 'var(--ink)'
const OK = 'var(--ok)', ACC = 'var(--accent)', ERR = 'var(--err)'

/* ─────────────────────────── gunluk ─────────────────────────── */

const lines = []
const esc = (s) => String(s).replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]))

function log(text, color) {
  lines.push({ text, color: color || SOFT })
  $('log').innerHTML = lines
    .map((l) => '<div style="color:' + l.color + '">' + esc(l.text) + '</div>')
    .join('') + '<div style="color:' + DIM + '">❯ <span class="caret">▌</span></div>'
}
function status(text, color) {
  $('status').textContent = text
  $('status').style.color = color || DIM
}

log('❯ bide login', DIM)
log('  wallet not connected', DIM)

/* ─────────────────────────── sunucu ─────────────────────────── */

async function post(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bide-nonce': NONCE },
    body: JSON.stringify(body),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.hint || j.message || ('HTTP ' + r.status))
  return j
}

/* ─────────────────────────── cuzdan ─────────────────────────── */

/*
 * window.BideWallet — NEAR Wallet Selector koprusu, yerel /wallet.js.
 * Sitenin panelleriyle AYNI dosya; biri degisirse ikisi de degisir.
 *
 * DIKKAT: bu blok bir sablon dizesinin ICINDE — backtick kullanma.
 */
let busy = false
let done = false
let NETWORK = 'testnet'

function loadBridge() {
  return new Promise((resolve, reject) => {
    if (window.BideWallet) return resolve(window.BideWallet)
    const s = document.createElement('script')
    s.src = '/wallet.js'
    s.onload = () => window.BideWallet ? resolve(window.BideWallet) : reject(new Error('wallet bridge did not load'))
    s.onerror = () => reject(new Error('could not load the wallet bridge'))
    document.head.appendChild(s)
  })
}

async function showWallets() {
  try {
    const W = await loadBridge()
    const list = await W.list(NETWORK)
    $('wallets').innerHTML = ''
    for (const w of list) {
      const b = document.createElement('button')
      b.className = 'primary'
      b.style.display = 'flex'; b.style.alignItems = 'center'; b.style.gap = '10px'
      if (!w.available) b.classList.add('quiet')
      const img = document.createElement('img')
      img.src = w.iconUrl; img.width = 22; img.height = 22; img.alt = ''; img.style.borderRadius = '5px'
      const t = document.createElement('span')
      t.textContent = w.name + (w.available ? '' : ' (not installed)')
      b.append(img, t)
      b.onclick = () => connect(w.id, w.name)
      $('wallets').appendChild(b)
    }
    log('  choose a wallet to sign with', DIM)
  } catch (e) { fail(e) }
}

/* ─────────────────────────── akis ─────────────────────────── */

async function connect(walletId, walletName) {
  if (busy || done) return
  busy = true
  status('challenge', INK)
  try {
    const ch = await post('/challenge', {})
    NETWORK = ch.network || NETWORK
    $('net').textContent = NETWORK
    log('→ challenge generated (NEP-413 message, not a transaction)', SOFT)

    status('awaiting signature', INK)
    log('⋯ waiting for a signature in ' + walletName, INK)
    const W = await loadBridge()
    const signed = await W.signMessage(NETWORK, walletId, ch)
    await finish(signed, ch.nonce)
  } catch (e) {
    fail(e)
  } finally {
    busy = false
  }
}

async function finish(signed, nonce) {
  log('✓ signature received', ACC)
  status('verifying', INK)
  log('⋯ verifying signature and key on chain', INK)

  const res = await post('/verify', {
    accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature, nonce,
  })

  done = true
  log('✓ verified — earnings will go to this account', ACC)
  log('✓ session saved to ~/.bide/credentials.json', DIM)
  status('connected', ACC)
  $('scene').classList.add('on')
  $('addr').textContent = res.publisherId
  $('addrbox').classList.remove('hide')
  $('manualbox').classList.add('hide')
  $('toggle-manual').classList.add('hide')
  $('walletbox').classList.add('hide')

  openProfile()
}

function fail(e) {
  const msg = (e && e.message) ? e.message : String(e)
  log('✗ ' + (/reject|denied|closed|declined|cancel/i.test(msg) ? 'the wallet closed without signing — nothing happened' : msg), ERR)
  status('error', ERR)
}

showWallets()

/* ─────────────────────────── siralama (istege bagli) ─────────────────────────── */

const SERVER = ${JSON.stringify((opts.serverUrl ?? '').replace(/\/+$/, ''))}
const CODES = ${CODES}
const NICK = /^[A-Za-z0-9_.-]{3,20}$/
let regionName = (c) => c
try { const dn = new Intl.DisplayNames(['en'], { type: 'region' }); regionName = (c) => dn.of(c) || c } catch {}
const flag = (c) => String.fromCodePoint(...[...c].map((ch) => 127397 + ch.charCodeAt(0)))

function fillCountries() {
  const sel = $('p-country')
  CODES.map((c) => [c, regionName(c)])
    .sort((a, b) => a[1].localeCompare(b[1]))
    .forEach(([c, name]) => {
      const o = document.createElement('option')
      o.value = c; o.textContent = flag(c) + '  ' + name
      sel.appendChild(o)
    })
}

function profileMsg(text, color) {
  $('p-msg').textContent = text
  $('p-msg').style.color = color || SOFT
  $('p-msg').classList.remove('hide')
}

async function openProfile() {
  fillCountries()
  $('profilebox').classList.remove('hide')
  try {
    const r = await post('/profile/get', {})
    const p = r.profile
    if (p) {
      $('p-nick').value = p.nickname
      $('p-country').value = p.country || ''
      $('p-listed').checked = !!p.listed
    }
    // CCgather yaklasimi: ulke secilmemisse baglantidan tahmin; kaydedilene
    // kadar hicbir yere yazilmaz.
    if ((!p || !p.country) && r.suggestedCountry) {
      $('p-country').value = r.suggestedCountry
      $('p-guess').textContent = regionName(r.suggestedCountry) + ' was picked from your connection — change it if that is wrong.'
      $('p-guess').classList.remove('hide')
    }
  } catch { /* okunamadiysa form bos kalir; kaydetmek yine calisir */ }
}

$('p-save').onclick = async () => {
  const nickname = $('p-nick').value.trim()
  if (!NICK.test(nickname)) { profileMsg('Nickname: 3–20 letters, digits, _ . -', ERR); return }
  $('p-save').disabled = true
  try {
    const r = await post('/profile/save', { nickname, country: $('p-country').value || null, listed: $('p-listed').checked })
    const listed = r.profile && r.profile.listed
    log(listed ? '✓ leaderboard: listed as ' + r.profile.nickname : '✓ leaderboard profile saved (not listed)', ACC)
    profileMsg(listed
      ? 'Saved. You will appear within a minute once you have earnings from other advertisers.'
      : 'Saved. You are not listed.', OK)
    if (SERVER && listed) {
      const a = document.createElement('a')
      a.href = SERVER + '/#board'; a.target = '_blank'; a.rel = 'noopener'
      a.textContent = 'See the leaderboard →'
      a.className = 'linkish'
      a.style.justifySelf = 'start'
      $('p-msg').after(a)
    }
    $('p-skip').classList.add('hide')
    status('done — you can close this page', ACC)
  } catch (e) {
    profileMsg(e && e.message ? e.message : String(e), ERR)
    $('p-save').disabled = false
  }
}

$('p-skip').onclick = async () => {
  try { await post('/profile/skip', {}) } catch {}
  $('profilebox').classList.add('hide')
  log('  leaderboard skipped — join later with: bide profile', DIM)
  status('done — you can close this page', ACC)
}


/* ─────────────────────────── NEAR CLI ─────────────────────────── */

$('toggle-manual').onclick = () => {
  const gizli = $('manualbox').classList.toggle('hide')
  $('toggle-manual').textContent = gizli ? 'Using NEAR CLI instead?' : 'Hide'
}
</script>
</body>
</html>`
}

# Bide

> Earn USDC on NEAR while your AI coding agent thinks.

While Claude Code is working on your prompt, one clearly disclosed sponsored line sits in its status line. When the answer arrives, it is gone. Every verified impression adds to the developer's balance. Developers can withdraw that balance as USDC on NEAR whenever they want, in any amount. There is no bank account, no country list and no minimum threshold.

Advertisers deposit USDC into the Bide treasury contract and buy those lines per impression. Half of every impression goes to the developer who saw it.

**Status: NEAR testnet.** The full money loop runs on testnet (`node scripts/testnet-e2e.mjs <treasury>`). Mainnet is not live and no real money moves yet.

| Step | Testnet transaction |
|---|---|
| Treasury contract deployed and initialized | `bide-treasury-acb026.testnet` |
| Advertiser deposits 3 USDC with `ft_transfer_call` → recorded by `ft_on_transfer` | [61TutZif…](https://testnet.nearblocks.io/txns/61TutZifcaHMphwzV3qvpt79goDXM4avxpcVJuqMnXNB) |
| Withdrawal of 2 USDC paid by the server's NEAR rail (`ft_transfer`) | [Ekf3sRex…](https://testnet.nearblocks.io/txns/Ekf3sRex5qNS6HsgwQN6vKpNnjQQzmkAUJ6LuiuQd8JR) |

---

## How it uses NEAR

| Piece | NEAR primitive | Where |
|---|---|---|
| Login | **NEP-413** signed message (`signMessage`). The server checks the signature and also checks on chain that the key is a **full-access key** of the account. A function-call key does not count as the owner. | `packages/payments/src/nep413.ts`, `packages/server/src/http/wallet-auth.ts` |
| Wallets | **NEAR Wallet Selector** (Meteor, HOT, Intear, Sender), bundled and served from Bide's own origin. Pages never load third-party scripts. | `packages/server/web/wallet.ts` |
| Headless login | `bide login --near-credentials alice.testnet` signs the same NEP-413 message locally with the NEAR CLI key. Only the signature leaves the machine. | `packages/cli/src/cli/login.ts` |
| Payouts | **NEP-141 USDC** (`ft_transfer`). One payout batch is one transaction: several `ft_transfer` actions to the USDC contract. Actions in a NEAR transaction run as one receipt, so a batch is paid entirely or not at all. | `packages/payments/src/near-rail.ts` |
| First payout | **NEP-145** `storage_deposit`. If a developer's account is not yet registered with USDC, Bide adds the deposit to the same transaction. The developer sets nothing up. | `near-rail.ts` |
| Deposits | Treasury contract with **`ft_on_transfer`**. Advertisers send USDC with `ft_transfer_call`, and the contract records the sender in an ordered log and emits a **NEP-297** event. The server reads `deposits_from(cursor)`, so no indexer is needed. Anyone can check `total_deposited(account)` on chain. | `contracts/treasury` |

### Payment safety

- **Each transaction is signed once.** A retry sends the same bytes. The hash is computed locally before anything is sent, so a payout can be reconciled even when the send call times out.
- **"Sent" does not mean "paid".** A payout counts as paid only when its outcome is `FINAL` with `SuccessValue`. A transaction that lands with `Failure` burns gas but moves no money, and the developer's balance is restored.
- **A payout is never rebuilt on a guess.** A missing transaction is declared dead only on chain evidence: the access-key nonce has moved past it, or its reference block is older than `transaction_validity_period`. Anything else stays pending. Rebuilding early could pay the same money twice.
- **All treasury transactions go through one queue.** Concurrent withdrawals cannot race on access-key nonces.
- **Gas and USDC are watched separately.** A treasury with plenty of USDC but no NEAR for gas stops silently, so low gas raises its own alarm.

## Where it works

Ads are shown, and impressions counted, **only in Claude Code running in a terminal**. That includes the integrated terminal of VS Code, Cursor or JetBrains. Billing rests entirely on the `statusLine`. Claude Code's documentation does not say that the IDE extension panels or the desktop app render a custom `statusLine`, so Bide shows nothing and counts nothing there. `bide doctor` says this too.

macOS, Linux and Windows are supported. On Windows the daemon uses a named pipe, and the installed commands work in Git Bash, PowerShell and `cmd`.

## Architecture

```
Claude Code
    │  hooks: UserPromptSubmit → Stop
    ▼
statusLine shim ──22ms──> daemon ──> turn state machine
    │                        │             │
    └──── ✶ Sponsor … ───────┘        disk queue
                                           │
                                           ▼
                                    Bide server ──> NEAR
                                     │  ledger       ├─ USDC ft_transfer (payouts)
                                     │  ads          ├─ treasury.deposits_from (deposits)
                                     │  verification └─ view_access_key (login)
```

The daemon holds the ad in memory, so the shim never touches the network. If the daemon is down, unreachable or unsure, the shim prints **nothing**: never an error, never a stale line.

## Design principles

**Disclosure is not optional.** Every surface, including the spinner verb, starts with `✶`. An ad is never formatted to look like the tool's own output.

**Ad copy is hostile input.** A creative containing control characters is treated as an attack. It is rejected, not sanitized and served. Tests cover 20 attack vectors, from OSC 52 clipboard writes to bidi overrides.

**Only what is measured is billed.** The ad is shown only during an active turn plus a short grace period. Idle time is not shown and not counted.

**Money is integers.** Amounts are branded `bigint` micros (1e-6 USDC), the same unit as NEAR USDC, so the ledger and the chain never convert. Floats are banned. The ledger is double-entry, and every reversal negates the original entries instead of recomputing them.

## Repo layout

```
packages/protocol/      shared types, money, sanitizer, schemas
packages/payments/      NEAR rail: NEP-413 login, batched NEP-141 payouts, RPC client
packages/server/        ad serving, impression ingest and verification, ledger, payouts, the site
packages/server/web/    browser wallet bridge (NEAR Wallet Selector) → public/wallet.js
packages/cli/           the `bidesh` npm package: daemon, IPC, status-line shim, disk queue, login
contracts/treasury/     NEAR contract on the treasury account: ft_on_transfer deposit log
scripts/                testnet setup and a scripted advertiser
```

## Quick start

Requires Node 20+, pnpm and, for the contract, Rust with `cargo-near`.

```bash
pnpm install
pnpm typecheck
pnpm test                          # TypeScript tests (mock payment rail, no network)
(cd contracts/treasury && cargo test)
```

### Run the server locally

```bash
pnpm --filter @bide/server build
node packages/server/dist/server.mjs     # http://127.0.0.1:8787, in-memory, dev token printed
```

Without `BIDE_TREASURY_ACCOUNT` / `BIDE_TREASURY_KEY` the server runs with payouts and deposits off. Ads, impressions, NEP-413 login and the panels all work.

### Turn on payouts (testnet)

```bash
(cd contracts/treasury && cargo near build non-reproducible-wasm)
node scripts/testnet-setup.mjs           # creates the account, deploys + inits the treasury, registers with USDC
```

The script prints the environment variables to set. Fund the treasury with testnet USDC from [faucet.circle.com](https://faucet.circle.com) (NEAR testnet). See `.env.example` for every setting.

### Use the CLI against it

```bash
pnpm --filter bidesh build
node packages/cli/dist/bide.mjs init
BIDE_SERVER=http://127.0.0.1:8787 node packages/cli/dist/bide.mjs login                       # browser wallet
BIDE_SERVER=http://127.0.0.1:8787 node packages/cli/dist/bide.mjs login --near-credentials you.testnet
node packages/cli/dist/bide.mjs balance
```

Advertisers use `/advertisers/app`. They connect a NEAR wallet, deposit USDC with one `ft_transfer_call`, and create a campaign. `node scripts/test-campaign.mjs you.testnet --apply` does the same from the command line.

## Status

- [x] Daemon: turn state machine, IPC, shim, disk queue (macOS, Linux, Windows)
- [x] Server: ad auction, impression ingest and verification, double-entry ledger, fraud caps
- [x] NEAR login: NEP-413 with an on-chain full-access-key check, browser wallets and NEAR CLI keys
- [x] NEAR payouts: batched, atomic NEP-141 transfers with chain-evidence reconciliation
- [x] Treasury contract: `ft_on_transfer` deposit log, NEP-297 events, unit tests
- [x] Advertiser panel: wallet deposits, self-serve campaigns and budgets
- [x] End-to-end on testnet: NEP-413 login → `ft_transfer_call` deposit → on-chain payout (`scripts/testnet-e2e.mjs`)
- [ ] Public testnet deployment of this build
- [ ] Mainnet

Click attribution and adapters beyond Claude Code are out of scope for now.

## License

MIT

# bidesh

Turn the waiting into earnings.

When you ask Claude Code something, one sponsored line of text sits in your
status line while the model works. When the answer arrives, it is gone. You
get paid in USDC on NEAR.

```
npm i -g bidesh && bide init --spinner
```

After install, the command is `bide`.

---

## What it looks like

```
✶ Firecrawl — docs to LLM-ready markdown · firecrawl.dev        Edit · 2.8s
```

One line, plain text, in the status line at the bottom of Claude Code. It
shows **only while you are waiting** — it disappears when the answer lands,
and an idle terminal shows nothing at all.

That is the only condition: you have to be waiting. No waiting, no line, no
impression, no payment.

## Install

```bash
npm i -g bidesh && bide init --spinner             # install and start
bide init --spinner   # also use the "Thinking…" words at the top
```

Then open a new Claude Code session.

## Getting paid

```bash
bide login      # connect your wallet — earnings go here
bide balance    # what you have earned
```

`bide login` opens a page on your own machine and you sign a message with
your NEAR wallet (Meteor, HOT, Intear or Sender). It is a NEP-413 message,
not a transaction: it moves nothing and costs nothing.
**Your private key never enters this tool.**

Already using NEAR CLI? `bide login --near-credentials alice.testnet` signs
the same message locally with the key NEAR CLI keeps in `~/.near-credentials`.
Only the signature leaves your machine.

Your identity *is* your NEAR account. No GitHub, no email, no password.

## Commands

| Command | What it does |
|---|---|
| `bide init` | install and start |
| `bide login` | connect your wallet |
| `bide balance` | show earnings |
| `bide whoami` | show the connected wallet |
| `bide status` | daemon status |
| `bide doctor` | diagnose the install — runs the installed commands in every shell Claude Code may use |
| `bide doctor --fix` | rewrite Bide's settings.json entries (installs from older versions) |
| `bide restart` | restart the daemon |
| `bide pause` / `resume` | stop showing ads for now |
| `bide logout` | disconnect the wallet |
| `bide uninstall` | remove it |

## Leaving

```bash
bide uninstall
```

It removes only our own entries. If you have your own settings in
`settings.json`, they are left exactly as they were — we do not restore from a
backup, because that would silently undo changes you made after the backup was
taken.

## What we send

Being clear about this matters: if a tool installs something on your machine,
you should know what it sees.

**We send:** impression id, campaign id, duration, session id, client version,
OS and architecture.

**We never send:** your directory paths, your file names, your prompts, your
code. The value used to tell projects apart is hashed with a salt generated on
your machine that never leaves it — raw paths never reach the network.

## Things you should know

**Ads show only in Claude Code running in a terminal**, including an IDE's
integrated terminal. Earnings are counted from the status line alone, and
Claude Code's documentation does not say that the VS Code / JetBrains extension
panels or the desktop app render a custom status line — so there, nothing is
shown and nothing is counted.

**Windows:** Claude Code runs Bide's commands through Git Bash, or through
PowerShell if Git for Windows is not installed. Bide writes commands that work
in both. If you installed version 0.1.16 or older and see no ads, run
`bide doctor --fix`.

Claude Code hides some of the keyboard hints at the bottom (like
`esc to interrupt`) while a custom `statusLine` is defined. That is Claude
Code's behaviour, not our choice — but you are the one who lives with it, so we
say it up front.

With `--spinner`, the "Thinking…" words at the top change too. That field
accepts one list at a time, so if another tool writes to it as well, one of you
overwrites the other.

## Status

NEAR testnet. Payouts are USDC (`ft_transfer`) from the Bide treasury account;
mainnet is out of scope for now.

Without a server connection `bide` shows sample ads and **records no
earnings**. `bide init` tells you when that is the case.

## Links

- [github.com/ynsmlkc/Bide](https://github.com/ynsmlkc/Bide)

## License

MIT

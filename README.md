# wallet-ager

Automatically generates fresh wallets every day from one or more **main wallets**
on **Robinhood Chain** and funds each new wallet with a small amount of ETH,
repeating daily until a main wallet runs out of funds.

Each day, for every main wallet:

1. Generate N fresh wallets (default 10), each with an address, private key and
   12-word seed phrase.
2. Save them to `output/<mainWallet>/wallets-dayN.json`.
3. Send a fixed amount of ETH (default 0.0005) to each new wallet.
4. Wait ~24h, then do it again with the next day's batch.
5. When the main wallet can no longer cover a batch + gas, it stops cleanly.

Multiple main wallets run **in parallel**, each on its own day counter and its
own `output/<name>/` folder.

## ⚠️ Security — read this

`config.json` and everything in `output/` contain **private keys and seed
phrases in plaintext**. Anyone who can read those files can take all the ETH.

- Keep them local. Both are already in `.gitignore` — never commit them.
- **Never** sync or back up `output/` or `config.json` to the cloud, GitHub, etc.
- On a server, run as a non-root user and `chmod 600` these files.

## Setup

```bash
npm install
cp config.example.json config.json      # then edit config.json
```

Edit `config.json`:

| Field | Meaning |
|-------|---------|
| `network` | `"testnet"` (chain 46630, free test ETH) or `"mainnet"` (chain 4663, real ETH) |
| `dryRun` | `true` = generate + save wallets but send **no** ETH (safe test) |
| `intervalHours` | Hours between batches (24 = daily) |
| `gasBufferEth` | ETH kept back as a gas cushion when deciding affordability |
| `mainWallets[]` | One entry per main wallet — see below |

Each `mainWallets` entry:

| Field | Required | Default | Meaning |
|-------|----------|---------|---------|
| `name` | no | `main-N` | Folder name under `output/` (alphanumeric, `._-`) |
| `privateKey` | **yes** | — | The main wallet's `0x…` private key (funds the batches) |
| `walletsPerDay` | no | 10 | How many wallets to create each day |
| `amountEth` | no | `0.0005` | ETH sent to each new wallet |

### Adding more main wallets

Add more entries to `mainWallets` — they all run independently. You can edit
`config.json` by hand, or use the CLI `add` command (below). Each new main wallet
needs its **own** funded key.

```json
"mainWallets": [
  { "name": "main-1", "privateKey": "0x..." },
  { "name": "main-2", "privateKey": "0x..." },
  { "name": "main-3", "privateKey": "0x...", "walletsPerDay": 5, "amountEth": "0.001" }
]
```

## Running

```bash
npm start        # runs forever, one batch per interval per main wallet (with hot-reload)
npm run once     # runs exactly one batch per main wallet, then exits (testing/catch-up)
npm test         # run the unit tests
```

## Managing wallets (CLI)

The worker (`npm start`) runs headless — under systemd/pm2 on a server. To
inspect or change it, use the CLI in a separate terminal:

```bash
npm run cli          # interactive arrow-key menu: Status / List / Add / Exit
npm run status       # per-wallet day, last run, live on-chain balance, exhausted?
npm run add          # interactively add a new main wallet (key input is masked)

# non-interactive add (handy for scripts / no terminal):
node src/cli.js add --name main-2 --key 0x<64hex> [--per-day 10] [--amount 0.0005]
```

`npm run cli` opens a real ↑/↓ selection menu — use it over SSH. The private-key
prompt is **masked** so your key never shows on screen. If run without a
terminal (e.g. accidentally under pm2/systemd or a pipe), it prints guidance and
exits instead of hanging; use the flag form there.

## Gather (sweep main wallets → supermain)

Consolidate leftover ETH from all your main wallets into one **supermain**
wallet. Set its address in `config.json`:

```json
"superMainWallet": "0xYourSupermainWalletAddress"
```

Only the **address** is needed (receiving requires no private key). Then:

```bash
node src/cli.js gather --dry     # preview: shows what WOULD be swept, sends nothing
node src/cli.js gather           # sweep for real (asks for confirmation in a terminal)
node src/cli.js gather --yes     # sweep headless (no prompt) — use with care
# or pick "Gather" in `npm run cli`
```

- Sweeps each main wallet's **entire balance minus a gas reserve** to the
  supermain. Wallets too low to cover gas are skipped.
- Moves real funds, so it **requires confirmation** interactively, or `--yes`
  headless. If `dryRun` is `true` in config, gather is always a preview.
- Sweeps the **main wallets only** — the daily child wallets keep their ETH.
- One-directional: main wallets → supermain. It never touches the supermain's
  funds (it has no key for it).

### Hot-reload (no restart needed)

The running worker **watches `config.json`**. When you add a new main wallet
(via the CLI or by editing the file), the worker starts its daily loop
automatically within a few seconds — **no restart, no downtime**. Existing
wallets are never touched (their state is preserved).

Note: only **adding** main wallets is live. Changing global settings
(`network`, `rpcUrl`, `intervalHours`) or an existing wallet's entry requires a
restart (`systemctl restart wallet-ager` or `pm2 restart wallet-ager`).

Recommended first run: keep `network: "testnet"` and set `dryRun: true`, run
`npm run once`, and inspect the generated `output/main-1/wallets-day1.json`.
Then set `dryRun: false` on testnet to confirm real (test) sends work. Only then
switch `network` to `"mainnet"`.

## State & restart-safety

Progress lives in `state/<mainWallet>.json` (`dayCounter`, `lastRunTime`,
`exhausted`). Stop and restart any time — it resumes at the right day and won't
double-send inside the same interval.

## Deploying to a server

See [DEPLOY.md](DEPLOY.md) for Ubuntu + systemd instructions.

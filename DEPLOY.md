# Deploying wallet-ager on Ubuntu (systemd)

This runs the funder 24/7, auto-restarts on crash, and comes back after a reboot.

## 1. Install Node.js (v20+)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version
```

## 2. Create a dedicated non-root user

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin walletager
sudo mkdir -p /opt/wallet-ager
sudo chown walletager:walletager /opt/wallet-ager
```

## 3. Copy the project (WITHOUT secrets)

From your machine, copy the code but **never** the `config.json`, `output/`, or
`state/` folders:

```bash
rsync -av --exclude config.json --exclude output --exclude state \
      --exclude node_modules ./ user@server:/tmp/wallet-ager/
```

On the server:

```bash
sudo cp -r /tmp/wallet-ager/. /opt/wallet-ager/
sudo chown -R walletager:walletager /opt/wallet-ager
cd /opt/wallet-ager
sudo -u walletager npm install --omit=dev
```

## 4. Create config.json on the server

```bash
sudo -u walletager cp config.example.json config.json
sudo -u walletager nano config.json      # paste your main wallet private key(s)
sudo chmod 600 config.json
```

## 5. Prove it before real funds

Keep `network: "testnet"`, set `dryRun: true`:

```bash
sudo -u walletager node src/index.js --once
sudo -u walletager cat output/main-1/wallets-day1.json
```

Then `dryRun: false` on testnet to confirm real sends, then switch `network`
to `"mainnet"`.

## 6. Install and start the service

```bash
sudo cp wallet-ager.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now wallet-ager
```

## 7. Watch it

```bash
systemctl status wallet-ager
journalctl -u wallet-ager -f
```

## Security checklist

- [ ] SSH key-only login; password login disabled.
- [ ] Firewall (`ufw`) allows only SSH.
- [ ] `config.json`, `output/`, `state/` are `chmod 600`/`700` and owned by `walletager`.
- [ ] `output/` and `config.json` are **never** backed up or synced anywhere.
- [ ] The `.gitignore` already blocks committing any of them — keep it that way.

## Backups (of keys)

The generated `output/*.json` files are the ONLY copy of those wallets' keys.
If you want them off the server, move them over an encrypted channel (`scp`) to
an offline, encrypted location — not cloud storage.

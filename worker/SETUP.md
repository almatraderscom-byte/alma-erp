# ALMA Agent Worker — VPS Setup Guide

Ubuntu 22.04+, Node.js 20+. Copy-paste each block in order.

---

## 1. Install Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # should print v20.x.x
```

## 2. Install Redis

```bash
sudo apt-get install -y redis-server
sudo systemctl enable redis-server
sudo systemctl start redis-server
redis-cli ping   # should print PONG
```

## 3. Install pm2

```bash
sudo npm install -g pm2
pm2 startup   # follow the printed command to enable on reboot
```

## 4. Clone / pull the repo

```bash
# If this is a fresh server:
git clone https://github.com/almatraderscom-byte/alma-erp.git /opt/alma-erp
cd /opt/alma-erp/worker

# If already cloned, just pull:
cd /opt/alma-erp && git pull origin main
cd worker
```

## 5. Install worker dependencies

```bash
cd /opt/alma-erp/worker
npm ci
```

## 6. Create the worker .env file

```bash
cat > /opt/alma-erp/worker/.env << 'EOF'
REDIS_URL=redis://127.0.0.1:6379
APP_URL=https://alma-erp-six.vercel.app
AGENT_INTERNAL_TOKEN=<generate with: openssl rand -hex 32>
GEMINI_API_KEY=
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=
EOF
```

Edit the file and fill in all values:
```bash
nano /opt/alma-erp/worker/.env
```

## 7. Start the worker with pm2

```bash
cd /opt/alma-erp/worker
pm2 start src/index.mjs --name alma-agent-worker --interpreter node
pm2 save
pm2 logs alma-agent-worker   # verify it started without errors
```

## 8. (Optional) Facebook token pre-flight check

Add `FB_PAGE_TOKEN_LIFESTYLE` and `FB_PAGE_TOKEN_ONLINESHOP` to `.env`, then:

```bash
cd /opt/alma-erp/worker
npm run check-fb
```

---

## GitHub Secrets (for auto-deploy)

Add these two secrets in the repo at **Settings → Secrets → Actions**:

| Secret name   | Value                                                         |
|---------------|---------------------------------------------------------------|
| `VPS_HOST`    | Your VPS IP or hostname (e.g. `31.97.237.40`)                |
| `VPS_SSH_KEY` | The private SSH key that can log in as `root` (or your user) |

After adding the secrets, every push to `main` that touches `worker/**` will automatically:
1. SSH to the VPS
2. `git pull`
3. `npm ci` in `worker/`
4. `pm2 restart alma-agent-worker`

---

## Verify everything is running

```bash
pm2 status
redis-cli ping
curl -s http://localhost:3001/health || echo "worker has no HTTP health endpoint — check pm2 logs"
```

---

## Troubleshooting

- **Worker exits immediately**: Check `pm2 logs alma-agent-worker` for missing env vars
- **Redis connection refused**: `sudo systemctl start redis-server`
- **Image gen fails**: Verify `GEMINI_API_KEY` is valid and the models `gemini-3-pro-image-preview` / `gemini-3.1-flash-image-preview` are accessible on your account
- **Job-result callback 401**: `AGENT_INTERNAL_TOKEN` must match the value set in Vercel environment variables

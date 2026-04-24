# CodeRover Production Deploy Runbook

**Target:** `coderover.must.company` on a dedicated Contabo Cloud VPS 30 in Tokyo.
**Estimated time:** ~90 minutes end-to-end if nothing surprises you.
**Prerequisites:** VPS ordered + IP available, SSH keypair ready, DNS write access (or someone to ping), GitHub access to this repo.

Execute top-to-bottom. Every step is either a command to paste or a UI action to take. Commands use `deploy@coderover` as the non-root user (created in step 3).

---

## § 0 — Pre-flight checklist

Tick all of these before starting. Skipping any of them means you'll hit a wall mid-deploy:

- [ ] VPS ordered, provisioned, IP visible in Contabo panel
- [ ] SSH pubkey ready (`~/.ssh/id_ed25519.pub` or similar) — keep the private key on your machine
- [ ] DNS access for `must.company` (or: devops team message sent per `DEPLOY-DNS.md`)
- [ ] A valid OpenRouter API key (or OpenAI, or local LLM endpoint) — the key that was rotated after `.env.bak` exposure
- [ ] A valid GitHub PAT for repo access (if cloning private) or SSH deploy key
- [ ] Local clone of this repo to copy configs from
- [ ] One hour of uninterrupted time

**Don't start until every box is checked.** Half-finished deploys are worse than no deploy.

---

## § 1 — First boot + SSH

Contabo gives you root credentials on first provision. Log in once to lock it down:

```bash
# From your laptop
ssh root@<VPS_IP>
# Enter the root password from Contabo email
```

First thing: disable password login. Paste your SSH pubkey and switch to key-only auth:

```bash
# On the VPS, as root:
mkdir -p ~/.ssh && chmod 700 ~/.ssh
# Paste your ~/.ssh/id_ed25519.pub content into the file:
nano ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

Test from a NEW terminal (keep the root session open until this works):

```bash
ssh root@<VPS_IP>  # should log in without password prompt
```

If that works, continue. If not, fix it before going further — you're one config away from being locked out.

---

## § 2 — Host hardening (critical, ~10 minutes)

Every step here makes the box less owned. Do all of them before you expose any port.

### 2a. Update + unattended upgrades

```bash
apt update && apt upgrade -y
apt install -y unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades  # pick "Yes"
```

### 2b. Firewall (ufw)

```bash
apt install -y ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # HTTP (for Let's Encrypt challenge)
ufw allow 443/tcp   # HTTPS
ufw --force enable
ufw status verbose
```

Only 22, 80, 443 are open. Anything else (Postgres, Redis, Memgraph, NestJS API) stays bound to localhost via Docker — never exposed publicly.

### 2c. fail2ban

```bash
apt install -y fail2ban
systemctl enable --now fail2ban
```

Default config bans SSH brute-force attempts. Good enough for day one.

### 2d. SSH hardening

```bash
nano /etc/ssh/sshd_config
```

Ensure these lines are set (uncomment and change values):

```
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
X11Forwarding no
MaxAuthTries 3
ClientAliveInterval 300
ClientAliveCountMax 2
```

Then restart SSH:

```bash
systemctl restart ssh
```

**⚠️ Test from a new terminal before closing the root session** — if sshd_config has a typo, you want a working session to fix it from.

### 2e. Create `deploy` user + disable root login

```bash
adduser deploy
# Set a strong password, or leave blank and use key-only
usermod -aG sudo deploy
mkdir -p /home/deploy/.ssh
cp ~/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys
```

Test the deploy user works:

```bash
# From your laptop, NEW terminal:
ssh deploy@<VPS_IP>
# Should log in with key, no password
sudo -v   # confirm sudo works
```

Once verified, close the root session and keep the `deploy` session going forward.

---

## § 3 — Docker + docker-compose

```bash
# As deploy user on VPS
sudo apt install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker deploy

# Log out and back in for group membership to stick
exit
```

Reconnect, then verify:

```bash
ssh deploy@<VPS_IP>
docker ps                 # should work without sudo
docker compose version    # should show plugin version
```

---

## § 4 — Clone repo + configure `.env`

```bash
cd ~
git clone https://github.com/MUST-Company-AX-Booster/coderover.git
cd coderover/coderover-api
```

Create `.env` with real production values. **Never commit this file.** Use `chmod 600`.

```bash
nano .env
```

Paste this template and fill in the `<PLACEHOLDERS>`:

```ini
# ─── Runtime ──────────────────────────────────────────────
PORT=3001
NODE_ENV=production
SWAGGER_USERNAME=admin
SWAGGER_PASSWORD=<generate: openssl rand -base64 24>

# ─── Postgres (Docker compose service) ────────────────────
DATABASE_HOST=postgres
DATABASE_PORT=5432
DATABASE_NAME=coderover
DATABASE_USER=postgres
DATABASE_PASSWORD=<generate: openssl rand -base64 24>

# ─── Redis (Docker compose service) ───────────────────────
REDIS_HOST=redis
REDIS_PORT=6379

# ─── Memgraph (Docker compose service) ────────────────────
MEMGRAPH_URI=bolt://memgraph:7687

# ─── LLM (OpenRouter or OpenAI — pick one) ────────────────
OPENAI_API_KEY=<your rotated OpenRouter key>
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_CHAT_MODEL=anthropic/claude-sonnet-4
OPENAI_EMBEDDING_MODEL=openai/text-embedding-3-small
OPENAI_EMBEDDING_DIMENSIONS=1536
LLM_PROVIDER=openrouter

ANTHROPIC_API_KEY=

# ─── GitHub integration ───────────────────────────────────
GITHUB_TOKEN=<your rotated GH PAT with repo:read>
GITHUB_WEBHOOK_SECRET=<generate: openssl rand -hex 32>
GITHUB_CLIENT_ID=<from your GitHub OAuth app>
GITHUB_CLIENT_SECRET=<from your GitHub OAuth app>
GITHUB_CALLBACK_URL=https://coderover.must.company/auth/github/callback
FRONTEND_APP_URL=https://coderover.must.company

# ─── Auth ─────────────────────────────────────────────────
JWT_SECRET=<generate: openssl rand -base64 48>
JWT_EXPIRES_IN=7d

# ─── Watcher / Agents ─────────────────────────────────────
FILE_WATCH_ENABLED=true
AGENT_PR_ENABLED=false

# ─── Observability (optional, fill in from Honeycomb) ─────
OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io
OTEL_EXPORTER_OTLP_HEADERS=x-honeycomb-team=<your honeycomb ingest key>
OTEL_SERVICE_NAME=coderover-api
```

Lock it down:

```bash
chmod 600 .env
```

Also create the frontend `.env.production`:

```bash
cd ../coderover-frontend
nano .env.production
```

```ini
VITE_API_URL=/api
VITE_API_BASE_URL=/api
```

Relative paths so the frontend + API share the same origin via nginx.

---

## § 5 — Build frontend + bring up Docker stack

```bash
cd ~/coderover/coderover-frontend
# Install + build (requires Node — install via nvm if not already)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.nvm/nvm.sh
nvm install --lts
npm ci
npm run build    # produces dist/
```

Now the backend stack:

```bash
cd ~/coderover/coderover-api
docker compose up -d --build
```

Wait for containers to settle (~60s for Memgraph + first Nest bootstrap), then verify:

```bash
docker compose ps
# all services should be "Up" or "Up (healthy)"

curl -s http://localhost:3001/health | jq .
# should return {"status":"ok", ...}
```

If `/health` returns `llm.status: down`, check your `OPENAI_API_KEY`. Everything else should be up.

---

## § 6 — nginx reverse proxy

```bash
sudo apt install -y nginx
```

Copy frontend dist into a serveable location:

```bash
sudo mkdir -p /var/www/coderover
sudo cp -r ~/coderover/coderover-frontend/dist /var/www/coderover/
sudo cp -r ~/coderover/coderover-frontend/public/landing /var/www/coderover/dist/
sudo chown -R www-data:www-data /var/www/coderover
```

Write the site config:

```bash
sudo nano /etc/nginx/sites-available/coderover
```

Paste this (combines `docs/deploy/landing-nginx.md` + HTTPS redirect + gzip/brotli):

```nginx
# HTTP → HTTPS redirect
server {
  listen 80;
  listen [::]:80;
  server_name coderover.must.company;
  # Let's Encrypt HTTP-01 challenge
  location /.well-known/acme-challenge/ { root /var/www/certbot; }
  location / { return 301 https://$host$request_uri; }
}

# HTTPS
server {
  listen 443 ssl http2;
  listen [::]:443 ssl http2;
  server_name coderover.must.company;
  root /var/www/coderover/dist;

  # TLS (filled in after certbot run)
  ssl_certificate     /etc/letsencrypt/live/coderover.must.company/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/coderover.must.company/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_ciphers HIGH:!aNULL:!MD5;
  ssl_prefer_server_ciphers on;
  ssl_session_cache shared:SSL:10m;
  ssl_session_timeout 10m;

  # Security headers
  add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
  add_header X-Content-Type-Options nosniff always;
  add_header X-Frame-Options SAMEORIGIN always;
  add_header Referrer-Policy strict-origin-when-cross-origin always;

  # Compression
  gzip on;
  gzip_vary on;
  gzip_min_length 1024;
  gzip_types text/plain text/css text/javascript application/javascript application/json image/svg+xml;

  # Marketing: serve the static landing at root
  location = / {
    try_files /landing/index.html =404;
    add_header Cache-Control "public, max-age=300";
  }

  # Landing assets (video, fonts)
  location /landing/ {
    try_files $uri =404;
    location ~* \.(mp4|webm|otf|ttf|woff2)$ {
      expires 30d;
      add_header Cache-Control "public, immutable";
    }
  }

  # Hashed SPA assets
  location /assets/ {
    try_files $uri =404;
    expires 1y;
    add_header Cache-Control "public, immutable";
  }

  # API → Docker
  location /api/ {
    proxy_pass http://127.0.0.1:3001/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;   # streaming chat responses
  }

  # Auth callback
  location /auth/ {
    proxy_pass http://127.0.0.1:3001/auth/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }

  # SPA fallback — any route not matched above goes to index.html
  location / {
    try_files $uri $uri/ /index.html;
    add_header Cache-Control "no-cache";
  }

  # Robots
  location = /robots.txt {
    try_files /robots.txt =404;
    access_log off;
  }
}
```

Enable it:

```bash
sudo ln -s /etc/nginx/sites-available/coderover /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default
sudo nginx -t          # MUST pass before reload
```

**Don't reload yet** — the SSL cert doesn't exist. Certbot generates a stub config first. Continue to step 7.

---

## § 7 — DNS + Let's Encrypt SSL

### 7a. DNS record

Message devops (or self-serve if you own DNS):

> **Add:**
> - `coderover.must.company` A → `<VPS_IP>`
> - `coderover.must.company` AAAA → `<VPS_IPv6>` (get from `ip -6 addr show`)
> - TTL 300 initially

Wait for propagation:

```bash
dig +short coderover.must.company
# Should return <VPS_IP>
```

Don't continue until DNS resolves globally. Test from your laptop and from `dig @8.8.8.8 coderover.must.company +short`.

### 7b. Certbot (Let's Encrypt)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo mkdir -p /var/www/certbot

# Start with a temp HTTP-only config so certbot can bind
sudo nano /etc/nginx/sites-available/coderover
# Comment out the entire "listen 443 ssl" server block for now.
# Keep only the :80 server block.

sudo systemctl enable --now nginx
sudo nginx -t && sudo systemctl reload nginx

# Run certbot in webroot mode
sudo certbot certonly --webroot -w /var/www/certbot -d coderover.must.company \
  --email ops@must.company --agree-tos --no-eff-email

# If successful, cert lives at /etc/letsencrypt/live/coderover.must.company/
sudo ls /etc/letsencrypt/live/coderover.must.company/
```

Restore the 443 block in `sites-available/coderover`, then:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Auto-renewal is installed as a systemd timer by certbot. Verify:

```bash
sudo systemctl list-timers | grep certbot
sudo certbot renew --dry-run
```

---

## § 8 — Systemd unit for docker-compose survival

```bash
sudo nano /etc/systemd/system/coderover-api.service
```

```ini
[Unit]
Description=CodeRover API (docker compose)
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
User=deploy
WorkingDirectory=/home/deploy/coderover/coderover-api
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=300
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
```

Enable:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now coderover-api
sudo systemctl status coderover-api
```

Reboot the VPS once to confirm:

```bash
sudo reboot
# Wait 60s, reconnect, then:
docker compose -f ~/coderover/coderover-api/docker-compose.yml ps
# Should show all services Up
```

---

## § 9 — Smoke test

From your laptop:

```bash
# Landing page
curl -sI https://coderover.must.company/ | head -5
# Should return 200 OK, Content-Type text/html

# SPA routes
curl -sI https://coderover.must.company/login | head -5
# Should return 200 (SPA fallback)

# API health
curl -s https://coderover.must.company/api/health | jq .
# Should return {"status":"ok", ...}

# Landing video
curl -sI https://coderover.must.company/landing/cr_video.mp4 | head -5
# Should return 206 Partial Content or 200

# SSL grade
curl -sI https://coderover.must.company/ | grep -i strict-transport
# Should show HSTS header
```

Then open in a real browser:

- `https://coderover.must.company/` — landing page with video
- `https://coderover.must.company/login` — login page with BOKEH wordmark, `§ Mission Control · v0.12.1` kicker
- `https://coderover.must.company/design-system` — brand primitives

All 🔒 lock icons should be green.

---

## § 10 — Backups (don't skip this)

Nightly `pg_dump` + Memgraph snapshot + artifacts tarball, shipped off-VPS.

### 10a. Object storage credentials

Options (pick one):
- **Cloudflare R2** — cheapest, no egress fees: https://dash.cloudflare.com → R2 → Create bucket `coderover-backups`
- **Contabo Object Storage** — €3/mo, already with your VPS provider
- **AWS S3** — simplest if you already have an AWS account

Get an Access Key + Secret + Endpoint URL.

### 10b. Install `rclone`

```bash
sudo apt install -y rclone awscli

# Configure rclone for your storage (example: Cloudflare R2)
rclone config
# - n) New remote
# - name: r2
# - storage: s3
# - provider: Cloudflare
# - access key + secret
# - endpoint: https://<account-id>.r2.cloudflarestorage.com
```

### 10c. Backup script

```bash
sudo nano /usr/local/bin/coderover-backup.sh
```

```bash
#!/bin/bash
set -euo pipefail

DATE=$(date -u +%Y%m%d-%H%M%S)
BACKUP_DIR=/var/backups/coderover
mkdir -p "$BACKUP_DIR"

# Postgres
docker compose -f /home/deploy/coderover/coderover-api/docker-compose.yml exec -T postgres \
  pg_dump -U postgres coderover | gzip > "$BACKUP_DIR/postgres-$DATE.sql.gz"

# Memgraph snapshot (uses its built-in snapshot mechanism)
docker compose -f /home/deploy/coderover/coderover-api/docker-compose.yml exec -T memgraph \
  mgconsole --use-ssl=false <<< "CREATE SNAPSHOT;" || true

# Ship to R2 (or your chosen remote)
rclone copy "$BACKUP_DIR/postgres-$DATE.sql.gz" r2:coderover-backups/postgres/
rclone copy /var/lib/docker/volumes/coderover-api_memgraph_data/_data/snapshots/ r2:coderover-backups/memgraph/$DATE/

# Local retention: keep last 7
find "$BACKUP_DIR" -name "postgres-*.sql.gz" -mtime +7 -delete

# Remote retention: keep 30 days
rclone delete r2:coderover-backups/postgres/ --min-age 30d
```

```bash
sudo chmod +x /usr/local/bin/coderover-backup.sh
```

### 10d. Cron it

```bash
sudo crontab -e
```

```
# Nightly at 03:00 UTC (12:00 KST, low traffic)
0 3 * * * /usr/local/bin/coderover-backup.sh >> /var/log/coderover-backup.log 2>&1
```

### 10e. **Test a restore before trusting it**

On your laptop (or a scratch container):

```bash
rclone copy r2:coderover-backups/postgres/ ./restore-test/ --max-depth 1
gunzip ./restore-test/postgres-*.sql.gz | head -20
# Should show valid SQL dump headers
```

**If this doesn't work, backups are theater.** Do it.

---

## § 11 — Monitoring

Three layers, free tiers are fine for Day 1.

### 11a. Uptime — UptimeRobot

1. Sign up at https://uptimerobot.com (free: 50 monitors, 5-min interval)
2. Add HTTP(S) monitor:
   - URL: `https://coderover.must.company/api/health`
   - Keyword: `"status":"ok"` (content match)
   - Alert contacts: your email + Slack webhook if you have one
3. Add a second monitor for the landing page: `https://coderover.must.company/`

### 11b. APM — Honeycomb (OTel already wired)

1. Sign up at https://ui.honeycomb.io (free: 100M events/mo)
2. Copy your ingest key
3. Set in `.env` (already templated):
   ```
   OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io
   OTEL_EXPORTER_OTLP_HEADERS=x-honeycomb-team=<ingest-key>
   OTEL_SERVICE_NAME=coderover-api
   ```
4. Restart: `docker compose restart api`
5. Visit Honeycomb dashboard → `coderover-api` dataset should appear within a minute

### 11c. Logs — Better Stack (or similar)

Cheapest option: rely on `docker compose logs` shipped to a local file with rotation. For centralized logs:

1. Sign up at https://betterstack.com (free: 3 GB/day)
2. Get source token
3. Configure Docker logging driver:
   ```bash
   sudo nano /etc/docker/daemon.json
   ```
   ```json
   {
     "log-driver": "syslog",
     "log-opts": {
       "syslog-address": "tcp+tls://<your-logtail-host>:<port>",
       "tag": "coderover-{{.Name}}"
     }
   }
   ```
4. Restart Docker: `sudo systemctl restart docker`

Or skip for Day 1 and add later when you start debugging your first real incident.

---

## § 12 — Cloudflare (optional but recommended)

Putting Cloudflare in front gives you DDoS protection + edge cache + WAF for free.

1. Sign up at https://cloudflare.com (free)
2. Add `must.company` as a site
3. Update nameservers at your registrar to Cloudflare's (takes 1-24h to propagate)
4. Once active, turn on:
   - **SSL/TLS** → Full (strict) — requires Let's Encrypt already running, which it is
   - **Always Use HTTPS** → On
   - **Automatic HTTPS Rewrites** → On
   - **Minimum TLS Version** → 1.2
5. For `coderover.must.company`, set the proxy status to ☁️ orange (proxied)
6. **Page Rules:**
   - `coderover.must.company/landing/*` → Cache Level: Cache Everything, Edge TTL: 1 day
   - `coderover.must.company/assets/*` → Cache Level: Cache Everything, Edge TTL: 1 month
7. **Firewall rules:**
   - Rate limit `/api/*` to 60 req/min/IP
   - Challenge known bad user-agents on `/`

Cloudflare surface area increase: zero. Risk reduction: significant.

---

## § 13 — Post-deploy verification

Run the `/canary` skill from gstack once the site is live:

```bash
# Locally, in the repo:
# /canary
```

It'll capture baseline screenshots + performance metrics. Next deploy gets compared against this baseline.

Also run `/qa` (as admin since `qa@coderover.dev` is promoted) to walk every page including the admin-gated routes (`/operations`, `/agents`, `/settings`).

---

## § Rollback plan

If anything breaks after the cutover:

### Quick rollback (reverts to pre-deploy nginx config)

```bash
sudo cp /etc/nginx/sites-available/coderover.bak /etc/nginx/sites-available/coderover
sudo nginx -t && sudo systemctl reload nginx
# 5 seconds, traffic bypasses the broken config
```

Make a backup *before* changing nginx:

```bash
sudo cp /etc/nginx/sites-available/coderover /etc/nginx/sites-available/coderover.bak
```

### Full app rollback (git + docker)

```bash
cd ~/coderover
git log --oneline -5   # find the last known-good commit
git checkout <commit>
cd coderover-api
docker compose down
docker compose up -d --build
```

### DB restore from backup

```bash
# Download the latest backup
rclone copy r2:coderover-backups/postgres/postgres-<date>.sql.gz /tmp/
gunzip /tmp/postgres-*.sql.gz

# Stop the app, restore, restart
docker compose stop api
docker compose exec -T postgres psql -U postgres -c "DROP DATABASE coderover;"
docker compose exec -T postgres psql -U postgres -c "CREATE DATABASE coderover;"
cat /tmp/postgres-*.sql | docker compose exec -T postgres psql -U postgres coderover
docker compose start api
```

---

## § Recurring ops tasks

| Frequency | Task | Command |
|---|---|---|
| Daily (auto) | DB + Memgraph backup | `/usr/local/bin/coderover-backup.sh` via cron |
| Daily (auto) | System package updates | `unattended-upgrades` |
| Weekly | Check uptime dashboard | UptimeRobot |
| Weekly | Check error budget | Honeycomb `coderover-api` dataset |
| Monthly | Let's Encrypt renewal check | `sudo certbot renew --dry-run` |
| Monthly | Test backup restore | restore latest dump to scratch env |
| Quarterly | Rotate JWT_SECRET | invalidates all sessions; coordinate |
| Quarterly | Rotate API keys (OpenRouter, GitHub PAT) | pre-announce, zero-downtime rotate |
| Per deploy | Run `/qa` on public URL | gstack skill |
| Per deploy | Run `/canary` for regression baseline | gstack skill |

---

## § References

- [`landing-nginx.md`](./landing-nginx.md) — routing contract for landing + SPA + API
- [`DESIGN.md`](../../DESIGN.md) — brand token system (for validating post-deploy visuals)
- `CHANGELOG.md` — what shipped and when

---

## § What this runbook does NOT cover

- **Multi-region HA** — single VPS, no failover. Add a second VPS + floating IP when traffic justifies it.
- **Managed DB migration** — when self-hosted Postgres becomes operationally annoying, move to Neon / Crunchy Bridge. Keeps VPS stateless.
- **Load testing** — use `k6` or `wrk` against a staging copy before a real launch spike.
- **Incident response** — write this after your first real incident. Template: `docs/runbooks/incident-template.md` (TBD).

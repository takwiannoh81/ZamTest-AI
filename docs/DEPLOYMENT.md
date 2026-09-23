# Deploying to zamtechai.com

The production stack runs on one Linux server with Docker. Caddy serves the apps and obtains HTTPS certificates automatically.

| Address | What it serves |
|---|---|
| `https://zamtechai.com` | Public website (`www.` redirects here) |
| `https://portal.zamtechai.com` | Portal |
| `https://designer.zamtechai.com` | Designer |
| `https://api.zamtechai.com` | API for bot agents running on your own machines |

The Portal and Designer call `/api` on their own address. Caddy forwards those calls to the orchestrator, so the browser never needs cross-site access.

## 1. Server

Any Linux VPS works, for example Ubuntu 24.04 with 2 vCPU, 4 GB RAM and 40 GB disk. Add more if cloud bot agents will run browsers on it.

1. Install Docker with the Compose plugin (<https://docs.docker.com/engine/install/>).
2. Open ports **80** and **443** (TCP, plus UDP 443 for HTTP/3) in the provider's firewall. Keep SSH restricted to your own IP addresses.

## 2. DNS

At your domain registrar, create these records, pointing at the server's public IPv4 address. If the server also has IPv6, add matching `AAAA` records.

| Type | Name | Value |
|---|---|---|
| A | `@` | server IP |
| A | `www` | server IP |
| A | `portal` | server IP |
| A | `designer` | server IP |
| A | `api` | server IP |

Wait until `dig +short portal.zamtechai.com` returns the server IP. Caddy can only get certificates once DNS points at the server.

## 3. Configure and start

```bash
git clone https://github.com/takwiannoh81/ZamTest-AI.git
cd ZamTest-AI/deploy
./init-env.sh               # asks for domain + email, generates secrets into deploy/.env
docker compose up -d --build
```

`init-env.sh` prints the **admin token**. Keep it safe: it is the password for the Portal and Designer. Both apps ask for it the first time you open them.

The orchestrator refuses to start in production without a strong admin token and agent key, so a server can't go live with the development defaults.

To enable the AI features, put `ANTHROPIC_API_KEY` in `deploy/.env` and run `docker compose up -d` again.

## 4. Bot agents

**On the server (cloud bot):**

```bash
docker compose --profile agent up -d --build
```

This bot includes Playwright browsers and runs in headless mode.

**On your own Windows, Mac or Linux machines:** install Node 20+ and pnpm, clone the repo, then run:

```bash
pnpm install
pnpm --filter @zamtest/agent exec playwright install chromium
ZAMTEST_SERVER=https://api.zamtechai.com \
ZAMTEST_AGENT_KEY=<value from deploy/.env> \
ZAMTEST_AGENT_NAME=finance-pc-01 \
pnpm --filter @zamtest/agent start
```

Agents only make outbound HTTPS requests, so they work behind company firewalls and NAT.

## 5. Operations

| Task | Command |
|---|---|
| Update to the latest code | `git pull && docker compose up -d --build` |
| Logs | `docker compose logs -f orchestrator` (or `web`, `agent`) |
| Backup | `docker run --rm -v zamtest_zamtest_data:/data -v $PWD:/backup alpine tar czf /backup/zamtest-$(date +%F).tgz -C /data .` |
| Restore | Stop the stack, extract the archive into the `zamtest_zamtest_data` volume, then start it again |

Back up the data volume regularly. It holds the workflows, processes, jobs, schedules and assets, including credentials. Until encryption at rest ships (see the roadmap), store the backups somewhere private.

## Security checklist

- [ ] `deploy/.env` stays on the server (it is git-ignored and created with permissions 600).
- [ ] The admin token is shared only with people who should administer the platform.
- [ ] SSH access uses keys, not passwords.
- [ ] Backups are scheduled and stored privately.
- [ ] User accounts, roles and SSO are the next security milestone (see [ROADMAP.md](ROADMAP.md)). Until then, everyone signs in with the same admin token.

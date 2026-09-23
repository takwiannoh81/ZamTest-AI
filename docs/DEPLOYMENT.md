# Deploying to zamtechai.com

The production stack runs on one Linux server with Docker. Caddy serves the apps and obtains HTTPS certificates automatically.

| Address | What it serves |
|---|---|
| `https://zamtechai.com` | Public website (`www.` redirects here) |
| `https://portal.zamtechai.com` | Portal |
| `https://designer.zamtechai.com` | Designer |
| `https://api.zamtechai.com` | API for bot agents running on your own machines |

The Portal and Designer call `/api` on their own address. Caddy forwards those calls to the orchestrator, so the browser never needs cross-site access.

## Quick path: AWS Lightsail (zamtechai.com)

These steps are for the Lightsail instance with static IP `18.227.11.31`.

1. **Firewall.** In Lightsail, open the instance, go to **Networking**, then **IPv4 Firewall**, and add a rule for **HTTPS (TCP 443)**. HTTP (80) and SSH (22) are open by default. If you add IPv6 DNS records later, add the same rules under **IPv6 Firewall**.
2. **DNS.** The domain is managed at Squarespace (**Domains**, then zamtechai.com, then **DNS**).
   - Replace the Squarespace records for `@` and `www` with `A` records pointing to `18.227.11.31`. Doing this takes down any site that Squarespace currently serves on the domain.
   - Add `A` records for `portal`, `designer` and `api` pointing to `18.227.11.31`.
   - Leave out `AAAA` (IPv6) records to begin with. That keeps certificate issuance to IPv4 only.
3. **Install.** Click **Connect using SSH** in Lightsail to open a terminal in the browser. Then run:
   ```bash
   sudo apt-get update && sudo apt-get install -y git
   git clone -b claude/low-code-automation-platform-13z01c https://github.com/takwiannoh81/ZamTest-AI.git
   sudo bash ZamTest-AI/deploy/install.sh
   ```
   If the repository is private, git asks for your GitHub username and a personal access token. A read-only token for this repo is enough.

   The script then does the following:
   - Adds swap memory, installs Docker and asks for your domain and email.
   - Generates the secrets and checks DNS.
   - Builds and starts everything. The first build takes about 5–10 minutes on a 2 GB instance.
4. **Sign in.** Run `sudo grep ZAMTEST_ADMIN_TOKEN ZamTest-AI/deploy/.env` to show the admin token, then open `https://portal.zamtechai.com` and sign in with it.

To update later, run `sudo bash ZamTest-AI/deploy/install.sh` again. It keeps your secrets and data.

The sections below explain each part in more detail and apply to any provider.

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

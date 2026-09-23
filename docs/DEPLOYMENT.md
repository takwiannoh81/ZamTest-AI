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

## 5. User accounts

People sign in with their own email and password. Each account has one role:

| Role | Can do |
|---|---|
| **Admin** | Everything, including users, backups and removing bot agents |
| **Developer** | Build, test and publish workflows; manage schedules and assets |
| **Operator** | Start and stop jobs, run schedules; view everything |
| **Viewer** | Read-only |

**First-time setup:**
1. Open the Portal. On the sign-in screen, click **Use the master access token instead** and paste `ZAMTEST_ADMIN_TOKEN` from `deploy/.env`.
2. Go to **Users**, then **+ New user**, and create your own **Admin** account. Then create an account for each teammate.
3. Sign out and sign back in with your email and password.

After that, keep the master token for emergencies only, for example if every admin is locked out. Sessions last 7 days. Changing a password signs that person out everywhere else. Repeated failed sign-ins are blocked for a few minutes.

## 6. Backups to Amazon S3

The orchestrator writes a compressed, encrypted (SSE-S3) copy of the database to S3 every night at 03:00 server time, and deletes copies older than 30 days. Admins see the status under **Settings**, where there is also a **Back up now** button.

**Automatic setup (recommended):**
1. In the AWS console, click the **CloudShell** icon (`>_`) in the top bar and wait for the prompt.
2. Paste:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/takwiannoh81/ZamTest-AI/claude/low-code-automation-platform-13z01c/deploy/aws-setup-backups.sh | bash
   ```
   The script:
   - creates a private, versioned, encrypted bucket
   - creates the `zamtech-backups` policy, limited to that bucket's `zamtest/` folder
   - creates the `zamtech-backup` user with an access key
   - prints one block of commands
3. Paste that block into the Lightsail terminal. It stores the settings, updates the server, and runs a test backup that should end with **Backup OK**.

**Manual setup in the AWS console** (the same steps, done by hand):
1. **Create a bucket.** In S3, click **Create bucket**, for example `zamtechai-backups`, in your region (for example us-east-2). Keep **Block all public access** turned on and turn **Bucket versioning** on.
2. **Create a policy.** In IAM, go to **Policies**, then **Create policy**, then the **JSON** tab. Paste [`deploy/backup-iam-policy.json`](../deploy/backup-iam-policy.json), replacing `YOUR-BUCKET-NAME` with your bucket name. Name the policy `zamtech-backups`.
3. **Create a user.** In IAM, go to **Users**, then **Create user**, for example `zamtech-backup`. Choose **Attach policies directly**, select `zamtech-backups`, and create the user. This user can only reach this one bucket folder.
4. **Create an access key.** Open the new user, go to **Security credentials**, then **Create access key**, and choose **Application running outside AWS**. Copy both values.
5. **Add the settings on the server.** Run `sudo nano ~/ZamTest-AI/deploy/.env` and add these lines:
   ```
   ZAMTEST_BACKUP_S3_BUCKET=zamtechai-backups
   ZAMTEST_BACKUP_S3_REGION=us-east-2
   AWS_ACCESS_KEY_ID=AKIA...
   AWS_SECRET_ACCESS_KEY=...
   ```
   Then run `cd ~/ZamTest-AI/deploy && sudo docker compose up -d`.
6. **Test it.** In the Portal, go to **Settings**, then **Backups**, then **Back up now**.

Never paste these keys into chats, tickets or the repository. They belong only in `deploy/.env` on the server.

**Restore:**
```bash
cd ~/ZamTest-AI/deploy
sudo docker compose stop orchestrator
sudo docker compose run --rm orchestrator node_modules/.bin/tsx apps/orchestrator/src/restore.ts latest
sudo docker compose start orchestrator
```
To restore an older copy, replace `latest` with an object key from S3, for example `zamtest/db-2026-09-20T03-00-00-000Z.json.gz`. The database that was replaced is kept next to it as `db.json.before-restore-<time>`.

## 7. Operations

| Task | Command |
|---|---|
| Update to the latest code | `git pull && docker compose up -d --build` |
| Logs | `docker compose logs -f orchestrator` (or `web`, `agent`) |
| Manual local backup | `docker run --rm -v zamtest_zamtest_data:/data -v $PWD:/backup alpine tar czf /backup/zamtest-$(date +%F).tgz -C /data .` |
| Restore | Stop the stack, extract the archive into the `zamtest_zamtest_data` volume, then start it again |

The data volume holds the workflows, processes, jobs, schedules, assets (including credentials) and user accounts (passwords are stored only as scrypt hashes). Set up the S3 backups in section 6 so that copies leave the server every night.

## Security checklist

- [ ] `deploy/.env` stays on the server (it is git-ignored and created with permissions 600).
- [ ] The admin token is shared only with people who should administer the platform.
- [ ] SSH access uses keys, not passwords.
- [ ] Every person has their own account. The master token is kept for emergencies only.
- [ ] S3 backups are configured, the bucket blocks public access, and the backup IAM user can reach only that bucket.

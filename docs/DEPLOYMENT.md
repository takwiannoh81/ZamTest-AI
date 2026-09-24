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

## 4a. AI features

Run this on the server and paste your Anthropic API key when asked (the input stays hidden):
```bash
sudo bash ~/ZamTest-AI/deploy/set-env.sh ANTHROPIC_API_KEY
```
The script saves the key and restarts the services, including the cloud bot. The Portal's **Settings** page then shows that AI is enabled.

## 4. Bot agents

**On the server (cloud bot):**

```bash
docker compose --profile agent up -d --build
```

This bot includes Playwright browsers and runs in headless mode.

**On your own Windows PCs:** use the Windows installer (below). **On Mac or Linux machines:** install Node 20+ and pnpm, clone the repo, then connect the machine and start the agent:

```bash
pnpm install
pnpm --filter @zamtest/agent exec playwright install chromium
cd apps/agent
npx tsx src/cli.ts enroll --server https://api.zamtechai.com --name build-server-01 --config agent.json
npx tsx src/cli.ts connect --config agent.json
```

`enroll` prints (and opens) a link to the Portal, where a Developer or Admin approves the machine; with `--install-key <key>` it is approved at once. The machine then has its own credential in `agent.json`. Agents can also still sign in with the shared `ZAMTEST_AGENT_KEY` (the cloud bot does); leave it out of `deploy/.env` to allow only approved machines.

Agents only make outbound HTTPS requests, so they work behind company firewalls and NAT. On machines without a screen, such as servers and containers, browsers run headless automatically.

**Recording a workflow (on your own computer):**
```bash
pnpm --filter @zamtest/agent exec tsx src/cli.ts record https://erp.example.com --upload --server https://api.zamtechai.com
```
1. **Record:** a browser window opens. Click through the process once.
2. **Finish:** close the window, or press Enter in the terminal.
3. **Upload:** sign in with your ZamTech AI email and password when asked. The workflow appears in the Designer, where you can review it, test it and publish it.

**Windows desktop bots (desktop applications such as SAP GUI, ERP clients, Excel or Notepad):**

Desktop actions (**Desktop** category in the Designer) drive Windows applications through Microsoft UI Automation. They use the Windows PowerShell and UI Automation that come with every Windows 10/11 PC, so there is nothing extra to install. They only run on a Windows bot agent, and the agent must run **inside a signed-in desktop session**: start it from a normal user session, not as a Windows service, and keep the session unlocked. With RDP, keep the session open rather than minimised, or use a console session.

**The easy way: the Windows installer.** People sign in to the Portal (the **Sign in** button on zamtechai.com takes them there) and click **Download for Windows** in the side menu. `ZamTechAI-Agent-Setup.exe` installs the agent for the signed-in Windows user: no administrator rights, nothing else to install, nothing to type. Its last page shows the Designer's address with a **Copy** button. On **Finish**, the browser opens **Connect this PC** in the Portal. The person checks that the code there matches the one on the ZamTech AI tray icon and clicks **Approve this PC**; this needs the Developer or Admin role, because a connected PC can use the workspace's stored credentials. The Designer then opens by itself.

The agent runs from a tray icon, starts when the user signs in and restarts itself if it stops. Right-click the tray icon for **Open Designer**, **Open Portal**, **Settings** (server, bot name, **Connect this PC again**), **Open log**, **Run desktop self-test** and **Record a desktop workflow**. It installs to `%LOCALAPPDATA%\Programs\ZamTech AI Agent`, with its settings in `agent.json` and daily logs in `logs\` there. The **Bot Agents** page lists every PC and who approved it; **Remove** disconnects a PC at once, and it has to be approved again to reconnect.

- **Each PC has its own credential**, issued when it is approved and kept encrypted for that Windows user (Windows DPAPI) as `tokenProtected` in `agent.json`. The server keeps only a hash of it. Another user, or a copy of the file on another PC, cannot use it; there, choose **Settings > Connect this PC again**.
- **Stopping never cuts a job short without asking.** **Quit** and **Restart** let a running job finish first (up to 10 minutes) and ask whether to cancel it instead. An upgrade or uninstall asks the same; run silently, it waits for the job. A cancelled job is reported to the orchestrator as *cancelled*.
- Releases are signed by **ZAMTECH&HOME LLC**, so Windows names the publisher. For the first releases, SmartScreen may still say "Windows protected your PC" until the publisher has built up reputation; choose **More info**, then **Run anyway**. Builds from branches are unsigned.

To roll it out to many PCs without anyone approving each one, an Admin creates an **install key** on the **Bot Agents** page (with a limit on the number of PCs and an expiry date) and copies the silent install command shown there:
```powershell
ZamTechAI-Agent-Setup.exe /VERYSILENT /SERVER=https://api.zamtechai.com /INSTALLKEY=<install key> /NAME=finance-pc-01
```
PCs installed this way are approved by the key, and the Bot Agents page says so. Delete the key when the rollout is done; PCs already connected keep working. Options: `/MERGETASKS="browsers"` also downloads Chromium for web automation, `/MERGETASKS="!autostart"` does not start the agent at sign-in, `/NOSTART` leaves it stopped after setup, and `/CANCELJOB` cancels a running job instead of waiting for it during an upgrade.

**Building and releasing the installer.** Build it on Windows with [Inno Setup 6](https://jrsoftware.org/isinfo.php) (`winget install JRSoftware.InnoSetup`):
```powershell
pnpm --filter @zamtest/agent build:installer
powershell -File apps/agent/installer/test-install.ps1   # install silently, check, uninstall
```
The setup file lands in `apps/agent/dist/installer/`. The **Agent installer (Windows)** GitHub Actions workflow builds and tests an unsigned installer on every change to the agent. To publish a signed version, raise `version` in `apps/agent/package.json`, commit, and push a tag with the same version:
```bash
git tag agent-v0.1.0 && git push origin agent-v0.1.0
```
The workflow then builds the installer signed, checks every signature, and creates the GitHub Release that the Portal's download button points to. A self-hosted Portal can link to its own copy instead by building it with `VITE_AGENT_DOWNLOAD_URL`.

**Code signing** uses [Azure Artifact Signing](https://learn.microsoft.com/azure/artifact-signing/) (formerly Trusted Signing): the Artifact Signing account `zamtech` (East US) and its certificate profile `ZamTechAI`, issued to the validated company ZAMTECH&HOME LLC. The account settings are in `apps/agent/installer/artifact-signing.json`. The build signs the tray app, the setup file and the uninstaller, and Inno Setup refuses to finish if a signature is missing. Certificates last three days and are renewed by the service; every signature is timestamped, so signed files stay valid afterwards.

One-time setup for GitHub, so releases can sign without any stored password:
1. In **Microsoft Entra ID > App registrations**, create an app (e.g. `zamtech-agent-github-signing`). Under **Certificates & secrets > Federated credentials**, add a credential for **GitHub Actions deploying Azure resources**: organization `takwiannoh81`, repository `ZamTest-AI`, entity type **Environment**, name `release`.
2. On the certificate profile **ZamTechAI**, open **Access control (IAM)** and give that app the **Artifact Signing Certificate Profile Signer** role.
3. In the GitHub repository, go to **Settings > Environments**, create the environment `release` and add the secrets `AZURE_CLIENT_ID` (the app's Application ID), `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID`. Optionally add yourself as a required reviewer, so every release waits for your approval.

To sign on your own PC instead: install the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli-windows), run `az login` with an account that has the Signer role on the profile, and build with `ZAMTEST_ARTIFACT_SIGNING=1`. It needs the Windows SDK's `signtool` and the .NET 8 runtime; the build downloads Microsoft's signing plug-in by itself. With a certificate from another authority, set `ZAMTEST_SIGN_COMMAND` to a command that signs one file, with `{file}` where the file goes.

**Unattended PCs (no one signed in).** Desktop automation needs a signed-in, unlocked Windows session, so a bot PC that must come back by itself after a reboot or a Windows update should sign in automatically:

1. Create a dedicated local Windows account for the bot, with only the rights its automations need. Install the agent while signed in as that account.
2. Turn on automatic sign-in with Microsoft's [Sysinternals Autologon](https://learn.microsoft.com/sysinternals/downloads/autologon): run it as an administrator, enter the bot account's user name, domain and password, and click **Enable**. It stores the password encrypted (as an LSA secret), not in plain text in the registry.
3. Keep the session unlocked: in **Settings > Accounts > Sign-in options** set *If you've been away, when should Windows require you to sign in again?* to **Never**; turn off the screen saver lock; and in **Settings > System > Power** set sleep to **Never**. A company Group Policy that locks idle sessions must exclude this account.
4. For virtual machines reached over Remote Desktop: closing the RDP window locks the session, and a locked session cannot be automated. Disconnect with `tscon %sessionname% /dest:console` (run as administrator inside the session) instead, which hands the session back to the console unlocked.
5. Reboot once and check that the agent appears as online on the Portal's **Agents** page.

Anyone with physical access to an auto-signed-in PC can use that account, so keep bot PCs in a locked room or run them as virtual machines, and turn on BitLocker.

**From source instead:**

1. Install Node 20+ and pnpm, then clone the repo as above.
2. Check that desktop automation works on the machine:
   ```powershell
   pnpm install
   pnpm --filter @zamtest/agent exec tsx src/cli.ts desktop-test
   ```
   This test opens Notepad and Calculator, types, clicks and reads text back. It writes `desktop-test-report.txt`; send that file along if anything fails.
3. Connect the PC (approve it in the Portal when the browser opens), then start the agent in PowerShell:
   ```powershell
   cd apps/agent
   npx tsx src/cli.ts enroll --server https://api.zamtechai.com --name finance-pc-01 --config agent.json
   npx tsx src/cli.ts connect --config agent.json
   ```
4. To run desktop processes on this bot, pick it as the target agent when starting a process or creating a schedule. The cloud bot on the Linux server cannot run desktop actions.

**Recording a desktop workflow (Windows):**
```powershell
pnpm --filter @zamtest/agent exec tsx src/cli.ts record-desktop notepad.exe --upload --server https://api.zamtechai.com
```
1. **Record:** the program starts, and only that program is recorded. Add `--all-apps` to record every application, or leave the program name out to record whatever is already open. Work through the process once.
2. **Finish:** return to the terminal and press Enter.
3. **Upload:** the result is a workflow of **Start Application**, **Click (Desktop)** and **Type Into (Desktop)** steps, with selectors such as `window[process="notepad"] > document`. Anything typed into a password field becomes a `password` input rather than being stored.

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

People sign in only in the Portal. The Designer uses the same sign-in: an HttpOnly cookie for the whole domain (`ZAMTEST_COOKIE_DOMAIN`, set to `.zamtechai.com` by `docker-compose.yml`). Opening the Designer without a session goes to the Portal's sign-in and back, and signing out in either app signs out of both. Everyone signs in once more after the server is updated to this version.

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

#!/usr/bin/env bash
# One-command installer for a fresh Ubuntu/Debian server (e.g. AWS Lightsail).
#
#   curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/<branch>/deploy/install.sh | sudo bash
#   or, from a clone:  sudo bash deploy/install.sh
#
# Safe to re-run: it updates the code and restarts the stack, and never
# overwrites deploy/.env (your secrets).
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/takwiannoh81/ZamTest-AI.git}"
BRANCH="${BRANCH:-claude/low-code-automation-platform-13z01c}"
# Running from inside a clone? Use that clone instead of making another one.
SCRIPT_REPO="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd || true)"
if [ -z "${INSTALL_DIR:-}" ] && [ -n "$SCRIPT_REPO" ] && [ -d "$SCRIPT_REPO/.git" ]; then
  INSTALL_DIR="$SCRIPT_REPO"
fi
INSTALL_DIR="${INSTALL_DIR:-/opt/zamtest}"

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33mWARNING: %s\033[0m\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root: sudo bash $0" >&2
  exit 1
fi

# The web images are built on the server; 2 GB RAM needs swap for that.
mem_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
if [ "$mem_kb" -lt 3500000 ] && ! swapon --show | grep -q .; then
  say "Adding a 2 GB swap file (this server has $((mem_kb / 1024)) MB RAM)"
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

say "Installing Docker, git and openssl"
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq git openssl curl ca-certificates dnsutils >/dev/null
else
  echo "This installer supports Ubuntu/Debian. On other systems install Docker + Compose manually (see docs/DEPLOYMENT.md)." >&2
  exit 1
fi
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null

say "Fetching ZamTech AI ($BRANCH)"
if [ -d "$INSTALL_DIR/.git" ]; then
  git config --global --add safe.directory "$INSTALL_DIR"
  if git -C "$INSTALL_DIR" fetch --quiet origin "$BRANCH"; then
    git -C "$INSTALL_DIR" checkout --quiet "$BRANCH"
    git -C "$INSTALL_DIR" merge --quiet --ff-only "origin/$BRANCH" || warn "Local changes in $INSTALL_DIR; using the code as it is."
  else
    warn "Could not fetch updates; using the code already in $INSTALL_DIR."
  fi
else
  echo "If the repository is private, git asks for your GitHub username and a personal access token (read-only is enough)."
  git clone --quiet --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR/deploy"

if [ ! -f .env ]; then
  say "Creating deploy/.env with fresh secrets"
  # init-env.sh is interactive; read from the terminal even when piped from curl.
  bash ./init-env.sh < /dev/tty
fi
# Settings added in later versions: filled in on existing servers too.
if ! grep -q '^ZAMTEST_DB_PASSWORD=.' .env; then
  say "Creating the Postgres database password"
  grep -v '^ZAMTEST_DB_PASSWORD=' .env > .env.tmp || true
  printf 'ZAMTEST_DB_PASSWORD=%s\n' "$(openssl rand -hex 24)" >> .env.tmp
  cat .env.tmp > .env && rm -f .env.tmp
fi
# Only what this script needs. .env is not run as a script: values may contain
# spaces or <> (MAIL_FROM, passwords); Docker Compose reads the file itself.
SITE_DOMAIN=$(grep -m1 '^SITE_DOMAIN=' .env | cut -d= -f2- | tr -d "\"'\r")
[ -n "$SITE_DOMAIN" ] || { echo "SITE_DOMAIN is missing in $INSTALL_DIR/deploy/.env" >&2; exit 1; }

say "Checking DNS for $SITE_DOMAIN"
public_ip=$(curl -fsS -4 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || true)
dns_ok=1
for host in "$SITE_DOMAIN" "www.$SITE_DOMAIN" "portal.$SITE_DOMAIN" "designer.$SITE_DOMAIN" "api.$SITE_DOMAIN"; do
  resolved=$(dig +short A "$host" | tail -1)
  if [ -n "$public_ip" ] && [ "$resolved" = "$public_ip" ]; then
    echo "  ok       $host -> $resolved"
  else
    echo "  pending  $host -> ${resolved:-<none>} (should be $public_ip)"
    dns_ok=0
  fi
done
if [ "$dns_ok" -eq 0 ]; then
  warn "Some DNS records don't point here yet. The stack starts anyway; HTTPS certificates are issued automatically once DNS is correct (Caddy keeps retrying)."
fi

say "Building and starting the stack (the first build takes several minutes)"
docker compose up -d --build

say "Done"
cat <<EOF
  Website   https://$SITE_DOMAIN
  Portal    https://portal.$SITE_DOMAIN
  Designer  https://designer.$SITE_DOMAIN
  Agents    https://api.$SITE_DOMAIN

  Sign in to the Portal and Designer with the admin token in $INSTALL_DIR/deploy/.env:
    sudo grep ZAMTEST_ADMIN_TOKEN $INSTALL_DIR/deploy/.env

  Make sure ports 80 and 443 are open in your cloud firewall.
  Logs:    cd $INSTALL_DIR/deploy && sudo docker compose logs -f
  Update:  sudo bash $INSTALL_DIR/deploy/install.sh
EOF

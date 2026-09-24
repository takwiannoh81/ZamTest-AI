#!/usr/bin/env bash
# Sets up the server's email (confirm-your-email and password-reset messages)
# with Google Workspace or Gmail: asks for the account and its app password
# (hidden), saves SMTP_URL and MAIL_FROM in deploy/.env, restarts, and shows
# whether Google accepted the sign-in.
#
#   sudo bash ~/ZamTest-AI/deploy/set-email.sh
#
# For other SMTP services, use set-env.sh SMTP_URL (see docs/DEPLOYMENT.md, 5c).
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "deploy/.env not found; run install.sh first." >&2; exit 1; }

set_value() {
  local tmp
  tmp=$(mktemp)
  grep -v "^${1}=" .env > "$tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"
  cat "$tmp" > .env && rm -f "$tmp"
  chmod 600 .env
}

echo "Email for ZamTech AI, sent through Google Workspace / Gmail."
echo
read -rp "Google account that sends the emails (e.g. takwi@titaautomation.com): " account < /dev/tty
account="${account//[[:space:]]/}"
[[ "$account" == *@*.* ]] || { echo "That is not an email address." >&2; exit 1; }

printf 'App password of that account (16 letters; spaces are fine; input hidden): '
read -rs password < /dev/tty
echo
password="${password//[[:space:]]/}"
[[ "$password" =~ ^[A-Za-z]{16}$ ]] || { echo "An app password is 16 letters (from https://myaccount.google.com/apppasswords). Nothing changed." >&2; exit 1; }

read -rp "Send as [ZamTech AI <noreply@zamtechai.com>]: " from < /dev/tty
from="${from:-ZamTech AI <noreply@zamtechai.com>}"

set_value SMTP_URL "smtps://${account//@/%40}:${password}@smtp.gmail.com:465"
set_value MAIL_FROM "$from"
echo "Saved. Restarting the services..."
profiles=()
if docker compose ps --services --status running 2>/dev/null | grep -qx agent; then profiles=(--profile agent); fi
docker compose "${profiles[@]}" up -d >/dev/null

echo "Checking the sign-in with Google..."
for _ in $(seq 1 20); do
  sleep 2
  line=$(docker compose logs --since 2m orchestrator 2>/dev/null | grep -o '"msg":"Email:[^"]*"' | tail -1 || true)
  case "$line" in
    *"signed in"*) echo "OK: ${line#\"msg\":}"; exit 0 ;;
    *refused* | *"not valid"* | *"could not"* | *"no user"*) echo "Problem: ${line#\"msg\":}" >&2; exit 1 ;;
  esac
done
echo "No answer yet. Check with: cd $(pwd) && sudo docker compose logs orchestrator | grep Email: | tail -1"

#!/usr/bin/env sh
# Creates deploy/.env with fresh random secrets. Never overwrites an existing file.
set -eu
cd "$(dirname "$0")"
if [ -f .env ]; then
  echo "deploy/.env already exists; not touching it."
  exit 0
fi
printf "Domain [zamtechai.com]: "; read -r domain; domain=${domain:-zamtechai.com}
printf "Email for HTTPS certificate notices: "; read -r email
printf "Anthropic API key (optional, Enter to skip): "; read -r anthropic
umask 077
cat > .env <<ENV
SITE_DOMAIN=$domain
ACME_EMAIL=$email
ZAMTEST_ADMIN_TOKEN=$(openssl rand -hex 32)
ZAMTEST_AGENT_KEY=$(openssl rand -hex 32)
ANTHROPIC_API_KEY=$anthropic
ZAMTEST_AI_MODEL=
ENV
echo "Wrote deploy/.env (permissions 600)."
echo "Your admin token (sign in to the Portal and Designer with it):"
grep ZAMTEST_ADMIN_TOKEN .env | cut -d= -f2

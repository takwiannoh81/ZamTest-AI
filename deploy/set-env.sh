#!/usr/bin/env bash
# Sets one value in deploy/.env without opening an editor, then restarts the
# services so they pick it up. The value is typed hidden and never echoed.
#
#   sudo bash ~/ZamTest-AI/deploy/set-env.sh ANTHROPIC_API_KEY
set -euo pipefail
cd "$(dirname "$0")"
name="${1:-}"
if ! [[ "$name" =~ ^[A-Z][A-Z0-9_]*$ ]]; then
  echo "Usage: sudo bash $0 VARIABLE_NAME" >&2
  exit 1
fi
[ -f .env ] || { echo "deploy/.env not found; run install.sh first." >&2; exit 1; }
printf 'Value for %s (input hidden): ' "$name"
read -rs value < /dev/tty
echo
[ -n "$value" ] || { echo "Empty value; nothing changed." >&2; exit 1; }
tmp=$(mktemp)
grep -v "^${name}=" .env > "$tmp" || true
printf '%s=%s\n' "$name" "$value" >> "$tmp"
cat "$tmp" > .env && rm -f "$tmp"
chmod 600 .env
echo "Saved $name. Restarting services..."
profiles=()
if docker compose ps --services --status running 2>/dev/null | grep -qx agent; then profiles=(--profile agent); fi
docker compose "${profiles[@]}" up -d
echo "Done."

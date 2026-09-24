#!/usr/bin/env bash
# Sets values in deploy/.env without opening an editor, then restarts the
# services so they pick them up. Values are typed hidden and never echoed.
#
#   sudo bash ~/ZamTest-AI/deploy/set-env.sh ANTHROPIC_API_KEY
#   sudo bash ~/ZamTest-AI/deploy/set-env.sh --paste     (several NAME=value lines at once)
set -euo pipefail
cd "$(dirname "$0")"
name="${1:-}"
[ -f .env ] || { echo "deploy/.env not found; run install.sh first." >&2; exit 1; }

set_value() {
  local tmp
  tmp=$(mktemp)
  grep -v "^${1}=" .env > "$tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"
  cat "$tmp" > .env && rm -f "$tmp"
}

if [ "$name" = "--paste" ]; then
  echo "Paste the NAME=value lines, then press Enter on an empty line (input hidden):"
  saved=()
  while IFS= read -rs line < /dev/tty; do
    line="${line%$'\r'}"
    [ -z "$line" ] && break
    if ! [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(.+)$ ]]; then
      echo "Skipped a line that is not NAME=value." >&2
      continue
    fi
    set_value "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
    saved+=("${BASH_REMATCH[1]}")
  done
  echo
  [ "${#saved[@]}" -gt 0 ] || { echo "Nothing pasted; nothing changed." >&2; exit 1; }
  echo "Saved ${saved[*]}."
else
  if ! [[ "$name" =~ ^[A-Z][A-Z0-9_]*$ ]]; then
    echo "Usage: sudo bash $0 VARIABLE_NAME   or   sudo bash $0 --paste" >&2
    exit 1
  fi
  printf 'Value for %s (input hidden): ' "$name"
  read -rs value < /dev/tty
  echo
  value="${value%$'\r'}"
  [ -n "$value" ] || { echo "Empty value; nothing changed." >&2; exit 1; }
  set_value "$name" "$value"
  echo "Saved $name."
fi
chmod 600 .env
echo "Restarting services..."
profiles=()
if docker compose ps --services --status running 2>/dev/null | grep -qx agent; then profiles=(--profile agent); fi
docker compose "${profiles[@]}" up -d
echo "Done."

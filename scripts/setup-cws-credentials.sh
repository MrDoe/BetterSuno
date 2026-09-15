#!/usr/bin/env bash
# Set up ~/.cws-credentials.env for the Chrome Web Store API
# (see https://developer.chrome.com/docs/webstore/using-api).
#
# Usage: npm run setup:cws -- [--force] [--open]
#
#   --force   overwrite an existing credentials file without asking
#   --open    open the Cloud Console / Developer Dashboard pages first
#
# Prompts for Publisher ID + OAuth client id/secret (Desktop app), can run
# `npx chrome-webstore-upload-keys` to create the refresh token, writes the
# file with 0600 permissions, verifies it against Google's token endpoint and
# prints the public key to register for Verified CRX Uploads.

set -euo pipefail

CRED_FILE="${CWS_CREDENTIALS_FILE:-$HOME/.cws-credentials.env}"
PRIVATE_KEY="${CWS_CRX_KEY:-$HOME/.firefox-private-key.pem}"
FORCE=0
OPEN=0

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --open) OPEN=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf '✖ %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null || die "curl is required"
command -v node >/dev/null || die "node is required (chrome-webstore-upload-keys, npm run publish:chrome)"

if [ -f "$CRED_FILE" ] && [ "$FORCE" -ne 1 ]; then
  say "ℹ $CRED_FILE already exists."
  read -rp "Overwrite it? [y/N] " answer
  [[ "${answer:-}" =~ ^[Yy]$ ]] || { say "Aborted."; exit 0; }
fi

if [ "$OPEN" -eq 1 ]; then
  xdg-open https://console.cloud.google.com/apis/library/chromewebstore.googleapis.com >/dev/null 2>&1 || true
  xdg-open https://console.cloud.google.com/auth/overview >/dev/null 2>&1 || true
  xdg-open https://console.cloud.google.com/apis/credentials >/dev/null 2>&1 || true
  xdg-open https://chrome.google.com/webstore/devconsole >/dev/null 2>&1 || true
fi

say ""
say "Collect these (https://developer.chrome.com/docs/webstore/using-api):"
say "  Publisher ID      Developer Dashboard → Publisher → Settings"
say "  Client ID/Secret  Cloud Console → OAuth client ID → Desktop app"
say ""

prompt() { # prompt <label> <var-name> [hidden]
  local label="$1" var="$2" hidden="${3:-}" current input
  current="${!var:-}"
  if [ "$hidden" = "hidden" ]; then
    read -rsp "$label${current:+ [keep current]}: " input; echo
  else
    read -rp "$label${current:+ [$current]}: " input
  fi
  printf -v "$var" '%s' "${input:-$current}"
}

prompt "Publisher ID" CWS_PUBLISHER_ID
prompt "Client ID" CWS_CLIENT_ID
prompt "Client secret" CWS_CLIENT_SECRET hidden
[ -n "$CWS_PUBLISHER_ID" ] && [ -n "$CWS_CLIENT_ID" ] && [ -n "$CWS_CLIENT_SECRET" ] \
  || die "empty value(s) — nothing written"

if [ -z "${CWS_REFRESH_TOKEN:-}" ]; then
  say ""
  read -rp "Generate a refresh token now with chrome-webstore-upload-keys? [Y/n] " gen
  if [[ ! "${gen:-}" =~ ^[Nn]$ ]]; then
    say "→ npx --yes chrome-webstore-upload-keys@2"
    npx --yes chrome-webstore-upload-keys@2 || say "⚠ tool exited non-zero — paste a token manually if you have one"
  fi
fi
prompt "Refresh token" CWS_REFRESH_TOKEN hidden
[ -n "$CWS_REFRESH_TOKEN" ] || die "no refresh token — nothing written"

umask 077
cat > "$CRED_FILE" <<EOF
CWS_PUBLISHER_ID=$CWS_PUBLISHER_ID
CWS_CLIENT_ID=$CWS_CLIENT_ID
CWS_CLIENT_SECRET=$CWS_CLIENT_SECRET
CWS_REFRESH_TOKEN=$CWS_REFRESH_TOKEN
EOF
chmod 600 "$CRED_FILE"
say ""
say "✔ wrote $CRED_FILE (0600)"

say "→ verifying credentials with Google…"
response="$(curl -s -X POST https://oauth2.googleapis.com/token \
  -d "client_id=$CWS_CLIENT_ID" \
  -d "client_secret=$CWS_CLIENT_SECRET" \
  -d "refresh_token=$CWS_REFRESH_TOKEN" \
  -d "grant_type=refresh_token")"
unset CWS_CLIENT_SECRET CWS_REFRESH_TOKEN
if printf '%s' "$response" | grep -q '"access_token"'; then
  say "✔ OAuth OK"
else
  say "✖ OAuth FAILED:"
  printf '%s\n' "$response" | head -c 500; echo
  die "check client id/secret/refresh token in $CRED_FILE"
fi

if [ -f "$PRIVATE_KEY" ]; then
  say ""
  say "Verified CRX uploads: register this public key under"
  say "Dashboard → Package → Verified CRX Uploads (one-time opt-in):"
  say ""
  if command -v openssl >/dev/null; then
    openssl rsa -in "$PRIVATE_KEY" -pubout 2>/dev/null || say "(could not read $PRIVATE_KEY)"
  else
    say "(openssl not installed — run: openssl rsa -in $PRIVATE_KEY -pubout)"
  fi
fi

say ""
say "Next: cd ~/code/BetterSuno && npm run publish:chrome    # or: npm run publish:chrome -- --no-publish"

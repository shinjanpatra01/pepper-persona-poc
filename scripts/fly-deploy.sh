#!/usr/bin/env bash
#
# Deploy the persona console to Fly.
#
#   scripts/fly-deploy.sh staging
#   scripts/fly-deploy.sh production
#
# Creates the app and its volume on first run, pushes the keys from .env as
# secrets, then deploys. Safe to re-run: every step checks for what it is about
# to create.
#
# Secrets go in over stdin via `fly secrets import` rather than as command
# arguments, because arguments are visible to anything that can read the process
# list on this machine.
set -euo pipefail

TARGET="${1:-}"
ORG="${FLY_ORG:-chittansh}"

case "$TARGET" in
  staging)    CONFIG="fly.staging.toml" ;;
  production) CONFIG="fly.toml" ;;
  *)
    echo "usage: $0 {staging|production}" >&2
    exit 64
    ;;
esac

cd "$(dirname "$0")/.."

APP=$(awk -F' *= *' '/^app *=/ {gsub(/"/, "", $2); print $2; exit}' "$CONFIG")
VOLUME=$(awk -F' *= *' '/^ *source *= *"/ {gsub(/"/, "", $2); print $2; exit}' "$CONFIG")
REGION=$(awk -F' *= *' '/^primary_region *=/ {gsub(/"/, "", $2); print $2; exit}' "$CONFIG")

echo "==> ${TARGET}: app ${APP} in org ${ORG} (${REGION})"

if ! flyctl auth whoami >/dev/null 2>&1; then
  echo "Not logged in. Run: fly auth login" >&2
  exit 1
fi

if ! flyctl apps list --org "$ORG" 2>/dev/null | awk '{print $1}' | grep -qx "$APP"; then
  echo "==> creating app"
  flyctl apps create "$APP" --org "$ORG"
else
  echo "==> app exists"
fi

# The volume holds examples/, which is where every persona lives. Without it a
# deploy would silently reset the app to the personas baked into the image.
if ! flyctl volumes list -a "$APP" 2>/dev/null | grep -q "$VOLUME"; then
  echo "==> creating 3GB volume ${VOLUME}"
  flyctl volumes create "$VOLUME" -a "$APP" --region "$REGION" --size 3 --yes
else
  echo "==> volume exists"
fi

# Everything in .env, minus comments, blanks and PORT (fly.toml owns the port).
# Values are never echoed.
echo "==> pushing secrets from .env"
if [ ! -f .env ]; then
  echo "No .env found; skipping secrets." >&2
else
  COUNT=$(grep -cE '^[A-Za-z_][A-Za-z0-9_]*=.' .env || true)
  grep -E '^[A-Za-z_][A-Za-z0-9_]*=.' .env \
    | grep -vE '^PORT=' \
    | flyctl secrets import -a "$APP" --stage
  echo "    ${COUNT} keys staged"
fi

echo "==> deploying"
# Remote builder: there is no Docker daemon on this machine, and the image
# needs ffmpeg, so building it locally would be the slow path anyway.
flyctl deploy -c "$CONFIG" -a "$APP" --remote-only

echo
echo "==> https://${APP}.fly.dev"

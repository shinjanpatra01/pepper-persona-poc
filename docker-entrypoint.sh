#!/bin/sh
# examples/ is a Fly volume, so it starts empty and shadows the personas baked
# into the image. Restore them once, without ever clobbering real data.
set -e
if [ -d /app/seed-examples ]; then
  for d in /app/seed-examples/*; do
    [ -d "$d" ] || continue
    name=$(basename "$d")
    [ -e "/app/examples/$name" ] || cp -r "$d" "/app/examples/$name"
  done
fi
exec "$@"

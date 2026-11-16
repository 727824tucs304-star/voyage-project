#!/usr/bin/env bash
# Builds one tenant image per version tag. Usage: scripts/build-tenant-images.sh v1 v2
set -euo pipefail
cd "$(dirname "$0")/../tenant-app"
REPO="${TENANT_IMAGE_REPO:-voyage-tenant}"
versions=("$@")
[ ${#versions[@]} -eq 0 ] && versions=(v1 v2)
for v in "${versions[@]}"; do
  [[ "$v" =~ ^v[1-9][0-9]{0,2}$ ]] || { echo "invalid version '$v' (use v1, v2, ...)" >&2; exit 1; }
  docker build --build-arg APP_VERSION="$v" -t "$REPO:$v" .
done

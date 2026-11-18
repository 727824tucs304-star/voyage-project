#!/bin/sh
case "$1" in
  *sername*) echo "x-access-token" ;;
  *) echo "$GITHUB_TOKEN" ;;
esac
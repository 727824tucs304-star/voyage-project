#!/bin/sh
# git calls this for credentials. The token comes from the environment, never from the command line.
case "$1" in
  *sername*) echo "x-access-token" ;;
  *) echo "$GITHUB_TOKEN" ;;
esac

#!/bin/bash
REAL_GIT=/usr/bin/git

case "$1" in
  checkout|switch)
    echo "ERROR: Branch switching is not allowed. You are on $BLAZEBOT_BRANCH." >&2
    exit 1
    ;;
  push)
    for arg in "$@"; do
      if [ "$arg" = "$BLAZEBOT_BRANCH" ] || [ "$arg" = "origin" ] || [ "$arg" = "push" ]; then
        continue
      fi
      if echo "$arg" | grep -q ":" && ! echo "$arg" | grep -q "$BLAZEBOT_BRANCH"; then
        echo "ERROR: You can only push to $BLAZEBOT_BRANCH." >&2
        exit 1
      fi
    done
    $REAL_GIT "$@"
    ;;
  *)
    $REAL_GIT "$@"
    ;;
esac

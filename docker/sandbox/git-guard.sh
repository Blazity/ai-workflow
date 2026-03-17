#!/bin/bash
REAL_GIT=/usr/bin/git

case "$1" in
  checkout|switch)
    echo "ERROR: Branch switching is not allowed. You are on $BLAZEBOT_BRANCH." >&2
    exit 1
    ;;
  push)
    echo "ERROR: git push is not allowed inside the sandbox. The orchestrator pushes after the run completes." >&2
    exit 1
    ;;
  *)
    $REAL_GIT "$@"
    ;;
esac

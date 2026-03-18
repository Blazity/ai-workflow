#!/bin/bash
set -euo pipefail

# inspect.sh — Lists running Blazebot sandbox containers and attaches to one.

containers=$(docker ps --filter label=blazebot=true --format '{{.ID}}\t{{.Label "blazebot.branch"}}\t{{.Status}}' 2>/dev/null)

if [ -z "$containers" ]; then
  echo "No running Blazebot containers found."
  echo "Make sure DEVELOPER_MODE=true is set and a job is running."
  exit 0
fi

# Read into arrays
ids=()
branches=()
statuses=()
while IFS=$'\t' read -r id branch status; do
  ids+=("$id")
  branches+=("${branch:-unknown}")
  statuses+=("$status")
done <<< "$containers"

count=${#ids[@]}

echo ""
echo "Blazebot sandbox containers:"
echo ""
for i in "${!ids[@]}"; do
  idx=$((i + 1))
  echo "  ${idx}) ${branches[$i]}  (${statuses[$i]})"
done
echo ""

if [ "$count" -eq 1 ]; then
  selected=0
  echo "Auto-attaching to ${branches[0]} ..."
else
  read -rp "Select container [1-${count}]: " choice
  if ! [[ "$choice" =~ ^[0-9]+$ ]] || [ "$choice" -lt 1 ] || [ "$choice" -gt "$count" ]; then
    echo "Invalid selection."
    exit 1
  fi
  selected=$((choice - 1))
  echo "Attaching to ${branches[$selected]} ..."
fi

echo ""
docker logs -f "${ids[$selected]}"

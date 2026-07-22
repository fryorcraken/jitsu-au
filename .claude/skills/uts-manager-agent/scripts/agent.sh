#!/usr/bin/env bash
# Thin curl wrapper for the UTS Jitsu manager agent API.
#
# Usage:
#   scripts/agent.sh <action> [json-params]
#   scripts/agent.sh manifest            # GET the self-describing manifest
#
# Requires: UTS_MANAGER_API_URL, UTS_MANAGER_API_KEY (and jq for pretty output).
set -euo pipefail

: "${UTS_MANAGER_API_URL:?set UTS_MANAGER_API_URL, e.g. https://jitsu.au}"
: "${UTS_MANAGER_API_KEY:?set UTS_MANAGER_API_KEY (server MANAGER_AGENT_API_KEY)}"

endpoint="${UTS_MANAGER_API_URL%/}/api/manager/agent"
action="${1:-manifest}"
params="${2:-{}}"

pretty() { if command -v jq >/dev/null 2>&1; then jq; else cat; fi; }

if [ "$action" = "manifest" ]; then
  curl -fsS "$endpoint" -H "Authorization: Bearer $UTS_MANAGER_API_KEY" | pretty
  exit 0
fi

curl -fsS "$endpoint" \
  -H "Authorization: Bearer $UTS_MANAGER_API_KEY" \
  -H "content-type: application/json" \
  -d "$(printf '{"action":"%s","params":%s}' "$action" "$params")" | pretty

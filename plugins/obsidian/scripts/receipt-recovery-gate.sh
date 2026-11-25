#!/usr/bin/env bash
set -euo pipefail

# BB Automations supplies these values. The worker is paused so only manual
# dispatches from this gate (or an operator) run the agent.
bb_cli=${BB_CLI:-bb}
state=$("$bb_cli" obsidian recovery-needed)
case "$state" in
  empty) exit 0 ;;
  work)
    "$bb_cli" automation run "${OBSIDIAN_RECOVERY_WORKER_ID:?Set the paused agent automation ID}" \
      --project "${BB_PROJECT_ID:?Missing automation project}" \
      --idempotency-key "${BB_AUTOMATION_RUN_ID:?Missing gate run ID}" --json
    ;;
  *) echo 'Unexpected Obsidian receipt queue response.' >&2; exit 1 ;;
esac

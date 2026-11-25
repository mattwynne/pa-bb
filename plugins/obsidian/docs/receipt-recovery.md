# Recovering Obsidian operation receipts

Obsidian records local save, conflict resolution and move intents in its plugin SQLite database. It records dispatch before the filesystem operation can take effect and appends a terminal receipt after verification. The first receipt access imports the old bounded ledger in one transaction and keeps the source entry. Historical receipt lookup and GTD's move verification use the original operation IDs. Move verification follows recorded later saves at the destination.

Use `obsidian_recover_receipts` to list outstanding operations, inspect an ID, request an evidence check and settle a proven outcome. Supply the exact operation ID and the token returned by the check. Settlement checks the evidence again, and repeat requests return the recorded outcome. The tool reports only IDs, operation kinds and evidence categories. Recovery records a local outcome. iCloud sync and delivery have their own status.

- An intent recorded before the dispatch barrier proves the operation never began publication. Recovery leaves any staging file in place.
- An atomic save can be confirmed from the staged file's recorded identity and hash at the intended path. A conflict resolution also needs evidence that conflict cleanup completed.
- A move can be confirmed from the original entry's identity at the destination and the absence of the original path. This confirms the physical move. GTD still performs its own follow-on verification.
- Missing proof, divergence, an interrupted conflict cleanup, or a Desktop edit with a lost acknowledgement after dispatch requires review. Some older receipts lack the file identity or dispatch evidence necessary to settle them. Historical iCloud-producer receipts stay available through the existing exact receipt lookup. A historical marker without local journal evidence is reported for exact legacy inspection.
- An unresolved entry blocks overlapping mutations in the same vault. Inspect the original ID before deciding how to handle it. The recovery tool cannot force a terminal state or perform a note edit, replay, move, or conflict cleanup.

## Activate hourly reconciliation

Use a project and an existing provider/model that can run BB agent tools. The worker stays paused and is invoked manually by the hourly gate. BB records each agent run under the worker, so look there for the outcome and any exact IDs needing review. An empty gate run is silent. BB deduplicates active runs of the worker.

Run from the checkout containing this plugin, with the CLI connected to the BB installation where Obsidian is enabled. Set `PROJECT`, `PROVIDER`, and `MODEL` to the selected BB IDs. Check `bb automation list --project "$PROJECT"` once before creating the pair. The script file is read on the server host, or on the invoking thread's host when run inside a thread.

```bash
worker_id=$(
  bb automation create --project "$PROJECT" \
    --name 'Obsidian receipt reconciliation worker' --disabled \
    --cron '0 * * * *' --timezone America/Vancouver \
    --provider "$PROVIDER" --model "$MODEL" --permission-mode auto \
    --prompt "$(bb obsidian recovery-prompt)" --json | jq -er '.id'
)

bb automation create --project "$PROJECT" \
  --name 'Obsidian receipt reconciliation hourly' \
  --cron '0 * * * *' --timezone America/Vancouver \
  --script-file "$(pwd)/plugins/obsidian/scripts/receipt-recovery-gate.sh" \
  --interpreter bash --working-directory automation-storage \
  --env-json "$(jq -nc --arg id "$worker_id" '{OBSIDIAN_RECOVERY_WORKER_ID: $id}')" \
  --json
```

Use `bb automation runs "$worker_id" --project "$PROJECT"` to find the agent runs. Pause the hourly gate to stop recurring dispatch. BB keeps a private copy of the gate script. After a script change, use `bb automation update` with the original script-file path to refresh that copy.

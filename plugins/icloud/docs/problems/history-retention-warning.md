# Recurring "history_retention capacity" warning

Status: open, low priority. It predates the stock rclone switch.

## Problem

The plugin log repeatedly shows `iCloud history_retention capacity`, every few hours. The sync-history store has hit its capacity budget and is dropping old entries. The README promises seven days of successful summaries and 30 days of failures, under separate budgets. A steady warning suggests the budget is too small for one-minute scans across several folders, or that it's counted more often than it should be.

## Current evidence

The warning appears in the plugin log on 2026-11-26, 27 and 28, alongside normal sync. It hasn't been investigated. See `adapters/run-history.ts` and the diagnostics section in [setup](../setup.md#diagnostics).

## Desired outcome

Normal operation produces no warning. Either size the budget for the expected run rate, or warn only when failure records are being dropped.

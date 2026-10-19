# Verification fixtures

These checks use disposable generated data. They are not shipped plugins or normal maintenance scripts. Never point them at a live BB installation, personal notes or a cloud account.

- [`installed-bb/`](installed-bb/README.md): current Linux BB integration, search, managed-update and optional rendered/provider checks. Follow its prerequisites and isolation instructions.
- [`probe-icloud-native-publication.cjs`](probe-icloud-native-publication.cjs): standalone Linux check of stock rclone v1.75.2 publishing a replacement file during a rate-limited local-to-local transfer. It needs Node 22 or later and an explicit pinned binary, but no BB installation or Apple account:

  ```sh
  RCLONE_TEST_BINARY=/path/to/rclone-v1.75.2 node fixtures/probe-icloud-native-publication.cjs
  ```

  The transfer takes at least 40 seconds. The check verifies sampled reads, temporary-file coexistence and replacement inode/bytes, then removes its generated files. It does not prove every crash boundary or cloud/device delivery.

The earlier Obsidian host spikes were removed after the installed-BB fixtures replaced them. Git retains their historical source. Routine repository maintenance stays in `scripts/`; `sync-connection-ui.mjs` generates the self-contained plugin UI copies and supports `--check` for drift.

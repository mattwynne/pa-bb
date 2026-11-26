# Managed iCloud note worker

BB uses the native worker to publish a known note save and reconcile it with the next scheduled two-way scan. Both processes share the mirror’s mutation lock. The configured worker and its SHA-256 must match. Use the ordinary worker for mirrors that have never been adopted by managed delivery.

Build from a local checkout containing the revision in `rclone-revision`. The build archives that revision and applies `managed-worker.patch`. It cannot overwrite an existing executable.

```sh
BB_TEST_NATIVE_WORKER=1 ./native/build.sh /path/to/rclone /path/to/new/bb-icloud-native
```

The build prints the executable’s SHA-256. Use the established iCloud maintenance workflow to change the worker or its managed mirrors. Preserve the mirror’s publication receipts and listing journal during maintenance. A mirror with an unsettled publication needs recovery through the managed worker before it can return to ordinary sync.

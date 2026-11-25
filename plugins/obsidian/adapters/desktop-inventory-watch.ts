// This code runs in the existing restricted Desktop session through the CLI.
// A single watch follows GTD's configured scope for the life of that session.
export function inventoryWatchProbe(folders: string[], epoch: string) {
  return String.raw`(() => {
    const folders = ${JSON.stringify(folders)};
    const scope = JSON.stringify(folders);
    const key = Symbol.for("pa-bb.gtd.inventory-watch");
    const { vault, metadataCache } = app;
    let watch = globalThis[key];
    if (watch?.scope !== scope) {
      watch?.dispose();
      let revision = 0;
      let changedAt = 0;
      const within = (path, folder) => path === folder || path.startsWith(folder + "/");
      const matches = (path, directory) => folders.some(folder =>
        within(path, folder) || (directory && within(folder, path)));
      const change = () => { revision++; changedAt = Date.now(); };
      const structural = (file, oldPath) => {
        const directory = Array.isArray(file.children);
        if ((directory || file.extension === "md" || oldPath?.endsWith(".md")) &&
            (matches(file.path, directory) || (oldPath && matches(oldPath, directory)))) change();
      };
      const refs = [
        [vault, vault.on("create", file => structural(file))],
        [vault, vault.on("delete", file => structural(file))],
        [vault, vault.on("rename", structural)],
        [metadataCache, metadataCache.on("changed", file => {
          if (matches(file.path, false)) change();
        })],
      ];
      const epoch = ${JSON.stringify(epoch)};
      watch = globalThis[key] = {
        scope,
        dispose: () => { for (const [emitter, ref] of refs) emitter.offref(ref); },
        read: () => metadataCache.isCacheClean() && Date.now() - changedAt >= 150
          ? epoch + ":" + revision : null,
      };
    }
    return { revision: watch.read() };
  })()`;
}

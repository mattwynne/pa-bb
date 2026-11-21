import { cliCommand, defineCli, PluginCliError, type BbPluginApi } from "@get-bb/plugin-sdk";

// A bounded preflight, not a lock. Starting work goes through BB's normal
// thread command and permission policy, not a privileged plugin handler.
const pageSize = 50;
const maxPages = 10;

// Plugin-ownership claims: one worker thread per plugin may edit its source.
// Claims live in plugin KV; the server is one process, so a promise chain makes
// check-and-set atomic. A claim whose thread is archived or gone is dropped.
const claimsKey = "claims-v1";
const pluginName = /^[a-z][a-z0-9-]{0,63}$/;
type Claims = Record<string, { thread: string; at: string }>;

export default function toolsmith(bb: BbPluginApi) {
  const settings = bb.settings.define({
    project: { type: "project", label: "PA development project" },
  });

  let chain: Promise<unknown> = Promise.resolve();
  const serialized = <T,>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(task, task);
    chain = next.catch(() => undefined);
    return next;
  };
  const loadClaims = async () => (await bb.storage.kv.get<Claims>(claimsKey)) ?? {};
  // Splits stored claims into live ones and those whose owner thread is gone.
  const sortClaims = async (claims: Claims, signal?: AbortSignal) => {
    const owners = [...new Set(Object.values(claims).map((claim) => claim.thread))];
    const alive = new Set<string>();
    for (let i = 0; i < owners.length; i += 200) {
      const found = await bb.sdk.threads.list({ threadIds: owners.slice(i, i + 200), archived: false, includeHidden: true, limit: 200, signal });
      for (const { id } of found) alive.add(id);
    }
    const live: Claims = {};
    for (const [plugin, claim] of Object.entries(claims)) if (alive.has(claim.thread)) live[plugin] = claim;
    return live;
  };
  const claimList = (claims: Claims) => Object.entries(claims).map(([plugin, { thread }]) => ({ plugin, thread }));
  const fail = (message: string, code: string, hint?: string) => new PluginCliError(message, { code, hint });

  bb.cli.register(defineCli({
    name: "toolsmith",
    summary: "Check where to hand off a confirmed PA plugin improvement",
    commands: {
      claim: cliCommand({
        summary: "Claim ownership of one or more plugins (existing or new) before editing their source",
        positionals: [{ name: "plugins", description: "Plugin directory names under plugins/", required: true, variadic: true }],
        options: { json: { type: "boolean", description: "Emit machine-readable result" } },
        async run(input, { signal, threadId }) {
          if (!threadId) throw fail("A claim must come from a BB thread.", "no_thread");
          const names = [...new Set(input.positionals.plugins)];
          const invalid = names.filter((name) => !pluginName.test(name));
          if (!names.length || invalid.length) throw fail("Plugin names must be lowercase letters, digits and hyphens.", "invalid_plugin", "Use the directory name under plugins/.");
          try {
            return await serialized(async () => {
              const claims = await sortClaims(await loadClaims(), signal);
              const taken = names.filter((name) => claims[name] && claims[name].thread !== threadId);
              if (taken.length) {
                await bb.storage.kv.set(claimsKey, claims);
                throw fail(`Already claimed: ${taken.map((name) => `${name} by ${claims[name].thread}`).join(", ")}.`, "claimed",
                  "Research and plan only, and ask the owner to release or hand off. Nothing was claimed.");
              }
              const at = new Date().toISOString();
              for (const name of names) claims[name] = claims[name] ?? { thread: threadId, at };
              await bb.storage.kv.set(claimsKey, claims);
              return { exitCode: 0, stdout: input.options.json ? JSON.stringify({ status: "claimed", plugins: names }) : `Claimed ${names.join(", ")}.` };
            });
          } catch (error) {
            if (error instanceof PluginCliError) throw error;
            if (signal?.aborted) throw new PluginCliError("Claim cancelled.", { code: "cancelled" });
            bb.log.warn("claim failed");
            throw fail("Could not record the claim.", "claim_unavailable", "Do not edit plugin source without a recorded claim.");
          }
        },
      }),
      release: cliCommand({
        summary: "Release this thread's plugin claims, or only the named plugins",
        positionals: [{ name: "plugins", description: "Plugins to release; default all of this thread's claims", variadic: true }],
        options: { json: { type: "boolean", description: "Emit machine-readable result" } },
        async run(input, { signal, threadId }) {
          if (!threadId) throw fail("A release must come from a BB thread.", "no_thread");
          try {
            return await serialized(async () => {
              const claims = await sortClaims(await loadClaims(), signal);
              const named = input.positionals.plugins.length ? input.positionals.plugins : undefined;
              const released = Object.keys(claims).filter((name) => claims[name].thread === threadId && (!named || named.includes(name)));
              for (const name of released) delete claims[name];
              await bb.storage.kv.set(claimsKey, claims);
              return { exitCode: 0, stdout: input.options.json ? JSON.stringify({ status: "released", plugins: released }) : `Released ${released.join(", ") || "nothing"}.` };
            });
          } catch {
            if (signal?.aborted) throw new PluginCliError("Release cancelled.", { code: "cancelled" });
            bb.log.warn("release failed");
            throw fail("Could not release the claim.", "release_unavailable");
          }
        },
      }),
      status: cliCommand({
        summary: "Check the target project and report other work without blocking a new handoff (read-only)",
        options: { json: { type: "boolean", description: "Emit machine-readable status" } },
        async run(input, { signal, threadId: callerId }) {
          let stage = "settings";
          try {
            const { project: projectId } = await settings.get();
            const output = (status: string, message: string, details: { projectId?: string; otherThreads?: string[]; claims?: { plugin: string; thread: string }[] } = {}) => ({
              exitCode: 0,
              stdout: input.options.json ? JSON.stringify({ status, ...details }) : message,
            });
            if (!projectId) return output("unconfigured", "Select the PA development project in Toolsmith settings.");

            stage = "project";
            const project = await bb.sdk.projects.get({ projectId, signal });
            if (project.kind !== "standard" || project.sources.length === 0) {
              return output("invalid_project", "Select a standard PA project with a checkout in Toolsmith settings.");
            }

            stage = "claims";
            const claims = claimList(await sortClaims(await loadClaims(), signal));

            stage = "thread-list";
            const otherThreads = new Set<string>();
            for (let page = 0; page < maxPages; page++) {
              const threads = await bb.sdk.threads.list({
                projectId, archived: false, includeHidden: true,
                limit: pageSize, offset: page * pageSize, signal,
              });
              for (const { id, status, activity } of threads) {
                if (id !== callerId && ((status !== "idle" && status !== "error") ||
                  Object.values(activity).some((count) => count > 0))) otherThreads.add(id);
              }
              if (threads.length < pageSize) return output("ready", otherThreads.size
                ? `Target is ready for another handoff. Other work is present: ${[...otherThreads].join(", ")}. Research and planning may proceed; implementation is single-threaded per plugin, so claim your target plugin with bb toolsmith claim before editing and stop if it is refused. This check is not a reservation.`
                : `No running work found in ${projectId}. This check is not a reservation.`,
                { projectId, otherThreads: [...otherThreads], claims });
            }
            return output("incomplete", "Could not check every PA thread. Do not start toolsmithing from this result.", { projectId, otherThreads: [...otherThreads], claims });
          } catch {
            if (signal?.aborted) throw new PluginCliError("Toolsmith status check cancelled.", { code: "cancelled" });
            bb.log.warn(`status ${stage} failed`);
            throw new PluginCliError("Could not check Toolsmith readiness.", {
              code: "status_unavailable",
              hint: "Check the configured project and bounded Toolsmith plugin logs. Do not start work on an unchecked target.",
            });
          }
        },
      }),
    },
  }));
}

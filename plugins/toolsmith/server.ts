import { cliCommand, defineCli, PluginCliError, type BbPluginApi } from "@get-bb/plugin-sdk";
import { rpcContract } from "./contract.ts";

// A bounded preflight, not a lock. Starting work goes through BB's normal
// thread command and permission policy, not a privileged plugin handler.
const pageSize = 50;
const maxPages = 10;

// Plugin-ownership claims: one worker thread per plugin may edit its source.
// Claims live in plugin KV; the server is one process, so a promise chain makes
// check-and-set atomic. A claim whose thread is archived or gone is dropped.
const stateKey = "ownership-v2";
const pluginName = /^[a-z][a-z0-9-]{0,63}$/;
type Claims = Record<string, { thread: string; at: string }>;
type Request = { thread: string; plugins: string[] };
type Ownership = { claims: Claims; queue: Request[] };

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
  const loadOwnership = async (signal?: AbortSignal) => {
    const { claims, queue } = (await bb.storage.kv.get<Ownership>(stateKey)) ?? {
      claims: (await bb.storage.kv.get<Claims>("claims-v1")) ?? {},
      queue: [],
    };
    const owners = [...new Set([...Object.values(claims), ...queue].map(({ thread }) => thread))];
    const threads = new Map<string, string>();
    for (let i = 0; i < owners.length; i += 200) {
      const found = await bb.sdk.threads.list({ threadIds: owners.slice(i, i + 200), archived: false, includeHidden: true, limit: 200, signal });
      for (const { id, title } of found) threads.set(id, title?.trim() || "Untitled thread");
    }
    return {
      claims: Object.assign(Object.create(null) as Claims,
        Object.fromEntries(Object.entries(claims).filter(([, claim]) => threads.has(claim.thread)))),
      queue: queue.filter(({ thread }) => threads.has(thread)),
      threads,
    };
  };
  const claimList = (claims: Claims) => Object.entries(claims).map(([plugin, { thread }]) => ({ plugin, thread }));
  const fail = (message: string, code: string, hint?: string) => new PluginCliError(message, { code, hint });

  bb.rpc.register(rpcContract, {
    async listWork(_input, { experimental_signal: signal }) {
      try {
        const { claims, queue, threads } = await loadOwnership(signal);
        const active = new Map<string, string[]>();
        for (const { plugin, thread } of claimList(claims)) {
          const plugins = active.get(thread) ?? [];
          plugins.push(plugin);
          active.set(thread, plugins);
        }
        const row = (thread: string, plugins: string[]) => ({
          thread, title: threads.get(thread) ?? "Untitled thread", plugins: [...plugins].sort(),
        });
        return {
          active: [...active].map(([thread, plugins]) => row(thread, plugins)),
          queue: queue.map(({ thread, plugins }) => ({
            ...row(thread, plugins),
            ready: plugins.every((plugin) => !claims[plugin] || claims[plugin].thread === thread),
          })),
        };
      } catch {
        if (!signal.aborted) bb.log.warn("listWork ownership read failed");
        throw new Error("Could not load Toolsmith threads.");
      }
    },
  });

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
              const { claims, queue } = await loadOwnership(signal);
              const taken = names.filter((name) => claims[name] && claims[name].thread !== threadId);
              if (taken.length) {
                const existing = queue.find((request) => request.thread === threadId);
                const sameRequest = existing?.plugins.length === names.length && names.every((name) => existing.plugins.includes(name));
                const waiting = sameRequest ? queue : [...queue.filter((request) => request.thread !== threadId), { thread: threadId, plugins: names }];
                await bb.storage.kv.set(stateKey, { claims, queue: waiting });
                throw fail(`Already claimed: ${taken.map((name) => `${name} by ${claims[name].thread}`).join(", ")}.`, "claimed",
                  "Request queued. Research and plan only, then retry the claim when the plugins are free.");
              }
              const at = new Date().toISOString();
              for (const name of names) claims[name] = claims[name] ?? { thread: threadId, at };
              await bb.storage.kv.set(stateKey, { claims, queue: queue.filter((request) => request.thread !== threadId) });
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
              const { claims, queue } = await loadOwnership(signal);
              const named = input.positionals.plugins.length ? input.positionals.plugins : undefined;
              const released = Object.keys(claims).filter((name) => claims[name].thread === threadId && (!named || named.includes(name)));
              for (const name of released) delete claims[name];
              const waiting = queue.filter((request) => request.thread !== threadId ||
                (named && !request.plugins.some((plugin) => named.includes(plugin))));
              await bb.storage.kv.set(stateKey, { claims, queue: waiting });
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
            const claims = claimList((await loadOwnership(signal)).claims);

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

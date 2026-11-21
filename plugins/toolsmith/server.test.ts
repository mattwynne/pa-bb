import assert from "node:assert/strict";
import { test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import toolsmith from "./server.ts";

function host({ projectId = "proj_test", callerId = undefined as string | undefined, project = { kind: "standard", sources: [{}] } as { kind: string; sources: object[] },
  list = (_: { offset: number }) => [] as { id: string; status: string; activity: object }[],
  alive = new Set<string>(["thr_a", "thr_b"]), store = new Map<string, unknown>() } = {}) {
  const logs: string[] = [];
  const reads: object[] = [];
  let command: Parameters<BbPluginApi["cli"]["register"]>[0] | undefined;
  toolsmith({
    settings: { define: () => ({ get: async () => ({ project: projectId }) }) },
    cli: { register: (registration: typeof command) => { command = registration; } },
    storage: { kv: { get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => { store.set(key, structuredClone(value)); } } },
    log: { warn: (message: string) => logs.push(message) },
    sdk: {
      projects: { get: async () => project },
      threads: { list: async (input: { offset: number; threadIds?: string[] }) => {
        if (input.threadIds) return input.threadIds.filter((id) => alive.has(id)).map((id) => ({ id, status: "idle", activity: {} }));
        reads.push(input); return list(input);
      } },
    },
  } as unknown as BbPluginApi);
  assert.ok(command);
  const registered = command;
  const as = (threadId: string | undefined, ...args: string[]) => registered.run(args, { threadId, signal: new AbortController().signal });
  return { logs, reads, alive, store, as, run: () => as(callerId, "status", "--json") };
}

const idle = { id: "thr_idle", status: "idle", activity: {} };
const fullPage = Array.from({ length: 50 }, () => idle);

test("returns the selected project and checks hidden work", async () => {
  const { run, reads } = host();
  const result = await run();
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout!), { status: "ready", projectId: "proj_test", otherThreads: [], claims: [] });
  assert.equal(reads.length, 1);
  assert.deepEqual({ ...reads[0], signal: undefined }, { projectId: "proj_test", archived: false, includeHidden: true, limit: 50, offset: 0, signal: undefined });
});

test("refuses unconfigured and non-source projects without checking threads", async () => {
  for (const [instance, status] of [
    [host({ projectId: "" }), "unconfigured"],
    [host({ project: { kind: "standard", sources: [] } }), "invalid_project"],
    [host({ project: { kind: "personal", sources: [{}] } }), "invalid_project"],
  ] as const) {
    assert.deepEqual(JSON.parse((await instance.run()).stdout!), { status });
    assert.deepEqual(instance.reads, []);
  }
});

test("accepts handoffs with active, pending, and background work, reporting later-page owners", async () => {
  for (const blocker of [
    { ...idle, status: "active" },
    { ...idle, status: "pending" },
    { ...idle, activity: { activeBackgroundCommandCount: 1 } },
  ]) {
    const { run } = host({ list: ({ offset }) => offset === 0 ? fullPage : [blocker] });
    assert.deepEqual(JSON.parse((await run()).stdout!), { status: "ready", projectId: "proj_test", otherThreads: [blocker.id], claims: [] });
  }
});

test("the asking thread itself does not count as another worker", async () => {
  const { run } = host({ callerId: idle.id, list: () => [{ ...idle, status: "active" }] });
  assert.deepEqual(JSON.parse((await run()).stdout!), { status: "ready", projectId: "proj_test", otherThreads: [], claims: [] });
});

test("never reports ready if the scan is incomplete", async () => {
  const { run, reads } = host({ list: () => fullPage });
  assert.equal(JSON.parse((await run()).stdout!).status, "incomplete");
  assert.equal(reads.length, 10);
});

test("running work does not short-circuit an incomplete scan", async () => {
  const { run, reads } = host({ list: () => [{ ...idle, status: "active" }, ...fullPage.slice(1)] });
  assert.deepEqual(JSON.parse((await run()).stdout!), { status: "incomplete", projectId: "proj_test", otherThreads: [idle.id], claims: [] });
  assert.equal(reads.length, 10);
});

test("SDK failures are reported without leaking raw messages", async () => {
  const { run, logs } = host({ list: () => { throw new Error("PRIVATE_CONTENT and SECRET_TOKEN"); } });
  const result = await run();
  assert.notEqual(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout!).error.code, "status_unavailable");
  assert.deepEqual(logs, ["status thread-list failed"]);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}\n${logs}`, /PRIVATE_CONTENT|SECRET_TOKEN/);
});

const parse = async (result: { stdout?: string } | Promise<{ stdout?: string }>) => JSON.parse((await result).stdout!);

test("claims are exclusive per plugin, parallel across plugins, and idempotent for the owner", async () => {
  const { as } = host();
  assert.deepEqual(await parse(as("thr_a", "claim", "gtd", "--json")), { status: "claimed", plugins: ["gtd"] });
  assert.deepEqual(await parse(as("thr_a", "claim", "gtd", "--json")), { status: "claimed", plugins: ["gtd"] });
  assert.deepEqual(await parse(as("thr_b", "claim", "icloud", "--json")), { status: "claimed", plugins: ["icloud"] });
  const refused = await parse(as("thr_b", "claim", "gtd", "--json"));
  assert.equal(refused.error.code, "claimed");
  assert.match(refused.error.message, /gtd by thr_a/);
});

test("a multi-plugin claim is all-or-nothing", async () => {
  const { as, store } = host();
  await as("thr_a", "claim", "gtd");
  assert.equal((await parse(as("thr_b", "claim", "icloud", "gtd", "--json"))).error.code, "claimed");
  assert.deepEqual(Object.keys(store.get("claims-v1") as object), ["gtd"]);
});

test("concurrent claims for one plugin have a single winner", async () => {
  const { as } = host();
  const results = await Promise.all([as("thr_a", "claim", "new-plugin", "--json"), as("thr_b", "claim", "new-plugin", "--json")]);
  assert.equal(results.filter((result) => result.exitCode === 0).length, 1);
});

test("release frees a plugin, only for its owner", async () => {
  const { as } = host();
  await as("thr_a", "claim", "gtd", "fastmail");
  assert.deepEqual(await parse(as("thr_b", "release", "gtd", "--json")), { status: "released", plugins: [] });
  assert.deepEqual(await parse(as("thr_a", "release", "gtd", "--json")), { status: "released", plugins: ["gtd"] });
  assert.equal((await parse(as("thr_b", "claim", "gtd", "--json"))).status, "claimed");
  assert.deepEqual(await parse(as("thr_a", "release", "--json")), { status: "released", plugins: ["fastmail"] });
});

test("a claim held by an archived or missing thread is dropped", async () => {
  const { as, alive } = host();
  await as("thr_a", "claim", "gtd");
  alive.delete("thr_a");
  assert.equal((await parse(as("thr_b", "claim", "gtd", "--json"))).status, "claimed");
});

test("claims need a thread and a valid plugin name", async () => {
  const { as } = host();
  assert.equal((await parse(as(undefined, "claim", "gtd", "--json"))).error.code, "no_thread");
  for (const bad of ["../x", "Gtd", "a b", ""]) assert.equal((await parse(as("thr_a", "claim", bad, "--json"))).error.code, "invalid_plugin");
});

test("status reports live claims and omits dead ones", async () => {
  const { as, alive } = host({ callerId: "thr_b" });
  await as("thr_a", "claim", "gtd");
  await as("thr_b", "claim", "icloud");
  const status = async () => JSON.parse((await as("thr_b", "status", "--json")).stdout!);
  assert.deepEqual((await status()).claims, [{ plugin: "gtd", thread: "thr_a" }, { plugin: "icloud", thread: "thr_b" }]);
  alive.delete("thr_a");
  assert.deepEqual((await status()).claims, [{ plugin: "icloud", thread: "thr_b" }]);
});

test("storage failures during a claim are reported without leaking raw messages", async () => {
  const { as, store, logs } = host();
  store.get = () => { throw new Error("SECRET_TOKEN"); };
  const result = await as("thr_a", "claim", "gtd", "--json");
  assert.notEqual(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout!).error.code, "claim_unavailable");
  assert.doesNotMatch(`${result.stdout}${logs}`, /SECRET_TOKEN/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import toolsmith from "./server.ts";

function host({ projectId = "proj_test", callerId = undefined as string | undefined, project = { kind: "standard", sources: [{}] } as { kind: string; sources: object[] },
  list = (_: { offset: number }) => [] as { id: string; status: string; activity: object }[] } = {}) {
  const logs: string[] = [];
  const reads: object[] = [];
  let command: Parameters<BbPluginApi["cli"]["register"]>[0] | undefined;
  toolsmith({
    settings: { define: () => ({ get: async () => ({ project: projectId }) }) },
    cli: { register: (registration: typeof command) => { command = registration; } },
    log: { warn: (message: string) => logs.push(message) },
    sdk: {
      projects: { get: async () => project },
      threads: { list: async (input: { offset: number }) => { reads.push(input); return list(input); } },
    },
  } as unknown as BbPluginApi);
  assert.ok(command);
  const registered = command;
  return { logs, reads, run: () => registered.run(["status", "--json"], { threadId: callerId, signal: new AbortController().signal }) };
}

const idle = { id: "thr_idle", status: "idle", activity: {} };
const fullPage = Array.from({ length: 50 }, () => idle);

test("returns the selected project and checks hidden work", async () => {
  const { run, reads } = host();
  const result = await run();
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout!), { status: "ready", projectId: "proj_test" });
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

test("blocks active, pending, and background work even on later pages", async () => {
  for (const blocker of [
    { ...idle, status: "active" },
    { ...idle, status: "pending" },
    { ...idle, activity: { activeBackgroundCommandCount: 1 } },
  ]) {
    const { run } = host({ list: ({ offset }) => offset === 0 ? fullPage : [blocker] });
    assert.equal(JSON.parse((await run()).stdout!).status, "busy");
  }
});

test("the asking thread itself does not count as another worker", async () => {
  const { run } = host({ callerId: idle.id, list: () => [{ ...idle, status: "active" }] });
  assert.equal(JSON.parse((await run()).stdout!).status, "ready");
});

test("never reports ready if the scan is incomplete", async () => {
  const { run, reads } = host({ list: () => fullPage });
  assert.equal(JSON.parse((await run()).stdout!).status, "incomplete");
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

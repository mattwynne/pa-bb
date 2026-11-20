import { cliCommand, defineCli, PluginCliError, type BbPluginApi } from "@get-bb/plugin-sdk";

// A bounded preflight, not a lock. Starting work goes through BB's normal
// thread command and permission policy, not a privileged plugin handler.
const pageSize = 50;
const maxPages = 10;

export default function toolsmith(bb: BbPluginApi) {
  const settings = bb.settings.define({
    project: { type: "project", label: "PA development project" },
  });

  bb.cli.register(defineCli({
    name: "toolsmith",
    summary: "Check where to hand off a confirmed PA plugin improvement",
    commands: {
      status: cliCommand({
        summary: "Check the configured project and whether it has work in progress (read-only)",
        options: { json: { type: "boolean", description: "Emit machine-readable status" } },
        async run(input, { signal, threadId: callerId }) {
          let stage = "settings";
          try {
            const { project: projectId } = await settings.get();
            const output = (status: string, message: string, details: { projectId?: string; threadId?: string } = {}) => ({
              exitCode: 0,
              stdout: input.options.json ? JSON.stringify({ status, ...details }) : message,
            });
            if (!projectId) return output("unconfigured", "Select the PA development project in Toolsmith settings.");

            stage = "project";
            const project = await bb.sdk.projects.get({ projectId, signal });
            if (project.kind !== "standard" || project.sources.length === 0) {
              return output("invalid_project", "Select a standard PA project with a checkout in Toolsmith settings.");
            }

            stage = "thread-list";
            for (let page = 0; page < maxPages; page++) {
              const threads = await bb.sdk.threads.list({
                projectId, archived: false, includeHidden: true,
                limit: pageSize, offset: page * pageSize, signal,
              });
              const busy = threads.find(({ id, status, activity }) =>
                id !== callerId && ((status !== "idle" && status !== "error") ||
                Object.values(activity).some((count) => count > 0)));
              if (busy) return output("busy", "A thread is working in the PA project. Do not start concurrent implementation.", { projectId, threadId: busy.id });
              if (threads.length < pageSize) return output("ready", `No running work found in ${projectId}. This check is not a reservation.`, { projectId });
            }
            return output("incomplete", "Could not check every PA thread. Do not start toolsmithing from this result.", { projectId });
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

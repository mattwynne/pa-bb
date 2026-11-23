import { useEffect, useState } from "react";
import { definePluginApp, experimental_Icon as Icon, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./contract.ts";
import "./app.css";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
const listWork = (rpc: Rpc) => rpc.call("listWork", {});
type Work = Awaited<ReturnType<typeof listWork>>;
type Row = Work["active"][number] & { ready?: boolean };

function WorkSection({ title, rows, empty }: {
  title: string;
  rows: Row[];
  empty: string;
}) {
  const navigate = useBbNavigate();
  return (
    <section className="toolsmith-section">
      <h2>{title}</h2>
      {rows.length === 0 ? <p className="toolsmith-empty">{empty}</p> : (
        <ul className="toolsmith-list">
          {rows.map(({ thread, title, plugins, ready }) => (
            <li key={thread}>
              <button className="toolsmith-row" type="button" onClick={() => navigate.toThread(thread)}>
                <span className="toolsmith-row-body">
                  <span className="toolsmith-title">{title}</span>
                  <span className="toolsmith-plugins">
                    {plugins.map((plugin) => <span className="toolsmith-plugin" key={plugin}>{plugin}</span>)}
                    {ready && <span className="toolsmith-ready">Ready to retry</span>}
                  </span>
                </span>
                <Icon name="ChevronRight" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ToolsmithPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [work, setWork] = useState<Work>();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      if (document.visibilityState === "visible") {
        try {
          const result = await listWork(rpc);
          if (!disposed) {
            setWork(result);
            setFailed(false);
          }
        } catch {
          if (!disposed) setFailed(true);
        }
      }
      if (!disposed) timer = setTimeout(load, 10_000);
    }
    void load();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [rpc, retry]);

  return (
    <div className="toolsmith-panel">
      {failed && <div className="toolsmith-error">
        <span role="alert">{work ? "Couldn’t refresh Toolsmith threads. Showing the last loaded list." : "Couldn’t load Toolsmith threads."}</span>
        <button type="button" onClick={() => setRetry((attempt) => attempt + 1)}>Retry</button>
      </div>}
      {!work && !failed && <p className="toolsmith-empty" role="status">Loading threads…</p>}
      {work && <>
        <WorkSection title="Active threads" rows={work.active} empty="No active plugin claims." />
        <WorkSection title="Queue" rows={work.queue} empty="No queued claims." />
      </>}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "work", path: "work", title: "Toolsmith", icon: "Toolbox", component: ToolsmithPanel });
});

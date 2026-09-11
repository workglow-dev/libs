/** @jsxImportSource preact */
/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { JSX } from "preact";
import { render } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { RunEvent } from "../../run-events/RunEventTypes";
import { renderCliLine, type WebInvocation } from "../argv";
import type { WebField } from "../commandFields";
import { findCommandNode, type WebCommandNode } from "../commandTree";
import type { PanelData, WebStatusItem } from "../extensions";
import {
  abortRun,
  answerHuman,
  getCommands,
  getFields,
  getPanels,
  getRun,
  getStatusWidgets,
  listRuns,
  openRunStream,
  ping,
  startRun,
  type RunSummary,
} from "./api";
import {
  formErrors,
  initialValues,
  toInvocation,
  valuesFromInvocation,
  type FormValues,
} from "./formModel";
import {
  HEARTBEAT_MS,
  HEARTBEAT_TIMEOUT_MS,
  INITIAL_LIVENESS,
  reduceHeartbeat,
  type CliLiveness,
} from "./heartbeat";
import { loadRailWidths, saveRailWidths, type RailSide, type RailWidths } from "./railWidths";
import {
  appendChatAsk,
  applyRecord,
  chatTranscript,
  emptyRunView,
  filterCommandTree,
  isChatRequest,
  openPathsFor,
  stackedPane,
  type RunViewState,
  type StackedPane,
} from "./state";
import { ChatTranscript } from "./views/ChatTranscript";
import { CommandTree } from "./views/CommandTree";
import { GroupView } from "./views/GroupView";
import { HumanPrompt } from "./views/HumanPrompt";
import { OptionsForm } from "./views/OptionsForm";
import { RailResizer } from "./views/RailResizer";
import { ResultTab } from "./views/ResultTab";
import { RunConsole } from "./views/RunConsole";

type Tab = "options" | "run" | "result";

/** How often the rail re-reads contributed status. Slow: a widget may query a database. */
const STATUS_POLL_MS = 15_000;
type FieldWithWidget = WebField & { widget?: string };

/** One timer drives every spinner and elapsed clock, as the terminal does. */
function useTick(active: boolean): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((value) => value + 1), 90);
    return () => clearInterval(id);
  }, [active]);
  return tick;
}

/**
 * Polls the CLI once a second and reports whether it is answering.
 *
 * The page is served BY the CLI, and every button on it either starts work
 * there or steers work already running there. When that process is gone —
 * Ctrl-C in the terminal, a crash, a laptop that slept — nothing in the DOM
 * says so: the buttons still look live and simply fail when pressed. This is
 * what the rest of the page gates on so it can stop offering them.
 */
function useCliLiveness(): CliLiveness {
  const [liveness, setLiveness] = useState<CliLiveness>(INITIAL_LIVENESS);

  useEffect(() => {
    let cancelled = false;
    // One probe at a time. A CLI slower than the interval would otherwise
    // accumulate a request per second against a process already struggling.
    let inFlight = false;

    const beat = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        const probe = await ping(HEARTBEAT_TIMEOUT_MS);
        if (!cancelled) setLiveness((previous) => reduceHeartbeat(previous, probe));
      } finally {
        inFlight = false;
      }
    };

    void beat();
    const timer = setInterval(() => void beat(), HEARTBEAT_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return liveness;
}

function App(): JSX.Element {
  const [commands, setCommands] = useState<readonly WebCommandNode[]>([]);
  const [binaryName, setBinaryName] = useState("workglow");
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [node, setNode] = useState<WebCommandNode | undefined>(undefined);
  const [fields, setFields] = useState<readonly FieldWithWidget[]>([]);
  const [values, setValues] = useState<FormValues>({});
  const [tab, setTab] = useState<Tab>("options");
  const [runs, setRuns] = useState<readonly RunSummary[]>([]);
  const [run, setRun] = useState<RunSummary | undefined>(undefined);
  const [view, setView] = useState<RunViewState>(emptyRunView());
  const [connected, setConnected] = useState(true);
  const cli = useCliLiveness();
  const [sortByStatus, setSortByStatus] = useState(true);
  const [mapView, setMapView] = useState<"rows" | "grid">("rows");
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [pane, setPane] = useState<StackedPane>("list");
  const [panels, setPanels] = useState<
    readonly { id: string; title: string; source: string; data: PanelData }[]
  >([]);
  const [widgets, setWidgets] = useState<
    readonly { id: string; title: string; source: string; items: readonly WebStatusItem[] }[]
  >([]);
  /**
   * A run held back by its command's confirmation.
   *
   * Kept here rather than in the form because Run has a keyboard path too, and
   * a dialog only the button honors is not a gate.
   */
  const [pendingRun, setPendingRun] = useState<
    { readonly dryRun: boolean; readonly confirm: string; readonly line: string } | undefined
  >(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [theme, setTheme] = useState<"light" | "auto" | "dark">("auto");
  /** Rail widths, restored from the last session and dragged by the seams. */
  const [rails, setRails] = useState<RailWidths>(loadRailWidths);
  const closeStreamRef = useRef<(() => void) | undefined>(undefined);

  const running = run !== undefined && view.state === "running";
  const tick = useTick(running);
  // Clock for the elapsed readout, started in an effect so render stays pure.
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [running]);

  useEffect(() => {
    void getCommands()
      .then((result) => {
        setCommands(result.commands);
        setBinaryName(result.binaryName);
        setOpen(new Set(result.commands.map((command) => command.path.join("."))));
      })
      .catch((cause: Error) => setError(cause.message));
    void listRuns()
      .then((result) => setRuns(result.runs))
      .catch(() => {});
  }, []);

  /**
   * Status is polled, not read once: the lines worth putting on a rail are the
   * ones that change while you sit there — a fetch queue entering a cooldown,
   * a sweep's dead-letter count climbing. Slow enough (15s) that a widget may
   * query a database to answer.
   */
  useEffect(() => {
    let cancelled = false;
    const read = (): void => {
      void getStatusWidgets()
        .then((result) => {
          if (!cancelled) setWidgets(result.widgets);
        })
        .catch(() => {});
    };
    read();
    const timer = setInterval(read, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  /**
   * Detaches the run being watched. Switching commands does this, because the
   * tabs describe the command in front of you: leaving a finished run attached
   * made `model detail` report itself completed, with `model list`'s results on
   * its Result tab.
   */
  const detachRun = useCallback(() => {
    closeStreamRef.current?.();
    closeStreamRef.current = undefined;
    setRun(undefined);
    setView(emptyRunView());
    setPanels([]);
    setSelected(undefined);
  }, []);

  const selectNode = useCallback(
    (next: WebCommandNode) => {
      if (next !== node) detachRun();
      setNode(next);
      setPane(stackedPane("select"));
      setTab("options");
      setOpen((current) => new Set([...current, ...openPathsFor(next.path)]));
      // A group has no action, so there is no form to ask the CLI for — and
      // the previous command's fields must not survive behind its page.
      if (next.children.length > 0) {
        setFields([]);
        setValues({});
        return;
      }
      void getFields(next.path, [])
        .then((result) => {
          setFields(result.fields);
          setValues(initialValues(result.fields));
        })
        .catch((cause: Error) => setError(cause.message));
    },
    [detachRun, node]
  );

  /**
   * Selecting from a group's page rather than the rail. Same selection, plus
   * the rail opens the subtree it just moved into — clicked in the rail that
   * is what the row's own caret did, and following a link should not leave the
   * tree pointing somewhere else.
   */
  const selectChild = useCallback(
    (next: WebCommandNode) => {
      selectNode(next);
      if (next.children.length > 0) {
        setOpen((current) => new Set([...current, next.path.join(".")]));
      }
    },
    [selectNode]
  );

  /**
   * Carries one row of a result panel into the command it is an argument for:
   * selects that command and fills its form from the invocation the panel
   * attached to the row.
   *
   * Fills, and stops there — the row is a suggestion someone is being asked to
   * judge, and the command behind it usually writes. The run stays attached on
   * purpose, so the table the button was clicked in is still on the Result tab
   * for the next row; that table is a worklist, and detaching would close it
   * after one.
   */
  const prefillFrom = useCallback(
    (invocation: WebInvocation) => {
      const owner = findCommandNode(commands, invocation.path);
      if (!owner) return;
      setNode(owner);
      setPane(stackedPane("select"));
      setTab("options");
      setOpen((current) => new Set([...current, ...openPathsFor(owner.path)]));
      void getFields(owner.path, invocation.args)
        .then((result) => {
          setFields(result.fields);
          setValues(valuesFromInvocation(result.fields, invocation));
        })
        .catch((cause: Error) => setError(cause.message));
    },
    [commands]
  );

  /** An argument decides which schema applies, so changing one re-asks. */
  const onFieldChange = useCallback(
    (key: string, value: string | boolean) => {
      setValues((current) => {
        const next = { ...current, [key]: value };
        const field = fields.find((candidate) => candidate.key === key);
        if (field?.source === "argument" && node) {
          const args = fields
            .filter((candidate) => candidate.source === "argument")
            .map((candidate) => String(next[candidate.key] ?? ""));
          void getFields(node.path, args).then((result) => {
            setFields(result.fields);
            setValues((values2) => ({ ...initialValues(result.fields), ...values2, [key]: value }));
          });
        }
        return next;
      });
    },
    [fields, node]
  );

  const attach = useCallback(
    (summary: RunSummary, keepCommand = false) => {
      // One stream at a time: without this, every run you opened kept its own
      // EventSource for the life of the page.
      closeStreamRef.current?.();
      closeStreamRef.current = undefined;
      setRun(summary);
      setPane(stackedPane("select"));
      setSelected(undefined);
      setPanels([]);
      setView(emptyRunView());
      setTab("run");
      // Show the command the run actually ran, so the crumb and the options
      // under it describe what you are looking at.
      if (!keepCommand) {
        const owner = findCommandNode(commands, summary.invocation.path);
        if (owner && owner !== node) {
          setNode(owner);
          setOpen((current) => new Set([...current, ...openPathsFor(owner.path)]));
          void getFields(owner.path, summary.invocation.args)
            .then((result) => {
              setFields(result.fields);
              setValues(initialValues(result.fields));
            })
            .catch(() => {});
        }
      }
      void getRun(summary.id).then((detail) => {
        let next = emptyRunView();
        for (const record of detail.events) next = applyRecord(next, record.seq, record.event);
        setView(next);
        closeStreamRef.current = openRunStream(
          summary.id,
          next.lastSeq,
          (seq, event: RunEvent) => setView((current) => applyRecord(current, seq, event)),
          setConnected
        );
      });
    },
    [commands, node]
  );

  const startInvocation = useCallback(
    (dryRun: boolean) => {
      if (!node) return;
      const invocation = toInvocation(fields, values, node.path);
      const withDry = dryRun
        ? { ...invocation, options: { ...invocation.options, "dry-run": true } }
        : invocation;
      void startRun(withDry)
        .then((summary) => {
          attach(summary, true);
          void listRuns().then((result) => setRuns(result.runs));
        })
        .catch((cause: Error) => setError(cause.message));
    },
    [attach, fields, node, values]
  );

  const onRun = useCallback(
    (dryRun: boolean) => {
      // A group is selectable — it is a page — but it has no action behind it,
      // and the Enter shortcut reaches it with no button to have said so.
      if (!node || node.children.length > 0) return;
      // Guarded here as well as on the button: Run also has a keyboard path,
      // and a request to a dead CLI fails as an unexplained network error.
      if (!cli.online) return;
      // A dry run changes nothing, so it is never what the confirmation is
      // protecting against — gating it would train the reflex that dismisses
      // the dialog on the run that does.
      if (node.confirm && !dryRun) {
        setPendingRun({
          dryRun,
          confirm: node.confirm,
          line: renderCliLine(binaryName, toInvocation(fields, values, node.path)),
        });
        return;
      }
      startInvocation(dryRun);
    },
    [binaryName, cli.online, fields, node, startInvocation, values]
  );

  // A finished run is where the Result tab and any contributed panels come from.
  useEffect(() => {
    if (!run || view.state === "running") return;
    void getPanels(run.id)
      .then((result) => setPanels(result.panels))
      .catch(() => {});
    void listRuns()
      .then((result) => setRuns(result.runs))
      .catch(() => {});
  }, [run, view.state]);

  // "auto" is the absence of a choice: the stylesheet reads the viewer's own
  // setting when nothing is stamped, so clearing is what auto means.
  useEffect(() => {
    if (theme === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    saveRailWidths(rails);
  }, [rails]);

  const resizeRail = useCallback((side: RailSide, width: number): void => {
    setRails((current) => (current[side] === width ? current : { ...current, [side]: width }));
  }, []);

  useEffect(() => () => closeStreamRef.current?.(), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
      if (event.key === "/" && !typing) {
        event.preventDefault();
        document.getElementById("filter")?.focus();
      }
      if (
        event.key === "Enter" &&
        (!typing || event.metaKey || event.ctrlKey) &&
        tab === "options"
      ) {
        event.preventDefault();
        onRun(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onRun, tab]);

  const filtered = useMemo(() => filterCommandTree(commands, filter), [commands, filter]);
  const errors = node ? formErrors(fields, values) : [];
  const elapsed = run ? Math.max(0, (run.endedAt ?? (now || run.startedAt)) - run.startedAt) : 0;
  const crumbs = node ? [binaryName, ...node.path] : [binaryName];

  return (
    <div
      className="app"
      data-pane={pane}
      style={`--rail-l:${rails.left}px;--rail-r:${rails.right}px`}
    >
      <aside className="rail rail-l" aria-label="Commands">
        <div className="brand">
          <div className="mark">w</div>
          <div>
            <div className="brand-t">{binaryName}</div>
            <div className="brand-s">{window.location.host}</div>
          </div>
        </div>
        <div className="searchbox">
          <input
            id="filter"
            type="text"
            placeholder="Filter commands   /"
            value={filter}
            onInput={(event) => setFilter((event.target as HTMLInputElement).value)}
          />
        </div>
        <CommandTree
          nodes={filtered}
          open={open}
          selectedPath={node?.path ?? []}
          onToggle={(key) =>
            setOpen((current) => {
              const next = new Set(current);
              if (next.has(key)) next.delete(key);
              else next.add(key);
              return next;
            })
          }
          onSelect={selectNode}
        />
      </aside>

      <RailResizer
        side="left"
        width={rails.left}
        otherWidth={rails.right}
        onResize={(width) => resizeRail("left", width)}
      />

      {pendingRun ? (
        <div
          className="modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-title"
          aria-describedby="confirm-body"
        >
          <div className="modal-b">
            <h3 id="confirm-title">Confirm</h3>
            <p id="confirm-body">{pendingRun.confirm}</p>
            <code className="modal-c">
              <span className="pr">$ </span>
              {pendingRun.line}
            </code>
            <div className="acts">
              <button className="ghost" onClick={() => setPendingRun(undefined)}>
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={() => {
                  const request = pendingRun;
                  setPendingRun(undefined);
                  startInvocation(request.dryRun);
                }}
              >
                Run anyway
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <main className="main">
        <header className="topbar">
          <button
            type="button"
            className="back"
            aria-label="Back to commands"
            onClick={() => setPane(stackedPane("back"))}
          >
            ←
          </button>
          <div className="crumb">
            {crumbs.map((segment, index) => (
              <>
                {index > 0 ? <span className="sep">›</span> : null}
                {index === crumbs.length - 1 && node ? (
                  <b key={segment}>{segment}</b>
                ) : (
                  <span className="dim" key={segment}>
                    {segment}
                  </span>
                )}
              </>
            ))}
          </div>
          <div className="spacer" />
          <div className="ctl">
            <div className="tgl" role="group" aria-label="Row order">
              <button aria-pressed={sortByStatus} onClick={() => setSortByStatus(true)}>
                CLI order
              </button>
              <button aria-pressed={!sortByStatus} onClick={() => setSortByStatus(false)}>
                Graph order
              </button>
            </div>
            <div className="tgl" role="group" aria-label="Theme">
              {(["light", "auto", "dark"] as const).map((candidate) => (
                <button
                  key={candidate}
                  aria-pressed={theme === candidate}
                  onClick={() => setTheme(candidate)}
                >
                  {candidate}
                </button>
              ))}
            </div>
          </div>
        </header>

        <div className="tabs" role="tablist">
          {(["options", "run", "result"] as const).map((candidate) => (
            <button
              key={candidate}
              className="tab"
              role="tab"
              aria-selected={tab === candidate}
              disabled={candidate !== "options" && !run}
              onClick={() => setTab(candidate)}
            >
              <span>
                {candidate === "options" ? "Options" : candidate === "run" ? "Run" : "Result"}
              </span>
              {candidate === "run" && run ? (
                <span className="pill">{view.state === "running" ? "live" : view.state}</span>
              ) : null}
            </button>
          ))}
        </div>

        <div className="body">
          {!cli.online ? (
            <div className="wrap" style="color:var(--fail)">
              {binaryName} is not responding. Anything that would talk to it is disabled until it
              answers again.
            </div>
          ) : null}
          {cli.online && cli.restarted ? (
            <div className="wrap" style="color:var(--fail)">
              {binaryName} restarted. It is reachable again, but it does not know about runs started
              before the restart.
            </div>
          ) : null}
          {error ? (
            <div className="wrap" style="color:var(--fail)">
              {error}
            </div>
          ) : null}
          {view.humanRequest && run && isChatRequest(view.humanRequest) ? (
            <ChatTranscript
              entries={chatTranscript(view)}
              message={view.humanRequest.message}
              canAnswer={cli.online}
              onSend={(text) => {
                if (!cli.online) return;
                void answerHuman(run.id, {
                  requestId: view.humanRequest!.requestId,
                  action: "accept",
                  content: { message: text },
                  done: true,
                });
                setView((current) => ({
                  ...appendChatAsk(current, text),
                  humanRequest: undefined,
                }));
              }}
              onEnd={() => {
                if (!cli.online) return;
                void answerHuman(run.id, {
                  requestId: view.humanRequest!.requestId,
                  action: "decline",
                  content: undefined,
                  done: true,
                });
                setView((current) => ({ ...current, humanRequest: undefined }));
              }}
            />
          ) : null}
          {view.humanRequest && run && !isChatRequest(view.humanRequest) ? (
            <HumanPrompt
              request={view.humanRequest}
              canAnswer={cli.online}
              onAnswer={(action, content) => {
                if (!cli.online) return;
                void answerHuman(run.id, {
                  requestId: view.humanRequest!.requestId,
                  action,
                  content,
                  done: true,
                });
                setView((current) => ({ ...current, humanRequest: undefined }));
              }}
            />
          ) : null}
          {tab === "options" && node && node.children.length > 0 ? (
            // Read back off the full tree, not the selected object: the rail
            // hands over the node it drew, and while a filter is on that node
            // is pruned to the matches — a group's page lists what is under
            // the group, not what someone last typed in the box.
            <GroupView node={findCommandNode(commands, node.path) ?? node} onSelect={selectChild} />
          ) : null}
          {tab === "options" && node && node.children.length === 0 ? (
            <OptionsForm
              binaryName={binaryName}
              path={node.path}
              description={node.description}
              fields={fields}
              values={values}
              errors={errors}
              badges={node.badges}
              note={node.note}
              runsInOrder={node.runsInOrder}
              runsIn={node.runsIn}
              onChange={onFieldChange}
              onRun={onRun}
              canRun={cli.online}
            />
          ) : null}
          {tab === "options" && !node ? (
            <div className="wrap">
              <p className="lede">
                Pick a command on the left. Its options come from the same schemas the terminal
                prompts from, and the line at the bottom is exactly what will run.
              </p>
            </div>
          ) : null}
          {tab === "run" && run ? (
            <RunConsole
              cli={run.cli}
              state={view}
              elapsedMs={elapsed}
              tick={tick}
              sortByStatus={sortByStatus}
              selectedId={selected}
              connected={connected}
              mapView={mapView}
              onMapView={setMapView}
              onSelect={setSelected}
              canAbort={cli.online}
              onAbort={() => {
                if (cli.online) void abortRun(run.id);
              }}
            />
          ) : null}
          {tab === "result" && run ? (
            <ResultTab run={run} state={view} panels={panels} onAction={prefillFrom} />
          ) : null}
        </div>

        <footer className="statusbar">
          <span className="live">
            {/* Liveness of the CLI itself outranks the run stream: with the
                process gone the stream is moot, and "reconnecting" would read
                as a network hiccup rather than as a CLI that has stopped. */}
            <span className={`dot ${cli.online ? (connected ? "ok" : "fail") : "fail"}`} />{" "}
            {!cli.online
              ? `${binaryName} not responding`
              : cli.restarted
                ? `${binaryName} restarted — earlier runs are gone`
                : connected
                  ? "connected"
                  : "reconnecting"}
          </span>
          <span>{run ? `run ${run.id.slice(0, 8)}` : "no run"}</span>
          <span className="spacer" />
          <span>No page reloads — the document is mounted once and patched per event</span>
        </footer>
      </main>

      <RailResizer
        side="right"
        width={rails.right}
        otherWidth={rails.left}
        onResize={(width) => resizeRail("right", width)}
      />

      {/* Status lives on its own rail so the command tree keeps the left one:
          runs first, then whatever the CLI contributed (fetch state, database
          size, …). Read on a slow poll; see the effect above. */}
      <aside className="rail rail-r" aria-label="Status">
        <div className="railsec">
          <h4>Runs</h4>
          {runs.length === 0 ? <div className="cmd-d">Nothing has run yet.</div> : null}
          {runs.slice(0, 6).map((summary) => (
            <button key={summary.id} className="runitem" onClick={() => attach(summary)}>
              <span
                className={`dot ${summary.state === "running" ? "run" : summary.state === "completed" ? "ok" : "fail"}`}
              />
              <span className="lbl">{summary.cli.replace(`${binaryName} `, "")}</span>
              <span className="t">
                {summary.endedAt
                  ? `${((summary.endedAt - summary.startedAt) / 1000).toFixed(1)}s`
                  : "…"}
              </span>
            </button>
          ))}
        </div>
        {widgets.map((widget) => (
          <div className="railsec" key={widget.id}>
            <h4>{widget.title}</h4>
            {widget.items.map((item) =>
              item.kind === "text" ? (
                <div className={`sline${item.tone ? ` t-${item.tone}` : ""}`} key={item.label}>
                  <span className="sl-l">{item.label}</span>
                  <span className="sl-v">{item.value}</span>
                </div>
              ) : (
                <div className="meter" key={item.label}>
                  <span>
                    {item.value} / {item.max} {item.label}
                  </span>
                  <span className="bar">
                    <i style={`width:${Math.min(100, (item.value / (item.max || 1)) * 100)}%`} />
                  </span>
                </div>
              )
            )}
          </div>
        ))}
      </aside>
    </div>
  );
}

const root = document.getElementById("root");
if (root) render(<App />, root);

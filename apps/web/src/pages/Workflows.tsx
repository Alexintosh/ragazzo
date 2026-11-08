import { Trans, useLingui } from "@lingui/react/macro";
import type { Workflow, WorkflowGraph, WorkflowRun } from "@rakazo/contracts";
import {
  canRecoverWorkflowNode,
  WORKFLOW_NODE_LIMIT,
  WorkflowGraphSchema,
} from "@rakazo/contracts";
import { Button, Input, NativeSelect, NativeSelectOption, Textarea } from "@rakazo/ui-web";
import { skipToken, useQuery } from "@tanstack/react-query";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import type { Dispatch, PointerEvent, SetStateAction } from "react";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useSpaceQueries } from "../lib/query";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { WindowChrome } from "./WindowChrome";

export function WorkflowsPage() {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const list = useQuery(queries.workflows.list.queryOptions({ input: {} }));
  const botsQuery = useQuery(queries.bots.list.queryOptions());
  const bots = botsQuery.data ?? [];
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [name, setName] = useState(t`Workflow`);
  const [graph, setGraph] = useState<WorkflowGraph>({ nodes: [], edges: [] });
  const [selected, setSelected] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [parent, setParent] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const nonces = useRef(new Map<string, string>());
  const nonce = (intent: string) => {
    let value = nonces.current.get(intent);
    if (!value) {
      value = crypto.randomUUID();
      nonces.current.set(intent, value);
    }
    return value;
  };
  const editGraph: Dispatch<SetStateAction<WorkflowGraph>> = (value) => {
    if (!busyRef.current) setGraph(value);
  };
  const [error, setError] = useState("");
  const history = useQuery(
    queries.workflows.runs.queryOptions({
      input: workflow ? { workflowId: workflow.id } : skipToken,
      refetchInterval: 3000,
    }),
  );
  const run = useQuery(
    queries.workflows.run.queryOptions({
      input: runId ? { runId } : skipToken,
      refetchInterval: (query) => {
        const current = query.state.data;
        return current &&
          (current.status === "running" ||
            current.nodes.some((node) =>
              ["queued", "running", "waiting_approval"].includes(node.status),
            ))
          ? 2000
          : false;
      },
    }),
  );
  const visibleGraph = runId && run.data ? run.data.graph : graph;
  const node = visibleGraph.nodes.find((item) => item.id === selected);
  const nodeState = run.data?.nodes.find((item) => item.nodeId === selected);
  const dirty =
    !workflow || workflow.name !== name || JSON.stringify(workflow.graph) !== JSON.stringify(graph);
  const valid = WorkflowGraphSchema.safeParse(graph);
  const action = async (fn: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const choose = (value: Workflow | null) => {
    if (busyRef.current) return;
    setWorkflow(value);
    setName(value?.name ?? t`Workflow`);
    setGraph(value?.graph ?? { nodes: [], edges: [] });
    setSelected(null);
    setRunId(null);
    setParent("");
    setError("");
  };
  const updateNode = (patch: Partial<WorkflowGraph["nodes"][number]>) =>
    editGraph((current) => ({
      ...current,
      nodes: current.nodes.map((item) => (item.id === selected ? { ...item, ...patch } : item)),
    }));
  const save = () =>
    action(async () => {
      if (!valid.success) throw new Error(valid.error.issues[0]?.message);
      const value = await rpc.workflows.save({
        ...(workflow ? { workflowId: workflow.id, revision: workflow.revision } : {}),
        name,
        graph,
      });
      setWorkflow(value);
      await list.refetch();
    });
  const start = () =>
    action(async () => {
      if (!workflow || dirty) return;
      const intent = `start:${workflow.id}:${workflow.revision}`;
      const value = await rpc.workflows.start({
        workflowId: workflow.id,
        revision: workflow.revision,
        clientNonce: nonce(intent),
      });
      nonces.current.delete(intent);
      setRunId(value.id);
      await history.refetch();
    });
  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
      data-testid="workflow-page"
    >
      <header className="app-drag flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <WindowChrome />
        <Link
          to="/app"
          className="app-no-drag rounded p-1 hover:bg-muted"
          aria-label={t`Back to chats`}
        >
          <ArrowLeft size={18} />
        </Link>
        <h1 className="text-sm font-medium">
          <Trans>Workflows</Trans>
        </h1>
        <div className="app-no-drag ml-auto flex items-center gap-2">
          {runId ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                if (busyRef.current) return;
                setRunId(null);
                setSelected(null);
              }}
            >
              <Trans>Edit workflow</Trans>
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                disabled={busy || !dirty || !name.trim() || !valid.success}
                onClick={() => void save()}
              >
                <Trans>Save</Trans>
              </Button>
              <Button disabled={busy || dirty || !workflow} onClick={() => void start()}>
                <Trans>Run</Trans>
              </Button>
            </>
          )}
          {run.data && runId && ["running", "failed"].includes(run.data.status) ? (
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await rpc.workflows.cancel({ runId, revision: run.data!.revision });
                  await run.refetch();
                })
              }
            >
              <Trans>Stop</Trans>
            </Button>
          ) : null}
        </div>
      </header>
      {error || list.error || botsQuery.error || history.error || run.error ? (
        <p role="alert" className="border-b border-border px-4 py-2 text-sm text-destructive">
          {error || errorText(list.error ?? botsQuery.error ?? history.error ?? run.error)}
        </p>
      ) : null}
      <fieldset disabled={busy} className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
        <aside
          className="flex w-full shrink-0 gap-2 overflow-auto border-b border-border p-3 md:w-52 md:flex-col md:border-r md:border-b-0"
          aria-label={t`Workflows`}
        >
          <Button variant="outline" onClick={() => choose(null)}>
            <Plus size={16} />
            <Trans>New workflow</Trans>
          </Button>
          {list.data?.workflows.map((item) => (
            <Button
              key={item.id}
              variant={workflow?.id === item.id ? "secondary" : "ghost"}
              className="justify-start"
              onClick={() => choose(item)}
            >
              {item.name}
            </Button>
          ))}
          {workflow && history.data?.runs.length ? (
            <section
              className="mt-3 flex flex-col gap-1 border-t border-border pt-3"
              aria-label={t`Runs`}
            >
              {history.data.runs.map((item) => (
                <Button
                  key={item.id}
                  variant={runId === item.id ? "secondary" : "ghost"}
                  className="h-auto justify-start py-2 text-xs"
                  onClick={() => {
                    setRunId(item.id);
                    setSelected(null);
                  }}
                >
                  <span>
                    {new Date(item.createdAt).toLocaleString()}
                    <br />
                    {statusLabel(item.status, t)}
                  </span>
                </Button>
              ))}
            </section>
          ) : null}
        </aside>
        <main className="flex min-h-64 min-w-0 flex-1 flex-col md:min-h-0">
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
            {runId ? (
              <>
                <h2 className="text-sm font-medium">{run.data?.name ?? name}</h2>
                <span className="text-xs text-muted-foreground">
                  {run.data ? statusLabel(run.data.status, t) : t`Loading`}
                </span>
              </>
            ) : (
              <>
                <Input
                  aria-label={t`Workflow name`}
                  value={name}
                  maxLength={100}
                  className="max-w-xs"
                  onChange={(event) => {
                    if (!busyRef.current) setName(event.target.value);
                  }}
                />
                <Button
                  variant="outline"
                  disabled={!bots.length || graph.nodes.length >= WORKFLOW_NODE_LIMIT}
                  onClick={() => {
                    const id = crypto.randomUUID();
                    editGraph((current) => ({
                      ...current,
                      nodes: [
                        ...current.nodes,
                        {
                          id,
                          label: t`Step ${current.nodes.length + 1}`,
                          botId: bots[0]!.id,
                          prompt: "",
                          x: 40 + (current.nodes.length % 3) * 240,
                          y: 40 + Math.floor(current.nodes.length / 3) * 130,
                        },
                      ],
                    }));
                    setSelected(id);
                  }}
                >
                  <Plus size={16} />
                  <Trans>Add step</Trans>
                </Button>
              </>
            )}
          </div>
          <WorkflowCanvas
            graph={visibleGraph}
            selected={selected}
            run={runId ? run.data : undefined}
            onSelect={setSelected}
            onMove={
              runId || busy
                ? undefined
                : (id, x, y) =>
                    editGraph((current) => ({
                      ...current,
                      nodes: current.nodes.map((item) =>
                        item.id === id ? { ...item, x, y } : item,
                      ),
                    }))
            }
          />
        </main>
        {node ? (
          <aside
            className="max-h-[45dvh] w-full shrink-0 space-y-4 overflow-y-auto border-t border-border p-4 md:max-h-none md:w-72 md:border-t-0 md:border-l"
            aria-label={t`Step details`}
          >
            {runId ? (
              <>
                <h2 className="text-sm font-medium">{node.label}</h2>
                <p className="text-sm text-muted-foreground">
                  {nodeState ? statusLabel(nodeState.status, t) : ""}
                </p>
                <p className="whitespace-pre-wrap text-sm">{node.prompt}</p>
                {nodeState?.error ? (
                  <p role="alert" className="text-sm text-destructive">
                    {nodeState.error}
                  </p>
                ) : null}
                {nodeState?.taskId ? (
                  <Link
                    className="block text-sm underline underline-offset-4"
                    to={`/app/${encodeURIComponent(node.botId)}/tasks/${encodeURIComponent(nodeState.taskId)}`}
                  >
                    <Trans>Open task</Trans>
                  </Link>
                ) : null}
                {nodeState && canRecoverWorkflowNode(nodeState) && run.data ? (
                  <Button
                    disabled={busy}
                    variant="outline"
                    onClick={() =>
                      void action(async () => {
                        const intent = `recover:${run.data!.id}:${node.id}:${run.data!.revision}`;
                        await rpc.workflows.recover({
                          runId: run.data!.id,
                          revision: run.data!.revision,
                          nodeId: node.id,
                          clientNonce: nonce(intent),
                        });
                        nonces.current.delete(intent);
                        await run.refetch();
                      })
                    }
                  >
                    <Trans>Recover step</Trans>
                  </Button>
                ) : null}
              </>
            ) : (
              <>
                <label htmlFor="workflow-step-name" className="block space-y-1 text-xs">
                  <span>
                    <Trans>Step name</Trans>
                  </span>
                  <Input
                    id="workflow-step-name"
                    value={node.label}
                    maxLength={100}
                    onChange={(event) => updateNode({ label: event.target.value })}
                  />
                </label>
                <label htmlFor="workflow-step-bot" className="block space-y-1 text-xs">
                  <span>
                    <Trans>Bot</Trans>
                  </span>
                  <NativeSelect
                    id="workflow-step-bot"
                    value={node.botId}
                    onChange={(event) => updateNode({ botId: event.target.value })}
                  >
                    {bots.map((bot) => (
                      <NativeSelectOption key={bot.id} value={bot.id}>
                        {bot.name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </label>
                <label htmlFor="workflow-step-instructions" className="block space-y-1 text-xs">
                  <span>
                    <Trans>Instructions</Trans>
                  </span>
                  <Textarea
                    id="workflow-step-instructions"
                    value={node.prompt}
                    maxLength={16000}
                    className="min-h-40"
                    onChange={(event) => updateNode({ prompt: event.target.value })}
                  />
                </label>
                <div className="space-y-2">
                  {graph.edges
                    .filter((edge) => edge.to === node.id)
                    .map((edge) => (
                      <div
                        key={edge.from}
                        className="flex items-center justify-between gap-2 text-xs"
                      >
                        <span>{graph.nodes.find((item) => item.id === edge.from)?.label}</span>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t`Remove dependency`}
                          onClick={() =>
                            editGraph((current) => ({
                              ...current,
                              edges: current.edges.filter(
                                (item) => item.from !== edge.from || item.to !== edge.to,
                              ),
                            }))
                          }
                        >
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    ))}
                  <NativeSelect
                    aria-label={t`Run after`}
                    value={parent}
                    onChange={(event) => setParent(event.target.value)}
                  >
                    <NativeSelectOption value="">
                      <Trans>Run after…</Trans>
                    </NativeSelectOption>
                    {graph.nodes
                      .filter(
                        (item) =>
                          item.id !== node.id &&
                          !graph.edges.some((edge) => edge.from === item.id && edge.to === node.id),
                      )
                      .map((item) => (
                        <NativeSelectOption key={item.id} value={item.id}>
                          {item.label}
                        </NativeSelectOption>
                      ))}
                  </NativeSelect>
                  <Button
                    variant="outline"
                    disabled={!parent}
                    onClick={() => {
                      const next = {
                        ...graph,
                        edges: [...graph.edges, { from: parent, to: node.id }],
                      };
                      const parsed = WorkflowGraphSchema.safeParse({
                        ...next,
                        nodes: next.nodes.map((item) => ({
                          ...item,
                          prompt: item.prompt || "pending",
                        })),
                      });
                      if (!parsed.success) {
                        setError(t`This dependency would create a cycle.`);
                        return;
                      }
                      editGraph(next);
                      setParent("");
                      setError("");
                    }}
                  >
                    <Trans>Add dependency</Trans>
                  </Button>
                </div>
                <Button
                  variant="ghost"
                  className="text-destructive"
                  onClick={() => {
                    editGraph((current) => ({
                      nodes: current.nodes.filter((item) => item.id !== node.id),
                      edges: current.edges.filter(
                        (edge) => edge.from !== node.id && edge.to !== node.id,
                      ),
                    }));
                    setSelected(null);
                  }}
                >
                  <Trash2 size={14} />
                  <Trans>Delete step</Trans>
                </Button>
              </>
            )}
          </aside>
        ) : null}
      </fieldset>
    </div>
  );
}

function statusLabel(value: string, t: ReturnType<typeof useLingui>["t"]): string {
  switch (value) {
    case "pending":
      return t`Pending`;
    case "queued":
      return t`Queued`;
    case "running":
      return t`Running`;
    case "waiting_approval":
      return t`Needs attention`;
    case "succeeded":
      return t`Completed`;
    case "failed":
      return t`Failed`;
    case "cancelled":
      return t`Stopped`;
    default:
      return value;
  }
}

export function WorkflowCanvas({
  graph,
  selected,
  run,
  onSelect,
  onMove,
}: {
  graph: WorkflowGraph;
  selected: string | null;
  run?: WorkflowRun;
  onSelect: (id: string) => void;
  onMove?: (id: string, x: number, y: number) => void;
}) {
  const { t } = useLingui();
  const drag = useRef<{
    id: string;
    clientX: number;
    clientY: number;
    x: number;
    y: number;
  } | null>(null);
  const width = Math.max(800, ...graph.nodes.map((node) => node.x + 240));
  const height = Math.max(500, ...graph.nodes.map((node) => node.y + 150));
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (current && onMove)
      onMove(
        current.id,
        Math.min(10000, Math.max(0, current.x + event.clientX - current.clientX)),
        Math.min(10000, Math.max(0, current.y + event.clientY - current.clientY)),
      );
  };
  return (
    <section className="min-h-52 flex-1 overflow-auto bg-muted/20" aria-label={t`Workflow canvas`}>
      <div className="relative" style={{ width, height }}>
        <svg
          className="pointer-events-none absolute inset-0 text-muted-foreground"
          width={width}
          height={height}
          role="img"
          aria-label={t`Step dependencies`}
        >
          <title>{t`Step dependencies`}</title>
          <defs>
            <marker
              id="workflow-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
            </marker>
          </defs>
          {graph.edges.map((edge) => {
            const from = graph.nodes.find((node) => node.id === edge.from);
            const to = graph.nodes.find((node) => node.id === edge.to);
            if (!from || !to) return null;
            return (
              <path
                key={`${edge.from}:${edge.to}`}
                d={`M ${from.x + 100} ${from.y + 76} C ${from.x + 100} ${from.y + 112}, ${to.x + 100} ${to.y - 36}, ${to.x + 100} ${to.y}`}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                markerEnd="url(#workflow-arrow)"
              />
            );
          })}
        </svg>
        {graph.nodes.map((node) => {
          const state = run?.nodes.find((item) => item.nodeId === node.id);
          return (
            <button
              key={node.id}
              type="button"
              aria-pressed={selected === node.id}
              className={`absolute flex h-[76px] w-[200px] touch-none flex-col items-start justify-center gap-1 rounded-lg border bg-card px-4 text-left shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected === node.id ? "border-primary ring-1 ring-primary" : "border-border"} ${onMove ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"}`}
              style={{ left: node.x, top: node.y }}
              onClick={() => onSelect(node.id)}
              onPointerDown={(event) => {
                onSelect(node.id);
                if (!onMove) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                drag.current = {
                  id: node.id,
                  clientX: event.clientX,
                  clientY: event.clientY,
                  x: node.x,
                  y: node.y,
                };
              }}
              onPointerMove={move}
              onPointerUp={() => {
                drag.current = null;
              }}
              onPointerCancel={() => {
                drag.current = null;
              }}
              onKeyDown={(event) => {
                if (
                  !onMove ||
                  !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
                )
                  return;
                event.preventDefault();
                onMove(
                  node.id,
                  Math.max(
                    0,
                    Math.min(
                      10000,
                      node.x +
                        (event.key === "ArrowRight" ? 20 : event.key === "ArrowLeft" ? -20 : 0),
                    ),
                  ),
                  Math.max(
                    0,
                    Math.min(
                      10000,
                      node.y + (event.key === "ArrowDown" ? 20 : event.key === "ArrowUp" ? -20 : 0),
                    ),
                  ),
                );
              }}
            >
              <span className="max-w-full truncate text-sm font-medium">{node.label}</span>
              {state ? (
                <span
                  className={`text-xs ${state.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}
                >
                  {statusLabel(state.status, t)}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}

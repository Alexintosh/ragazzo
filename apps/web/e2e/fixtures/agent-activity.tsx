import { I18nProvider } from "@lingui/react";
import { reduceAgentActivity } from "@rakazo/core";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentActivity } from "../../src/components/AgentActivity";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import "../../src/styles.css";
const runId = "fixture-run";
const initial = [
  {
    seq: 1,
    type: "agent.reasoning",
    runId,
    payload: {
      id: "summary",
      text: "I will inspect the project, then check the changed files.",
      done: true,
    },
  },
  { seq: 2, type: "agent.tool.called", runId, payload: { name: "read_file", executionId: "read" } },
];
function Fixture() {
  const [entries, setEntries] = useState(() =>
    initial.reduce(
      (rows, event) => reduceAgentActivity(rows, event),
      reduceAgentActivity([], initial[0]!),
    ),
  );
  return (
    <main className="mx-auto max-w-3xl bg-background p-6 text-foreground">
      <p className="mb-6">Check the project and follow the live activity.</p>
      <AgentActivity entries={entries} />
      <button
        className="mt-4 rounded border border-border p-2"
        onClick={() =>
          setEntries((rows) =>
            reduceAgentActivity(rows, {
              seq: 3,
              type: "agent.tool.completed",
              runId,
              payload: {
                name: "read_file",
                executionId: "read",
                outcome: "error",
                error: "Fixture file was not found",
                durationMs: 1200,
              },
            }),
          )
        }
      >
        Finish fixture call
      </button>
    </main>
  );
}
void bootstrapI18n("en").then(() =>
  createRoot(document.getElementById("root")!).render(
    <I18nProvider i18n={i18n}>
      <Fixture />
    </I18nProvider>,
  ),
);

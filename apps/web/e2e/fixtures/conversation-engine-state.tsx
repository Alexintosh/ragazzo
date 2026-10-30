import { I18nProvider } from "@lingui/react";
import type { ConversationEngineState } from "@rakazo/contracts";
import { createRoot } from "react-dom/client";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import { ConversationEngineStatePanel } from "../../src/pages/shell/conversation-engine-state";
import "../../src/styles.css";

const character = { id: "00000000-0000-4000-8000-000000000001", name: "Aster" };
const initial: ConversationEngineState = {
  engineId: "eros",
  status: "ready",
  character,
  historyGeneration: 2,
  settings: { revision: 0, values: {} },
  inspection: {
    needs: {
      hunger: "low",
      social: "mid",
      stamina: "high",
      emotional: "mid",
      outing: "low",
      indulgence: "low",
    },
    effects: [],
    lifeEvent: null,
    backgroundEvent: null,
    items: [],
    profile: {
      location: "Glass Harbor",
      occupation: null,
      currentSituation: null,
      desires: null,
      vulnerabilities: null,
      habits: null,
      personalValues: null,
      likes: ["Maps"],
      dislikes: [],
      relationships: [],
      updatedAt: null,
    },
    affinity: {
      trust: 0.2,
      intrigue: 0.3,
      intimacy: 0.4,
      tension: 0.1,
      warmth: 0.5,
      patience: 0.6,
      bond: 0.3,
      chemistry: 0.2,
      bondTier: 2,
      chemistryTier: 1,
      bondLabel: "Familiar",
      chemistryLabel: "Neutral",
      ghostStreak: 0,
      totalGhosts: 0,
      updatedAt: "2026-10-01T12:00:00Z",
    },
    latestEvent: null,
    emotionalNeed: "mid",
    asOf: "2026-10-01T12:00:00Z",
    changesAt: null,
    observedAt: "2026-10-01T12:00:00Z",
    debug: {
      generation: {
        tasks: [
          {
            name: "reply",
            models: ["local-model"],
            fallback: [],
            temperature: 0.7,
            maxTokens: 2048,
          },
        ],
        profiles: ["fast", "quality"],
      },
      feeling: "Curious about the unfamiliar chart.",
      feelingUpdatedAt: "2026-10-01T11:59:00Z",
      persona: {
        name: "Aster",
        systemPrompt: "A careful cartographer. Stay in character.",
        tipPersonality: "Careful and curious.",
        timezone: "UTC",
      },
      axes: { trust: 0.2, intrigue: 0.3, intimacy: 0.4, tension: 0.1 },
      warmthGrade: 2,
      patienceGrade: 2,
      revision: "revision-one",
      editable: true,
      editBlockedReason: null,
      time: {
        timezone: "UTC",
        currentTime: "2026-10-01T12:00:00Z",
        localTime: "2026-10-01 12:00:00",
        affinityElapsedHours: 0,
        feelingElapsedHours: 1 / 60,
      },
    },
  },
};

let state = initial;
await bootstrapI18n("en");
createRoot(document.getElementById("root")!).render(
  <I18nProvider i18n={i18n}>
    <main className="min-h-dvh bg-background text-foreground">
      <div className="mx-auto w-full max-w-md px-5 py-8 sm:px-8">
        <h1 className="text-xl font-semibold">Aster · Settings</h1>
        <ConversationEngineStatePanel
          onLoad={async () => state}
          onSaveSettings={async (_previous, values) => {
            state = { ...state, settings: { revision: state.settings.revision + 1, values } };
            return state.settings;
          }}
          onAction={async (_previous, action) => {
            if (action.kind === "add_item")
              state = {
                ...state,
                inspection: {
                  ...state.inspection!,
                  items: [
                    ...(state.inspection?.items ?? []),
                    {
                      id: crypto.randomUUID(),
                      kind: action.itemKind,
                      name: action.name,
                      source: "caller",
                      createdAt: "2026-10-01T12:00:00Z",
                    },
                  ],
                },
              };
            if (action.kind === "delete_item")
              state = {
                ...state,
                inspection: {
                  ...state.inspection!,
                  items: state.inspection!.items!.filter((item) => item.id !== action.itemId),
                },
              };
            if (action.kind === "event")
              state = {
                ...state,
                inspection: {
                  ...state.inspection!,
                  lifeEvent: {
                    kind: "walk",
                    category: "short",
                    offline: false,
                    startedAt: "2026-10-01T12:00:00Z",
                    endsAt: "2026-10-01T13:00:00Z",
                  },
                },
              };
            return { status: "completed", message: null };
          }}
          onSave={async (_previous, edit) => {
            state = {
              ...state,
              inspection: {
                ...state.inspection!,
                debug: {
                  ...state.inspection!.debug!,
                  axes: edit.axes,
                  warmthGrade: edit.warmthGrade,
                  patienceGrade: edit.patienceGrade,
                  revision: "revision-two",
                  ...(edit.elapsedHours !== undefined
                    ? {
                        feeling: null,
                        time: {
                          ...state.inspection!.debug!.time!,
                          affinityElapsedHours: edit.elapsedHours,
                          feelingElapsedHours: null,
                        },
                      }
                    : {}),
                },
              },
            };
            return state;
          }}
        />
      </div>
    </main>
  </I18nProvider>,
);

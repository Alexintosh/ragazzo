import { Trans, useLingui } from "@lingui/react/macro";
import type { ConversationEngineState, UpdateConversationEngineState } from "@rakazo/contracts";
import { Button, Input, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useEffect, useId, useRef, useState } from "react";
import { errorText } from "../../lib/user-error";
import type { EngineActionHandler } from "./conversation-engine-actions";
import {
  ConversationEngineInventory,
  ConversationEngineObservations,
  useEngineActions,
} from "./conversation-engine-actions";
import {
  EngineDisclosure as Disclosure,
  EngineProfile,
  EngineValue as Value,
} from "./conversation-engine-fields";
import { ConversationEngineSettings } from "./conversation-engine-settings";

type Inspection = NonNullable<ConversationEngineState["inspection"]>;
type Debug = NonNullable<Inspection["debug"]>;
export type EngineStateEdit = Omit<UpdateConversationEngineState, "botId" | "historyGeneration">;
const editableAxes = ["trust", "intrigue", "intimacy", "tension"] as const;
type Draft = Record<
  (typeof editableAxes)[number] | "warmthGrade" | "patienceGrade" | "elapsedHours" | "revision",
  string
>;
const draftFrom = (debug: Debug): Draft => ({
  trust: String(debug.axes!.trust),
  intrigue: String(debug.axes!.intrigue),
  intimacy: String(debug.axes!.intimacy),
  tension: String(debug.axes!.tension),
  warmthGrade: String(debug.warmthGrade),
  patienceGrade: String(debug.patienceGrade),
  elapsedHours: "",
  revision: debug.revision!,
});

/** Reads the bound conversation only; opening settings never creates an engine session. */
export function ConversationEngineStatePanel({
  onLoad,
  onSave,
  onSaveSettings,
  onAction,
  onCheckAction,
  actionUncertain = false,
  busy: botBusy = false,
}: {
  onLoad: () => Promise<ConversationEngineState>;
  onSave: (
    state: ConversationEngineState,
    edit: EngineStateEdit,
  ) => Promise<ConversationEngineState>;
  onSaveSettings?: (
    state: ConversationEngineState,
    values: ConversationEngineState["settings"]["values"],
  ) => Promise<ConversationEngineState["settings"]>;
  actionUncertain?: boolean;
  onCheckAction?: () => ReturnType<EngineActionHandler>;
  onAction?: (
    state: ConversationEngineState,
    action: Parameters<EngineActionHandler>[0],
  ) => ReturnType<EngineActionHandler>;
  busy?: boolean;
}) {
  const { t } = useLingui();
  const id = useId();
  const [state, setState] = useState<ConversationEngineState | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, setPending] = useState(false);
  const [settingsPending, setSettingsPending] = useState(false);
  const actions = useEngineActions(
    onAction && state ? (action) => onAction(state, action) : undefined,
    refresh,
    actionUncertain,
    onCheckAction,
  );
  const busy = botBusy || settingsPending || actions.pending;
  const [failure, setFailure] = useState<string | null>(null);
  const load = useRef(onLoad);
  load.current = onLoad;
  const active = useRef(true);
  const inFlight = useRef(false);
  const dirtyRef = useRef(false);
  function accept(next: ConversationEngineState, preserveDraft = true) {
    setState(next);
    const nextDebug = next.inspection?.debug;
    setDraft((previous) =>
      nextDebug?.axes && nextDebug.warmthGrade && nextDebug.patienceGrade && nextDebug.revision
        ? preserveDraft && dirtyRef.current && previous
          ? previous
          : draftFrom(nextDebug)
        : null,
    );
  }

  async function refresh() {
    if (inFlight.current || settingsPending || actions.pending) return;
    inFlight.current = true;
    setPending(true);
    setFailure(null);
    try {
      const next = await load.current();
      if (active.current) accept(next);
    } catch (error) {
      if (active.current) setFailure(errorText(error, t`Could not load Eros state`));
    } finally {
      inFlight.current = false;
      if (active.current) setPending(false);
    }
  }
  useEffect(() => {
    active.current = true;
    void refresh();
    return () => {
      active.current = false;
    };
  }, []);
  const inspection = state?.inspection;
  const debug = inspection?.debug;
  const dirty = Boolean(
    debug && draft && JSON.stringify(draft) !== JSON.stringify(draftFrom(debug)),
  );
  const staleDraft = Boolean(dirty && draft && draft.revision !== debug?.revision);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (
      !botBusy &&
      (debug?.editable !== false ||
        debug.editBlockedReason === "missing_affinity" ||
        debug.editBlockedReason === "unacknowledged_turn")
    )
      return;
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [botBusy, settingsPending, actions.pending, debug?.editable, debug?.editBlockedReason]);
  const wasBusy = useRef(botBusy);
  useEffect(() => {
    if (wasBusy.current && !botBusy) void refresh();
    wasBusy.current = botBusy;
  }, [botBusy]);
  async function save() {
    if (
      !state ||
      !debug?.editable ||
      !debug.axes ||
      !debug.revision ||
      !draft ||
      pending ||
      staleDraft ||
      busy ||
      inFlight.current
    )
      return;
    if (
      editableAxes.some(
        (key) =>
          !draft[key].trim() ||
          !Number.isFinite(Number(draft[key])) ||
          Number(draft[key]) < 0 ||
          Number(draft[key]) > 1,
      )
    ) {
      setFailure(t`Enter numbers from 0 to 1.`);
      return;
    }
    if (
      draft.elapsedHours.trim() &&
      (!Number.isFinite(Number(draft.elapsedHours)) ||
        Number(draft.elapsedHours) < 0 ||
        Number(draft.elapsedHours) > 720)
    ) {
      setFailure(t`Enter elapsed hours from 0 to 720.`);
      return;
    }
    inFlight.current = true;
    setPending(true);
    setFailure(null);
    try {
      const next = await onSave(state, {
        expectedRevision: draft.revision,
        ...(draft.elapsedHours.trim() ? { elapsedHours: Number(draft.elapsedHours) } : {}),
        axes: {
          ...debug.axes,
          ...Object.fromEntries(editableAxes.map((key) => [key, Number(draft[key])])),
        },
        warmthGrade: Number(draft.warmthGrade),
        patienceGrade: Number(draft.patienceGrade),
      });
      if (active.current) accept(next, false);
    } catch (error) {
      if (active.current) setFailure(errorText(error, t`Could not save Eros state`));
    } finally {
      inFlight.current = false;
      if (active.current) setPending(false);
    }
  }
  const axisLabels = {
    trust: t`Trust`,
    intrigue: t`Intrigue`,
    intimacy: t`Intimacy`,
    tension: t`Tension`,
  };
  const blockedReason =
    debug?.editBlockedReason === "missing_affinity"
      ? t`Start a conversation to edit.`
      : debug?.editBlockedReason === "processing"
        ? t`Reply in progress.`
        : debug?.editBlockedReason === "settling"
          ? t`Settling…`
          : debug?.editBlockedReason === "unacknowledged_turn"
            ? t`Last turn is not settled.`
            : busy
              ? t`Wait for the reply to finish.`
              : t`Editing unavailable.`;
  return (
    <section
      className="mt-6 space-y-3"
      aria-label={t`Eros character and state`}
      data-testid="conversation-engine-state"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">Eros</span>
        <Button
          variant="ghost"
          size="sm"
          disabled={pending || settingsPending || actions.pending}
          onClick={() => void refresh()}
        >
          <Trans>Refresh</Trans>
        </Button>
      </div>
      {pending && !state ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Loading…</Trans>
        </p>
      ) : null}
      <Disclosure label={t`Character`} open>
        {state ? (
          <p className="text-sm font-medium">{debug?.persona.name ?? state.character.name}</p>
        ) : null}
        {debug ? (
          <>
            <Value label={t`Character instructions`}>{debug.persona.systemPrompt}</Value>
            {debug.persona.tipPersonality ? (
              <Value label={t`Personality guidance`}>{debug.persona.tipPersonality}</Value>
            ) : null}
          </>
        ) : state?.status === "ready" ? (
          <p className="text-xs text-muted-foreground">
            <Trans>Character instructions unavailable.</Trans>
          </p>
        ) : null}
        {state?.status === "uninitialized" ? (
          <p className="text-sm text-muted-foreground">
            <Trans>Start a conversation to see character insights and Eros state.</Trans>
          </p>
        ) : null}
        {inspection ? (
          <Disclosure label={t`Character insights`}>
            <EngineProfile profile={inspection.profile} />
          </Disclosure>
        ) : null}
      </Disclosure>
      {state?.settings && onSaveSettings ? (
        <ConversationEngineSettings
          state={state}
          busy={busy || pending}
          inventory={
            <ConversationEngineInventory
              state={state}
              disabled={busy || pending || actions.uncertain || state.status !== "ready"}
              run={onAction ? actions.run : undefined}
            />
          }
          onSave={async (settings, values) => {
            setSettingsPending(true);
            try {
              const next = await onSaveSettings({ ...state, settings }, values);
              if (active.current)
                setState((current) => (current ? { ...current, settings: next } : current));
              return next;
            } finally {
              if (active.current) setSettingsPending(false);
            }
          }}
        />
      ) : null}
      {state ? (
        <ConversationEngineObservations
          state={state}
          disabled={busy || pending || actions.uncertain}
          run={onAction ? actions.run : undefined}
        />
      ) : null}
      {actions.uncertain && onCheckAction ? (
        <Button
          variant="outline"
          size="sm"
          disabled={actions.pending || botBusy}
          onClick={() => void actions.check()}
        >
          <Trans>Check action</Trans>
        </Button>
      ) : null}
      {actions.notice ? (
        <p role="status" className="text-xs text-muted-foreground">
          {actions.notice}
        </p>
      ) : null}
      {actions.failure ? (
        <p role="alert" className="text-xs text-destructive">
          {actions.failure}
        </p>
      ) : null}
      {debug?.time ? (
        <Disclosure label={t`Time`}>
          <Value label={t`Timezone`}>{debug.time.timezone ?? t`Not available`}</Value>
          <Value label={t`Engine time`}>{debug.time.localTime ?? debug.time.currentTime}</Value>
          <Value label={t`Affinity elapsed hours`}>
            {debug.time.affinityElapsedHours == null
              ? t`Not available`
              : Math.round(debug.time.affinityElapsedHours * 100) / 100}
          </Value>
          <Value label={t`Feeling elapsed hours`}>
            {debug.time.feelingElapsedHours == null
              ? t`Not available`
              : Math.round(debug.time.feelingElapsedHours * 100) / 100}
          </Value>
          {draft ? (
            <div className="space-y-1">
              <label htmlFor={`${id}-elapsedHours`} className="text-sm">
                <Trans>Simulate elapsed hours (0–720)</Trans>
              </label>
              <Input
                id={`${id}-elapsedHours`}
                inputMode="decimal"
                type="number"
                min={0}
                max={720}
                step="any"
                disabled={pending || busy || !debug.editable}
                value={draft.elapsedHours}
                onChange={(event) => setDraft({ ...draft, elapsedHours: event.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                <Trans>
                  Simulates relationship time and clears the feeling summary. The engine clock and
                  message dates stay unchanged.
                </Trans>
              </p>
            </div>
          ) : null}
        </Disclosure>
      ) : null}
      {busy || debug?.editable === false ? (
        <p role="status" className="text-xs text-muted-foreground">
          {blockedReason}
        </p>
      ) : null}
      <Disclosure label={t`Eros debug`}>
        {inspection ? (
          <>
            <Value label={t`Feeling summary`}>{debug?.feeling || t`Not available`}</Value>
            {debug?.feelingUpdatedAt ? (
              <Value label={t`Feeling updated at`}>{debug.feelingUpdatedAt}</Value>
            ) : null}
            <Value label={t`Emotional need`}>
              {inspection.emotionalNeed === "low"
                ? t`Low`
                : inspection.emotionalNeed === "mid"
                  ? t`Medium`
                  : inspection.emotionalNeed === "high"
                    ? t`High`
                    : t`Not available`}
            </Value>
            <Value label={t`Observed at`}>{inspection.observedAt}</Value>
            {debug?.feeling ? (
              <p className="text-xs text-muted-foreground">
                <Trans>The feeling summary may update after the reply.</Trans>
              </p>
            ) : null}
            {inspection.affinity ? (
              <div className="grid grid-cols-2 gap-3">
                <Value label={t`Warmth`}>{inspection.affinity.warmth}</Value>
                <Value label={t`Patience`}>{inspection.affinity.patience}</Value>
                <Value label={t`Bond`}>
                  {inspection.affinity.bondLabel} ({inspection.affinity.bond})
                </Value>
                <Value label={t`Chemistry`}>
                  {inspection.affinity.chemistryLabel} ({inspection.affinity.chemistry})
                </Value>
              </div>
            ) : null}
            {debug && draft ? (
              <fieldset disabled={pending || busy || !debug.editable} className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  {editableAxes.map((key) => (
                    <div key={key} className="space-y-1">
                      <label htmlFor={`${id}-${key}`} className="text-sm">
                        {axisLabels[key]}{" "}
                        <span className="text-xs text-muted-foreground">(0–1)</span>
                      </label>
                      <Input
                        id={`${id}-${key}`}
                        aria-label={axisLabels[key]}
                        inputMode="decimal"
                        type="number"
                        min={0}
                        max={1}
                        step="any"
                        value={draft[key]}
                        onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                      />
                    </div>
                  ))}
                  {(
                    [
                      ["warmthGrade", t`Warmth grade`],
                      ["patienceGrade", t`Patience grade`],
                    ] as const
                  ).map(([key, label]) => (
                    <div key={key} className="space-y-1">
                      <label htmlFor={`${id}-${key}`} className="text-sm">
                        {label}
                      </label>
                      <NativeSelect
                        id={`${id}-${key}`}
                        value={draft[key]}
                        onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                      >
                        {[1, 2, 3].map((grade) => (
                          <NativeSelectOption key={grade} value={grade}>
                            {grade}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </div>
                  ))}
                </div>
              </fieldset>
            ) : inspection.affinity ? (
              <div className="grid grid-cols-2 gap-3">
                {editableAxes.map((key) => (
                  <Value key={key} label={axisLabels[key]}>
                    {inspection.affinity![key]}
                  </Value>
                ))}
              </div>
            ) : null}
            {inspection.latestEvent ? (
              <Value label={t`Latest evaluation`}>
                {inspection.latestEvent.type} · {inspection.latestEvent.createdAt}
              </Value>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            <Trans>No conversation state yet.</Trans>
          </p>
        )}
      </Disclosure>
      {staleDraft ? (
        <p role="status" className="text-xs text-muted-foreground">
          <Trans>State changed. Discard edits to use the latest values.</Trans>
        </p>
      ) : null}
      {dirty && debug ? (
        <div className="flex gap-2">
          <Button
            disabled={pending || busy || !debug.editable || staleDraft}
            onClick={() => void save()}
          >
            <Trans>Save changes</Trans>
          </Button>
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() => {
              setDraft(draftFrom(debug));
              setFailure(null);
            }}
          >
            <Trans>Discard</Trans>
          </Button>
        </div>
      ) : null}

      {failure ? (
        <p role="alert" className="text-xs text-destructive">
          {failure}
        </p>
      ) : null}
    </section>
  );
}

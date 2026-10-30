import { Trans, useLingui } from "@lingui/react/macro";
import type {
  ConversationEngineAction,
  ConversationEngineActionOutcome,
  ConversationEngineState,
} from "@rakazo/contracts";
import { Button, Input, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useEffect, useId, useRef, useState } from "react";
import { errorText } from "../../lib/user-error";
import { EngineDisclosure as Disclosure, EngineValue as Value } from "./conversation-engine-fields";

export type EngineAction = ConversationEngineAction;
export type EngineActionOutcome = ConversationEngineActionOutcome;
export type EngineActionHandler = (action: EngineAction) => Promise<EngineActionOutcome>;

export function useEngineActions(
  onAction: EngineActionHandler | undefined,
  onRefresh: () => Promise<void>,
  unresolved = false,
  onCheck?: () => Promise<EngineActionOutcome>,
) {
  const { t } = useLingui();
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(unresolved);
  useEffect(() => {
    setUncertain(unresolved);
  }, [unresolved]);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inFlight = useRef(false);
  async function perform(request: () => Promise<EngineActionOutcome>, expectMessage = false) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setFailure(null);
    setNotice(null);
    try {
      const result = await request();
      if (result.status === "uncertain") {
        setUncertain(true);
        setFailure(t`Action outcome is uncertain. Check the conversation before continuing.`);
      } else {
        setUncertain(false);
        if (expectMessage && result.message === null) setNotice(t`No message generated.`);
        await onRefresh();
      }
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      setUncertain(code !== "BAD_REQUEST" && code !== "CONFLICT");
      setFailure(
        code === "ACTION_RECOVERY_UNAVAILABLE"
          ? t`Action recovery storage is unavailable. No new action was sent.`
          : code === "ACTION_RECOVERY_INVALID"
            ? t`The saved action could not be read. No new action was sent.`
            : errorText(error, t`Could not complete the Eros action`),
      );
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }
  return {
    pending,
    uncertain,
    failure,
    notice,
    run: (action: EngineAction) => {
      if (!onAction || uncertain) return Promise.resolve();
      return perform(() => onAction(action), action.kind === "open" || action.kind === "event");
    },
    check: () => (onCheck ? perform(onCheck) : Promise.resolve()),
  };
}

export function ConversationEngineObservations({
  state,
  disabled,
  run,
}: {
  state: ConversationEngineState;
  disabled: boolean;
  run?: (action: EngineAction) => Promise<void>;
}) {
  const { t } = useLingui();
  const inspection = state.inspection;
  const needLabels = {
    hunger: t`Hunger`,
    social: t`Social`,
    stamina: t`Stamina`,
    emotional: t`Emotional`,
    outing: t`Outing`,
    indulgence: t`Indulgence`,
  };
  const levels = { low: t`Low`, mid: t`Medium`, high: t`High` };
  return (
    <div className="space-y-3">
      <Disclosure label={t`Needs`}>
        {inspection?.needs ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              {Object.entries(inspection.needs).map(([key, level]) => (
                <Value key={key} label={needLabels[key as keyof typeof needLabels]}>
                  {levels[level]}
                </Value>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              <Trans>Observed by Eros. Direct overrides are unavailable.</Trans>
            </p>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            <Trans>Needs are unavailable from this Eros deployment.</Trans>
          </p>
        )}
        {inspection?.effects?.length ? (
          <Value label={t`Active effects`}>
            {inspection.effects.map((effect, index) => (
              <p key={`${effect.item}-${index}`}>
                {effect.name ?? effect.item} · {effect.phase} · {effect.step}/{effect.steps}
              </p>
            ))}
          </Value>
        ) : null}
      </Disclosure>
      <Disclosure label={t`Events and daily life`}>
        {inspection?.lifeEvent ? (
          <Value label={t`Current event`}>
            {inspection.lifeEvent.kind} · {inspection.lifeEvent.endsAt}
          </Value>
        ) : (
          <p className="text-xs text-muted-foreground">
            <Trans>No current event reported.</Trans>
          </p>
        )}
        {inspection?.backgroundEvent ? (
          <Value label={t`Background event`}>
            {inspection.backgroundEvent.kind} · {inspection.backgroundEvent.endsAt}
          </Value>
        ) : null}
        {run ? (
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || state.status !== "ready"}
            onClick={() => void run({ kind: "event" })}
          >
            <Trans>Draw event</Trans>
          </Button>
        ) : null}
      </Disclosure>
      <Disclosure label={t`Initiative and greetings`}>
        <p className="text-xs text-muted-foreground">
          <Trans>Automatic initiative is managed by the Eros deployment.</Trans>
        </p>
        {run ? (
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => void run({ kind: "open", occasion: "just_opened" })}
          >
            <Trans>Greet now</Trans>
          </Button>
        ) : null}
      </Disclosure>
    </div>
  );
}

export function ConversationEngineInventory({
  state,
  disabled,
  run,
}: {
  state: ConversationEngineState;
  disabled: boolean;
  run?: (action: EngineAction) => Promise<void>;
}) {
  const { t } = useLingui();
  const id = useId();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"item" | "clothing">("item");
  const items = state.inspection?.items;
  return (
    <div className="space-y-3">
      {items ? (
        items.length ? (
          <ul className="space-y-2">
            {items.map((item, index) => (
              <li
                key={item.id ?? `${item.name}-${index}`}
                className="flex items-center justify-between gap-2 text-sm"
              >
                <span>
                  {item.name} · {item.kind === "clothing" ? t`Clothing` : t`Item`}
                </span>
                {run && item.id ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={disabled}
                    aria-label={t`Remove ${item.name}`}
                    onClick={() => void run({ kind: "delete_item", itemId: item.id! })}
                  >
                    <Trans>Remove</Trans>
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">
            <Trans>No inventory items.</Trans>
          </p>
        )
      ) : (
        <p className="text-xs text-muted-foreground">
          <Trans>Inventory is unavailable from this Eros deployment.</Trans>
        </p>
      )}
      {run ? (
        <fieldset disabled={disabled} className="space-y-2">
          <label className="text-sm" htmlFor={`${id}-kind`}>
            <Trans>Item type</Trans>
          </label>
          <NativeSelect
            id={`${id}-kind`}
            value={kind}
            onChange={(event) => setKind(event.target.value as "item" | "clothing")}
          >
            <NativeSelectOption value="item">{t`Item`}</NativeSelectOption>
            <NativeSelectOption value="clothing">{t`Clothing`}</NativeSelectOption>
          </NativeSelect>
          <label className="text-sm" htmlFor={`${id}-name`}>
            <Trans>Item name</Trans>
          </label>
          <Input
            id={`${id}-name`}
            value={name}
            maxLength={64}
            onChange={(event) => setName(event.target.value)}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={!name.trim()}
            onClick={() => void run({ kind: "add_item", itemKind: kind, name: name.trim() })}
          >
            <Trans>Add item</Trans>
          </Button>
        </fieldset>
      ) : null}
    </div>
  );
}

import { Trans, useLingui } from "@lingui/react/macro";
import type { RoleplayRelationshipDebug as RoleplayRelationshipState } from "@rakazo/contracts";
import { Button, Input } from "@rakazo/ui-web";
import { useEffect, useId, useRef, useState } from "react";
import { errorText } from "../../lib/user-error";

type Scores = Record<keyof RoleplayRelationshipState["relationship"], string>;
const draftFrom = (state: RoleplayRelationshipState): Scores => ({
  warmth: String(state.relationship.warmth),
  intimacy: String(state.relationship.intimacy),
  love: String(state.relationship.love),
});

export function RoleplayRelationshipDebug({
  onLoad,
  onSave,
}: {
  onLoad: () => Promise<RoleplayRelationshipState>;
  onSave: (state: RoleplayRelationshipState) => Promise<RoleplayRelationshipState>;
}) {
  const { t } = useLingui();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<RoleplayRelationshipState | null>(null);
  const [draft, setDraft] = useState<Scores | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const load = useRef(onLoad);
  load.current = onLoad;
  const loadError = useRef("");
  loadError.current = t`Could not load relationship`;
  const saving = useRef(false);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPending(true);
    setFailure(null);
    setSaved(null);
    setDraft(null);
    void load
      .current()
      .then((state) => {
        if (!cancelled) {
          setSaved(state);
          setDraft(draftFrom(state));
        }
      })
      .catch((error) => {
        if (!cancelled) setFailure(errorText(error, loadError.current));
      })
      .finally(() => {
        if (!cancelled) setPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);
  const dirty = saved && draft && JSON.stringify(draft) !== JSON.stringify(draftFrom(saved));
  async function save() {
    if (!saved || !draft || pending || saving.current) return;
    const values = Object.values(draft);
    if (values.some((value) => !/^\d+$/.test(value) || Number(value) > 100)) {
      setFailure(t`Enter whole numbers from 0 to 100.`);
      return;
    }
    saving.current = true;
    setPending(true);
    setFailure(null);
    try {
      const state = await onSave({
        ...saved,
        relationship: {
          warmth: Number(draft.warmth),
          intimacy: Number(draft.intimacy),
          love: Number(draft.love),
        },
      });
      setSaved(state);
      setDraft(draftFrom(state));
    } catch (error) {
      setFailure(errorText(error, t`Could not save relationship`));
    } finally {
      saving.current = false;
      setPending(false);
    }
  }
  return (
    <details
      className="mt-6 border-b border-border pb-3"
      open={open}
      onToggle={(event) => {
        if (pending && !event.currentTarget.open) {
          event.currentTarget.open = true;
          return;
        }
        setOpen(event.currentTarget.open);
      }}
    >
      <summary className="cursor-pointer text-sm font-medium" aria-disabled={pending}>
        <Trans>Relationship debug</Trans>
      </summary>
      {open ? (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-muted-foreground">
            <Trans>Changes affect this conversation.</Trans>
          </p>
          {pending && !draft ? (
            <p role="status" className="text-sm text-muted-foreground">
              <Trans>Loading…</Trans>
            </p>
          ) : null}
          {draft ? (
            <fieldset disabled={pending} className="space-y-3">
              {(
                [
                  ["warmth", t`Warmth`],
                  ["intimacy", t`Intimacy`],
                  ["love", t`Love`],
                ] as const
              ).map(([key, label]) => (
                <div key={key} className="space-y-1">
                  <label htmlFor={`${id}-${key}`} className="text-sm">
                    {label}
                  </label>
                  <Input
                    id={`${id}-${key}`}
                    type="text"
                    inputMode="numeric"
                    value={draft[key]}
                    onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                  />
                </div>
              ))}
              {dirty ? (
                <div className="flex gap-2">
                  <Button onClick={() => void save()}>
                    {pending ? t`Saving…` : t`Save changes`}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setDraft(draftFrom(saved!));
                      setFailure(null);
                    }}
                  >
                    <Trans>Discard</Trans>
                  </Button>
                </div>
              ) : null}
            </fieldset>
          ) : null}
          {failure ? (
            <p role="alert" className="text-xs text-destructive">
              {failure}
            </p>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

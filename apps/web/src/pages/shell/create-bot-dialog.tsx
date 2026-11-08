import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, BotAvatarSet, ComputerMode, RoleplayCharacter } from "@rakazo/contracts";
import {
  BOT_NAME_MAX_LENGTH,
  DEFAULT_NEW_BOT_AVATAR_SET,
  parseRoleplayCharacterJson,
  ROLEPLAY_IMPORT_MAX_BYTES,
} from "@rakazo/contracts";
import {
  newClientId,
  ORGANIC_AVATAR_HEART_FAMILY,
  ORGANIC_AVATAR_LOOKS,
  organicAvatarFamily,
  organicAvatarSampleIdentity,
} from "@rakazo/core";
import {
  BOT_AVATAR_COLORS,
  BotAvatar,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  parseBotAvatar,
  Toggle,
} from "@rakazo/ui-web";
import { useEffect, useId, useRef, useState } from "react";
import { errorText } from "../../lib/user-error";
import { BotLookPicker } from "./avatar-studio-popover";
import { ComputerModePicker } from "./bot-panel";
import type { BotRuntimeSettingsValue } from "./bot-runtime-settings";
import { BotRuntimeSettings } from "./bot-runtime-settings";

/** One preview identity per organic look, so the dialog can show a body before the bot has an id. */
const ORGANIC_IDENTITIES = ORGANIC_AVATAR_LOOKS.map(organicAvatarSampleIdentity);

function pick<T>(options: readonly T[]): T {
  return options[Math.floor(Math.random() * options.length)]!;
}

export interface CreateBotDialogInput {
  name: string;
  botKind?: "agent" | "roleplay";
  roleplayCharacter?: RoleplayCharacter;
  color: string;
  /** Reserve the logo preview's persistent seed through creation and retries. */
  id?: string;
  avatarSet: BotAvatarSet;
  /** The organic family the preview drew; omitted when a studio shape is picked. */
  avatarFamily?: number;
  runtimeKind?: Bot["runtimeKind"];
  executionTarget?: Bot["executionTarget"];
  runtimePermission?: Bot["runtimePermission"];
  projectPath?: string | null;
  registeredHostId?: string | null;
  computerMode?: ComputerMode;
}

/** Mounted only while open; the parent unmounts it from `onCancel` or after `onCreate`. */
export function CreateBotDialog({
  onCancel,
  onCreate,
}: {
  onCancel: () => void;
  onCreate: (input: CreateBotDialogInput) => Promise<void>;
}) {
  const { t } = useLingui();
  const ids = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [roleplay, setRoleplay] = useState(false);
  const [character, setCharacter] = useState<RoleplayCharacter | null>(null);
  const [fileName, setFileName] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const importVersion = useRef(0);
  useEffect(
    () => () => {
      ++importVersion.current;
    },
    [],
  );
  const currentName = useRef(name);
  currentName.current = name;

  async function importCharacter(file: File | undefined) {
    const version = ++importVersion.current;
    setCharacter(null);
    setWarnings([]);
    setImportError(null);
    setFileName("");
    if (!file) {
      setImporting(false);
      return;
    }
    if (file.size > ROLEPLAY_IMPORT_MAX_BYTES) {
      setImporting(false);
      setImportError(t`Character JSON must be 1 MB or smaller.`);
      return;
    }
    setImporting(true);
    try {
      const result = parseRoleplayCharacterJson(await file.text());
      if (version !== importVersion.current) return;
      setCharacter(result.character);
      setWarnings(result.warnings);
      setFileName(file.name);
      if (!currentName.current.trim()) setName(result.character.name.slice(0, BOT_NAME_MAX_LENGTH));
    } catch (cause) {
      if (version === importVersion.current)
        setImportError(
          cause instanceof SyntaxError
            ? t`Choose a valid character JSON file.`
            : cause instanceof Error && cause.name === "ZodError"
              ? t`Character JSON contains invalid or oversized fields.`
              : errorText(cause, t`Could not import character JSON`),
        );
    } finally {
      if (version === importVersion.current) setImporting(false);
    }
  }
  const [previewId] = useState(() => {
    let id: string;
    do {
      id = `c${newClientId().replaceAll("-", "").slice(0, 24)}`;
    } while (organicAvatarFamily(id) === ORGANIC_AVATAR_HEART_FAMILY);
    return id;
  });
  const [look, setLook] = useState(() => ({
    value: pick(BOT_AVATAR_COLORS),
    identity: pick(ORGANIC_IDENTITIES),
  }));
  const [executionOpen, setExecutionOpen] = useState(false);
  const [runtime, setRuntime] = useState<BotRuntimeSettingsValue>({
    runtimeKind: "pi",
    executionTarget: "default",
    runtimePermission: "workspace",
    projectPath: null,
  });
  const [computerMode, setComputerMode] = useState<ComputerMode>("team");
  const [avatarSet, setAvatarSet] = useState<BotAvatarSet>(DEFAULT_NEW_BOT_AVATAR_SET);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();

  async function create() {
    if (!trimmed || submitting || (roleplay && (!character || importing))) return;
    setError(null);
    setSubmitting(true);
    const organic = avatarSet === "organic" && parseBotAvatar(look.value).shapeIndex === undefined;
    try {
      await onCreate({
        name: trimmed,
        color: look.value,
        ...(roleplay && character
          ? {
              botKind: "roleplay" as const,
              roleplayCharacter: character,
              runtimeKind: "pi" as const,
              executionTarget: "docker" as const,
              computerMode: "dedicated" as const,
              projectPath: null,
              registeredHostId: null,
            }
          : executionOpen
            ? { ...runtime, computerMode }
            : {}),
        ...(avatarSet === "rakazo" ? { id: previewId } : {}),
        avatarSet,
        ...(organic ? { avatarFamily: organicAvatarFamily(look.identity) } : {}),
      });
    } catch (err) {
      setError(errorText(err, t`Could not create bot`));
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting) onCancel();
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        initialFocus={nameRef}
        className="max-h-[calc(100dvh-2rem)] grid-cols-1 overflow-y-auto sm:max-w-md"
        data-testid="create-bot-dialog"
      >
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <DialogHeader>
            <DialogTitle className="text-center">
              <Trans>New bot</Trans>
            </DialogTitle>
          </DialogHeader>
          <div className="flex justify-center py-2">
            <BotAvatar
              color={look.value}
              identity={avatarSet === "rakazo" ? previewId : look.identity}
              size={96}
              avatarSet={avatarSet}
            />
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <Input
              ref={nameRef}
              aria-label={t`Name`}
              placeholder={t`Name your Bot`}
              value={name}
              maxLength={BOT_NAME_MAX_LENGTH}
              onChange={(event) => setName(event.target.value)}
              className="flex-1 text-center"
            />
            <Toggle
              aria-label={t`Roleplay`}
              pressed={roleplay}
              disabled={submitting}
              variant="outline"
              className="shrink-0"
              onPressedChange={(pressed) => {
                ++importVersion.current;
                setRoleplay(pressed);
                setCharacter(null);
                setFileName("");
                setWarnings([]);
                setImportError(null);
                setImporting(false);
                setError(null);
              }}
            >
              RP
            </Toggle>
          </div>
          {roleplay ? (
            <div className="min-w-0 space-y-2 wrap-anywhere">
              <label htmlFor={`${ids}-character`} className="block space-y-2 text-sm">
                <span>
                  <Trans>Character JSON</Trans>
                </span>
                <Input
                  id={`${ids}-character`}
                  type="file"
                  accept=".json,application/json"
                  aria-label={t`Character JSON`}
                  disabled={submitting}
                  className="truncate"
                  onChange={(event) => void importCharacter(event.target.files?.[0])}
                />
              </label>
              {importing ? (
                <p role="status" className="text-xs text-muted-foreground">
                  <Trans>Importing…</Trans>
                </p>
              ) : null}
              {character ? (
                <p role="status" className="text-sm">
                  {character.name}
                  <span className="block text-xs text-muted-foreground">{fileName}</span>
                </p>
              ) : null}
              {importError ? (
                <p role="alert" className="text-[13px] text-destructive">
                  {importError}
                </p>
              ) : null}
              {warnings.length ? (
                <ul
                  aria-label={t`Import warnings`}
                  className="list-disc space-y-1 ps-4 text-xs text-muted-foreground"
                >
                  {warnings.map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          {error ? (
            <p role="alert" data-testid="create-bot-error" className="text-[13px] text-destructive">
              {error}
            </p>
          ) : null}
          <BotLookPicker
            value={look.value}
            identity={avatarSet === "rakazo" ? previewId : look.identity}
            organicIdentities={ORGANIC_IDENTITIES}
            avatarSet={avatarSet}
            onAvatarSetChange={(set, value) => {
              setAvatarSet(set);
              setLook((current) => ({ ...current, value }));
            }}
            onChange={(value, identity) => {
              setLook((current) => ({ value, identity: identity ?? current.identity }));
            }}
          />
          {!roleplay ? (
            <Button
              type="button"
              variant="ghost"
              aria-expanded={executionOpen}
              onClick={() => setExecutionOpen(!executionOpen)}
            >
              <Trans>Agent and environment</Trans>
            </Button>
          ) : null}
          {executionOpen && !roleplay ? (
            <div className="space-y-3">
              <BotRuntimeSettings value={runtime} onChange={setRuntime} />
              <ComputerModePicker value={computerMode} onChange={setComputerMode} />
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={submitting} onClick={onCancel}>
              <Trans>Cancel</Trans>
            </Button>
            <Button
              type="submit"
              disabled={!trimmed || submitting || (roleplay && (!character || importing))}
            >
              <Trans>Create</Trans>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

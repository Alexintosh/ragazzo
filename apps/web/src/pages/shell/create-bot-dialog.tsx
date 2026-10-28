import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, ComputerMode } from "@rakazo/contracts";
import { BOT_NAME_MAX_LENGTH } from "@rakazo/contracts";
import {
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
} from "@rakazo/ui-web";
import { useRef, useState } from "react";
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
  color: string;
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
  onImport,
}: {
  onCancel: () => void;
  onCreate: (input: CreateBotDialogInput) => Promise<void>;
  onImport?: () => void;
}) {
  const { t } = useLingui();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();

  async function create() {
    if (!trimmed || submitting) return;
    setError(null);
    setSubmitting(true);
    const organic = parseBotAvatar(look.value).shapeIndex === undefined;
    try {
      await onCreate({
        name: trimmed,
        color: look.value,
        ...(executionOpen ? { ...runtime, computerMode } : {}),
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
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
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
            <BotAvatar color={look.value} identity={look.identity} size={96} />
          </div>
          <Input
            ref={nameRef}
            aria-label={t`Name`}
            placeholder={t`Name your Bot`}
            value={name}
            maxLength={BOT_NAME_MAX_LENGTH}
            onChange={(event) => setName(event.target.value)}
            className="text-center"
          />
          {error ? (
            <p role="alert" data-testid="create-bot-error" className="text-[13px] text-destructive">
              {error}
            </p>
          ) : null}
          <BotLookPicker
            value={look.value}
            identity={look.identity}
            organicIdentities={ORGANIC_IDENTITIES}
            onChange={(value, identity) =>
              setLook((current) => ({ value, identity: identity ?? current.identity }))
            }
          />
          <Button
            type="button"
            variant="ghost"
            aria-expanded={executionOpen}
            onClick={() => setExecutionOpen(!executionOpen)}
          >
            <Trans>Agent and environment</Trans>
          </Button>
          {executionOpen ? (
            <div className="space-y-3">
              <BotRuntimeSettings value={runtime} onChange={setRuntime} />
              <ComputerModePicker value={computerMode} onChange={setComputerMode} />
            </div>
          ) : null}
          <DialogFooter>
            {onImport ? (
              <Button
                type="button"
                variant="ghost"
                className="sm:me-auto"
                disabled={submitting}
                data-testid="create-bot-import"
                onClick={onImport}
              >
                <Trans>Import</Trans>
              </Button>
            ) : null}
            <Button type="button" variant="outline" disabled={submitting} onClick={onCancel}>
              <Trans>Cancel</Trans>
            </Button>
            <Button type="submit" disabled={!trimmed || submitting}>
              <Trans>Create</Trans>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

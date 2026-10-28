import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, ThinkingLevel } from "@rakazo/contracts";
import {
  chatModelChoices,
  connectedModelChoices,
  credentialForModel,
  groupModelChoices,
  modelOptionKey,
  parseModelOptionKey,
  resolveSelectableModelId,
} from "@rakazo/core";
import {
  Button,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  NativeSelect,
  NativeSelectOption,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, LoaderCircle } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { thinkingLevelLabel } from "../../lib/model-catalog";
import { useSpaceQueries } from "../../lib/query";
import { SpaceRpcProvider, useSpaceRpc } from "../../lib/space-rpc";
import { errorText } from "../../lib/user-error";

type ModelOption = {
  key: string;
  label: string;
  provider?: string;
  modelId?: string;
  providerLabel?: string;
  modelLabel?: string;
  thinkingLevels: ThinkingLevel[];
  defaultThinkingLevel: ThinkingLevel | null;
};

/** Keep a request pinned to its bot and Space, including when navigation changes mid-save. */
export function BotModelPicker({ bot, onSaved }: { bot: Bot; onSaved?: (bot: Bot) => void }) {
  return (
    <SpaceRpcProvider spaceId={bot.spaceId}>
      <BotModelPickerContent
        key={JSON.stringify([
          bot.spaceId,
          bot.id,
          bot.runtimeKind,
          bot.registeredHostId ?? null,
          bot.projectPath ?? null,
          bot.runtimeGeneration ?? 0,
        ])}
        bot={bot}
        onSaved={onSaved}
      />
    </SpaceRpcProvider>
  );
}

function BotModelPickerContent({ bot, onSaved }: { bot: Bot; onSaved?: (bot: Bot) => void }) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const queries = useSpaceQueries();
  const pi = !bot.runtimeKind || bot.runtimeKind === "pi";
  const catalog = useQuery({ ...queries.models.list.queryOptions(), enabled: pi });
  const credentials = useQuery({ ...queries.models.credentials.queryOptions(), enabled: pi });
  const me = useQuery({ ...queries.me.queryOptions(), enabled: pi });
  const nativeOptions = queries.bots.runtimeModels.queryOptions({ input: { botId: bot.id } });
  const native = useQuery({
    ...nativeOptions,
    queryKey: [
      ...nativeOptions.queryKey,
      bot.runtimeKind,
      bot.registeredHostId ?? null,
      bot.projectPath ?? null,
      bot.runtimeGeneration ?? 0,
    ],
    enabled: !pi,
  });
  const [accepted, setAccepted] = useState(bot);
  // Roster polls can finish with a snapshot from before this picker saved.
  const current = bot.updatedAt > accepted.updatedAt ? bot : accepted;
  useEffect(() => {
    if (bot.updatedAt > accepted.updatedAt) setAccepted(bot);
  }, [bot, accepted.updatedAt]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const effortId = useId();

  let options: ModelOption[] = [];
  let selectedKey = "";
  let effective: ModelOption | undefined;
  let loading: boolean;
  let failed: boolean;
  let available: boolean;
  if (pi) {
    loading = catalog.isPending || credentials.isPending || me.isPending;
    failed = catalog.isError || credentials.isError || me.isError;
    available = !loading && !failed;
    const entries = catalog.data ?? [];
    const connections = credentials.data ?? [];
    selectedKey =
      current.modelProvider && current.modelId
        ? modelOptionKey(
            current.modelProvider,
            resolveSelectableModelId(entries, current.modelProvider, current.modelId),
          )
        : "";
    options = chatModelChoices(
      connectedModelChoices(connections, entries),
      selectedKey,
      t`Space default`,
    ).map((choice) => {
      const provider = choice.provider ?? me.data?.defaultProvider;
      const id = choice.modelId ?? me.data?.defaultModel;
      const entry = entries.find((item) => item.provider === provider && item.id === id);
      const credential = credentialForModel(connections, provider, id);
      return {
        ...choice,
        thinkingLevels: (credential?.thinkingLevels ?? entry?.thinkingLevels ?? []).filter(
          (level) => level !== "off",
        ),
        defaultThinkingLevel: credential?.thinkingLevel ?? "medium",
      };
    });
    effective = options.find((option) => option.key === selectedKey);
    if (effective && !selectedKey) {
      const entry = entries.find(
        (item) => item.provider === me.data?.defaultProvider && item.id === me.data?.defaultModel,
      );
      effective = {
        ...effective,
        label: entry?.label ?? me.data?.defaultModel ?? t`Space default`,
      };
    }
  } else {
    loading = native.isPending;
    failed = native.isError;
    available = native.data?.available === true && native.data.runtimeKind === bot.runtimeKind;
    selectedKey = current.modelId ?? "";
    options = (native.data?.models ?? []).map((model) => ({
      key: model.id,
      modelId: model.id,
      label: model.name,
      thinkingLevels: model.thinkingLevels,
      defaultThinkingLevel: model.defaultThinkingLevel,
    }));
    effective = options.find(
      (option) => option.key === (selectedKey || native.data?.defaultModelId),
    );
    const defaultModel = options.find((option) => option.key === native.data?.defaultModelId);
    if (!current.modelId && effective) {
      // An inherited model uses project configuration; a concrete override uses that model's default.
      effective = { ...effective, defaultThinkingLevel: native.data?.defaultThinkingLevel ?? null };
    }
    if (available)
      options.unshift({
        key: "",
        label: t`Runtime default`,
        modelId: native.data?.defaultModelId ?? undefined,
        thinkingLevels: defaultModel?.thinkingLevels ?? [],
        defaultThinkingLevel: native.data?.defaultThinkingLevel ?? null,
      });
  }
  const effort =
    current.thinkingLevel ??
    (!pi && !current.modelId ? native.data?.defaultThinkingLevel : effective?.defaultThinkingLevel);
  const effortLabel = effort ? thinkingLevelLabel(effort) : !pi ? t`Default` : null;
  const label =
    effective?.modelLabel ??
    effective?.label ??
    current.modelId ??
    (!pi ? (native.data?.defaultModelId ?? t`Runtime default`) : t`Model`);
  const sections = groupModelChoices(options, search);
  const canEdit = available && options.length > 0 && !loading && !failed;

  async function save(
    option: ModelOption,
    thinkingLevel: ThinkingLevel | null,
    effortOnly = false,
  ) {
    if (savingRef.current || !canEdit) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const model = parseModelOptionKey(option.key);
      const updated = pi
        ? await rpc.bots.update({
            botId: bot.id,
            modelProvider: model?.provider ?? null,
            modelId: model?.modelId ?? null,
            thinkingLevel,
          })
        : await rpc.bots.setRuntimeModel({
            botId: bot.id,
            modelId: effortOnly
              ? (current.modelId ?? effective?.modelId ?? null)
              : option.key
                ? (option.modelId ?? null)
                : null,
            thinkingLevel,
          });
      if (!mounted.current) return;
      setAccepted(updated);
      onSaved?.(updated);
    } catch (cause) {
      if (mounted.current) setError(errorText(cause, t`Could not save model`));
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  function refresh() {
    if (pi) void Promise.all([catalog.refetch(), credentials.refetch(), me.refetch()]);
    else void native.refetch();
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setSearch("");
      }}
    >
      <PopoverTrigger
        render={<Button variant="floating" />}
        aria-label={t`Model and effort`}
        aria-busy={saving || loading}
        data-testid="bot-model-trigger"
        className="app-no-drag h-9 min-w-0 max-w-full gap-1.5 px-3 text-xs font-normal text-muted-foreground"
      >
        <span className="truncate">{label}</span>
        {effortLabel ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="shrink-0">{effortLabel}</span>
          </>
        ) : null}
        {saving || loading ? (
          <LoaderCircle aria-hidden="true" className="size-3 shrink-0 animate-spin" />
        ) : (
          <ChevronDown aria-hidden="true" className="size-3 shrink-0" />
        )}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={8}
        initialFocus={searchRef}
        className="w-80 max-w-[calc(100vw-1.5rem)] gap-0 overflow-hidden p-0"
      >
        {canEdit ? (
          <>
            <Command shouldFilter={false} label={t`Search models`} loop className="rounded-none!">
              <CommandInput
                ref={searchRef}
                value={search}
                onValueChange={setSearch}
                aria-label={t`Search models`}
                placeholder={t`Search models`}
                disabled={saving}
              />
              <CommandList label={t`Model options`} className="max-h-64">
                <CommandEmpty>
                  <Trans>No matching models</Trans>
                </CommandEmpty>
                {sections.map((section) => (
                  <CommandGroup key={section.key} heading={section.heading}>
                    {section.data.map((choice) => {
                      const option = options.find((item) => item.key === choice.key)!;
                      return (
                        <CommandItem
                          key={choice.key}
                          value={choice.key || "space-default"}
                          aria-label={choice.label}
                          data-checked={choice.key === selectedKey}
                          disabled={saving}
                          onSelect={() => {
                            if (option.key === selectedKey) return;
                            void save(
                              option,
                              (pi || option.key) &&
                                current.thinkingLevel &&
                                option.thinkingLevels.includes(current.thinkingLevel)
                                ? current.thinkingLevel
                                : null,
                            );
                          }}
                        >
                          <span className="min-w-0 flex-1 truncate">
                            {choice.title ?? choice.label}
                          </span>
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                ))}
              </CommandList>
            </Command>
            {effective?.thinkingLevels.length ? (
              <div className="flex items-center justify-between gap-3 border-t px-3 py-2">
                <label htmlFor={effortId} className="text-xs text-muted-foreground">
                  <Trans>Effort</Trans>
                </label>
                <NativeSelect
                  id={effortId}
                  aria-label={t`Reasoning effort`}
                  value={current.thinkingLevel ?? ""}
                  disabled={saving}
                  className="h-8 w-auto min-w-28 text-xs"
                  onChange={(event) => {
                    const option = options.find((item) => item.key === selectedKey) ?? options[0];
                    if (option)
                      void save(option, (event.target.value || null) as ThinkingLevel | null, true);
                  }}
                >
                  <NativeSelectOption value="">
                    {effective.defaultThinkingLevel
                      ? t`Default (${thinkingLevelLabel(effective.defaultThinkingLevel)})`
                      : t`Default`}
                  </NativeSelectOption>
                  {effective.thinkingLevels.map((level) => (
                    <NativeSelectOption key={level} value={level}>
                      {thinkingLevelLabel(level)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
            ) : null}
          </>
        ) : (
          <div className="flex items-center justify-between gap-3 p-3 text-xs text-muted-foreground">
            <span role="status">
              {loading
                ? t`Loading models…`
                : failed
                  ? t`Could not load models`
                  : t`Model selection unavailable`}
            </span>
            {!loading ? (
              <Button variant="ghost" size="sm" onClick={refresh}>{t`Refresh`}</Button>
            ) : null}
          </div>
        )}
        {error ? (
          <p role="alert" className="border-t px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}
        {saving ? (
          <span role="status" className="sr-only">
            <Trans>Saving model…</Trans>
          </span>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

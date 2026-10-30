import { Trans, useLingui } from "@lingui/react/macro";
import type { ConversationEngineState } from "@rakazo/contracts";
import type { ReactNode } from "react";

export function EngineValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-sm">
        {children}
      </div>
    </div>
  );
}

export function EngineDisclosure({
  label,
  open,
  children,
}: {
  label: string;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details open={open} className="border-b border-border">
      <summary className="min-h-10 cursor-pointer py-2 text-sm font-medium">{label}</summary>
      <div className="space-y-4 pb-4 pt-1">{children}</div>
    </details>
  );
}

export function EngineProfile({
  profile,
}: {
  profile: NonNullable<ConversationEngineState["inspection"]>["profile"];
}) {
  const { t } = useLingui();
  const entries: [string, string | string[] | null][] = [
    [t`Location`, profile.location],
    [t`Occupation`, profile.occupation],
    [t`Current situation`, profile.currentSituation],
    [t`Desires`, profile.desires],
    [t`Vulnerabilities`, profile.vulnerabilities],
    [t`Habits`, profile.habits],
    [t`Personal values`, profile.personalValues],
    [t`Likes`, profile.likes],
    [t`Dislikes`, profile.dislikes],
    [t`Relationships`, profile.relationships],
  ];
  const visible = entries.filter(([, value]) =>
    Array.isArray(value) ? value.length : Boolean(value),
  );
  return visible.length ? (
    visible.map(([label, value]) => (
      <EngineValue key={label} label={label}>
        {Array.isArray(value) ? value.join("\n") : value}
      </EngineValue>
    ))
  ) : (
    <p className="text-xs text-muted-foreground">
      <Trans>No insights yet.</Trans>
    </p>
  );
}

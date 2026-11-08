import { I18nProvider } from "@lingui/react";
import type { Bot } from "@rakazo/contracts";
import { DEFAULT_BOT_AVATAR_COLOR } from "@rakazo/ui-web";
import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import { queryClient } from "../../src/lib/query";
import { ChatHeader } from "../../src/pages/shell/chat-header";
import "../../src/styles.css";

export const fixtureBot = {
  id: "11111111-1111-4111-8111-111111111111",
  spaceId: "22222222-2222-4222-8222-222222222222",
  name: "Scout",
  color: DEFAULT_BOT_AVATAR_COLOR,
  status: "idle",
  runtimeKind: "codex",
  registeredHostId: null,
  modelProvider: "codex-native",
  modelId: "gpt-5.4",
  thinkingLevel: "medium",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as Bot;

function Fixture() {
  const [bot, setBot] = useState(fixtureBot);
  return (
    <main className="relative flex h-dvh flex-col bg-background text-foreground">
      <ChatHeader
        inGroup={false}
        active={bot}
        activeGroup={undefined}
        activeSnapshot={null}
        phoneCallsEnabled={false}
        inCall={false}
        computerPanelOpen={false}
        onOpenNavigation={() => undefined}
        onOpenChatSettings={() => undefined}
        onCall={() => undefined}
        onToggleComputer={() => undefined}
        onModelSaved={setBot}
      />
      <div
        data-testid="transcript"
        className="flex flex-1 flex-col gap-5 px-6 pt-32 md:mx-auto md:w-full md:max-w-3xl md:pt-28"
      >
        <p className="self-end rounded-2xl bg-muted px-4 py-3 text-sm">
          Plan the launch checklist.
        </p>
        <p className="max-w-lg text-sm leading-7">
          I’ll review the open work and put together a checklist for the launch.
        </p>
      </div>
    </main>
  );
}

await bootstrapI18n("en");
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <I18nProvider i18n={i18n}>
      <Fixture />
    </I18nProvider>
  </QueryClientProvider>,
);

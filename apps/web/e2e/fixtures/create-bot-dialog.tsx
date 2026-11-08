import { I18nProvider } from "@lingui/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import { queryClient } from "../../src/lib/query";
import { CreateBotDialog } from "../../src/pages/shell/create-bot-dialog";
import "../../src/styles.css";

await bootstrapI18n("en");
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <I18nProvider i18n={i18n}>
      <MemoryRouter>
        <CreateBotDialog onCancel={() => undefined} onCreate={async () => undefined} />
      </MemoryRouter>
    </I18nProvider>
  </QueryClientProvider>,
);

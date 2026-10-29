import { I18nProvider } from "@lingui/react";
import type { RoleplayCharacter } from "@rakazo/contracts";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import { RoleplayRelationshipDebug } from "../../src/pages/shell/roleplay-relationship-debug";
import { RoleplaySettings } from "../../src/pages/shell/roleplay-settings";
import "../../src/styles.css";

const syntheticCharacter: RoleplayCharacter = {
  name: "Mira",
  description:
    "A cartographer who maps the islands that appear only at low tide. Her notebooks are full of careful observations and unfinished questions.",
  personality: "Observant, quietly adventurous, and slow to trust easy answers.",
  scenario: "You meet at the harbor as an unfamiliar island rises through the morning mist.",
  exampleDialogue:
    "{{user}}: What is out there?\n{{char}}: Something the old charts would rather we forgot.",
  firstMessage: "Mira closes her notebook. “You saw it too, didn’t you?”",
  systemPrompt: "Stay in character and leave the player's decisions to the player.",
  postHistoryInstructions: "Keep the mystery grounded in the details of the scene.",
  alternateGreetings: ["A lantern flickers at the end of the pier."],
  lorebook: {
    name: "The tidebound islands",
    description: "Places, people, and fragments from Mira's charts.",
    scanDepth: 4,
    tokenBudget: 2048,
    entries: [
      {
        keys: ["Glass Harbor", "harbor, east"],
        secondaryKeys: ["tide"],
        content: "Glass Harbor is built around an observatory whose windows face the sea.",
        enabled: true,
        constant: false,
        selective: false,
        caseSensitive: false,
        insertionOrder: 0,
        position: "before_char",
      },
      {
        keys: ["The Cartographers' Guild"],
        secondaryKeys: [],
        content: "The guild stopped publishing charts of the outer islands a generation ago.",
        enabled: true,
        constant: true,
        selective: false,
        caseSensitive: false,
        insertionOrder: 10,
        position: "after_char",
      },
      {
        keys: ["Old lighthouse"],
        secondaryKeys: [],
        content: "The lighthouse has stood dark since the last winter storm.",
        enabled: false,
        constant: false,
        selective: true,
        caseSensitive: true,
        insertionOrder: 20,
        position: "before_char",
      },
    ],
  },
};

function Fixture() {
  const [character, setCharacter] = useState(syntheticCharacter);
  const [relationship, setRelationship] = useState({
    relationship: { warmth: 35, intimacy: 20, love: 10 },
    historyGeneration: 1,
    revision: "fixture-revision",
  });
  const [saved, setSaved] = useState(false);
  return (
    <main className="min-h-dvh bg-background text-foreground">
      <div className="mx-auto w-full max-w-md px-5 py-8 sm:px-8">
        <header className="mb-6 border-b border-border pb-5">
          <p className="text-xs text-muted-foreground">Mira · Settings</p>
          <h1 className="mt-2 text-xl font-semibold">Character & story</h1>
        </header>
        <RoleplaySettings
          botId="synthetic-mira"
          character={character}
          status="idle"
          onSave={async (value) => {
            setCharacter(value);
            setSaved(true);
          }}
        />
        <RoleplayRelationshipDebug
          onLoad={async () => relationship}
          onSave={async (value) => {
            const saved = { ...value, revision: "fixture-updated-revision" };
            setRelationship(saved);
            return saved;
          }}
        />
        {saved ? (
          <p role="status" className="mt-4 text-xs text-muted-foreground">
            Changes saved
          </p>
        ) : null}
      </div>
    </main>
  );
}

await bootstrapI18n("en");
createRoot(document.getElementById("root")!).render(
  <I18nProvider i18n={i18n}>
    <Fixture />
  </I18nProvider>,
);

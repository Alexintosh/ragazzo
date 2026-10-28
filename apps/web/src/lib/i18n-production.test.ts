import { fileURLToPath } from "node:url";
import { transformSync, types } from "@babel/core";
import linguiMacro from "@lingui/babel-plugin-lingui-macro";
import { createCompiledCatalog, getCatalogs } from "@lingui/cli/api";
import { getConfig } from "@lingui/conf";
import { setupI18n } from "@lingui/core";
import { I18nProvider, Trans } from "@lingui/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { linguiMacroOptions } from "./lingui-macro-options";
import { UI_LOCALES } from "./ui-locale";

const config = getConfig({ cwd: fileURLToPath(new URL("../../", import.meta.url)) });

function readDescriptor(argument: types.Node | null | undefined) {
  if (!types.isObjectExpression(argument)) throw new Error("Expected a message descriptor");
  const descriptor: { id: string; message?: string } = { id: "" };
  for (const property of argument.properties) {
    if (
      types.isObjectProperty(property) &&
      types.isIdentifier(property.key) &&
      types.isStringLiteral(property.value)
    ) {
      if (property.key.name === "id") descriptor.id = property.value.value;
      if (property.key.name === "message") descriptor.message = property.value.value;
    }
  }
  return descriptor;
}

function productionDescriptor(message: string) {
  const result = transformSync(`import { t } from "@lingui/core/macro"; t\`${message}\`;`, {
    ast: true,
    configFile: false,
    babelrc: false,
    plugins: [[linguiMacro, { ...linguiMacroOptions, linguiConfig: config }]],
  });
  const statement = result?.ast?.program.body.at(-1);
  if (!types.isExpressionStatement(statement) || !types.isCallExpression(statement.expression)) {
    throw new Error("Expected a translated message call");
  }
  return readDescriptor(statement.expression.arguments[0]);
}

afterEach(() => vi.unstubAllEnvs());

describe("production translations", () => {
  it("keeps source text readable when a production catalog is missing a message", () => {
    vi.stubEnv("NODE_ENV", "production");
    const descriptor = productionDescriptor("Run on");
    const i18n = setupI18n({ locale: "en", messages: { en: {} } });
    expect(i18n._(descriptor)).toBe("Run on");

    i18n.loadAndActivate({ locale: "de", messages: { [descriptor.id]: "Ausführen auf" } });
    expect(i18n._(descriptor)).toBe("Ausführen auf");
  });

  it("keeps JSX labels readable when a production catalog is missing a message", () => {
    vi.stubEnv("NODE_ENV", "production");
    const result = transformSync(
      'import { Trans } from "@lingui/react/macro"; <Trans>Run on</Trans>;',
      {
        ast: true,
        configFile: false,
        babelrc: false,
        parserOpts: { plugins: ["jsx"] },
        plugins: [[linguiMacro, { ...linguiMacroOptions, linguiConfig: config }]],
      },
    );
    const statement = result?.ast?.program.body.at(-1);
    if (!types.isExpressionStatement(statement) || !types.isJSXElement(statement.expression)) {
      throw new Error("Expected a translated JSX label");
    }
    const attribute = statement.expression.openingElement.attributes[0];
    if (!types.isJSXSpreadAttribute(attribute)) throw new Error("Expected a message descriptor");
    const descriptor = readDescriptor(attribute.argument);
    const i18n = setupI18n({ locale: "en", messages: { en: {} } });
    expect(
      renderToStaticMarkup(createElement(I18nProvider, { i18n }, createElement(Trans, descriptor))),
    ).toBe("Run on");
  });

  it("resolves native agent and host controls from every compiled locale catalog", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const [catalog] = await getCatalogs(config);
    if (!catalog) throw new Error("Expected a web translation catalog");
    const descriptors = [
      "Agent",
      "Agent and environment",
      "Run on",
      "Default environment",
      "Host machine",
      "Docker sandbox",
      "Host",
      "Local host",
      "Register host",
      "Set up runtime",
      "Project folder",
      "Absolute path on host",
      "Access",
      "Workspace",
      "Full access",
      "Runtime ready",
      "Start the host with host access enabled.",
      "Install the runtime on the host.",
      "Sign in to the runtime on the host.",
    ].map(productionDescriptor);

    for (const locale of UI_LOCALES) {
      const { messages } = await catalog.getTranslations(locale, {
        sourceLocale: config.sourceLocale,
        fallbackLocales: config.fallbackLocales,
      });
      const compiled = createCompiledCatalog(locale, messages, { namespace: "json" });
      expect(compiled.errors, locale).toEqual([]);
      const i18n = setupI18n({
        locale,
        messages: { [locale]: JSON.parse(compiled.source).messages },
      });
      for (const { id } of descriptors) {
        // Pass only the hashed ID, exactly as a production descriptor did before
        // source fallbacks were retained. This checks catalog coverage itself.
        expect(i18n._(id), `${locale}: ${id}`).not.toBe(id);
      }
    }
  });
});

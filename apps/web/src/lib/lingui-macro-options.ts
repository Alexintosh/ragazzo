import type { LinguiPluginOpts } from "@lingui/babel-plugin-lingui-macro";

// Retain readable source text when a deployed catalog is missing a message.
export const linguiMacroOptions = { descriptorFields: "message" } satisfies LinguiPluginOpts;

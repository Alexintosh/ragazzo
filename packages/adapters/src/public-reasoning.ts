import type { ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";

/** Observe only the provider's explicitly public summary channel, before Pi combines
 * it with other thinking events. Never forward a partial message or reasoning_text. */
export function withPublicReasoningSummaries(
  options: ModelsSimpleStreamOptions | undefined,
  publish: (text: string) => void,
): ModelsSimpleStreamOptions {
  return {
    ...options,
    onProviderStreamEvent: async (event, model) => {
      await options?.onProviderStreamEvent?.(event, model);
      if (!event || typeof event !== "object") return;
      const value = event as Record<string, unknown>;
      if (value.type === "response.reasoning_summary_text.delta" && typeof value.delta === "string")
        publish(value.delta);
      else if (value.type === "response.reasoning_summary_part.done") publish("\n\n");
    },
  };
}

import type { Api, Model } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { withPublicReasoningSummaries } from "./public-reasoning.js";
it("forwards only public summary deltas, preserving the caller observer", async () => {
  const caller = vi.fn();
  const publish = vi.fn();
  const options = withPublicReasoningSummaries({ onProviderStreamEvent: caller }, publish);
  const model = { api: "openai-responses" } as Model<Api>;
  for (const event of [
    { type: "response.reasoning_summary_text.delta", delta: "Check the files" },
    { type: "response.reasoning_summary_part.done" },
    { type: "response.reasoning_text.delta", delta: "private reasoning" },
    { type: "thinking_delta", delta: "private thinking" },
    { type: "response.completed", response: { encrypted_content: "opaque" } },
  ])
    await options.onProviderStreamEvent?.(event, model);
  expect(publish.mock.calls).toEqual([["Check the files"], ["\n\n"]]);
  expect(caller).toHaveBeenCalledTimes(5);
});

import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ThreadWorkingFooter } from "../components/thread/thread-list-controls";

vi.mock("react-native", () => ({
  View: ({
    children,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
  }) => (
    <div role="status" aria-label={accessibilityLabel}>
      {children}
    </div>
  ),
}));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("../components/scroll-to-bottom-button", () => ({ ScrollToBottomButton: () => null }));
vi.mock("../components/activity-mark", () => ({
  ActivityMark: ({ bots, label }: { bots: Array<{ status: string }>; label?: string }) => (
    <div data-status={bots[0]?.status}>{label}</div>
  ),
}));

describe("thread working footer", () => {
  const bots = [{ id: "character", name: "Mira", color: "#14B8A6", status: "running" }];

  it("keeps the roleplay activity mark and accessible status without visible working copy", () => {
    const html = renderToString(
      <ThreadWorkingFooter bots={bots} label="Working…" atBottom botKind="roleplay" />,
    );
    expect(html).toContain('data-status="running"');
    expect(html).toContain('aria-label="{name} is working"');
    expect(html).not.toContain("Working…");
  });

  it("keeps the visible status for ordinary bots", () => {
    const html = renderToString(
      <ThreadWorkingFooter bots={bots} label="Working…" atBottom botKind="agent" />,
    );
    expect(html).toContain(">Working…</div>");
    expect(html).toContain('data-status="running"');
  });
});

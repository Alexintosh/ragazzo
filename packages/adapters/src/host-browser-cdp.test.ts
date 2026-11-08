import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { HostBrowserPipe } from "./host-browser-cdp.js";

describe("managed browser debugging pipe", () => {
  it("frames private requests and joins split responses without exposing protocol diagnostics", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const stop = vi.fn(async () => undefined);
    const browser = new HostBrowserPipe(input, output, stop);
    const writes: string[] = [];
    input.on("data", (chunk) => writes.push(chunk.toString()));
    const result = browser.call("Page.captureScreenshot", {}, "owned-session");
    const request = JSON.parse(writes[0]!.slice(0, -1));
    expect(request).toEqual({
      id: 1,
      method: "Page.captureScreenshot",
      params: {},
      sessionId: "owned-session",
    });
    output.write('{"id":1,"result":{"da');
    output.write('ta":"image"}}\0');
    await expect(result).resolves.toEqual({ data: "image" });
    const failed = browser.call("Runtime.evaluate", { expression: "private-value" });
    output.write('{"id":2,"error":{"message":"private-value"}}\0');
    await expect(failed).rejects.toThrow("Managed browser operation failed");
    await browser.close();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("delivers download events and stops the owned process when its pipe disconnects", async () => {
    const output = new PassThrough();
    const stop = vi.fn(async () => undefined);
    const browser = new HostBrowserPipe(new PassThrough(), output, stop);
    const event = vi.fn();
    browser.onEvent(event);
    output.write('{"method":"Browser.downloadProgress","params":{"guid":"download"}}\0');
    expect(event).toHaveBeenCalledWith("Browser.downloadProgress", { guid: "download" }, undefined);
    output.write(
      '{"method":"Page.javascriptDialogOpening","params":{"type":"alert"},"sessionId":"owned-tab"}\0',
    );
    expect(event).toHaveBeenCalledWith(
      "Page.javascriptDialogOpening",
      { type: "alert" },
      "owned-tab",
    );
    const pending = browser.call("Browser.getVersion");
    output.end();
    await expect(pending).rejects.toThrow("connection closed");
    expect(stop).toHaveBeenCalledOnce();
    await browser.close();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("cancels a pending command without accepting a later response", async () => {
    const output = new PassThrough();
    const browser = new HostBrowserPipe(new PassThrough(), output, async () => undefined);
    const controller = new AbortController();
    const pending = browser.call("Page.navigate", {}, undefined, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    output.write('{"id":1,"result":{}}\0');
    await browser.close();
  });
});

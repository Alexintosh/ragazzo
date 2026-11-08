import { resolveSupervisorToken } from "@rakazo/core";
import { beforeEach, expect, it, vi } from "vitest";

const docker = vi.hoisted(() => ({
  ping: vi.fn(),
  inspect: vi.fn(),
  buildImage: vi.fn(),
  createContainer: vi.fn(),
}));
vi.mock("dockerode", () => ({
  default: class {
    ping = docker.ping;
    buildImage = docker.buildImage;
    createContainer = docker.createContainer;
    getImage() {
      return { inspect: docker.inspect };
    }
  },
}));

import { supervisorApp } from "./index.js";

beforeEach(() => {
  vi.clearAllMocks();
  docker.ping.mockResolvedValue("OK");
  docker.inspect.mockResolvedValue({ Id: "installed-image" });
});

it("requires authentication before inspecting Docker readiness", async () => {
  expect((await supervisorApp.request("/readiness")).status).toBe(401);
  expect(docker.ping).not.toHaveBeenCalled();
  expect(docker.inspect).not.toHaveBeenCalled();
});

it("checks Docker and the installed image without provisioning", async () => {
  const response = await supervisorApp.request("/readiness", {
    headers: { authorization: `Bearer ${resolveSupervisorToken(process.env)}` },
  });
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ ok: true, image: expect.any(String) });
  expect(docker.ping).toHaveBeenCalledOnce();
  expect(docker.inspect).toHaveBeenCalledOnce();
  expect(docker.buildImage).not.toHaveBeenCalled();
  expect(docker.createContainer).not.toHaveBeenCalled();
});

it.each(["ping", "inspect"] as const)(
  "fails closed when %s fails without building an image",
  async (method) => {
    docker[method].mockRejectedValueOnce(new Error("not available"));
    const response = await supervisorApp.request("/readiness", {
      headers: { authorization: `Bearer ${resolveSupervisorToken(process.env)}` },
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
    expect(docker.buildImage).not.toHaveBeenCalled();
    expect(docker.createContainer).not.toHaveBeenCalled();
  },
);

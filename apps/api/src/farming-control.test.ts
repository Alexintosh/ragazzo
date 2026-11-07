import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createFarmingControlService } from "./farming-control.js";

const actor: Actor = {
  userId: "fixture-owner",
  spaceId: "personal-space",
  email: "owner@example.test",
  isDeploymentOwner: false,
};
const personal = {
  id: actor.spaceId,
  organizationId: actor.spaceId,
  deletingAt: null,
  memberships: [{ userId: actor.userId, role: "owner" }],
  organization: { members: [{ userId: actor.userId, role: "owner" }] },
};
function fixture() {
  const findFirst = vi.fn().mockResolvedValue(personal);
  const prisma = { space: { findFirst } } as unknown as Pick<PrismaClient, "space">;
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify({ status: "ok" })));
  const service = createFarmingControlService(
    prisma,
    { farmingControlApiUrl: "http://127.0.0.1:9876", farmingControlOwnerUserId: actor.userId },
    transport,
  );
  return { service, findFirst, transport };
}
describe("Farming Control host data authorization", () => {
  it("keeps an unconfigured bridge disabled and requires explicit owner binding", async () => {
    const findFirst = vi.fn().mockResolvedValue(personal);
    const prisma = { space: { findFirst } } as unknown as Pick<PrismaClient, "space">;
    const disabled = createFarmingControlService(prisma, {
      farmingControlOwnerUserId: actor.userId,
    });
    expect(disabled.configured).toBe(false);
    expect(await disabled.status(actor)).toMatchObject({
      configured: false,
      connection: "not_configured",
    });
    await expect(disabled.read(actor, "portfolio")).rejects.toMatchObject({ code: "NOT_FOUND" });
    const unbound = createFarmingControlService(prisma, {});
    findFirst.mockClear();
    await expect(unbound.status(actor)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(findFirst).not.toHaveBeenCalled();
  });
  it("requires the immutable configured account before any database or host request", async () => {
    const { service, findFirst, transport } = fixture();
    await expect(
      service.status({ ...actor, userId: "another-user", email: actor.email }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(findFirst).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
  it("checks the bootstrapped personal organization and owner membership on every request", async () => {
    const { service, findFirst, transport } = fixture();
    expect(await service.status(actor)).toMatchObject({
      configured: true,
      connection: "connected",
      readOnly: true,
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: actor.spaceId,
          isDefault: true,
          createdByUserId: actor.userId,
          organization: { slug: "user-fixture-owne" },
        }),
      }),
    );
    findFirst.mockResolvedValue({
      ...personal,
      memberships: [...personal.memberships, { userId: "peer", role: "member" }],
    });
    await expect(service.status(actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each([
    null,
    { ...personal, organizationId: "shared-org" },
    { ...personal, deletingAt: new Date() },
    { ...personal, memberships: [] },
    { ...personal, organization: { members: [{ userId: "peer", role: "owner" }] } },
    {
      ...personal,
      organization: {
        members: [...personal.organization.members, { userId: "peer", role: "member" }],
      },
    },
  ])("denies absent, shared, mismatched or deleting personal scope", async (record) => {
    const { service, findFirst, transport } = fixture();
    findFirst.mockResolvedValue(record);
    await expect(service.read(actor, "portfolio")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(transport).not.toHaveBeenCalled();
  });
});

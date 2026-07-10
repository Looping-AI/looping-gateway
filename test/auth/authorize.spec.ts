import { describe, it, expect } from "vitest";
import { authorize } from "@/auth/authorize";
import { makeAuthCtx } from "../helpers/workspace";

const owner = makeAuthCtx({ isPrimaryOwner: true });
const orgAdmin = makeAuthCtx({ isOrgAdmin: true });
const wsAdmin5 = makeAuthCtx({ adminWorkspaces: [5] });
const none = makeAuthCtx();

describe("authorize — truth table", () => {
  it("IsPrimaryOwner: only the owner", () => {
    const req = { type: "IsPrimaryOwner" } as const;
    expect(authorize(owner, req)).toBe(true);
    expect(authorize(orgAdmin, req)).toBe(false);
    expect(authorize(wsAdmin5, req)).toBe(false);
    expect(authorize(none, req)).toBe(false);
  });

  it("IsOrgAdmin: org admin OR owner (owner implies)", () => {
    const req = { type: "IsOrgAdmin" } as const;
    expect(authorize(owner, req)).toBe(true);
    expect(authorize(orgAdmin, req)).toBe(true);
    expect(authorize(wsAdmin5, req)).toBe(false);
    expect(authorize(none, req)).toBe(false);
  });

  it("IsWorkspaceAdmin(5): ws-admin of 5, or any org-level role", () => {
    const req = { type: "IsWorkspaceAdmin", workspaceId: 5 } as const;
    expect(authorize(owner, req)).toBe(true);
    expect(authorize(orgAdmin, req)).toBe(true);
    expect(authorize(wsAdmin5, req)).toBe(true);
    expect(authorize(none, req)).toBe(false);
  });

  it("IsWorkspaceAdmin: rejects a different workspace id", () => {
    expect(
      authorize(wsAdmin5, { type: "IsWorkspaceAdmin", workspaceId: 9 })
    ).toBe(false);
  });

  it("array form is OR across requirements", () => {
    const reqs = [
      { type: "IsPrimaryOwner" },
      { type: "IsWorkspaceAdmin", workspaceId: 5 }
    ] as const;
    expect(authorize(wsAdmin5, [...reqs])).toBe(true);
    expect(authorize(none, [...reqs])).toBe(false);
  });

  it("an empty requirement list denies", () => {
    expect(authorize(owner, [])).toBe(false);
  });
});

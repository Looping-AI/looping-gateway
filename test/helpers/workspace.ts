import type { UserAuthContext } from "@/auth";
import { createWorkspace } from "@/db/models/workspaces";

export function makeAuthCtx(
  overrides: Partial<UserAuthContext> = {}
): UserAuthContext {
  return {
    slackUserId: "U1",
    displayName: null,
    isPrimaryOwner: false,
    isOrgAdmin: false,
    adminWorkspaces: [],
    ...overrides
  };
}

export async function freshWsId(name: string): Promise<number> {
  return (await createWorkspace({ name })).id;
}

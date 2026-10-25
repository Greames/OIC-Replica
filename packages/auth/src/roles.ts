import { type AccessControl, createAccessControl, type Role } from "better-auth/plugins/access";
import { defaultStatements, ownerAc } from "better-auth/plugins/organization/access";

// Better Auth checks who can manage the org itself (members, invites).
// Product permissions (build, operate...) are checked in @oicr/db's `can()`.
// Explicit types keep the emitted .d.ts assignable to Better Auth's own types.
export const ac: AccessControl<typeof defaultStatements> = createAccessControl(defaultStatements);

export const roles: Record<"admin" | "developer" | "monitor" | "viewer", Role> = {
  admin: ac.newRole(ownerAc.statements),
  developer: ac.newRole({}),
  monitor: ac.newRole({}),
  viewer: ac.newRole({}),
};

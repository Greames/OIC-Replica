import type { Role } from "../schema/auth.js";

/** Who is calling. Every repo function takes one; nothing queries without it. */
export interface Actor {
  userId: string;
  orgId: string;
  role: Role;
}

export type Action = "read" | "build" | "operate" | "admin";

const allowed: Record<Role, readonly Action[]> = {
  admin: ["read", "build", "operate", "admin"],
  developer: ["read", "build", "operate"],
  monitor: ["read", "operate"],
  viewer: ["read"],
};

export function can(role: Role, action: Action): boolean {
  return allowed[role].includes(action);
}

export class ForbiddenError extends Error {
  constructor(action: Action) {
    super(`Your role cannot ${action} here.`);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found.`);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export function assertCan(actor: Actor, action: Action): void {
  if (!can(actor.role, action)) throw new ForbiddenError(action);
}

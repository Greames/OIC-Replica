import { describe, expect, it } from "vitest";
import { assertCan, can } from "./access.js";
import { NewProject, toIdentifier } from "./projects.js";

describe("roles", () => {
  it("grants each role its actions", () => {
    expect(can("admin", "admin")).toBe(true);
    expect(can("developer", "build")).toBe(true);
    expect(can("developer", "admin")).toBe(false);
    expect(can("monitor", "operate")).toBe(true);
    expect(can("monitor", "build")).toBe(false);
    expect(can("viewer", "read")).toBe(true);
    expect(can("viewer", "operate")).toBe(false);
  });

  it("throws a readable error", () => {
    expect(() => assertCan({ userId: "u", orgId: "o", role: "viewer" }, "build")).toThrow(
      "Your role cannot build here.",
    );
  });
});

describe("project identifiers", () => {
  it("derives an identifier from the name", () => {
    expect(toIdentifier("Orders sync (EU)")).toBe("ORDERS_SYNC_EU");
    expect(toIdentifier("  2024 café   imports ")).toBe("CAFE_IMPORTS");
    expect(toIdentifier("!!!")).toBe("PROJECT");
    expect(toIdentifier("x".repeat(80))).toHaveLength(50);
  });

  it("validates explicit identifiers", () => {
    expect(NewProject.safeParse({ name: "A", identifier: "ORDERS_1" }).success).toBe(true);
    expect(NewProject.safeParse({ name: "A", identifier: "orders" }).success).toBe(false);
    expect(NewProject.safeParse({ name: "  " }).success).toBe(false);
  });
});

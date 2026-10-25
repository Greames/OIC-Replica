import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./secrets.js";

beforeAll(() => {
  process.env.SECRETS_KEY = randomBytes(32).toString("base64");
});

describe("secrets", () => {
  it("round-trips values and never stores plaintext", () => {
    const blob = encryptSecret({ password: "hunter2-very-secret" });
    expect(blob.toString("utf8")).not.toContain("hunter2");
    expect(decryptSecret(blob)).toEqual({ password: "hunter2-very-secret" });
  });

  it("uses a fresh IV each time", () => {
    expect(encryptSecret("x").equals(encryptSecret("x"))).toBe(false);
  });

  it("rejects tampering", () => {
    const blob = encryptSecret({ token: "abc" });
    blob[blob.length - 1] = (blob[blob.length - 1] ?? 0) ^ 1;
    expect(() => decryptSecret(blob)).toThrow();
  });

  it("rejects a different key", () => {
    const blob = encryptSecret("x");
    process.env.SECRETS_KEY = randomBytes(32).toString("hex");
    expect(() => decryptSecret(blob)).toThrow();
  });
});

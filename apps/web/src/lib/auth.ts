import { type Auth, createAuth } from "@oicr/auth";
import { nextCookies } from "better-auth/next-js";
import { db } from "./db";

export const googleEnabled = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

// Built on first use, so `next build` runs without BETTER_AUTH_SECRET.
let instance: Auth | undefined;

export function getAuth(): Auth {
  instance ??= createAuth({
    db,
    google: googleEnabled
      ? { clientId: process.env.GOOGLE_CLIENT_ID!, clientSecret: process.env.GOOGLE_CLIENT_SECRET! }
      : undefined,
    plugins: [nextCookies()],
  });
  return instance;
}

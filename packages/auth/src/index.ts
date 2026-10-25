import { accounts, type Db, invitations, memberships, orgs, sessions, users, verifications } from "@oicr/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins/organization";
import { ac, roles } from "./roles.js";

export interface AuthOptions {
  db: Db;
  baseURL?: string;
  secret?: string;
  google?: { clientId: string; clientSecret: string };
  /** Next.js passes nextCookies() here so server actions can set cookies. */
  plugins?: ReturnType<typeof organization>[] | unknown[];
}

export function createAuth({ db, baseURL, secret, google, plugins = [] }: AuthOptions) {
  return betterAuth({
    baseURL: baseURL ?? process.env.BETTER_AUTH_URL,
    secret: secret ?? process.env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, {
      provider: "pg",
      // keyed by modelName below
      schema: { users, sessions, accounts, verifications, orgs, memberships, invitations },
    }),
    advanced: { database: { generateId: "uuid" } },
    emailAndPassword: { enabled: true, minPasswordLength: 10 },
    // On by default in production. AUTH_RATE_LIMIT=off is for e2e tests only.
    rateLimit: { enabled: process.env.AUTH_RATE_LIMIT === "off" ? false : undefined },
    socialProviders: google ? { google } : {},
    plugins: [
      organization({
        ac,
        roles,
        creatorRole: "admin",
        schema: {
          organization: { modelName: "orgs" },
          member: { modelName: "memberships" },
          invitation: { modelName: "invitations" },
        },
      }),
      ...(plugins as []),
    ],
    user: { modelName: "users" },
    session: { modelName: "sessions" },
    account: { modelName: "accounts" },
    verification: { modelName: "verifications" },
  });
}

export type Auth = ReturnType<typeof createAuth>;
export { ac, roles } from "./roles.js";

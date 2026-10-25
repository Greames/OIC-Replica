import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { orgs, users } from "./auth.js";

const created = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updated = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** S02/S03. A bundle of integrations, connections, lookups and libraries. */
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    identifier: text("identifier").notNull(),
    description: text("description").notNull().default(""),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    uniqueIndex().on(t.orgId, t.identifier),
    index().on(t.orgId, t.updatedAt),
    check("projects_identifier_format", sql`${t.identifier} ~ '^[A-Z][A-Z0-9_]{0,49}$'`),
  ],
);

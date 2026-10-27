import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { orgs, users } from "./auth.js";

/**
 * S17. Value maps between systems (e.g. country codes), used in expressions
 * as $lookupValue("name", "from domain", value, "to domain"). Domains are the
 * columns; rows hold one value per domain.
 */
export const lookups = pgTable(
  "lookups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    /** Used in expressions, so letters, digits, _ and -. Unique per org. */
    name: text("name").notNull(),
    description: text("description"),
    domains: text("domains").array().notNull(),
    rows: jsonb("rows").$type<string[][]>().notNull().default([]),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex().on(t.orgId, t.name), index().on(t.orgId)],
);

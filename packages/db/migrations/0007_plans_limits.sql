CREATE TABLE "integration_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"version" text NOT NULL,
	"definition_hash" text NOT NULL,
	"definition" jsonb NOT NULL,
	"tracing_level" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_limits" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"tier" text DEFAULT 'standard' NOT NULL,
	"sync_concurrency" integer,
	"requests_per_second" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "plan_id" uuid;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "active_plan_id" uuid;--> statement-breakpoint
ALTER TABLE "integration_plans" ADD CONSTRAINT "integration_plans_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_plans" ADD CONSTRAINT "integration_plans_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_plans" ADD CONSTRAINT "integration_plans_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_limits" ADD CONSTRAINT "tenant_limits_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "integration_plans_integration_id_definition_hash_tracing_level_index" ON "integration_plans" USING btree ("integration_id","definition_hash","tracing_level");--> statement-breakpoint
CREATE INDEX "integration_plans_org_id_index" ON "integration_plans" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "instances" ADD CONSTRAINT "instances_plan_id_integration_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."integration_plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_active_plan_id_integration_plans_id_fk" FOREIGN KEY ("active_plan_id") REFERENCES "public"."integration_plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_plans" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "integration_plans" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "integration_plans" USING (oicr_can_access("org_id")) WITH CHECK (oicr_can_access("org_id"));
--> statement-breakpoint
ALTER TABLE "tenant_limits" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenant_limits" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant_limits" USING (oicr_can_access("org_id")) WITH CHECK (oicr_can_access("org_id"));
--> statement-breakpoint
-- Integrations active before plans existed get one now, so their runs keep working.
INSERT INTO "integration_plans" ("org_id", "integration_id", "version", "definition_hash", "definition", "tracing_level", "created_by")
SELECT "org_id", "id", "version", "definition_hash", "definition", "tracing_level", "activated_by" FROM "integrations" WHERE "status" = 'active'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "integrations" i SET "active_plan_id" = p."id" FROM "integration_plans" p
WHERE i."status" = 'active' AND p."integration_id" = i."id" AND p."definition_hash" = i."definition_hash" AND p."tracing_level" = i."tracing_level";

-- Tenant isolation (row-level security). Runs with app.bypass_rls on (see migrate.ts).
ALTER TABLE "ai_messages" ADD COLUMN "org_id" uuid;
--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "org_id" uuid;
--> statement-breakpoint
ALTER TABLE "instance_steps" ADD COLUMN "org_id" uuid;
--> statement-breakpoint
UPDATE "ai_messages" m SET "org_id" = s."org_id" FROM "ai_sessions" s WHERE s."id" = m."session_id";
--> statement-breakpoint
UPDATE "deliveries" d SET "org_id" = e."org_id" FROM "events" e WHERE e."id" = d."event_id";
--> statement-breakpoint
UPDATE "instance_steps" st SET "org_id" = i."org_id" FROM "instances" i WHERE i."id" = st."instance_id";
--> statement-breakpoint
ALTER TABLE "ai_messages" ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "deliveries" ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "instance_steps" ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "instance_steps" ADD CONSTRAINT "instance_steps_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- A row is visible when it belongs to the transaction's tenant, or when the
-- platform runs a cross-tenant job (app.bypass_rls). Unset means nothing.
CREATE OR REPLACE FUNCTION oicr_can_access(row_org uuid) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT coalesce(current_setting('app.bypass_rls', true), '') = 'on'
      OR row_org = nullif(current_setting('app.tenant_id', true), '')::uuid
$$;
--> statement-breakpoint
ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "projects" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "projects" USING (oicr_can_access("org_id")) WITH CHECK (oicr_can_access("org_id"));
--> statement-breakpoint
ALTER TABLE "connections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "connections" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "connections" USING (oicr_can_access("org_id")) WITH CHECK (oicr_can_access("org_id"));
--> statement-breakpoint
ALTER TABLE "integrations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "integrations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "integrations" USING (oicr_can_access("org_id")) WITH CHECK (oicr_can_access("org_id"));
--> statement-breakpoint
ALTER TABLE "schedules" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "schedules" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "schedules" USING (oicr_can_access("org_id")) WITH CHECK (oicr_can_access("org_id"));
--> statement-breakpoint
ALTER TABLE "instances" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "instances" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "instances" USING (oicr_can_access("org_id")) WITH CHECK (oicr_can_access("org_id"));
--> statement-breakpoint
ALTER TABLE "instance_steps" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "instance_steps" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "instance_steps" USING (oicr_can_access("org_id")) WITH CHECK (oicr_can_access("org_id"));
--> statement-breakpoint
ALTER TABLE "ai_sessions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ai_sessions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai_sessions" USING (oicr_can_access("org_id")) WITH CHECK (oicr_can_access("org_id"));
--> statement-breakpoint
ALTER TABLE "ai_messages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ai_messages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai_messages" USING (oicr_can_access("org_id")) WITH CHECK (oicr_can_access("org_id"));
--> statement-breakpoint
ALTER TABLE "ai_changes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ai_changes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai_changes" USING (oicr_can_access("org_id")) WITH CHECK (oicr_can_access("org_id"));
--> statement-breakpoint
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "events" USING (oicr_can_access("org_id")) WITH CHECK (oicr_can_access("org_id"));
--> statement-breakpoint
ALTER TABLE "notification_channels" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "notification_channels" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notification_channels" USING (oicr_can_access("org_id")) WITH CHECK (oicr_can_access("org_id"));
--> statement-breakpoint
ALTER TABLE "deliveries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "deliveries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "deliveries" USING (oicr_can_access("org_id")) WITH CHECK (oicr_can_access("org_id"));
--> statement-breakpoint
ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "api_keys" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "api_keys" USING (oicr_can_access("org_id")) WITH CHECK (oicr_can_access("org_id"));
--> statement-breakpoint
ALTER TABLE "lookups" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "lookups" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "lookups" USING (oicr_can_access("org_id")) WITH CHECK (oicr_can_access("org_id"));
--> statement-breakpoint
ALTER TABLE "dev_secrets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "dev_secrets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "dev_secrets" USING (oicr_can_access("tenant")) WITH CHECK (oicr_can_access("tenant"));
--> statement-breakpoint
-- An application role, when this migration runs with the privilege to make one
-- (docker compose). It owns nothing and cannot bypass the policies.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolcreaterole)) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oicr_app') THEN
      CREATE ROLE oicr_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
    END IF;
    GRANT USAGE ON SCHEMA public TO oicr_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO oicr_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO oicr_app;
    GRANT EXECUTE ON FUNCTION oicr_can_access(uuid) TO oicr_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO oicr_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO oicr_app;
  END IF;
END
$$;

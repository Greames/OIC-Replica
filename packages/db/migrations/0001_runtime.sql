CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"identifier" text NOT NULL,
	"adapter" text NOT NULL,
	"role" text NOT NULL,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"auth_type" text DEFAULT 'none' NOT NULL,
	"secret_ciphertext" "bytea",
	"status" text DEFAULT 'draft' NOT NULL,
	"last_tested_at" timestamp with time zone,
	"last_test_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connections_identifier_format" CHECK ("connections"."identifier" ~ '^[a-z][a-z0-9_]{0,49}$')
);
--> statement-breakpoint
CREATE TABLE "instance_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"step_id" text NOT NULL,
	"step_type" text NOT NULL,
	"iteration" integer,
	"status" text NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"message" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"integration_version" text NOT NULL,
	"definition_hash" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"trigger_kind" text NOT NULL,
	"parent_instance_id" uuid,
	"idempotency_key" text,
	"primary_business_id" text,
	"business_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"identifier" text NOT NULL,
	"version" text DEFAULT '01.00.0000' NOT NULL,
	"style" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"definition" jsonb NOT NULL,
	"definition_hash" text NOT NULL,
	"validation_errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tracing_level" text DEFAULT 'audit' NOT NULL,
	"trigger_token_ciphertext" "bytea",
	"activated_at" timestamp with time zone,
	"activated_by" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integrations_identifier_format" CHECK ("integrations"."identifier" ~ '^[A-Z][A-Z0-9_]{0,49}$')
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"expression" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"allow_overlap" boolean DEFAULT false NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedules_integration_id_unique" UNIQUE("integration_id")
);
--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_steps" ADD CONSTRAINT "instance_steps_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instances" ADD CONSTRAINT "instances_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instances" ADD CONSTRAINT "instances_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_activated_by_users_id_fk" FOREIGN KEY ("activated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connections_org_id_identifier_index" ON "connections" USING btree ("org_id","identifier");--> statement-breakpoint
CREATE INDEX "connections_project_id_index" ON "connections" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "instance_steps_instance_id_seq_index" ON "instance_steps" USING btree ("instance_id","seq");--> statement-breakpoint
CREATE INDEX "instances_org_id_created_at_index" ON "instances" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "instances_integration_id_created_at_index" ON "instances" USING btree ("integration_id","created_at");--> statement-breakpoint
CREATE INDEX "instances_org_id_status_created_at_index" ON "instances" USING btree ("org_id","status","created_at");--> statement-breakpoint
CREATE INDEX "instances_org_id_primary_business_id_index" ON "instances" USING btree ("org_id","primary_business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "instances_integration_id_idempotency_key_index" ON "instances" USING btree ("integration_id","idempotency_key") WHERE "instances"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_org_id_identifier_version_index" ON "integrations" USING btree ("org_id","identifier","version");--> statement-breakpoint
CREATE INDEX "integrations_project_id_index" ON "integrations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "integrations_org_id_status_index" ON "integrations" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "schedules_status_next_run_at_index" ON "schedules" USING btree ("status","next_run_at");
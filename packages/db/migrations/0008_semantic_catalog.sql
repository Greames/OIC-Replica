CREATE TABLE "semantic_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"system" text NOT NULL,
	"object" text NOT NULL,
	"field" text NOT NULL,
	"attribute" text,
	"read_transform" text,
	"write_transform" text,
	"read_only" boolean DEFAULT false NOT NULL,
	"origin" text NOT NULL,
	"confidence" real,
	"evidence" text,
	"proposal_id" uuid,
	"approved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "semantic_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"label" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"attributes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "semantic_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"system" text NOT NULL,
	"object" text NOT NULL,
	"entity" text NOT NULL,
	"label" text,
	"description" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "semantic_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"system" text NOT NULL,
	"object" text NOT NULL,
	"entity" text NOT NULL,
	"entity_confidence" real NOT NULL,
	"reasoning" text DEFAULT '' NOT NULL,
	"model" text NOT NULL,
	"items" jsonb NOT NULL,
	"unmapped" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dropped" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"auto_approve_at" real,
	"status" text DEFAULT 'open' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
DROP INDEX "integration_plans_integration_id_definition_hash_tracing_level_index";--> statement-breakpoint
ALTER TABLE "integration_plans" ADD COLUMN "semantics" jsonb;--> statement-breakpoint
ALTER TABLE "integration_plans" ADD COLUMN "semantic_hash" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "semantic_bindings" ADD CONSTRAINT "semantic_bindings_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "semantic_bindings" ADD CONSTRAINT "semantic_bindings_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "semantic_entities" ADD CONSTRAINT "semantic_entities_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "semantic_entities" ADD CONSTRAINT "semantic_entities_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "semantic_objects" ADD CONSTRAINT "semantic_objects_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "semantic_objects" ADD CONSTRAINT "semantic_objects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "semantic_proposals" ADD CONSTRAINT "semantic_proposals_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "semantic_proposals" ADD CONSTRAINT "semantic_proposals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "semantic_bindings_org_id_system_object_field_index" ON "semantic_bindings" USING btree ("org_id","system","object","field");--> statement-breakpoint
CREATE INDEX "semantic_bindings_org_id_system_index" ON "semantic_bindings" USING btree ("org_id","system");--> statement-breakpoint
CREATE UNIQUE INDEX "semantic_entities_org_id_name_index" ON "semantic_entities" USING btree ("org_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "semantic_objects_org_id_system_object_index" ON "semantic_objects" USING btree ("org_id","system","object");--> statement-breakpoint
CREATE INDEX "semantic_proposals_org_id_status_index" ON "semantic_proposals" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "semantic_proposals_org_id_system_object_index" ON "semantic_proposals" USING btree ("org_id","system","object");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_plans_reuse_index" ON "integration_plans" USING btree ("integration_id","definition_hash","tracing_level","semantic_hash");--> statement-breakpoint
ALTER TABLE "semantic_entities" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "semantic_entities" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "semantic_entities" USING (oicr_can_access("org_id")) WITH CHECK (oicr_can_access("org_id"));
--> statement-breakpoint
ALTER TABLE "semantic_objects" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "semantic_objects" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "semantic_objects" USING (oicr_can_access("org_id")) WITH CHECK (oicr_can_access("org_id"));
--> statement-breakpoint
ALTER TABLE "semantic_bindings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "semantic_bindings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "semantic_bindings" USING (oicr_can_access("org_id")) WITH CHECK (oicr_can_access("org_id"));
--> statement-breakpoint
ALTER TABLE "semantic_proposals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "semantic_proposals" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "semantic_proposals" USING (oicr_can_access("org_id")) WITH CHECK (oicr_can_access("org_id"));

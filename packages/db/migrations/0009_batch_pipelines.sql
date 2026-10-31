CREATE TABLE "pipeline_checkpoints" (
	"org_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"step_id" text NOT NULL,
	"cursor" jsonb,
	"read" bigint DEFAULT 0 NOT NULL,
	"written" bigint DEFAULT 0 NOT NULL,
	"filtered" bigint DEFAULT 0 NOT NULL,
	"rejected" bigint DEFAULT 0 NOT NULL,
	"chunks" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_checkpoints_instance_id_step_id_pk" PRIMARY KEY("instance_id","step_id")
);
--> statement-breakpoint
CREATE TABLE "pipeline_rejects" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "pipeline_rejects_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"org_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"step_id" text NOT NULL,
	"chunk" integer NOT NULL,
	"row_index" integer NOT NULL,
	"stage" text NOT NULL,
	"code" text NOT NULL,
	"message" text NOT NULL,
	"record" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "lane" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "attempts" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_checkpoints" ADD CONSTRAINT "pipeline_checkpoints_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_checkpoints" ADD CONSTRAINT "pipeline_checkpoints_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_rejects" ADD CONSTRAINT "pipeline_rejects_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_rejects" ADD CONSTRAINT "pipeline_rejects_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pipeline_checkpoints_org_id_index" ON "pipeline_checkpoints" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "pipeline_rejects_instance_id_step_id_id_index" ON "pipeline_rejects" USING btree ("instance_id","step_id","id");--> statement-breakpoint
CREATE INDEX "pipeline_rejects_org_id_index" ON "pipeline_rejects" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "instances_lane_status_index" ON "instances" USING btree ("lane","status");--> statement-breakpoint
ALTER TABLE "pipeline_checkpoints" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pipeline_checkpoints" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "pipeline_checkpoints" USING (oicr_can_access("org_id")) WITH CHECK (oicr_can_access("org_id"));
--> statement-breakpoint
ALTER TABLE "pipeline_rejects" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pipeline_rejects" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "pipeline_rejects" USING (oicr_can_access("org_id")) WITH CHECK (oicr_can_access("org_id"));

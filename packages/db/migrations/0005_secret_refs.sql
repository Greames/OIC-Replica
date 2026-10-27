CREATE TABLE "dev_secrets" (
	"tenant" uuid NOT NULL,
	"kind" text NOT NULL,
	"id" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dev_secrets_tenant_kind_id_pk" PRIMARY KEY("tenant","kind","id")
);
--> statement-breakpoint
ALTER TABLE "notification_channels" ALTER COLUMN "config_ciphertext" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD COLUMN "target" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "has_secret" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "trigger_token_hash" text;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "trigger_token_hint" text;--> statement-breakpoint
-- Pre-v2 rows keep their ciphertext until `migrate` moves it to the secret store.
UPDATE "connections" SET "has_secret" = true WHERE "secret_ciphertext" IS NOT NULL;

CREATE TABLE "identity"."sessions" (
	"id" bigint PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "identity"."sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_active_by_user_idx" ON "identity"."sessions" USING btree ("user_id") WHERE "identity"."sessions"."revoked_at" is null;
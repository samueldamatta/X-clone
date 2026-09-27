CREATE TABLE "identity"."refresh_tokens" (
	"id" bigint PRIMARY KEY NOT NULL,
	"session_id" bigint NOT NULL,
	"token_hash" text NOT NULL,
	"spent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "identity"."refresh_tokens" ADD CONSTRAINT "refresh_tokens_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "identity"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Added by hand: carry each existing session's token over before its column goes, so no one is logged out.
INSERT INTO "identity"."refresh_tokens" ("id", "session_id", "token_hash", "spent_at", "created_at")
SELECT "id", "id", "refresh_token_hash", NULL, "created_at" FROM "identity"."sessions";--> statement-breakpoint
ALTER TABLE "identity"."sessions" DROP COLUMN "refresh_token_hash";
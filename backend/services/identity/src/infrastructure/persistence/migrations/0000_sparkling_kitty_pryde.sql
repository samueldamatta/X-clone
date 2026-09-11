-- drizzle-kit generates "CREATE SCHEMA identity" here by default, unaware
-- that infra/postgres/init/01-schemas.sql already created it during
-- bootstrap. identity_svc has USAGE + CREATE *on* that schema, not CREATE
-- on the database, so running that statement under this role would fail
-- with "permission denied for database xclone" — see
-- docs/adr/0007-bootstrap-versus-service-migrations.md. Removed by hand.
CREATE TABLE "identity"."credentials" (
	"user_id" bigint PRIMARY KEY NOT NULL,
	"password_hash" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity"."users" (
	"id" bigint PRIMARY KEY NOT NULL,
	-- drizzle-kit quotes the whole "public.citext" dataType string as one
	-- identifier, which Postgres would read as a type literally named
	-- `public.citext` rather than schema-qualified. Hand-fixed to
	-- `public.citext` (unquoted), the correct schema.typename form.
	"handle" public.citext NOT NULL,
	"display_name" text NOT NULL,
	"bio" text DEFAULT '' NOT NULL,
	"avatar_media_id" bigint,
	"follower_count" integer DEFAULT 0 NOT NULL,
	"following_count" integer DEFAULT 0 NOT NULL,
	"is_celebrity" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_handle_unique" UNIQUE("handle")
);
--> statement-breakpoint
ALTER TABLE "identity"."credentials" ADD CONSTRAINT "credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE no action ON UPDATE no action;
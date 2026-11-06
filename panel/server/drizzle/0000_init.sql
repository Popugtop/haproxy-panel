CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"diff" jsonb,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE "backend_daily" (
	"node_id" uuid NOT NULL,
	"backend" text NOT NULL,
	"day" date NOT NULL,
	"bin_bytes" bigint DEFAULT 0 NOT NULL,
	"bout_bytes" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "backend_daily_node_id_backend_day_pk" PRIMARY KEY("node_id","backend","day")
);
--> statement-breakpoint
CREATE TABLE "backend_metrics" (
	"node_id" uuid NOT NULL,
	"backend" text NOT NULL,
	"res" smallint NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"dt" real NOT NULL,
	"n" integer DEFAULT 1 NOT NULL,
	"bin_bytes" bigint NOT NULL,
	"bout_bytes" bigint NOT NULL,
	"scur_avg" real DEFAULT 0 NOT NULL,
	"scur_max" integer DEFAULT 0 NOT NULL,
	"servers_up_min" smallint DEFAULT 0 NOT NULL,
	"servers_total" smallint DEFAULT 0 NOT NULL,
	CONSTRAINT "backend_metrics_node_id_backend_res_ts_pk" PRIMARY KEY("node_id","backend","res","ts")
);
--> statement-breakpoint
CREATE TABLE "node_daily" (
	"node_id" uuid NOT NULL,
	"day" date NOT NULL,
	"rx_bytes" bigint DEFAULT 0 NOT NULL,
	"tx_bytes" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "node_daily_node_id_day_pk" PRIMARY KEY("node_id","day")
);
--> statement-breakpoint
CREATE TABLE "node_live" (
	"node_id" uuid PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"data" jsonb NOT NULL,
	"counters" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "node_metrics" (
	"node_id" uuid NOT NULL,
	"res" smallint NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"dt" real NOT NULL,
	"n" integer DEFAULT 1 NOT NULL,
	"rx_bytes" bigint NOT NULL,
	"tx_bytes" bigint NOT NULL,
	"cpu_avg" real,
	"cpu_max" real,
	"mem_total" bigint,
	"mem_avail_avg" double precision,
	"load1_avg" real,
	"sessions_avg" real DEFAULT 0 NOT NULL,
	"sessions_max" integer DEFAULT 0 NOT NULL,
	"clients_avg" real,
	"clients_max" integer,
	CONSTRAINT "node_metrics_node_id_res_ts_pk" PRIMARY KEY("node_id","res","ts")
);
--> statement-breakpoint
CREATE TABLE "nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"ip" text,
	"domain" text,
	"hoster" text,
	"notes" text,
	"quota_tb" numeric(10, 2),
	"billing_day" smallint DEFAULT 1 NOT NULL,
	"quota_counts" text DEFAULT 'tx' NOT NULL,
	"default_ip_limit_mbit" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"key_hash" text,
	"key_created_at" timestamp with time zone,
	"key_revoked_at" timestamp with time zone,
	"enroll_token_hash" text,
	"enroll_expires_at" timestamp with time zone,
	"agent_version" text,
	"protocol" integer,
	"haproxy_version" text,
	"haproxy_installed" boolean,
	"hostname" text,
	"os" text,
	"ops" jsonb,
	"addrs" jsonb,
	"last_remote_ip" text,
	"last_seen_at" timestamp with time zone,
	"last_connected_at" timestamp with time zone,
	"last_disconnected_at" timestamp with time zone,
	CONSTRAINT "nodes_key_hash_unique" UNIQUE("key_hash"),
	CONSTRAINT "nodes_enroll_token_hash_unique" UNIQUE("enroll_token_hash")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"mfa_ok" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"login" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'admin' NOT NULL,
	"totp_secret_enc" text,
	"totp_pending_enc" text,
	"totp_enabled" boolean DEFAULT false NOT NULL,
	"totp_last_step" bigint,
	"failed_logins" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_login_unique" UNIQUE("login")
);
--> statement-breakpoint
ALTER TABLE "backend_daily" ADD CONSTRAINT "backend_daily_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backend_metrics" ADD CONSTRAINT "backend_metrics_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_daily" ADD CONSTRAINT "node_daily_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_live" ADD CONSTRAINT "node_live_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_metrics" ADD CONSTRAINT "node_metrics_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");
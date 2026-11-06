CREATE TABLE "alert_rules" (
	"kind" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"threshold" real,
	"threshold2" real,
	"for_min" integer DEFAULT 0 NOT NULL,
	"repeat_hours" integer DEFAULT 6 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"subject_label" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"severity" text DEFAULT 'warn' NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"value" real,
	"pending_since" timestamp with time zone DEFAULT now() NOT NULL,
	"fired_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"last_notified_at" timestamp with time zone,
	"notify_count" integer DEFAULT 0 NOT NULL,
	"last_notify_error" text,
	"is_demo" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "torrent_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"report_id" bigint NOT NULL,
	"username" text DEFAULT '' NOT NULL,
	"remna_node" text DEFAULT '' NOT NULL,
	"ip" text NOT NULL,
	"action" text NOT NULL,
	"reason" text,
	"duration_sec" integer,
	"nodes_count" integer DEFAULT 0 NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN "limit_mbit" integer;--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN "ip_limit_mbit" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_open_uq" ON "alerts" USING btree ("kind","subject") WHERE "alerts"."status" <> 'resolved';--> statement-breakpoint
CREATE INDEX "alerts_status_idx" ON "alerts" USING btree ("status","fired_at");--> statement-breakpoint
CREATE INDEX "torrent_events_at_idx" ON "torrent_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "torrent_events_ip_idx" ON "torrent_events" USING btree ("ip");
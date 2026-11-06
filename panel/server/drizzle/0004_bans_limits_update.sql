CREATE TABLE "bans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ip" text NOT NULL,
	"node_id" uuid NOT NULL,
	"reason" text DEFAULT 'manual' NOT NULL,
	"note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ip_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ip" text NOT NULL,
	"node_id" uuid NOT NULL,
	"mbit" integer NOT NULL,
	"note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "arch" text;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "update_ready" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bans" ADD CONSTRAINT "bans_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip_limits" ADD CONSTRAINT "ip_limits_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bans_ip_node_uq" ON "bans" USING btree ("ip","node_id");--> statement-breakpoint
CREATE INDEX "bans_node_idx" ON "bans" USING btree ("node_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ip_limits_ip_node_uq" ON "ip_limits" USING btree ("ip","node_id");
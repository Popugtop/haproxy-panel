CREATE TABLE "check_results" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "check_results_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"node_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	"exit_id" uuid,
	"source" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"ok" boolean NOT NULL,
	"ms" real,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "config_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"cfg" text NOT NULL,
	"sni_map" text DEFAULT '' NOT NULL,
	"sha256" text NOT NULL,
	"source" text DEFAULT 'panel' NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"finished_at" timestamp with time zone,
	"output" text,
	"duration_ms" real
);
--> statement-breakpoint
CREATE TABLE "exits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"country" text,
	"host" text NOT NULL,
	"port" integer DEFAULT 443 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "route_exits" (
	"route_id" uuid NOT NULL,
	"exit_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "route_exits_route_id_exit_id_pk" PRIMARY KEY("route_id","exit_id")
);
--> statement-breakpoint
CREATE TABLE "route_nodes" (
	"route_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	CONSTRAINT "route_nodes_route_id_node_id_pk" PRIMARY KEY("route_id","node_id")
);
--> statement-breakpoint
CREATE TABLE "routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"snis" text[] DEFAULT '{}'::text[] NOT NULL,
	"proxy_protocol" boolean DEFAULT false NOT NULL,
	"health_check" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routes_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "applied_version_id" uuid;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "default_route_id" uuid;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "extra_config" text;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "config_sha256" text;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "import_done" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "check_results" ADD CONSTRAINT "check_results_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_results" ADD CONSTRAINT "check_results_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_versions" ADD CONSTRAINT "config_versions_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_exits" ADD CONSTRAINT "route_exits_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_exits" ADD CONSTRAINT "route_exits_exit_id_exits_id_fk" FOREIGN KEY ("exit_id") REFERENCES "public"."exits"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_nodes" ADD CONSTRAINT "route_nodes_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_nodes" ADD CONSTRAINT "route_nodes_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "check_results_route_idx" ON "check_results" USING btree ("route_id","node_id","ts");--> statement-breakpoint
CREATE INDEX "check_results_ts_idx" ON "check_results" USING btree ("ts");--> statement-breakpoint
CREATE UNIQUE INDEX "config_versions_node_number_uq" ON "config_versions" USING btree ("node_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "exits_addr_uq" ON "exits" USING btree ("host","port");--> statement-breakpoint
CREATE INDEX "route_nodes_node_idx" ON "route_nodes" USING btree ("node_id");
ALTER TABLE "exits" ADD COLUMN "is_demo" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN "is_demo" boolean DEFAULT false NOT NULL;
ALTER TABLE "candidate" ADD COLUMN "search_text" text DEFAULT '' NOT NULL;--> statement-breakpoint

-- Full-text index over the maintained blob.
--
-- 'simple' rather than 'english': candidate data is a mix of Arabic and English
-- names, company names and skill tokens. English stemming would fold "Engineers"
-- into "engin" and mangle proper nouns; 'simple' just lowercases and splits,
-- which is what matching names and skills actually wants.
CREATE INDEX IF NOT EXISTS "ix_candidate_fts"
  ON "candidate" USING gin (to_tsvector('simple', "search_text"));
--> statement-breakpoint

-- NOTE: no pg_trgm. The partial-word fallback uses ILIKE instead, because
-- PGlite (the portable test backend) cannot load the extension and the project
-- must run identically on both. ILIKE without a trigram index is a scan; at
-- talent-pool scale that is fine, and it can be accelerated later on a
-- deployment that has the extension without changing a line of query code.

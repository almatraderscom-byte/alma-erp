-- File 15: creative reference library (additive; seeds live in File 14 design playbook)

CREATE TABLE IF NOT EXISTS reference_creative (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source       TEXT NOT NULL,
  image_path   TEXT,
  source_url   TEXT,
  brand        TEXT,
  attrs        JSONB NOT NULL DEFAULT '{}',
  why_it_works TEXT,
  product_type TEXT,
  score        INT NOT NULL DEFAULT 3,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS reference_creative_source_product_type_idx
  ON reference_creative (source, product_type);

CREATE INDEX IF NOT EXISTS reference_creative_created_at_idx
  ON reference_creative (created_at DESC);

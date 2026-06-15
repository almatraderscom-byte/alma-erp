-- Product content library for autonomous FB content engine (Phase 1)

CREATE TABLE IF NOT EXISTS product_content_asset (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_code TEXT NOT NULL,
  name TEXT,
  category TEXT,
  fabric TEXT,
  image_path TEXT NOT NULL,
  family_match BOOLEAN NOT NULL DEFAULT false,
  last_posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_content_asset_last_posted_idx ON product_content_asset (last_posted_at);
CREATE INDEX IF NOT EXISTS product_content_asset_code_idx ON product_content_asset (product_code);

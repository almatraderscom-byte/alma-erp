-- Brand model library for try-on + content engine (roles: father/mother/son/daughter/single)

CREATE TABLE IF NOT EXISTS agent_brand_models (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  image_path TEXT NOT NULL,
  role TEXT UNIQUE,
  is_default BOOLEAN NOT NULL DEFAULT false,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_brand_models_is_default_idx ON agent_brand_models (is_default);

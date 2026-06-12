-- CS-0: product images, design groups, age→size charts (additive only)

CREATE TABLE IF NOT EXISTS product_images (
  id                  TEXT        PRIMARY KEY DEFAULT CAST(gen_random_uuid() AS TEXT),
  product_code        TEXT        NOT NULL,
  business            TEXT        NOT NULL,
  storage_path        TEXT        NOT NULL,
  url                 TEXT,
  is_primary          BOOLEAN     NOT NULL DEFAULT FALSE,
  uploaded_by_chat_id TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS product_images_code_idx ON product_images (product_code);
CREATE INDEX IF NOT EXISTS product_images_business_idx ON product_images (business);

CREATE TABLE IF NOT EXISTS cs_design_groups (
  id          TEXT        PRIMARY KEY DEFAULT CAST(gen_random_uuid() AS TEXT),
  group_code  TEXT        NOT NULL UNIQUE,
  title       TEXT,
  business    TEXT        NOT NULL,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS cs_design_groups_business_idx ON cs_design_groups (business);

CREATE TABLE IF NOT EXISTS cs_design_group_members (
  id           TEXT        PRIMARY KEY DEFAULT CAST(gen_random_uuid() AS TEXT),
  group_id     TEXT        NOT NULL REFERENCES cs_design_groups(id) ON DELETE CASCADE,
  product_code TEXT        NOT NULL,
  member_role  TEXT        NOT NULL DEFAULT 'other',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (group_id, product_code)
);

CREATE INDEX IF NOT EXISTS cs_design_group_members_code_idx ON cs_design_group_members (product_code);

CREATE TABLE IF NOT EXISTS cs_size_charts (
  id             TEXT           PRIMARY KEY DEFAULT CAST(gen_random_uuid() AS TEXT),
  business       TEXT           NOT NULL,
  category       TEXT           NOT NULL,
  age_min_years  NUMERIC(4, 1)  NOT NULL,
  age_max_years  NUMERIC(4, 1)  NOT NULL,
  size_label     TEXT           NOT NULL,
  height_note    TEXT,
  created_at     TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS cs_size_charts_biz_cat_idx ON cs_size_charts (business, category);

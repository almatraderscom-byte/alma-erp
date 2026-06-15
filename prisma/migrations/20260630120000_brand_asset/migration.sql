-- Brand logo paths for content-engine compositor (owner upload via save_brand_asset)
CREATE TABLE IF NOT EXISTS "brand_asset" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brand_asset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "brand_asset_kind_key" ON "brand_asset"("kind");

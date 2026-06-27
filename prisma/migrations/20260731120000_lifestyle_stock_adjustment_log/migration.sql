-- Inventory adjustment audit trail. The "Adjust" action collected a reason
-- (damaged / lost / manual correction / supplier update / return restock) but
-- never stored it. This table records each manual stock change with who, what,
-- how much and why. Additive + idempotent.
CREATE TABLE IF NOT EXISTS "lifestyle_stock_adjustments" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL DEFAULT 'ALMA_LIFESTYLE',
    "sku" TEXT NOT NULL,
    "size" TEXT NOT NULL DEFAULT '',
    "previous_stock" INTEGER NOT NULL,
    "new_stock" INTEGER NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "actor" TEXT NOT NULL DEFAULT '',
    "actor_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "lifestyle_stock_adjustments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "lifestyle_stock_adjustments_sku_idx" ON "lifestyle_stock_adjustments"("sku");
CREATE INDEX IF NOT EXISTS "lifestyle_stock_adjustments_business_id_created_at_idx" ON "lifestyle_stock_adjustments"("business_id", "created_at");

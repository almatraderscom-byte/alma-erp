-- Phase 1: ALMA Lifestyle core tables (GAS → Postgres migration)
-- Additive only — no changes to existing ERP tables.

CREATE TABLE IF NOT EXISTS "lifestyle_orders" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL DEFAULT 'ALMA_LIFESTYLE',
    "date" DATE NOT NULL,
    "customer" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "payment" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "size" TEXT NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "unit_price" INTEGER NOT NULL DEFAULT 0,
    "discount" INTEGER NOT NULL DEFAULT 0,
    "add_discount" INTEGER NOT NULL DEFAULT 0,
    "adv_cost" INTEGER NOT NULL DEFAULT 0,
    "adv_platform" TEXT NOT NULL DEFAULT '',
    "sell_price" INTEGER NOT NULL DEFAULT 0,
    "shipping_fee" INTEGER NOT NULL DEFAULT 0,
    "cogs" INTEGER NOT NULL DEFAULT 0,
    "courier_charge" INTEGER NOT NULL DEFAULT 0,
    "other_costs" INTEGER NOT NULL DEFAULT 0,
    "profit" INTEGER NOT NULL DEFAULT 0,
    "courier" TEXT NOT NULL DEFAULT '',
    "tracking_id" TEXT NOT NULL DEFAULT '',
    "tracking_status" TEXT NOT NULL DEFAULT '',
    "est_delivery" DATE,
    "actual_delivery" DATE,
    "return_reason" TEXT NOT NULL DEFAULT '',
    "return_date" DATE,
    "return_status" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "sku" TEXT NOT NULL DEFAULT '',
    "handled_by" TEXT NOT NULL DEFAULT '',
    "invoice_num" TEXT NOT NULL DEFAULT '',
    "auto_flag" TEXT NOT NULL DEFAULT '',
    "paid_amount" INTEGER,
    "due_amount" INTEGER,
    "estimated_profit" INTEGER,
    "realized_profit" INTEGER,
    "reversed_profit" INTEGER,
    "net_profit" INTEGER,
    "return_net_profit" INTEGER,
    "shipping_margin" INTEGER,
    "merchandise_profit" INTEGER,
    "return_type" TEXT,
    "courier_cost" INTEGER,
    "inventory_cost" INTEGER,
    "stock_restored" BOOLEAN NOT NULL DEFAULT false,
    "stock_restored_at" TIMESTAMP(3),
    "stock_restore_reason" TEXT,
    "notes_meta_json" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lifestyle_orders_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "lifestyle_order_items" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "line_no" INTEGER NOT NULL,
    "sku" TEXT NOT NULL,
    "product_code" TEXT NOT NULL DEFAULT '',
    "product" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT '',
    "size" TEXT NOT NULL DEFAULT '',
    "variant" TEXT NOT NULL DEFAULT '',
    "qty" INTEGER NOT NULL DEFAULT 1,
    "unit_price" INTEGER NOT NULL DEFAULT 0,
    "sell_price" INTEGER NOT NULL DEFAULT 0,
    "subtotal" INTEGER NOT NULL DEFAULT 0,
    "cogs" INTEGER NOT NULL DEFAULT 0,
    "stock_sku" TEXT NOT NULL DEFAULT '',
    "collection_code" TEXT NOT NULL DEFAULT '',
    "collection_type" TEXT NOT NULL DEFAULT '',
    "size_group" TEXT NOT NULL DEFAULT '',
    "variant_group" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lifestyle_order_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "lifestyle_products" (
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT '',
    "default_cogs" INTEGER NOT NULL DEFAULT 0,
    "default_price" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT NOT NULL DEFAULT '',
    "image_url" TEXT,
    "supplier" TEXT DEFAULT 'manual',
    "supplier_product_id" TEXT,
    "description" TEXT,
    "variants_json" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lifestyle_products_pkey" PRIMARY KEY ("sku")
);

CREATE TABLE IF NOT EXISTS "lifestyle_stock_items" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT '',
    "color" TEXT NOT NULL DEFAULT '',
    "size" TEXT NOT NULL DEFAULT '',
    "opening" INTEGER NOT NULL DEFAULT 0,
    "purchased" INTEGER NOT NULL DEFAULT 0,
    "sold" INTEGER NOT NULL DEFAULT 0,
    "returned" INTEGER NOT NULL DEFAULT 0,
    "damaged" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "current_stock" INTEGER NOT NULL DEFAULT 0,
    "available" INTEGER NOT NULL DEFAULT 0,
    "reorder_level" INTEGER NOT NULL DEFAULT 5,
    "status" TEXT NOT NULL DEFAULT '',
    "stock_value" INTEGER NOT NULL DEFAULT 0,
    "sell_value" INTEGER NOT NULL DEFAULT 0,
    "potential_profit" INTEGER NOT NULL DEFAULT 0,
    "meta_json" TEXT,
    "collection_code" TEXT,
    "collection_type" TEXT,
    "size_group" TEXT,
    "variant_group" TEXT,
    "buying_price" INTEGER,
    "barcode" TEXT DEFAULT '',
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "image_url" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lifestyle_stock_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "lifestyle_customers" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL DEFAULT 'ALMA_LIFESTYLE',
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "district" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "whatsapp" TEXT NOT NULL DEFAULT '',
    "total_orders" INTEGER NOT NULL DEFAULT 0,
    "delivered" INTEGER NOT NULL DEFAULT 0,
    "returned" INTEGER NOT NULL DEFAULT 0,
    "cancelled" INTEGER NOT NULL DEFAULT 0,
    "pending" INTEGER NOT NULL DEFAULT 0,
    "total_spent" INTEGER NOT NULL DEFAULT 0,
    "avg_order" INTEGER NOT NULL DEFAULT 0,
    "total_profit" INTEGER NOT NULL DEFAULT 0,
    "cod_orders" INTEGER NOT NULL DEFAULT 0,
    "cod_fails" INTEGER NOT NULL DEFAULT 0,
    "cod_fail_pct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "return_rate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "last_order" DATE,
    "days_inactive" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fav_category" TEXT NOT NULL DEFAULT '',
    "clv_score" INTEGER NOT NULL DEFAULT 0,
    "risk_score" INTEGER NOT NULL DEFAULT 0,
    "risk_level" TEXT NOT NULL DEFAULT 'LOW',
    "segment" TEXT NOT NULL DEFAULT 'NEW',
    "loyalty_pts" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT '',
    "wa_optin" TEXT NOT NULL DEFAULT 'Yes',
    "notes" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lifestyle_customers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "lifestyle_promos" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL DEFAULT 'ALMA_LIFESTYLE',
    "code" TEXT NOT NULL,
    "discount_pct" INTEGER,
    "discount_amount" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "expires_at" TIMESTAMP(3),
    "usage_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lifestyle_promos_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "lifestyle_invoice_sequences" (
    "business_id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "lifestyle_invoice_sequences_pkey" PRIMARY KEY ("business_id", "year")
);

CREATE UNIQUE INDEX IF NOT EXISTS "lifestyle_order_items_order_id_line_no_key"
    ON "lifestyle_order_items"("order_id", "line_no");
CREATE INDEX IF NOT EXISTS "lifestyle_order_items_sku_idx" ON "lifestyle_order_items"("sku");
CREATE INDEX IF NOT EXISTS "lifestyle_order_items_order_id_idx" ON "lifestyle_order_items"("order_id");

CREATE INDEX IF NOT EXISTS "lifestyle_orders_business_id_status_idx" ON "lifestyle_orders"("business_id", "status");
CREATE INDEX IF NOT EXISTS "lifestyle_orders_business_id_date_idx" ON "lifestyle_orders"("business_id", "date");
CREATE INDEX IF NOT EXISTS "lifestyle_orders_business_id_customer_idx" ON "lifestyle_orders"("business_id", "customer");
CREATE INDEX IF NOT EXISTS "lifestyle_orders_phone_idx" ON "lifestyle_orders"("phone");
CREATE INDEX IF NOT EXISTS "lifestyle_orders_status_date_idx" ON "lifestyle_orders"("status", "date");

CREATE INDEX IF NOT EXISTS "lifestyle_products_category_idx" ON "lifestyle_products"("category");
CREATE INDEX IF NOT EXISTS "lifestyle_products_active_idx" ON "lifestyle_products"("active");

CREATE UNIQUE INDEX IF NOT EXISTS "lifestyle_stock_items_sku_size_key" ON "lifestyle_stock_items"("sku", "size");
CREATE INDEX IF NOT EXISTS "lifestyle_stock_items_sku_idx" ON "lifestyle_stock_items"("sku");
CREATE INDEX IF NOT EXISTS "lifestyle_stock_items_category_idx" ON "lifestyle_stock_items"("category");
CREATE INDEX IF NOT EXISTS "lifestyle_stock_items_archived_active_idx" ON "lifestyle_stock_items"("archived", "active");
CREATE INDEX IF NOT EXISTS "lifestyle_stock_items_available_idx" ON "lifestyle_stock_items"("available");

CREATE UNIQUE INDEX IF NOT EXISTS "lifestyle_customers_business_id_phone_key" ON "lifestyle_customers"("business_id", "phone");
CREATE INDEX IF NOT EXISTS "lifestyle_customers_business_id_segment_idx" ON "lifestyle_customers"("business_id", "segment");
CREATE INDEX IF NOT EXISTS "lifestyle_customers_business_id_risk_level_idx" ON "lifestyle_customers"("business_id", "risk_level");
CREATE INDEX IF NOT EXISTS "lifestyle_customers_name_idx" ON "lifestyle_customers"("name");
CREATE INDEX IF NOT EXISTS "lifestyle_customers_phone_idx" ON "lifestyle_customers"("phone");

CREATE UNIQUE INDEX IF NOT EXISTS "lifestyle_promos_business_id_code_key" ON "lifestyle_promos"("business_id", "code");
CREATE INDEX IF NOT EXISTS "lifestyle_promos_active_idx" ON "lifestyle_promos"("active");

DO $$ BEGIN
    ALTER TABLE "lifestyle_order_items"
        ADD CONSTRAINT "lifestyle_order_items_order_id_fkey"
        FOREIGN KEY ("order_id") REFERENCES "lifestyle_orders"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

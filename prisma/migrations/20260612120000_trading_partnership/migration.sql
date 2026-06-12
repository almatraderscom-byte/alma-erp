-- Trading account 50/50 partnership settlement layer

CREATE TYPE "TradingExpensePaidBy" AS ENUM ('OWNER', 'STAFF');

ALTER TABLE "trading_accounts" ADD COLUMN "partnership_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "trading_accounts" ADD COLUMN "staff_share_percent" DECIMAL(8,4) NOT NULL DEFAULT 50;
ALTER TABLE "trading_accounts" ADD COLUMN "last_partnership_settled_at" TIMESTAMP(3);
ALTER TABLE "trading_accounts" ADD COLUMN "partnership_baseline_profit" DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "trading_accounts" ADD COLUMN "partnership_baseline_loss" DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "trading_accounts" ADD COLUMN "partnership_baseline_owner_expenses" DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "trading_accounts" ADD COLUMN "partnership_baseline_staff_expenses" DECIMAL(14,2) NOT NULL DEFAULT 0;

ALTER TABLE "trading_expenses" ADD COLUMN "paid_by" "TradingExpensePaidBy";
ALTER TABLE "trading_expenses" ADD COLUMN "settlement_id" TEXT;

CREATE TABLE "trading_partnership_settlements" (
    "id" TEXT NOT NULL,
    "trading_account_id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "delta_profit_bdt" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "delta_loss_bdt" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "net_trading_delta_bdt" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "owner_paid_expenses_bdt" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "staff_paid_expenses_bdt" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "staff_share_percent" DECIMAL(8,4) NOT NULL DEFAULT 50,
    "staff_trading_share_bdt" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "expense_adjustment_bdt" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "net_staff_owes_bdt" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "admin_override_bdt" DECIMAL(14,2),
    "notes" TEXT,
    "settled_by_user_id" TEXT NOT NULL,
    "ledger_entry_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trading_partnership_settlements_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "trading_partnership_settlements_trading_account_id_created_at_idx" ON "trading_partnership_settlements"("trading_account_id", "created_at");
CREATE INDEX "trading_partnership_settlements_business_id_created_at_idx" ON "trading_partnership_settlements"("business_id", "created_at");
CREATE INDEX "trading_partnership_settlements_settled_by_user_id_idx" ON "trading_partnership_settlements"("settled_by_user_id");
CREATE INDEX "trading_expenses_settlement_id_idx" ON "trading_expenses"("settlement_id");

ALTER TABLE "trading_expenses" ADD CONSTRAINT "trading_expenses_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "trading_partnership_settlements"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "trading_partnership_settlements" ADD CONSTRAINT "trading_partnership_settlements_trading_account_id_fkey" FOREIGN KEY ("trading_account_id") REFERENCES "trading_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "trading_partnership_settlements" ADD CONSTRAINT "trading_partnership_settlements_settled_by_user_id_fkey" FOREIGN KEY ("settled_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

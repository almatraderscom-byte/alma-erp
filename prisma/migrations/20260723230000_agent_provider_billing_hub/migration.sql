-- Phase 69 — truthful provider billing snapshots + subscription provenance.
-- Additive only: all new subscription metadata is nullable or has a safe default.

ALTER TABLE "agent_subscriptions"
  ADD COLUMN "provider_id" TEXT,
  ADD COLUMN "source_type" TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN "external_subscription_id" TEXT,
  ADD COLUMN "billing_period_start" DATE,
  ADD COLUMN "billing_period_end" DATE,
  ADD COLUMN "invoice_amount" DECIMAL(12,2),
  ADD COLUMN "invoice_currency" TEXT,
  ADD COLUMN "invoice_due_at" DATE,
  ADD COLUMN "invoice_status" TEXT,
  ADD COLUMN "source_url" TEXT,
  ADD COLUMN "last_synced_at" TIMESTAMP(3),
  ADD COLUMN "sync_status" TEXT NOT NULL DEFAULT 'manual';

CREATE INDEX "agent_subscriptions_provider_id_idx"
  ON "agent_subscriptions"("provider_id");
CREATE INDEX "agent_subscriptions_invoice_due_at_idx"
  ON "agent_subscriptions"("invoice_due_at");
CREATE INDEX "agent_subscriptions_sync_status_idx"
  ON "agent_subscriptions"("sync_status");

CREATE TABLE "agent_provider_billing_snapshots" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "metric" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "source_type" TEXT NOT NULL,
  "authoritative" BOOLEAN NOT NULL DEFAULT false,
  "amount" DECIMAL(18,6),
  "currency" TEXT,
  "unit" TEXT,
  "text_value" TEXT,
  "provider_as_of" TIMESTAMP(3),
  "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "stale_after" TIMESTAMP(3),
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agent_provider_billing_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_provider_billing_snapshots_provider_metric_key"
  ON "agent_provider_billing_snapshots"("provider", "metric");
CREATE INDEX "agent_provider_billing_snapshots_status_stale_after_idx"
  ON "agent_provider_billing_snapshots"("status", "stale_after");
CREATE INDEX "agent_provider_billing_snapshots_provider_fetched_at_idx"
  ON "agent_provider_billing_snapshots"("provider", "fetched_at" DESC);

CREATE TABLE "agent_provider_sync_runs" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMP(3),
  "fields_updated" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_provider_sync_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agent_provider_sync_runs_provider_started_at_idx"
  ON "agent_provider_sync_runs"("provider", "started_at" DESC);
CREATE INDEX "agent_provider_sync_runs_status_started_at_idx"
  ON "agent_provider_sync_runs"("status", "started_at" DESC);

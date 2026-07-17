-- Phase 53 — transactional effect engine: exactly-once action runs, append-only
-- effect ledger, transactional outbox. Additive only.
-- CreateTable
CREATE TABLE "agent_action_runs" (
    "id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "effect_hash" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "surface" TEXT NOT NULL DEFAULT 'owner',
    "actor" TEXT NOT NULL DEFAULT 'owner',
    "instruction_origin" TEXT NOT NULL DEFAULT 'owner_direct',
    "conversation_id" TEXT,
    "turn_id" TEXT,
    "business_id" TEXT,
    "risk_tier" TEXT NOT NULL,
    "policy_version" TEXT NOT NULL,
    "approval_ref" TEXT,
    "state" TEXT NOT NULL DEFAULT 'proposed',
    "state_version" INTEGER NOT NULL DEFAULT 1,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "input" JSONB NOT NULL,
    "destination" TEXT,
    "provider_ref" TEXT,
    "proof" JSONB,
    "result" JSONB,
    "cost_usd" DOUBLE PRECISION,
    "money_taka" INTEGER,
    "error" TEXT,
    "compensation_of_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_action_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_effect_ledger" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "from_state" TEXT,
    "to_state" TEXT,
    "payload" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_effect_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_effect_outbox" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "due_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_until" TIMESTAMP(3),
    "lease_owner" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_effect_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_action_runs_idempotency_key_key" ON "agent_action_runs"("idempotency_key");

-- CreateIndex
CREATE INDEX "agent_action_runs_state_updated_at_idx" ON "agent_action_runs"("state", "updated_at");

-- CreateIndex
CREATE INDEX "agent_action_runs_conversation_id_created_at_idx" ON "agent_action_runs"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_action_runs_tool_created_at_idx" ON "agent_action_runs"("tool", "created_at");

-- CreateIndex
CREATE INDEX "agent_effect_ledger_run_id_at_idx" ON "agent_effect_ledger"("run_id", "at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_effect_ledger_run_id_seq_key" ON "agent_effect_ledger"("run_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "agent_effect_outbox_run_id_key" ON "agent_effect_outbox"("run_id");

-- CreateIndex
CREATE INDEX "agent_effect_outbox_due_at_lease_until_idx" ON "agent_effect_outbox"("due_at", "lease_until");

-- AddForeignKey
ALTER TABLE "agent_effect_ledger" ADD CONSTRAINT "agent_effect_ledger_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_action_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


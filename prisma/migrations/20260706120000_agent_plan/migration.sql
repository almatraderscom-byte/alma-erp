-- CreateTable
CREATE TABLE "agent_plans" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT,
    "business_id" TEXT NOT NULL DEFAULT 'ALMA_LIFESTYLE',
    "goal" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "self_check_note" TEXT,

    CONSTRAINT "agent_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_plan_steps" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "tool_name" TEXT,
    "depends_on" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'pending',
    "result" JSONB,
    "error" TEXT,
    "started_at" TIMESTAMP(3),
    "done_at" TIMESTAMP(3),

    CONSTRAINT "agent_plan_steps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_plans_conversation_id_idx" ON "agent_plans"("conversation_id");

-- CreateIndex
CREATE INDEX "agent_plans_business_id_status_idx" ON "agent_plans"("business_id", "status");

-- CreateIndex
CREATE INDEX "agent_plan_steps_plan_id_seq_idx" ON "agent_plan_steps"("plan_id", "seq");

-- AddForeignKey
ALTER TABLE "agent_plan_steps" ADD CONSTRAINT "agent_plan_steps_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "agent_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

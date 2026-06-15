CREATE TABLE IF NOT EXISTS "agent_playbook" (
    "id"             UUID         NOT NULL DEFAULT gen_random_uuid(),
    "business_id"    TEXT         NOT NULL,
    "domain"         TEXT         NOT NULL,
    "heuristic"      TEXT         NOT NULL,
    "evidence"       TEXT         NOT NULL,
    "confidence"     INTEGER      NOT NULL DEFAULT 2,
    "status"         TEXT         NOT NULL DEFAULT 'proposed',
    "times_applied"  INTEGER      NOT NULL DEFAULT 0,
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_at"    TIMESTAMP(3),
    CONSTRAINT "agent_playbook_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "agent_playbook_business_id_status_idx"
  ON "agent_playbook"("business_id", "status");

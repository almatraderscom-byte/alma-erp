-- Additive, nullable fields for an atomic per-action image model + USD quote.
-- Historical clients/actions continue to use payload/costEstimate unchanged.
ALTER TABLE "agent_pending_actions"
  ADD COLUMN IF NOT EXISTS "image_model" TEXT,
  ADD COLUMN IF NOT EXISTS "image_quote" JSONB,
  ADD COLUMN IF NOT EXISTS "approval_claimed_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "job_result_pending" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "job_result_envelope" JSONB,
  ADD COLUMN IF NOT EXISTS "job_result_claimed_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "agent_pending_actions_image_result_outbox_idx"
  ON "agent_pending_actions" ("job_result_pending", "type")
  WHERE "job_result_pending" = true;

-- Atomic, monotonic terminal receipt: first failure is durable, a later success
-- may upgrade it, and success can never be overwritten by a late queue failure.
-- Replacing a failure with success releases any stale server reconciliation
-- claim so the success receipt is delivered on the next callback/poll.
CREATE OR REPLACE FUNCTION record_agent_image_terminal_receipt(
  p_action_id TEXT,
  p_envelope JSONB
)
RETURNS TABLE (
  job_result_envelope JSONB,
  status TEXT,
  job_result_claimed_at TIMESTAMP(3)
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF jsonb_typeof(p_envelope) IS DISTINCT FROM 'object'
    OR p_envelope->>'version' IS DISTINCT FROM '1'
    OR p_envelope->>'status' NOT IN ('success', 'failed')
    OR COALESCE(p_envelope->>'receiptId', '') = ''
    OR COALESCE(p_envelope->>'recordedAt', '') = ''
  THEN
    RAISE EXCEPTION 'invalid_image_terminal_envelope' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  UPDATE agent_pending_actions AS action
  SET
    job_result_envelope = CASE
      WHEN action.job_result_envelope->>'status' = 'success' THEN action.job_result_envelope
      WHEN p_envelope->>'status' = 'success' THEN p_envelope
      WHEN action.job_result_envelope IS NOT NULL THEN action.job_result_envelope
      ELSE p_envelope
    END,
    job_result_pending = true,
    job_result_claimed_at = CASE
      WHEN action.job_result_envelope->>'status' IS DISTINCT FROM 'success'
        AND p_envelope->>'status' = 'success'
      THEN NULL
      ELSE action.job_result_claimed_at
    END
  WHERE action.id = p_action_id
    AND action.type = 'image_gen'
    AND action.status IN ('approved', 'preview_approved', 'campaign_approved', 'failed', 'executed')
  RETURNING action.job_result_envelope, action.status, action.job_result_claimed_at;
END;
$$;

-- This function mutates an internal worker outbox and intentionally bypasses
-- RLS. Supabase grants function execution to PUBLIC by default, so explicitly
-- keep it service-role-only; an action UUID must not be enough for a browser
-- client to forge a terminal receipt.
REVOKE ALL ON FUNCTION record_agent_image_terminal_receipt(TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_agent_image_terminal_receipt(TEXT, JSONB) FROM anon;
REVOKE ALL ON FUNCTION record_agent_image_terminal_receipt(TEXT, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION record_agent_image_terminal_receipt(TEXT, JSONB) TO service_role;

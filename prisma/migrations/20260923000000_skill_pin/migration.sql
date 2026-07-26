-- SK-3: the skill pinned to a conversation, and why.
--
-- One chat, one job. Re-selecting a ~5k-token skill body every turn would break
-- the prompt cache prefix, which the owner's own cost meter already showed the
-- price of; pinned, it costs one cache write for the whole conversation.
--
-- `skill_route_trace` stores the decision (which layer chose it, the reason, the
-- runner-up) so a wrong pin can be explained instead of guessed at.
--
-- NULL on both means "no skill pinned", so every existing conversation behaves
-- exactly as it does today. Additive and safe for the live ERP.
ALTER TABLE "agent_conversations"
  ADD COLUMN IF NOT EXISTS "pinned_skill" TEXT,
  ADD COLUMN IF NOT EXISTS "skill_route_trace" JSONB;

-- File 14: taste signals + design playbook seeds (additive)

CREATE TABLE IF NOT EXISTS agent_taste_signal (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  verdict      TEXT NOT NULL,
  attrs        JSONB NOT NULL DEFAULT '{}',
  product_type TEXT,
  product_code TEXT,
  image_path   TEXT NOT NULL,
  source       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS agent_taste_signal_created_at_idx
  ON agent_taste_signal (created_at DESC);

CREATE INDEX IF NOT EXISTS agent_taste_signal_verdict_idx
  ON agent_taste_signal (verdict, created_at DESC);

-- Day-1 design taste defaults (idempotent — skip if seed marker exists)
INSERT INTO agent_playbook (id, business_id, domain, heuristic, evidence, confidence, status, times_applied, created_at)
SELECT gen_random_uuid(), 'ALMA_LIFESTYLE', 'design', h.heuristic, h.evidence, 4, 'active', 0, NOW()
FROM (VALUES
  ('Full-body or three-quarter shots convert better than tight crops for panjabi/family sets.', '{"seed":"design-defaults","source":"market-knowledge"}'),
  ('Soft golden-hour or clean even studio light reads premium; harsh flat light reads cheap.', '{"seed":"design-defaults","source":"market-knowledge"}'),
  ('Keep the garment as the hero — uncluttered backgrounds, embroidery sharp and unobstructed.', '{"seed":"design-defaults","source":"market-knowledge"}'),
  ('Model gaze/relaxed confident posture > stiff catalog pose for family/emotional brands.', '{"seed":"design-defaults","source":"market-knowledge"}'),
  ('One clear focal point per creative; avoid competing text + busy props.', '{"seed":"design-defaults","source":"market-knowledge"}'),
  ('Festival creatives: warm accent + restraint, never cluttered.', '{"seed":"design-defaults","source":"market-knowledge"}'),
  ('Consistent crop/format per channel (4:5 feed, 9:16 story) for a professional grid.', '{"seed":"design-defaults","source":"market-knowledge"}')
) AS h(heuristic, evidence)
WHERE NOT EXISTS (
  SELECT 1 FROM agent_playbook p
  WHERE p.business_id = 'ALMA_LIFESTYLE'
    AND p.domain = 'design'
    AND p.evidence LIKE '%"seed":"design-defaults"%'
  LIMIT 1
);

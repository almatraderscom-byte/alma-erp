-- The provider's own registration table, carried over from the console's step 1.
--
-- Reading it needs an amarip.net login, which is why it is a settings-shaped problem rather
-- than a read-only one. It matters because OUR side of the registration is not evidence:
-- Asterisk reported "Registered (exp. 3227s)" while the provider's table did not list us at
-- all, and the provider keeps exactly one binding per account with the last registrant
-- owning it. Only their table shows who actually holds the line.
--
-- The password is stored AES-256-GCM encrypted (`secret_enc`) and is never returned by any
-- route — the console shows status, never a secret. It is deliberately kept out of
-- `agent_kv_settings`, whose whole contents the agent's own get_settings tool can read.
--
-- Additive: a new table, nothing existing is touched.
CREATE TABLE IF NOT EXISTS "phone_provider_credentials" (
  "id"            TEXT NOT NULL DEFAULT 'amarip',
  "username"      TEXT NOT NULL,
  "secret_enc"    TEXT NOT NULL,
  "login_url"     TEXT,
  "status_url"    TEXT,
  "last_check_at" TIMESTAMP(3),
  "last_check_ok" BOOLEAN,
  "last_error"    TEXT,
  "updated_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "phone_provider_credentials_pkey" PRIMARY KEY ("id")
);

ALTER TABLE finance_expenses ADD COLUMN IF NOT EXISTS deleted BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE finance_ledger ADD COLUMN IF NOT EXISTS deleted BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS finance_expenses_deleted_idx ON finance_expenses(deleted);
CREATE INDEX IF NOT EXISTS finance_ledger_deleted_idx ON finance_ledger(deleted);

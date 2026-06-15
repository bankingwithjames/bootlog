-- Admin soft-delete (void) for cash_collections.
-- Voided rows stay in the table as an audit trail but are excluded from every
-- total, holder tracker, recent list, and the attendant's own view.
ALTER TABLE cash_collections
  ADD COLUMN IF NOT EXISTS voided boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS voided_at text,
  ADD COLUMN IF NOT EXISTS voided_by_name text;

-- Speeds up the "exclude voided" filter used on every cash read.
CREATE INDEX IF NOT EXISTS idx_cash_collections_voided
  ON cash_collections (voided);

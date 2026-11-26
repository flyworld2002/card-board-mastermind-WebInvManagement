-- Carrier tracking results on TCGplayer orders (applied 2026-11-26).
--
-- Filled by importer/tcg_tracking.py (daily, open orders that have a tracking number): the carrier's
-- own estimated delivery date while in transit, or the actual delivery date once delivered.
-- tcg_orders.est_delivery stays TCGplayer's estimate; carrier_* is what USPS / UPS say.

ALTER TABLE tcg_orders
    ADD COLUMN IF NOT EXISTS carrier_status       text,         -- e.g. In Transit, Out for Delivery, Delivered
    ADD COLUMN IF NOT EXISTS carrier_est_delivery date,         -- carrier's expected / scheduled delivery date
    ADD COLUMN IF NOT EXISTS carrier_delivered_on date,         -- actual delivery date when delivered
    ADD COLUMN IF NOT EXISTS carrier_summary     text,         -- carrier's one-line status text
    ADD COLUMN IF NOT EXISTS carrier_checked_at  timestamptz,
    ADD COLUMN IF NOT EXISTS carrier_error       text;         -- why the last lookup did not work (no credentials, not found, ...)

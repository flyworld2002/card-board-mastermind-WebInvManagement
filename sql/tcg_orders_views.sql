-- TCGplayer order tracker views (applied 2026-11-26). Both run with the caller's rights
-- (security_invoker) so the table policies in tcg_orders.sql still apply.

-- Cards on order, per variant: open = not received and not cancelled. Only lines already
-- matched to an exact variant count (card_only / unmatched lines have no variant yet).
CREATE OR REPLACE VIEW v_tcg_on_order WITH (security_invoker = true) AS
SELECT l.variant_id,
       SUM(l.quantity)::integer AS on_order_qty,
       COUNT(DISTINCT o.order_number)::integer AS order_count,
       MIN(o.est_delivery) AS next_est_delivery,
       ARRAY_AGG(DISTINCT o.order_number) AS order_numbers
FROM tcg_order_lines l
JOIN tcg_orders o ON o.order_number = l.order_number
WHERE o.received_at IS NULL AND o.status <> 'cancelled' AND l.variant_id IS NOT NULL
GROUP BY l.variant_id;

-- Orders that need a look. Ages count from the order date (TCGplayer shows no ship date).
--   no_tracking_14d   shipped without tracking and ordered 14+ days ago
--   not_confirmed_7d  "Shipping Not Confirmed" and ordered 7+ days ago
--   past_estimate     estimated delivery date has passed and the order is still open
CREATE OR REPLACE VIEW v_tcg_order_alerts WITH (security_invoker = true) AS
WITH t AS (SELECT (now() AT TIME ZONE 'America/New_York')::date AS today)
SELECT o.order_number, a.alert_type, a.days
FROM tcg_orders o CROSS JOIN t
CROSS JOIN LATERAL (VALUES
    ('no_tracking_14d',  CASE WHEN o.status = 'shipped_no_tracking' AND t.today - o.ordered_on >= 14 THEN t.today - o.ordered_on END),
    ('not_confirmed_7d', CASE WHEN o.status = 'not_shipped' AND t.today - o.ordered_on >= 7 THEN t.today - o.ordered_on END),
    ('past_estimate',    CASE WHEN o.status <> 'cancelled' AND o.est_delivery < t.today THEN t.today - o.est_delivery END)
) AS a(alert_type, days)
WHERE o.received_at IS NULL AND o.status <> 'cancelled' AND a.days IS NOT NULL;

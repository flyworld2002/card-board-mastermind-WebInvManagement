-- Missing cards worklist (applied 2026-11-27).
--
-- A card marked Short (it did not arrive) is work until it is settled. v_tcg_short_work has one row per
-- short line with where it stands; the Held page's "Missing cards" tab shows the open ones, and the
-- Follow-ups reason 'short' and the Held badge use the same rule:
--   open = short_qty > 0, not resolved by hand, and what was refunded for it is less than what it cost
-- Settled by: a refund assigned to that line that covers it, or tcg_resolve_short(): seller resent it /
-- refund received / dropped (not chasing). tcg_reopen_short() undoes a resolve.

ALTER TABLE tcg_staged_lines
    ADD COLUMN IF NOT EXISTS short_resolved_at timestamptz,
    ADD COLUMN IF NOT EXISTS short_resolution text;
ALTER TABLE tcg_staged_lines DROP CONSTRAINT IF EXISTS tcg_staged_lines_short_resolution_check;
ALTER TABLE tcg_staged_lines ADD CONSTRAINT tcg_staged_lines_short_resolution_check
    CHECK (short_resolution IS NULL OR short_resolution IN ('resent', 'refunded', 'dropped'));

CREATE OR REPLACE VIEW v_tcg_short_work WITH (security_invoker = true) AS
WITH last_msg AS (
    SELECT DISTINCT ON (m.thread_id) m.thread_id, m.direction FROM tcg_msg_messages m ORDER BY m.thread_id, m.position DESC
), thr AS (
    SELECT DISTINCT ON (t.order_number) t.order_number, t.last_date, lm.direction AS last_dir
    FROM tcg_msg_threads t LEFT JOIN last_msg lm ON lm.thread_id = t.thread_id
    WHERE t.subject ILIKE 'Item(s) Missing%' OR t.subject ILIKE 'Product Missing%'
    ORDER BY t.order_number, t.last_date DESC NULLS LAST
), ob AS (
    SELECT order_number, max(sent_at) FILTER (WHERE status = 'sent') AS sent_at, bool_or(status IN ('approved', 'exported')) AS pending
    FROM tcg_msg_outbox WHERE kind = 'missing' GROUP BY order_number
), base AS (
    SELECT sl.staging_id, sl.line_id, sl.order_number, o.seller, l.card_name, l.card_number, sl.short_qty AS qty,
           l.unit_price AS paid_each, round(sl.short_qty * COALESCE(l.unit_price, 0), 2) AS owed,
           COALESCE((SELECT sum(a.amount) FROM tcg_refund_allocations a WHERE a.line_id = sl.line_id AND a.kind = 'short'), 0) AS refunded,
           sl.short_note, sl.short_resolved_at, sl.short_resolution, o.ordered_on
    FROM tcg_staged_lines sl
    JOIN tcg_order_lines l ON l.id = sl.line_id
    JOIN tcg_orders o ON o.order_number = sl.order_number
    WHERE sl.short_qty > 0
)
SELECT b.*, thr.last_date AS thread_last_date, thr.last_dir AS thread_last_dir,
       ob.sent_at AS message_sent_at, COALESCE(ob.pending, false) AS message_pending,
       (b.short_resolved_at IS NULL AND b.refunded < b.owed - 0.005) AS is_open
FROM base b
LEFT JOIN thr ON thr.order_number = b.order_number
LEFT JOIN ob ON ob.order_number = b.order_number;

CREATE OR REPLACE FUNCTION public.tcg_resolve_short(p_staging_id uuid, p_resolution text, p_note text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $f$
BEGIN
    IF p_resolution NOT IN ('resent', 'refunded', 'dropped') THEN RAISE EXCEPTION 'Pick how it was settled'; END IF;
    UPDATE tcg_staged_lines SET short_resolved_at = now(), short_resolution = p_resolution,
           short_note = COALESCE(NULLIF(btrim(p_note), ''), short_note)
    WHERE staging_id = p_staging_id AND short_qty > 0;
    IF NOT FOUND THEN RAISE EXCEPTION 'No missing cards on that line'; END IF;
END $f$;

CREATE OR REPLACE FUNCTION public.tcg_reopen_short(p_staging_id uuid) RETURNS void
LANGUAGE plpgsql AS $f$
BEGIN
    UPDATE tcg_staged_lines SET short_resolved_at = NULL, short_resolution = NULL WHERE staging_id = p_staging_id AND short_qty > 0;
    IF NOT FOUND THEN RAISE EXCEPTION 'No missing cards on that line'; END IF;
END $f$;

DO $$
DECLARE f text;
BEGIN
    FOREACH f IN ARRAY ARRAY['tcg_resolve_short(uuid,text,text)', 'tcg_reopen_short(uuid)'] LOOP
        EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC, anon', f);
        EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated', f);
    END LOOP;
END $$;

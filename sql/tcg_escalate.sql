-- Escalate to TCGplayer when a seller has not answered for 3 days (applied 2026-11-27).
--
-- An order is a candidate when it still has a problem (on hold / missing / refund to review / not arrived) and our last message in one of its threads is 3+ days old (within 90 days)
-- and the seller has not replied since. The Incoming page ("Escalate" tab, escalate.js) drafts an email
-- to TCGplayer from the facts below; Fei opens it in Hotmail and sends it himself. Nothing is sent by the app.
--
--   tcg_escalations   what Fei did with a candidate:
--                     'escalated'  email opened/copied and marked done -> hidden for 7 days (then it shows again if still silent)
--                     'dismissed'  not needed -> hidden until a newer unanswered message of ours

CREATE TABLE IF NOT EXISTS tcg_escalations (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_number  text NOT NULL REFERENCES tcg_orders(order_number) ON DELETE CASCADE,
    thread_id     text,
    kind          text NOT NULL CHECK (kind IN ('escalated', 'dismissed')),
    escalated_at  timestamptz NOT NULL DEFAULT now(),
    subject       text,
    body          text,
    note          text
);
CREATE INDEX IF NOT EXISTS tcg_escalations_order_idx ON tcg_escalations (order_number, escalated_at DESC);

ALTER TABLE tcg_escalations ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.tcg_escalations'::regclass AND polname = 'authenticated only') THEN
        CREATE POLICY "authenticated only" ON public.tcg_escalations FOR ALL USING (auth.role() = 'authenticated'::text);
    END IF;
END $$;

CREATE OR REPLACE VIEW v_tcg_escalate_candidates WITH (security_invoker = true) AS
WITH today AS (
    SELECT ((now() AT TIME ZONE 'America/New_York'))::date AS d
), last_msg AS (
    SELECT DISTINCT ON (m.thread_id) m.thread_id, m.direction, m.body
    FROM tcg_msg_messages m
    ORDER BY m.thread_id, m."position" DESC
), waiting AS (                      -- per order: the oldest thread where our message is still unanswered
    SELECT DISTINCT ON (t.order_number)
           t.order_number, t.thread_id, t.subject, t.last_date AS our_last_date, lm.body AS our_last_body,
           (today.d - t.last_date) AS days_waiting
    FROM tcg_msg_threads t
    JOIN last_msg lm ON lm.thread_id = t.thread_id, today
    WHERE lm.direction = 'out' AND t.last_date <= today.d - 3 AND t.last_date >= today.d - 90
    ORDER BY t.order_number, t.last_date ASC
)
SELECT w.order_number, w.thread_id, w.subject, w.our_last_date, w.our_last_body, w.days_waiting,
       o.seller, o.ordered_on, o.total, o.status, o.received_at,
       COALESCE(c.items, '[]'::jsonb) AS cond_items,
       COALESCE(s.items, '[]'::jsonb) AS short_items
FROM waiting w
JOIN tcg_orders o ON o.order_number = w.order_number
LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('name', x.card_name, 'qty', x.n) ORDER BY x.card_name) AS items
    FROM (SELECT h.card_name, count(*) AS n FROM tcg_held_cards h
          WHERE h.order_number = w.order_number
            AND ((h.flags && ARRAY['wrong_condition', 'wrong_item', 'error']::text[]) OR h.keep_reason IN ('damaged', 'lower_condition', 'wrong_card'))
          GROUP BY h.card_name) x) c ON true
LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('name', y.card_name, 'qty', y.n) ORDER BY y.card_name) AS items
    FROM (SELECT v.card_name, sum(v.qty) AS n FROM v_tcg_short_work v
          WHERE v.order_number = w.order_number AND v.is_open GROUP BY v.card_name) y) s ON true
WHERE (
    -- the order still has a problem: a card on hold, a missing card not settled, a refund waiting for a decision,
    -- or it has not arrived yet. Conversations that ended with a thank-you on a settled order stay out.
    (o.received_at IS NULL AND o.status <> 'cancelled')
    OR EXISTS (SELECT 1 FROM tcg_held_cards h WHERE h.order_number = w.order_number AND h.status = 'held')
    OR EXISTS (SELECT 1 FROM v_tcg_short_work v WHERE v.order_number = w.order_number AND v.is_open)
    OR EXISTS (SELECT 1 FROM v_tcg_refund_review r WHERE r.order_number = w.order_number))
  AND NOT EXISTS (
    SELECT 1 FROM tcg_escalations e
    WHERE e.order_number = w.order_number
      AND ((e.kind = 'dismissed' AND e.escalated_at::date >= w.our_last_date)
        OR (e.kind = 'escalated' AND e.escalated_at > now() - interval '7 days')));

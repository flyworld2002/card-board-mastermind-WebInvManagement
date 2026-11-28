-- Facts for the "Escalate" button on any order (applied 2026-11-27). Replaces the queue idea: Fei decides
-- per order, so every order has a row, with its seller conversation state and the cards that are wrong.
--
-- The thread used is the most recent one where our message is still unanswered; if none, the most recent thread.
--   last_msg_dir  'out' = our message is the last one (seller has not answered), 'in' = the seller answered
--   days_since    days since that last message (America/New_York dates); NULL when the order has no thread

CREATE OR REPLACE VIEW v_tcg_escalate_order WITH (security_invoker = true) AS
WITH today AS (
    SELECT ((now() AT TIME ZONE 'America/New_York'))::date AS d
)
SELECT o.order_number, o.seller, o.ordered_on, o.total, o.status, o.received_at,
       t.thread_id, t.subject, t.last_date AS last_msg_date, t.direction AS last_msg_dir, t.body AS last_msg_body,
       CASE WHEN t.last_date IS NULL THEN NULL ELSE today.d - t.last_date END AS days_since,
       COALESCE(c.items, '[]'::jsonb) AS cond_items,
       COALESCE(s.items, '[]'::jsonb) AS short_items
FROM tcg_orders o
CROSS JOIN today
LEFT JOIN LATERAL (
    SELECT tt.thread_id, tt.subject, tt.last_date, lm.direction, lm.body
    FROM tcg_msg_threads tt
    JOIN LATERAL (SELECT m.direction, m.body FROM tcg_msg_messages m WHERE m.thread_id = tt.thread_id ORDER BY m."position" DESC LIMIT 1) lm ON true
    WHERE tt.order_number = o.order_number
    ORDER BY (lm.direction = 'out') DESC, tt.last_date DESC
    LIMIT 1) t ON true
LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('name', x.card_name, 'qty', x.n) ORDER BY x.card_name) AS items
    FROM (SELECT h.card_name, count(*) AS n FROM tcg_held_cards h
          WHERE h.order_number = o.order_number
            AND ((h.flags && ARRAY['wrong_condition', 'wrong_item', 'error']::text[]) OR h.keep_reason IN ('damaged', 'lower_condition', 'wrong_card'))
          GROUP BY h.card_name) x) c ON true
LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('name', y.card_name, 'qty', y.n) ORDER BY y.card_name) AS items
    FROM (SELECT v.card_name, sum(v.qty) AS n FROM v_tcg_short_work v
          WHERE v.order_number = o.order_number AND v.is_open GROUP BY v.card_name) y) s ON true;

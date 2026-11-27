-- Escalation emails sent by Grok from Fei's Hotmail (applied 2026-11-27). Builds on sql/tcg_escalate.sql.
--
-- Same handshake as seller messages: draft -> approve (Fei's click) -> the desktop writes outbox/email_<id>.json ->
-- Grok sends it with "do messages" from flyworld2002@hotmail.com -> Grok writes inbox/email_result_<id>.json.
-- The app only allows addresses ending in @tcgplayer.com, so an approved email can never go anywhere else.

ALTER TABLE tcg_escalations
    ADD COLUMN IF NOT EXISTS to_addr     text,
    ADD COLUMN IF NOT EXISTS status      text CHECK (status IN ('draft', 'approved', 'exported', 'sent', 'failed', 'unknown')),
    ADD COLUMN IF NOT EXISTS approved_at timestamptz,
    ADD COLUMN IF NOT EXISTS exported_at timestamptz,
    ADD COLUMN IF NOT EXISTS sent_at     timestamptz,
    ADD COLUMN IF NOT EXISTS error       text;

CREATE OR REPLACE FUNCTION public.tcg_approve_escalation(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql AS $f$
DECLARE r tcg_escalations; v_today integer; v_cap constant integer := 5;
BEGIN
    SELECT * INTO r FROM tcg_escalations WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Email not found'; END IF;
    IF r.kind <> 'escalated' OR r.status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'This email is already % and cannot be approved again', COALESCE(r.status, r.kind); END IF;
    IF r.to_addr IS NULL OR r.to_addr !~* '^[^@[:space:],;]+@tcgplayer\.com$' THEN RAISE EXCEPTION 'The To address must be one address ending in @tcgplayer.com'; END IF;
    IF length(btrim(COALESCE(r.subject, ''))) < 3 OR length(r.subject) > 200 THEN RAISE EXCEPTION 'The subject must be 3 to 200 characters'; END IF;
    IF r.subject ~ E'[\\r\\n]' THEN RAISE EXCEPTION 'The subject cannot have line breaks'; END IF;
    IF length(btrim(COALESCE(r.body, ''))) < 20 OR length(r.body) > 5000 THEN RAISE EXCEPTION 'The email text must be 20 to 5000 characters'; END IF;
    IF EXISTS (SELECT 1 FROM tcg_escalations e WHERE e.order_number = r.order_number AND e.id <> r.id AND e.kind = 'escalated'
               AND e.status IN ('approved', 'exported', 'sent', 'unknown') AND COALESCE(e.approved_at, e.escalated_at) > now() - interval '7 days') THEN
        RAISE EXCEPTION 'An email about this order was already approved or sent in the last 7 days';
    END IF;
    SELECT count(*) INTO v_today FROM tcg_escalations
        WHERE approved_at >= (date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York');
    IF v_today >= v_cap THEN RAISE EXCEPTION 'Daily limit reached: % escalation emails already approved today', v_cap; END IF;
    UPDATE tcg_escalations SET status = 'approved', approved_at = now(), error = NULL WHERE id = p_id;
    RETURN jsonb_build_object('id', p_id, 'approved_today', v_today + 1, 'daily_limit', v_cap);
END $f$;

CREATE OR REPLACE FUNCTION public.tcg_withdraw_escalation(p_id uuid) RETURNS void
LANGUAGE plpgsql AS $f$
BEGIN
    UPDATE tcg_escalations SET status = 'draft', approved_at = NULL, exported_at = NULL WHERE id = p_id AND kind = 'escalated' AND status IN ('approved', 'exported');
    IF NOT FOUND THEN RAISE EXCEPTION 'Only an email that Grok has not sent yet can be withdrawn'; END IF;
END $f$;

CREATE OR REPLACE FUNCTION public.tcg_mark_escalation_sent(p_id uuid) RETURNS void
LANGUAGE plpgsql AS $f$
BEGIN
    UPDATE tcg_escalations SET status = 'sent', sent_at = now(), error = NULL WHERE id = p_id AND kind = 'escalated' AND status IN ('exported', 'unknown', 'failed');
    IF NOT FOUND THEN RAISE EXCEPTION 'Only an email that is waiting on Grok, failed, or has no answer can be marked as sent'; END IF;
END $f$;

REVOKE EXECUTE ON FUNCTION public.tcg_approve_escalation(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.tcg_withdraw_escalation(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.tcg_mark_escalation_sent(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tcg_approve_escalation(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tcg_withdraw_escalation(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tcg_mark_escalation_sent(uuid) TO authenticated;

-- a candidate is hidden while an email about it is approved / waiting / sent (7 days), or after "Not needed"
CREATE OR REPLACE VIEW v_tcg_escalate_candidates WITH (security_invoker = true) AS
WITH today AS (
    SELECT ((now() AT TIME ZONE 'America/New_York'))::date AS d
), last_msg AS (
    SELECT DISTINCT ON (m.thread_id) m.thread_id, m.direction, m.body
    FROM tcg_msg_messages m
    ORDER BY m.thread_id, m."position" DESC
), waiting AS (
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
    (o.received_at IS NULL AND o.status <> 'cancelled')
    OR EXISTS (SELECT 1 FROM tcg_held_cards h WHERE h.order_number = w.order_number AND h.status = 'held')
    OR EXISTS (SELECT 1 FROM v_tcg_short_work v WHERE v.order_number = w.order_number AND v.is_open)
    OR EXISTS (SELECT 1 FROM v_tcg_refund_review r WHERE r.order_number = w.order_number))
  AND NOT EXISTS (
    SELECT 1 FROM tcg_escalations e
    WHERE e.order_number = w.order_number
      AND ((e.kind = 'dismissed' AND e.escalated_at::date >= w.our_last_date)
        OR (e.kind = 'escalated' AND e.status IN ('approved', 'exported', 'sent', 'unknown')
            AND COALESCE(e.approved_at, e.escalated_at) > now() - interval '7 days')));

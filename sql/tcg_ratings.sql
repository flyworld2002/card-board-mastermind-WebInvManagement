-- Seller ratings through Grok (applied 2026-11-27).
--
-- TCGplayer shows a "Rate Transaction" button on every order that has not been rated yet, so the
-- order pages Grok saves tell us which sellers still need a rating (tcg_orders.rate_available, set by
-- importer/tcg_orders.py). Any such order can be rated whatever its status (in the mail, received,
-- cancelled, with open problems). A rating is drafted on the Incoming page ("Rate sellers" tab),
-- approved with one click (it is public, posted under Fei's name), written to the Dropbox outbox as
-- rate_<id>.json for Grok to submit, and Grok's rate_result_<id>.json comes back on the next Sync.
--
-- TCGplayer's form: comment (max 400 characters, no HTML or line breaks), stars 1-5, and three optional
-- questions: Product(s) As Described (yes/no), Arrived When Expected (yes/no),
-- Prompt and Courteous Communication (yes/no/no contact).

ALTER TABLE tcg_orders
    ADD COLUMN IF NOT EXISTS rate_available boolean,          -- true: the order page shows Rate Transaction (not rated yet)
    ADD COLUMN IF NOT EXISTS rate_seen_at timestamptz;

CREATE TABLE IF NOT EXISTS tcg_rating_outbox (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_number      text NOT NULL REFERENCES tcg_orders(order_number) ON DELETE CASCADE,
    seller            text,
    stars             integer CHECK (stars BETWEEN 1 AND 5),
    comment           text NOT NULL DEFAULT '',
    as_described      text CHECK (as_described IN ('yes', 'no')),
    arrived_on_time   text CHECK (arrived_on_time IN ('yes', 'no')),
    communication     text CHECK (communication IN ('yes', 'no', 'no_contact')),
    status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'exported', 'sent', 'failed', 'unknown', 'skipped')),
    created_at        timestamptz NOT NULL DEFAULT now(),
    approved_at       timestamptz,
    exported_at       timestamptz,
    sent_at           timestamptz,
    error             text
);
CREATE INDEX IF NOT EXISTS tcg_rating_outbox_order_idx ON tcg_rating_outbox (order_number);
-- an order is rated at most once: only one rating can be in flight or done
CREATE UNIQUE INDEX IF NOT EXISTS tcg_rating_outbox_active_idx ON tcg_rating_outbox (order_number)
    WHERE status IN ('approved', 'exported', 'sent', 'unknown');

ALTER TABLE tcg_rating_outbox ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.tcg_rating_outbox'::regclass AND polname = 'authenticated only') THEN
        CREATE POLICY "authenticated only" ON public.tcg_rating_outbox FOR ALL USING (auth.role() = 'authenticated'::text);
    END IF;
END $$;

CREATE OR REPLACE FUNCTION public.tcg_approve_rating(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql AS $f$
DECLARE r tcg_rating_outbox; v_today integer; v_cap constant integer := 20;
BEGIN
    SELECT * INTO r FROM tcg_rating_outbox WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Rating not found'; END IF;
    IF r.status <> 'draft' THEN RAISE EXCEPTION 'This rating is already % and cannot be approved again', r.status; END IF;
    IF r.stars IS NULL THEN RAISE EXCEPTION 'Pick the stars first'; END IF;
    IF length(btrim(r.comment)) < 3 THEN RAISE EXCEPTION 'Write a short comment'; END IF;
    IF length(r.comment) > 400 THEN RAISE EXCEPTION 'The comment is too long (% characters, TCGplayer allows 400)', length(r.comment); END IF;
    IF r.comment ~ E'[\\r\\n]' THEN RAISE EXCEPTION 'The comment cannot have line breaks'; END IF;
    IF r.comment ~ '[<>]' THEN RAISE EXCEPTION 'The comment cannot have HTML (< or >)'; END IF;
    IF EXISTS (SELECT 1 FROM tcg_rating_outbox WHERE order_number = r.order_number AND id <> r.id AND status IN ('approved', 'exported', 'sent', 'unknown')) THEN
        RAISE EXCEPTION 'This order already has a rating that was sent or is waiting to be sent';
    END IF;
    SELECT count(*) INTO v_today FROM tcg_rating_outbox
        WHERE approved_at >= (date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York');
    IF v_today >= v_cap THEN RAISE EXCEPTION 'Daily limit reached: % ratings already approved today', v_cap; END IF;
    UPDATE tcg_rating_outbox SET status = 'approved', approved_at = now(), error = NULL WHERE id = p_id;
    RETURN jsonb_build_object('id', p_id, 'approved_today', v_today + 1, 'daily_limit', v_cap);
END $f$;

CREATE OR REPLACE FUNCTION public.tcg_withdraw_rating(p_id uuid) RETURNS void
LANGUAGE plpgsql AS $f$
BEGIN
    UPDATE tcg_rating_outbox SET status = 'draft', approved_at = NULL WHERE id = p_id AND status = 'approved';
    IF NOT FOUND THEN RAISE EXCEPTION 'Only a rating that is approved but not yet handed to Grok can be withdrawn'; END IF;
END $f$;

REVOKE EXECUTE ON FUNCTION public.tcg_approve_rating(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.tcg_withdraw_rating(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tcg_approve_rating(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tcg_withdraw_rating(uuid) TO authenticated;

-- Orders that can be rated now (TCGplayer still shows the button and we have not rated or skipped it),
-- with the facts the Incoming page uses to suggest stars, the three answers and a comment.
CREATE OR REPLACE VIEW v_tcg_rate_candidates WITH (security_invoker = true) AS
SELECT o.order_number, o.seller, o.ordered_on, o.status, o.received_at, o.est_delivery, o.carrier_delivered_on, o.total, o.quantity,
       (o.carrier_delivered_on - o.est_delivery) AS late_days,
       COALESCE(h.cond_issue, 0) AS cond_issue, h.cond_names,
       COALESCE(h.open_held, 0) AS open_held,
       COALESCE(s.short_total, 0) AS short_total, COALESCE(s.open_short, 0) AS open_short, s.short_names,
       COALESCE(m.seller_msgs, 0) AS seller_msgs, COALESCE(m.threads, 0) AS threads,
       COALESCE(m.unanswered, false) AS unanswered,
       i.issue_subjects                                   -- subjects of problem threads, e.g. "Condition Issue" (held cards may not exist for them)
FROM tcg_orders o
LEFT JOIN LATERAL (
    SELECT string_agg(DISTINCT t.subject, ', ') FILTER (WHERE t.subject ILIKE ANY (ARRAY['Condition Issue%', 'Item(s) Missing%', 'Received Wrong%', 'Product Missing%'])) AS issue_subjects
    FROM tcg_msg_threads t WHERE t.order_number = o.order_number) i ON true
LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE (c.flags && ARRAY['wrong_condition', 'wrong_item', 'error']::text[]) OR c.keep_reason IN ('damaged', 'lower_condition', 'wrong_card')) AS cond_issue,
           string_agg(DISTINCT c.card_name, ', ') FILTER (WHERE (c.flags && ARRAY['wrong_condition', 'wrong_item', 'error']::text[]) OR c.keep_reason IN ('damaged', 'lower_condition', 'wrong_card')) AS cond_names,
           count(*) FILTER (WHERE c.status = 'held') AS open_held
    FROM tcg_held_cards c WHERE c.order_number = o.order_number) h ON true
LEFT JOIN LATERAL (
    SELECT count(*) AS short_total, count(*) FILTER (WHERE w.is_open) AS open_short, string_agg(w.card_name, ', ') AS short_names
    FROM v_tcg_short_work w WHERE w.order_number = o.order_number) s ON true
LEFT JOIN LATERAL (
    SELECT count(DISTINCT t.thread_id) AS threads,
           count(*) FILTER (WHERE mm.direction = 'in' AND mm.sender NOT ILIKE 'team %') AS seller_msgs,
           bool_or(lm.direction = 'out' AND t.last_date >= current_date - 90) AS unanswered
    FROM tcg_msg_threads t
    LEFT JOIN tcg_msg_messages mm ON mm.thread_id = t.thread_id
    LEFT JOIN LATERAL (SELECT x.direction FROM tcg_msg_messages x WHERE x.thread_id = t.thread_id ORDER BY x.position DESC LIMIT 1) lm ON true
    WHERE t.order_number = o.order_number) m ON true
WHERE o.rate_available IS TRUE
  AND NOT EXISTS (SELECT 1 FROM tcg_rating_outbox r WHERE r.order_number = o.order_number AND r.status IN ('approved', 'exported', 'sent', 'unknown', 'skipped'));

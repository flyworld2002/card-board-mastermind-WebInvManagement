-- TCGplayer seller messages, Phase 3: sending through Grok (applied 2026-11-26).
-- Plan: Card-Board-MasterMind/docs/plans/tcg-seller-messages.md
--
-- A message is drafted on the Incoming page (templates build the text), approved with one click, and
-- written to the Dropbox outbox for Grok by importer/tcg_outbox.py. Grok sends it on TCGplayer and
-- drops msg_result_<id>.json back; the next Sync records sent / failed. No result after 24 h =>
-- 'unknown' (never re-sent automatically).
--
--   status: draft -> approved -> exported -> sent | failed | unknown
--   mode:   new (a new thread, subject from TCGplayer's 8) | reply (inside thread_id, 11 subjects)

CREATE TABLE IF NOT EXISTS tcg_msg_outbox (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_number     text NOT NULL REFERENCES tcg_orders(order_number) ON DELETE CASCADE,
    seller           text,
    mode             text NOT NULL CHECK (mode IN ('new', 'reply')),
    thread_id        bigint,                       -- required for 'reply'
    subject          text NOT NULL,
    response_needed  boolean NOT NULL DEFAULT true,
    body             text NOT NULL,
    include_link     boolean NOT NULL DEFAULT false,
    kind             text,                         -- template used: where_is_order, missing, condition, wrong_item, cancel, followup, plain
    status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'exported', 'sent', 'failed', 'unknown')),
    created_at       timestamptz NOT NULL DEFAULT now(),
    approved_at      timestamptz,
    exported_at      timestamptz,
    sent_at          timestamptz,
    error            text
);
CREATE INDEX IF NOT EXISTS tcg_msg_outbox_order_idx ON tcg_msg_outbox (order_number);
CREATE INDEX IF NOT EXISTS tcg_msg_outbox_status_idx ON tcg_msg_outbox (status);

ALTER TABLE tcg_msg_outbox ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.tcg_msg_outbox'::regclass AND polname = 'authenticated only') THEN
        CREATE POLICY "authenticated only" ON public.tcg_msg_outbox FOR ALL USING (auth.role() = 'authenticated'::text);
    END IF;
END $$;

-- Approve a draft: checks it, enforces a daily cap, and marks it approved (the desktop then writes the file).
CREATE OR REPLACE FUNCTION public.tcg_approve_message(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql AS $f$
DECLARE m tcg_msg_outbox; v_today integer; v_cap constant integer := 20;
        v_all text[] := ARRAY['Cancellation Request', 'Address or Shipping Change', 'Where Is My Order', 'Condition Issue',
                              'Item(s) Missing From Order', 'Received Wrong Item', 'Received Wrong Package', 'Other',
                              'General Inquiry', 'Product Missing/Damaged', 'Order Refund'];
BEGIN
    SELECT * INTO m FROM tcg_msg_outbox WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Message not found'; END IF;
    IF m.status <> 'draft' THEN RAISE EXCEPTION 'This message is already % and cannot be approved again', m.status; END IF;
    IF length(btrim(m.body)) < 5 THEN RAISE EXCEPTION 'The message is empty'; END IF;
    IF length(m.body) > 4000 THEN RAISE EXCEPTION 'The message is too long (% characters, limit 4000)', length(m.body); END IF;
    IF NOT (m.subject = ANY (v_all)) THEN RAISE EXCEPTION 'Unknown subject "%"', m.subject; END IF;
    IF m.mode = 'new' AND NOT (m.subject = ANY (v_all[1:8])) THEN
        RAISE EXCEPTION 'A new thread can only use these subjects: %', array_to_string(v_all[1:8], ', ');
    END IF;
    IF m.mode = 'reply' AND m.thread_id IS NULL THEN RAISE EXCEPTION 'A reply needs a thread'; END IF;
    IF m.mode = 'reply' AND NOT EXISTS (SELECT 1 FROM tcg_msg_threads WHERE thread_id = m.thread_id AND order_number = m.order_number) THEN
        RAISE EXCEPTION 'That thread does not belong to this order';
    END IF;
    SELECT count(*) INTO v_today FROM tcg_msg_outbox
        WHERE approved_at >= (date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York');
    IF v_today >= v_cap THEN RAISE EXCEPTION 'Daily limit reached: % messages already approved today', v_cap; END IF;
    UPDATE tcg_msg_outbox SET status = 'approved', approved_at = now(), error = NULL WHERE id = p_id;
    RETURN jsonb_build_object('id', p_id, 'approved_today', v_today + 1, 'daily_limit', v_cap);
END $f$;

-- Take an approved message back to draft while Grok has not sent it yet (approved, or written to the outbox but no result back).
-- The desktop's next export removes the file from the outbox.
CREATE OR REPLACE FUNCTION public.tcg_withdraw_message(p_id uuid) RETURNS void
LANGUAGE plpgsql AS $f$
BEGIN
    UPDATE tcg_msg_outbox SET status = 'draft', approved_at = NULL, exported_at = NULL WHERE id = p_id AND status IN ('approved', 'exported');
    IF NOT FOUND THEN RAISE EXCEPTION 'Only a message that Grok has not sent yet can be withdrawn'; END IF;
END $f$;

REVOKE EXECUTE ON FUNCTION public.tcg_approve_message(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.tcg_withdraw_message(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tcg_approve_message(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tcg_withdraw_message(uuid) TO authenticated;

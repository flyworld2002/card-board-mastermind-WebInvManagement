-- TCGplayer seller messages, Phase 1: inbound messages + Follow-ups (applied 2026-11-26).
--
-- Grok saves the TCGplayer message-center list and thread pages into the Dropbox inbox;
-- importer/tcg_messages.py reads them (tracked orders only) into these tables. Plan:
-- Card-Board-MasterMind/docs/plans/tcg-seller-messages.md
--
--   tcg_msg_threads   one row per TCGplayer message thread (id = TCGplayer's thread id)
--   tcg_msg_messages  the messages inside a thread; direction 'in' = from the seller, 'out' = from us.
--                     seen_at IS NULL on an 'in' message = new, not looked at in our app yet
--                     (opening the order on the Incoming page marks it seen)
--   tcg_followups     manual "Follow up" / "Resolved" switch per order
--   v_tcg_followups   orders that need following up, with the reasons

CREATE TABLE IF NOT EXISTS tcg_msg_threads (
    thread_id            bigint PRIMARY KEY,
    order_number         text NOT NULL REFERENCES tcg_orders(order_number) ON DELETE CASCADE,
    seller               text,
    subject              text,
    message_count        integer,                 -- the "(N)" TCGplayer shows on the list
    last_date            date,
    unread_on_tcgplayer  boolean NOT NULL DEFAULT false,
    first_seen_at        timestamptz NOT NULL DEFAULT now(),
    last_synced_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tcg_msg_threads_order_idx ON tcg_msg_threads (order_number);

CREATE TABLE IF NOT EXISTS tcg_msg_messages (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id     bigint NOT NULL REFERENCES tcg_msg_threads(thread_id) ON DELETE CASCADE,
    order_number  text NOT NULL,
    position      integer NOT NULL,              -- oldest first within the thread
    sender        text,
    sent_on       date,                          -- TCGplayer shows a date only, no time
    body          text NOT NULL,
    direction     text NOT NULL CHECK (direction IN ('in', 'out')),
    msg_hash      text NOT NULL UNIQUE,
    seen_at       timestamptz,
    first_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tcg_msg_messages_thread_idx ON tcg_msg_messages (thread_id, position);
CREATE INDEX IF NOT EXISTS tcg_msg_messages_order_idx ON tcg_msg_messages (order_number);

CREATE TABLE IF NOT EXISTS tcg_followups (
    order_number  text PRIMARY KEY REFERENCES tcg_orders(order_number) ON DELETE CASCADE,
    manual        boolean NOT NULL DEFAULT false,   -- "Follow up" switched on by hand
    resolved_at   timestamptz,                      -- "Resolved": off until new activity
    note          text,
    updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tcg_msg_threads  ENABLE ROW LEVEL SECURITY;
ALTER TABLE tcg_msg_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE tcg_followups    ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['tcg_msg_threads', 'tcg_msg_messages', 'tcg_followups'] LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = ('public.' || t)::regclass AND polname = 'authenticated only') THEN
            EXECUTE format('CREATE POLICY "authenticated only" ON public.%I FOR ALL USING (auth.role() = ''authenticated''::text)', t);
        END IF;
    END LOOP;
END $$;

-- Orders to follow up, with why. An order is listed when any reason applies:
--   on_order        not received, not cancelled
--   held            a held card is still held
--   short           cards marked Short that no refund has been assigned to yet
--   refund          a TCGplayer refund not fully assigned (v_tcg_refund_review)
--   active_thread   a message thread with activity in the last 30 days
--   awaiting_reply  our message was the last one in a thread (last 90 days): waiting on the seller
--   manual          "Follow up" switched on by hand
-- "Resolved" hides the order until a thread shows activity after it was resolved.
CREATE OR REPLACE VIEW v_tcg_followups WITH (security_invoker = true) AS
WITH today AS (SELECT (now() AT TIME ZONE 'America/New_York')::date AS d),
last_msg AS (
    SELECT DISTINCT ON (m.thread_id) m.thread_id, m.direction
    FROM tcg_msg_messages m ORDER BY m.thread_id, m.position DESC
),
reasons AS (
    SELECT o.order_number, 'on_order'::text AS reason FROM tcg_orders o
        WHERE o.received_at IS NULL AND o.status <> 'cancelled'
    UNION ALL SELECT DISTINCT h.order_number, 'held' FROM tcg_held_cards h WHERE h.status = 'held'
    UNION ALL SELECT DISTINCT sl.order_number, 'short' FROM tcg_staged_lines sl
        WHERE sl.short_qty > 0 AND NOT EXISTS (SELECT 1 FROM tcg_refund_allocations a WHERE a.line_id = sl.line_id AND a.kind = 'short')
    UNION ALL SELECT DISTINCT r.order_number, 'refund' FROM v_tcg_refund_review r
    UNION ALL SELECT DISTINCT t.order_number, 'active_thread' FROM tcg_msg_threads t, today
        WHERE t.last_date >= today.d - 30
    UNION ALL SELECT DISTINCT t.order_number, 'awaiting_reply' FROM tcg_msg_threads t
        JOIN last_msg lm ON lm.thread_id = t.thread_id, today
        WHERE lm.direction = 'out' AND t.last_date >= today.d - 90
    UNION ALL SELECT f.order_number, 'manual' FROM tcg_followups f WHERE f.manual AND f.resolved_at IS NULL
)
SELECT r.order_number, array_agg(DISTINCT r.reason ORDER BY r.reason) AS reasons
FROM reasons r
JOIN tcg_orders o ON o.order_number = r.order_number
LEFT JOIN tcg_followups f ON f.order_number = r.order_number
WHERE o.status <> 'cancelled' OR r.reason IN ('held', 'short', 'refund', 'manual')
GROUP BY r.order_number, f.resolved_at
HAVING f.resolved_at IS NULL
    OR EXISTS (SELECT 1 FROM tcg_msg_threads t WHERE t.order_number = r.order_number AND t.last_date > f.resolved_at::date);

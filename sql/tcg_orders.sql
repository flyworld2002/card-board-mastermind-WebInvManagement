-- TCGplayer purchase-order tracker (applied 2026-11-26).
--
-- Fed by the order-list pages Grok saves into Dropbox (tcg_orders/inbox) and read by
-- importer/tcg_orders.py in the Card-Board-MasterMind repo (main.py --tcg-orders-process).
-- TCGplayer never shows "Delivered", so "received" is our own mark: an order is received
-- automatically when its order number already exists in purchases/staging, or manually.
--
-- status (from the page's own label):
--   not_shipped          "Shipping Not Confirmed"
--   shipped_no_tracking  "Shipped Without Tracking"
--   shipped_tracking     "Shipped With Tracking:" (tracking number + link on the page)
--   cancelled            "Canceled"
-- Refunds are separate notes on the page ("A partial refund was issued on <date> for the
-- amount of $X"), one row each in tcg_order_refunds.

CREATE TABLE IF NOT EXISTS tcg_orders (
    order_number     text PRIMARY KEY,
    ordered_on       date NOT NULL,
    channel          text,
    seller           text,
    raw_status       text,
    status           text NOT NULL CHECK (status IN ('not_shipped', 'shipped_no_tracking', 'shipped_tracking', 'cancelled')),
    tracking_number  text,
    tracking_url     text,
    carrier          text,
    ship_method      text,
    est_delivery     date,
    quantity         integer,
    subtotal         numeric,
    shipping         numeric,
    tax              numeric,
    total            numeric,
    refund_total     numeric NOT NULL DEFAULT 0,
    received_at      timestamptz,
    received_by      text,                  -- 'auto_system' (order already in purchases/staging) | 'manual'
    first_seen_at    timestamptz NOT NULL DEFAULT now(),
    last_seen_at     timestamptz NOT NULL DEFAULT now(),
    last_changed_at  timestamptz NOT NULL DEFAULT now(),
    source_file      text,
    notes            text
);
CREATE INDEX IF NOT EXISTS tcg_orders_open_idx ON tcg_orders (status) WHERE received_at IS NULL;

CREATE TABLE IF NOT EXISTS tcg_order_lines (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_number  text NOT NULL REFERENCES tcg_orders(order_number) ON DELETE CASCADE,
    line_no       integer NOT NULL,
    product_id    bigint,                   -- TCGplayer product id (from the thumbnail address)
    product_slug  text,                     -- e.g. /pokemon/me-30th-celebration/chandelure-137-128
    card_name     text,
    card_number   text,
    set_label     text,                     -- TCGplayer's set label, e.g. "ME: 30th Celebration"
    rarity        text,
    condition_raw text,                     -- e.g. "Near Mint Holofoil"
    printing      text,                     -- Normal | Holofoil | Reverse Holofoil
    foil_type     text,
    foil_pattern  text,
    texture       text,
    unit_price    numeric,
    quantity      integer NOT NULL DEFAULT 1,
    card_id       uuid,
    variant_id    uuid,
    match_status  text NOT NULL DEFAULT 'unmatched' CHECK (match_status IN ('matched', 'card_only', 'unmatched')),
    match_source  text,                     -- product_map | set_number | set_name
    UNIQUE (order_number, line_no)
);
CREATE INDEX IF NOT EXISTS tcg_order_lines_variant_idx ON tcg_order_lines (variant_id);
CREATE INDEX IF NOT EXISTS tcg_order_lines_product_idx ON tcg_order_lines (product_id);

CREATE TABLE IF NOT EXISTS tcg_order_refunds (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_number  text NOT NULL REFERENCES tcg_orders(order_number) ON DELETE CASCADE,
    refund_id     bigint NOT NULL,          -- TCGplayer's refundId from the (Details) link
    issued_on     date,
    amount        numeric NOT NULL,
    kind          text CHECK (kind IN ('full', 'partial')),
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (order_number, refund_id)
);

-- Learned mapping: one TCGplayer product (+ printing) -> one exact variant of ours.
CREATE TABLE IF NOT EXISTS tcg_products (
    product_id  bigint NOT NULL,
    printing    text NOT NULL,
    variant_id  uuid NOT NULL,
    card_id     uuid,
    name        text,
    set_label   text,
    slug        text,
    source      text NOT NULL DEFAULT 'order_match',   -- order_match | manual
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (product_id, printing)
);

-- One row per file read from the inbox (so a file is read once) and per Grok note file.
CREATE TABLE IF NOT EXISTS tcg_order_files (
    file_name    text PRIMARY KEY,
    sha256       text NOT NULL,
    kind         text NOT NULL,             -- pages | grab_ok | run_failed
    grabbed_on   date,
    window_days  text,
    orders_seen  integer,
    orders_saved integer,
    note         text,
    parsed_at    timestamptz NOT NULL DEFAULT now()
);

-- Same access rule as the other settings tables: signed-in users only.
ALTER TABLE tcg_orders          ENABLE ROW LEVEL SECURITY;
ALTER TABLE tcg_order_lines     ENABLE ROW LEVEL SECURITY;
ALTER TABLE tcg_order_refunds   ENABLE ROW LEVEL SECURITY;
ALTER TABLE tcg_products        ENABLE ROW LEVEL SECURITY;
ALTER TABLE tcg_order_files     ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['tcg_orders', 'tcg_order_lines', 'tcg_order_refunds', 'tcg_products', 'tcg_order_files'] LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = ('public.' || t)::regclass AND polname = 'authenticated only') THEN
            EXECUTE format('CREATE POLICY "authenticated only" ON public.%I FOR ALL USING (auth.role() = ''authenticated''::text)', t);
        END IF;
    END LOOP;
END $$;

-- Weekly market-price refresh: settings, schedule, run history and held
-- price changes. Read by the scheduled job on the desktop
-- (Card-Board-MasterMind/importer/price_refresh_job.py) and by the web app's
-- Price Refresh page (price-refresh.js).
--
-- Days of the week are ISO numbers: 1 = Monday ... 7 = Sunday.
-- Times are the desktop's local time.

-- ── Settings (always exactly one row, id = 1) ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.price_refresh_settings (
    id                 smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    enabled            boolean  NOT NULL DEFAULT true,
    refresh_start_time time     NOT NULL DEFAULT '04:00',
    -- after_refresh: push each listing as soon as its sets are refreshed.
    -- fixed_time:    wait until push_time the same day.
    push_timing        text     NOT NULL DEFAULT 'after_refresh'
                       CHECK (push_timing IN ('after_refresh', 'fixed_time')),
    push_time          time,
    -- dry_run: work out what would be pushed and report it, send nothing to eBay.
    push_mode          text     NOT NULL DEFAULT 'dry_run'
                       CHECK (push_mode IN ('dry_run', 'live')),
    -- When an approved held price goes to eBay.
    approval_push_mode text     NOT NULL DEFAULT 'next_run'
                       CHECK (approval_push_mode IN ('next_run', 'immediate')),
    -- Guard: hold a price when it moves more than swing_pct percent AND more
    -- than swing_min_dollars; hold when TCGplayer shows fewer than
    -- min_listings listings; hold the whole set when more than
    -- set_hold_fraction of its priced cards trip the guard.
    swing_pct          numeric  NOT NULL DEFAULT 50,
    swing_min_dollars  numeric  NOT NULL DEFAULT 2,
    min_listings       integer  NOT NULL DEFAULT 15,
    set_hold_fraction  numeric  NOT NULL DEFAULT 0.25,
    api_tries_older    integer  NOT NULL DEFAULT 6,
    api_tries_newest   integer  NOT NULL DEFAULT 2,
    updated_at         timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.price_refresh_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── Per-set options ─────────────────────────────────────────────────────────
-- A set with no row here counts as enabled and not "newest".
CREATE TABLE IF NOT EXISTS public.price_refresh_sets (
    set_id         uuid PRIMARY KEY REFERENCES public.card_sets(id) ON DELETE CASCADE,
    enabled        boolean NOT NULL DEFAULT true,
    -- Newest sets get few API tries (the API has no prices for them yet)
    -- and go straight to TCGplayer.
    is_newest      boolean NOT NULL DEFAULT false,
    tcgplayer_slug text,
    updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ── Which set runs on which day (a set may sit on more than one day) ────────
CREATE TABLE IF NOT EXISTS public.price_refresh_schedule (
    set_id      uuid     NOT NULL REFERENCES public.card_sets(id) ON DELETE CASCADE,
    day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
    sort_order  integer  NOT NULL DEFAULT 0,
    PRIMARY KEY (set_id, day_of_week)
);

-- ── Run history ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.price_refresh_runs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_date        date NOT NULL,
    trigger         text NOT NULL DEFAULT 'scheduled',
    status          text NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running', 'awaiting_push', 'done', 'failed')),
    push_mode       text NOT NULL DEFAULT 'dry_run',
    started_at      timestamptz NOT NULL DEFAULT now(),
    finished_at     timestamptz,
    message_sent_at timestamptz,
    summary         jsonb,
    error           text
);
CREATE INDEX IF NOT EXISTS idx_price_refresh_runs_date ON public.price_refresh_runs (run_date DESC);

CREATE TABLE IF NOT EXISTS public.price_refresh_run_sets (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id            uuid NOT NULL REFERENCES public.price_refresh_runs(id) ON DELETE CASCADE,
    set_id            uuid NOT NULL REFERENCES public.card_sets(id) ON DELETE CASCADE,
    set_name          text NOT NULL,
    status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'api', 'fallback', 'guard', 'done', 'failed')),
    variants_in_scope integer,
    api_tries         integer NOT NULL DEFAULT 0,
    api_priced        integer NOT NULL DEFAULT 0,
    fallback_priced   integer NOT NULL DEFAULT 0,
    unchanged         integer NOT NULL DEFAULT 0,
    applied           integer NOT NULL DEFAULT 0,
    held              integer NOT NULL DEFAULT 0,
    set_held          boolean NOT NULL DEFAULT false,
    -- [{variant_id, card, reason}] — cards the run could not price.
    needs_manual      jsonb   NOT NULL DEFAULT '[]'::jsonb,
    error             text,
    started_at        timestamptz,
    finished_at       timestamptz
);
CREATE INDEX IF NOT EXISTS idx_price_refresh_run_sets_run ON public.price_refresh_run_sets (run_id);

-- ── Every price change a run proposed ───────────────────────────────────────
-- applied    written to market_prices by the run
-- held       tripped the guard; NOT written, waiting for approval
-- approved   approved on the Price Refresh page and written to market_prices
-- rejected   turned down; old price kept
-- superseded a later run proposed a newer price before this one was decided
CREATE TABLE IF NOT EXISTS public.price_refresh_changes (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id        uuid NOT NULL REFERENCES public.price_refresh_runs(id) ON DELETE CASCADE,
    run_set_id    uuid REFERENCES public.price_refresh_run_sets(id) ON DELETE CASCADE,
    set_id        uuid NOT NULL REFERENCES public.card_sets(id) ON DELETE CASCADE,
    variant_id    uuid NOT NULL REFERENCES public.card_variants(id) ON DELETE CASCADE,
    condition     text NOT NULL DEFAULT 'Near Mint',
    old_price     numeric,
    new_price     numeric NOT NULL,
    source        text NOT NULL,
    listing_count integer,
    status        text NOT NULL
                  CHECK (status IN ('applied', 'held', 'approved', 'rejected', 'superseded')),
    hold_reason   text,
    decided_at    timestamptz,
    applied_at    timestamptz,
    pushed_at     timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_price_refresh_changes_run     ON public.price_refresh_changes (run_id);
CREATE INDEX IF NOT EXISTS idx_price_refresh_changes_status  ON public.price_refresh_changes (status);
CREATE INDEX IF NOT EXISTS idx_price_refresh_changes_variant ON public.price_refresh_changes (variant_id);

-- ── eBay pushes a run made (or would have made, in dry-run) ─────────────────
CREATE TABLE IF NOT EXISTS public.price_refresh_pushes (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id     uuid NOT NULL REFERENCES public.price_refresh_runs(id) ON DELETE CASCADE,
    listing_id text NOT NULL,
    account    text,
    title      text,
    dry_run    boolean NOT NULL,
    status     text NOT NULL CHECK (status IN ('ok', 'failed', 'skipped')),
    resolved   integer,
    changed    integer,
    pushed     integer,
    warnings   jsonb,
    error      text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_price_refresh_pushes_run ON public.price_refresh_pushes (run_id);

-- ── Row level security: same rule as every other table ──────────────────────
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['price_refresh_settings', 'price_refresh_sets',
                             'price_refresh_schedule', 'price_refresh_runs',
                             'price_refresh_run_sets', 'price_refresh_changes',
                             'price_refresh_pushes']
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS "authenticated only" ON public.%I', t);
        EXECUTE format('CREATE POLICY "authenticated only" ON public.%I FOR ALL '
                       'USING (auth.role() = ''authenticated''::text)', t);
    END LOOP;
END $$;

-- ── Sets the Schedule tab shows: every set with live eBay cards ─────────────
CREATE OR REPLACE VIEW public.v_price_refresh_sets
WITH (security_invoker = true) AS
SELECT
    s.id                                  AS set_id,
    s.name,
    s.set_code,
    s.series,
    l.listed_variants,
    l.listings,
    COALESCE(c.enabled, true)             AS enabled,
    COALESCE(c.is_newest, false)          AS is_newest,
    c.tcgplayer_slug,
    COALESCE(d.days, '{}'::smallint[])    AS days
FROM public.card_sets s
JOIN (
    SELECT cm.set_id,
           count(DISTINCT pl.variant_id) AS listed_variants,
           count(DISTINCT pl.listing_id) AS listings
    FROM public.platform_listings pl
    JOIN public.card_variants cv ON cv.id = pl.variant_id
    JOIN public.card_master   cm ON cm.id = cv.card_id
    WHERE pl.platform = 'ebay' AND pl.status IN ('active', 'out_of_stock')
    GROUP BY cm.set_id
) l ON l.set_id = s.id
LEFT JOIN public.price_refresh_sets c ON c.set_id = s.id
LEFT JOIN (
    SELECT set_id, array_agg(day_of_week ORDER BY day_of_week) AS days
    FROM public.price_refresh_schedule
    GROUP BY set_id
) d ON d.set_id = s.id;

-- ── Approve held prices ─────────────────────────────────────────────────────
-- Writes each held price to market_prices (keeping the old one as
-- "previous", same as db/connection.py upsert_market_price) and marks the
-- change approved. The eBay push is done by the desktop job, on its next
-- run or its next check, depending on approval_push_mode.
CREATE OR REPLACE FUNCTION public.approve_price_refresh_changes(p_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_count integer;
BEGIN
    WITH picked AS (
        SELECT id, variant_id, condition, new_price, source, created_at
        FROM price_refresh_changes
        WHERE id = ANY(p_ids) AND status = 'held'
        FOR UPDATE
    ), written AS (
        INSERT INTO market_prices (variant_id, condition, market_price, source, updated_at)
        SELECT DISTINCT ON (variant_id, condition)
               variant_id, condition, new_price, source, now()
        FROM picked
        ORDER BY variant_id, condition, created_at DESC
        ON CONFLICT (variant_id, condition)
        DO UPDATE SET
            previous_market_price = CASE
                WHEN market_prices.market_price IS DISTINCT FROM EXCLUDED.market_price
                THEN market_prices.market_price
                ELSE market_prices.previous_market_price END,
            previous_updated_at = CASE
                WHEN market_prices.market_price IS DISTINCT FROM EXCLUDED.market_price
                THEN market_prices.updated_at
                ELSE market_prices.previous_updated_at END,
            market_price = EXCLUDED.market_price,
            source       = EXCLUDED.source,
            updated_at   = now()
        RETURNING variant_id
    )
    UPDATE price_refresh_changes c
    SET status = 'approved', decided_at = now(), applied_at = now()
    FROM picked p
    WHERE c.id = p.id;

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

-- ── Starting schedule (agreed 2026-11-15) ───────────────────────────────────
INSERT INTO public.price_refresh_schedule (set_id, day_of_week, sort_order)
SELECT s.id, v.dow, v.ord
FROM (VALUES
    ('me2', 1, 1), ('sv8pt5', 1, 2), ('sv2', 1, 3),
    ('me2pt5', 2, 1), ('svp', 2, 2), ('sv6pt5', 2, 3), ('sve', 2, 4), ('mee', 2, 5), ('MEP', 2, 6),
    ('me3', 3, 1), ('sv3', 3, 2), ('me1', 3, 3), ('sv7', 3, 4),
    ('me4', 4, 1), ('sv10', 4, 2), ('sv4pt5', 4, 3), ('sv9', 4, 4),
    ('me6', 5, 1), ('sv1', 5, 2), ('sv5', 5, 3), ('sv3pt5', 5, 4),
    ('me55', 6, 1), ('me55c', 6, 2), ('sv4', 6, 3), ('sv8', 6, 4),
    ('me5', 7, 1), ('zsv10pt5', 7, 2), ('rsv10pt5', 7, 3), ('sv6', 7, 4)
) AS v(code, dow, ord)
JOIN public.card_sets s ON s.set_code = v.code
ON CONFLICT (set_id, day_of_week) DO NOTHING;

INSERT INTO public.price_refresh_sets (set_id, is_newest, tcgplayer_slug)
SELECT s.id, true, v.slug
FROM (VALUES
    ('me2', NULL), ('me2pt5', NULL), ('me3', NULL), ('me4', NULL),
    ('me5', 'me05-pitch-black'), ('me55', 'me-30th-celebration'),
    ('me55c', 'me-30th-celebration-classic-collection'), ('me6', 'me06-delta-reign')
) AS v(code, slug)
JOIN public.card_sets s ON s.set_code = v.code
ON CONFLICT (set_id) DO NOTHING;

INSERT INTO public.price_refresh_sets (set_id, is_newest, tcgplayer_slug)
SELECT s.id, false, 'sv-scarlet-and-violet-promo-cards'
FROM public.card_sets s WHERE s.set_code = 'svp'
ON CONFLICT (set_id) DO NOTHING;

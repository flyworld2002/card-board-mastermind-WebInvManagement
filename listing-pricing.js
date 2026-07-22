// listing-pricing.js
// Listing pricing page — docs/plans/listing-pricing-system.md (Card-Board-MasterMind repo).
// Loads ONE eBay listing (platform + listing_id) at a time, groups its
// platform_listings rows by derived label (rarity [+ foil type]), shows
// the pricing_profile assigned to each label via a listing_pricing_rules
// row, lets you (re)assign a profile, pin an individual card's price, and
// push resolved prices/quantities to eBay via the FastAPI /push-prices
// endpoint (same picking_api.py service as the Picking tab).
//
// Resolution ALWAYS comes from the resolve_listing_prices() Postgres RPC —
// never recomputed here — so this page and the Python push job can never
// disagree.

import { supabase, formatPrice } from './shared.js';

// picking_api.py config — mirrors picking.js's constants (same service,
// same shared secret). Keep these two in sync with picking.js if the
// desktop's LAN IP or token ever changes.
const PICKING_API_URL = 'http://192.168.1.186:8765';
const PICKING_API_TOKEN = 'I1knbOJAve_UZJQHAFZANds9-HalgCxcRJw1GXDg404';

// shared.js doesn't export an escapeHtml — inventory.js/configuration.js
// each define their own local copy; do the same here rather than adding a
// cross-cutting export that wasn't asked for.
function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

let state = {
    platform: 'ebay',
    listingId: '',
    accountNum: 1,
    loading: false,
    error: null,
    loaded: false,
    resolvedRows: [],      // resolve_listing_prices() output, keyed by row_id
    listingRows: {},       // row_id -> platform_listings row (external_id, manual_price, pushed_price, pushed_qty, pushed_at)
    variantMeta: {},       // variant_id -> {foil_type, card_id}
    cardMeta: {},          // card_id -> {rarity}
    profiles: [],
    rules: [],             // listing_pricing_rules for this listing
    pushBusy: false,
    pushResult: null,
};

export async function renderListingPricing(container) {
    container.innerHTML = shellHTML();
    wireShell(container);
    await ensureProfilesLoaded(container);
}

function shellHTML() {
    return `
        <h2 style="margin:0 0 4px;">Listing pricing</h2>
        <p style="color:var(--text-secondary); font-size:13px; margin:0 0 16px;">
            docs/plans/listing-pricing-system.md — resolved prices always
            come from the resolve_listing_prices() database function,
            never computed here.
        </p>
        <div class="filters-bar">
            <label style="font-size:13px;">Platform
                <select id="lp-platform" style="margin-left:6px;">
                    <option value="ebay" selected>ebay</option>
                </select>
            </label>
            <label style="font-size:13px;">eBay Item # (listing_id)
                <input type="text" id="lp-listing-id" placeholder="e.g. 335662210469"
                       value="${escapeHtml(state.listingId)}" style="margin-left:6px; width:160px;" />
            </label>
            <label style="font-size:13px;">Account #
                <input type="number" id="lp-account" value="${state.accountNum}" min="1"
                       style="margin-left:6px; width:60px;" />
            </label>
            <button class="btn btn-primary" id="lp-load-btn">Load</button>
        </div>
        <div id="lp-body"></div>
    `;
}

function wireShell(container) {
    container.querySelector('#lp-load-btn').addEventListener('click', async () => {
        state.listingId = container.querySelector('#lp-listing-id').value.trim();
        state.accountNum = parseInt(container.querySelector('#lp-account').value, 10) || 1;
        state.platform = container.querySelector('#lp-platform').value;
        if (!state.listingId) {
            window.alert('Enter an eBay Item # first.');
            return;
        }
        await loadListing(container);
    });
    container.querySelector('#lp-listing-id').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') container.querySelector('#lp-load-btn').click();
    });
}

async function ensureProfilesLoaded(container) {
    const { data, error } = await supabase.from('pricing_profiles').select('*').order('name');
    if (!error) state.profiles = data || [];
}

// ----------------------------------------------------------------
// Loading one listing
// ----------------------------------------------------------------

async function loadListing(container) {
    const body = container.querySelector('#lp-body');
    body.innerHTML = '<p>Loading listing...</p>';
    state.loading = true;
    state.error = null;
    state.pushResult = null;

    try {
        const { data: resolved, error: rErr } = await supabase.rpc('resolve_listing_prices', {
            p_platform: state.platform, p_listing_id: state.listingId,
        });
        if (rErr) throw rErr;

        if (!resolved || resolved.length === 0) {
            state.loading = false;
            state.loaded = true;
            state.resolvedRows = [];
            body.innerHTML = `<p style="color:var(--text-secondary);">No platform_listings rows found for ${escapeHtml(state.platform)} listing ${escapeHtml(state.listingId)}.</p>`;
            return;
        }

        const rowIds = resolved.map(r => r.row_id);
        const variantIds = [...new Set(resolved.map(r => r.variant_id).filter(Boolean))];

        const [{ data: listingRows, error: lErr }, { data: variants, error: vErr }, { data: rules, error: ruErr }] = await Promise.all([
            supabase.from('platform_listings').select('id, external_id, manual_price, pushed_price, pushed_qty, pushed_at, sync_enabled, status').in('id', rowIds),
            supabase.from('card_variants').select('id, foil_type, card_id').in('id', variantIds),
            supabase.from('listing_pricing_rules').select('*').eq('platform', state.platform).eq('listing_id', state.listingId),
        ]);
        if (lErr) throw lErr;
        if (vErr) throw vErr;
        if (ruErr) throw ruErr;

        const cardIds = [...new Set((variants || []).map(v => v.card_id).filter(Boolean))];
        const { data: cards, error: cErr } = await supabase.from('card_master').select('id, rarity').in('id', cardIds);
        if (cErr) throw cErr;

        state.resolvedRows = resolved;
        state.listingRows = Object.fromEntries((listingRows || []).map(r => [r.id, r]));
        state.variantMeta = Object.fromEntries((variants || []).map(v => [v.id, v]));
        state.cardMeta = Object.fromEntries((cards || []).map(c => [c.id, c]));
        state.rules = rules || [];
        state.loading = false;
        state.loaded = true;

        renderBody(container);
    } catch (err) {
        console.error(err);
        state.loading = false;
        body.innerHTML = `<p style="color:var(--danger)">Failed to load listing: ${escapeHtml(err.message)}</p>`;
    }
}

// ----------------------------------------------------------------
// Grouping by derived label
// ----------------------------------------------------------------

function groupByLabel() {
    const groups = {};
    for (const r of state.resolvedRows) {
        const variant = state.variantMeta[r.variant_id] || {};
        const card = state.cardMeta[variant.card_id] || {};
        const key = r.derived_label;
        if (!groups[key]) {
            groups[key] = { label: key, rarity: card.rarity || null, foilType: variant.foil_type || null, rows: [] };
        }
        groups[key].rows.push(r);
    }
    return Object.values(groups).sort((a, b) => a.label.localeCompare(b.label));
}

// The "plain" rule for a label: no set/card scoping — this is what the
// profile picker manages. Set-/card-scoped rules are left to the Advanced
// flow and just show up under "other rules for this listing".
function plainRuleFor(rarity, foilType) {
    return state.rules.find(r =>
        r.match_rarity === rarity && r.match_foil_type === foilType
        && r.match_set_id == null && r.match_card_id == null
    ) || null;
}

// ----------------------------------------------------------------
// Render
// ----------------------------------------------------------------

function renderBody(container) {
    const body = container.querySelector('#lp-body');
    const groups = groupByLabel();
    const pending = state.resolvedRows.filter(r => needsPush(r));
    const pendingGated = pending.filter(r => isGatedIn(r));
    const pendingNotGated = pending.length - pendingGated.length;

    body.innerHTML = `
        <div style="display:flex; align-items:center; gap:16px; margin:16px 0;">
            <div style="font-size:13px; color:var(--text-secondary);">
                ${state.resolvedRows.length} line(s) across ${groups.length} label group(s)
                ${pendingGated.length > 0 ? ` · <span style="color:var(--warning);">${pendingGated.length} need push</span>` : ''}
                ${pendingNotGated > 0 ? ` · <span style="color:var(--text-secondary);">${pendingNotGated} changed but not sync-enabled (won't push)</span>` : ''}
                ${pending.length === 0 ? ' · in sync' : ''}
            </div>
            <button class="btn btn-primary" id="lp-push-btn" style="margin-left:auto;" ${pendingGated.length === 0 ? 'disabled' : ''}>
                Push ${pendingGated.length > 0 ? `(${pendingGated.length})` : ''}
            </button>
            <button class="btn" id="lp-push-dryrun-btn">Dry-run</button>
        </div>
        <div id="lp-push-msg" style="font-size:13px; margin-bottom:12px;"></div>
        ${groups.map(g => groupHTML(g)).join('')}
    `;

    wireGroupControls(container, body);

    body.querySelector('#lp-push-btn').addEventListener('click', () => doPush(container, false));
    body.querySelector('#lp-push-dryrun-btn').addEventListener('click', () => doPush(container, true));
}

// Mirrors the same low-stock gating the CLI applies before pushing
// (available - low_stock_qty, floored at 0) — comparing against the raw
// available_qty instead would show a permanent false "needs push" for
// every row that has a low_stock_qty set, even when nothing changed.
function gatedQty(r) {
    const available = r.available_qty ?? 0;
    if (r.low_stock_qty == null) return available;
    return Math.max(available - r.low_stock_qty, 0);
}

function needsPush(r) {
    const row = state.listingRows[r.row_id];
    if (!row) return false;
    if (row.pushed_at == null) return true;
    const priceDiff = row.pushed_price == null || Math.abs(Number(row.pushed_price) - Number(r.resolved_price)) >= 0.005;
    const qtyDiff = row.pushed_qty == null || row.pushed_qty !== gatedQty(r);
    return priceDiff || qtyDiff;
}

// Client-side approximation of the server-side push gate (sync_enabled +
// status='active') — doesn't check the platform_sync_status kill switch,
// which isn't loaded here, but covers the common case so the grid isn't
// silent about why a row with pending changes won't actually get pushed.
function isGatedIn(r) {
    const row = state.listingRows[r.row_id];
    if (!row) return false;
    return !!row.sync_enabled && row.status === 'active';
}

function sourceBadge(source) {
    if (source === 'pin') return `<span class="badge" style="background:rgba(167,139,250,0.15); color:#a78bfa;">pinned</span>`;
    if (source === 'default') return `<span class="badge badge-ambiguous">default</span>`;
    return `<span class="badge badge-matched">rule</span>`;
}

function groupHTML(g) {
    const rule = plainRuleFor(g.rarity, g.foilType);
    const profile = rule ? state.profiles.find(p => p.id === rule.profile_id) : null;
    const hasNoRule = !rule && g.rows.some(r => r.price_source === 'default');

    return `
        <div class="lp-group" style="border:1px solid var(--border); border-radius:8px; margin-bottom:14px; overflow:hidden;">
            <div style="display:flex; align-items:center; gap:12px; padding:10px 14px; background:var(--bg-tertiary); flex-wrap:wrap;">
                <span class="badge" style="background:rgba(74,140,255,0.15); color:var(--accent);">${escapeHtml(g.label)}</span>
                <span style="font-size:12px; color:var(--text-secondary);">${g.rows.length} card(s)</span>
                <label style="font-size:12px; color:var(--text-secondary); margin-left:auto;">Profile
                    <select class="lp-profile-picker" data-rarity="${escapeHtml(g.rarity || '')}" data-foil-type="${escapeHtml(g.foilType || '')}" data-rule-id="${rule ? rule.id : ''}" style="margin-left:6px;">
                        <option value="">(none — falls to platform default)</option>
                        ${state.profiles.map(p => `<option value="${p.id}" ${profile && profile.id === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
                    </select>
                </label>
            </div>
            ${hasNoRule ? `
                <div style="padding:8px 14px; background:rgba(245,166,35,0.1); color:var(--warning); font-size:12px;">
                    ⚠ No rule assigned — these cards are pricing off the platform default fallback. Pick a profile above.
                </div>
            ` : ''}
            <table>
                <thead><tr>
                    <th>Variation</th><th>Market</th><th>Resolved</th><th>Source</th><th>Synced?</th><th>Available</th><th>Low-stock qty</th><th>Manual pin</th>
                </tr></thead>
                <tbody>
                    ${g.rows.map(r => rowHTML(r)).join('')}
                </tbody>
            </table>
        </div>
    `;
}

function rowHTML(r) {
    const row = state.listingRows[r.row_id] || {};
    const stale = needsPush(r);
    return `
        <tr data-row-id="${r.row_id}" ${stale ? 'style="background:rgba(245,166,35,0.06);"' : ''}>
            <td>${escapeHtml(row.external_id || '')}</td>
            <td>${r.market_price != null ? formatPrice(r.market_price) : '-'}</td>
            <td style="font-weight:600;">${formatPrice(r.resolved_price)}</td>
            <td>${sourceBadge(r.price_source)}</td>
            <td>${isGatedIn(r)
                ? '<span style="color:var(--success); font-size:12px;">yes</span>'
                : '<span style="color:var(--text-secondary); font-size:12px;" title="sync_enabled=false or status != active">no</span>'}</td>
            <td>${r.available_qty ?? '-'}</td>
            <td>
                <input type="number" class="lp-low-stock-input" data-row-id="${r.row_id}"
                       value="${r.low_stock_qty ?? ''}" placeholder="-" style="width:60px;" />
            </td>
            <td>
                <input type="number" step="0.01" class="lp-pin-input" data-row-id="${r.row_id}"
                       value="${row.manual_price ?? ''}" placeholder="unpinned" style="width:80px;" />
            </td>
        </tr>
    `;
}

// ----------------------------------------------------------------
// Wiring
// ----------------------------------------------------------------

function wireGroupControls(container, body) {
    body.querySelectorAll('.lp-profile-picker').forEach(sel => {
        sel.addEventListener('change', async () => {
            const rarity = sel.dataset.rarity || null;
            const foilType = sel.dataset.foilType || null;
            const existingRuleId = sel.dataset.ruleId || null;
            const profileId = sel.value || null;

            try {
                if (!profileId) {
                    if (existingRuleId) {
                        const { error } = await supabase.from('listing_pricing_rules').delete().eq('id', existingRuleId);
                        if (error) throw error;
                    }
                } else if (existingRuleId) {
                    const { error } = await supabase.from('listing_pricing_rules').update({ profile_id: profileId }).eq('id', existingRuleId);
                    if (error) throw error;
                } else {
                    const { error } = await supabase.from('listing_pricing_rules').insert({
                        platform: state.platform, listing_id: state.listingId, profile_id: profileId,
                        match_rarity: rarity, match_foil_type: foilType,
                    });
                    if (error) throw error;
                }
                await loadListing(container);
            } catch (err) {
                console.error(err);
                window.alert(`Failed to assign profile: ${err.message}`);
            }
        });
    });

    body.querySelectorAll('.lp-pin-input').forEach(input => {
        input.addEventListener('change', async () => {
            const rowId = input.dataset.rowId;
            const raw = input.value.trim();
            const manualPrice = raw === '' ? null : parseFloat(raw);
            const { error } = await supabase.from('platform_listings').update({ manual_price: manualPrice }).eq('id', rowId);
            if (error) {
                window.alert(`Failed to save pin: ${error.message}`);
                return;
            }
            await loadListing(container);
        });
    });

    body.querySelectorAll('.lp-low-stock-input').forEach(input => {
        input.addEventListener('change', async () => {
            const rowId = input.dataset.rowId;
            const raw = input.value.trim();
            const lowStockQty = raw === '' ? null : parseInt(raw, 10);
            const { error } = await supabase.from('platform_listings').update({ low_stock_qty: lowStockQty }).eq('id', rowId);
            if (error) {
                window.alert(`Failed to save low-stock qty: ${error.message}`);
                return;
            }
            await loadListing(container);
        });
    });
}

// ----------------------------------------------------------------
// Push (POSTs to picking_api.py, same service/token as the Picking tab —
// eBay credentials never touch the browser)
// ----------------------------------------------------------------

async function doPush(container, dryRun) {
    const body = container.querySelector('#lp-body');
    const msg = body.querySelector('#lp-push-msg');
    const pushBtn = body.querySelector('#lp-push-btn');
    const dryBtn = body.querySelector('#lp-push-dryrun-btn');

    if (!dryRun) {
        const confirmed = window.confirm(
            `This will send live price/quantity changes to eBay listing ${state.listingId}. `
            + `Only rows with sync_enabled=true and status='active' will actually be pushed — `
            + `run Dry-run first if you haven't already. Continue?`
        );
        if (!confirmed) return;
    }

    pushBtn.disabled = true;
    dryBtn.disabled = true;
    msg.innerHTML = `<span style="color:var(--text-secondary);">${dryRun ? 'Checking' : 'Pushing'}...</span>`;

    try {
        const resp = await fetch(`${PICKING_API_URL}/api/push-prices`, {
            method: 'POST',
            headers: { 'x-picking-token': PICKING_API_TOKEN, 'content-type': 'application/json' },
            body: JSON.stringify({ listing_id: state.listingId, account_num: state.accountNum, dry_run: dryRun }),
        });
        if (!resp.ok) {
            const detail = await resp.text().catch(() => '');
            throw new Error(`${resp.status} ${detail}`);
        }
        const result = await resp.json();
        const warningsNote = result.warnings && result.warnings.length
            ? ` — ${result.warnings.length} warning(s): ${escapeHtml(result.warnings.join('; '))}` : '';
        msg.innerHTML = `<span style="color:var(--success);">
            ${dryRun ? 'Would push' : 'Pushed'} ${result.pushed} of ${result.resolved} row(s)${warningsNote}
        </span>`;
        if (!dryRun) await loadListing(container);
    } catch (err) {
        console.error(err);
        msg.innerHTML = `<span style="color:var(--danger)">Push failed: ${escapeHtml(err.message)}
            — is picking_api.py running and reachable at ${PICKING_API_URL}?</span>`;
    } finally {
        pushBtn.disabled = false;
        dryBtn.disabled = false;
    }
}

// picking.js
// Picking page: batch pick list + pack-by-shipment view over picking_queue.
//
// Data flow: the Refresh button POSTs to a tiny FastAPI endpoint on the
// always-on Windows desktop (picking_api.py), which runs the same
// pull_picking() as `--ebay-pullpicking` and rewrites picking_queue. This
// page then re-reads the table via Supabase. No auto-pull on tab open —
// Refresh is the ONLY trigger (deliberate; see plan). If the endpoint is
// unreachable, the last snapshot renders with a staleness banner.
//
// Shipments: orders sharing (buyer_username + ship-to address) are one
// physical package. Badges: [S] = single-card single-order shipments (all
// share one "singles" zone — no pile needed); [3] = one order, multiple
// cards → pile 3; [1a][1b] = multiple orders, one buyer → pile 1, letter
// per order.
//
// Session state (checkboxes, badge numbers, previous-snapshot keys for NEW
// tags) survives navigation away and back. IMPORTANT: index.html re-imports
// this module with a cache-busting ?v= on every navigation, so module-level
// variables reset each visit — session state therefore lives on
// window.__cbmPickingSession (same class of fix as
// window.__cbmInventoryChannel in inventory.js). Badge numbers: on every
// refresh, piles whose shipments have fully shipped release their numbers,
// and all *unlocked* piles resequence from 1 in paid order. A pile is
// "locked" (keeps its number untouched) while it has at least one checked
// card in the pick list — a check means physical packing is in progress and
// the physical pile label must stay valid. Shipped piles' checks are dead
// and release the lock along with the number. Order letters (1a/1b) keep
// the old stable-forever behavior — never resequenced. Any renumbering is
// surfaced in the post-refresh diff banner so physical piles can be
// relabeled before packing continues.

import { supabase } from './shared.js';

// ── Config — EDIT THESE TWO for your LAN ─────────────────────────────────────
// Desktop's reserved LAN IP + the port picking_api.py listens on.
const PICKING_API_URL = 'http://192.168.1.186:8765';
// const PICKING_API_URL = 'http://localhost:8765'
// Must equal PICKING_API_TOKEN in the desktop's .env.
const PICKING_API_TOKEN = 'I1knbOJAve_UZJQHAFZANds9-HalgCxcRJw1GXDg404';
// ─────────────────────────────────────────────────────────────────────────────

const PILE_COLORS = [
    // [background, text] — 8 hues, cycled by (pileNum - 1) % 8
    ['rgba(74,140,255,0.18)',  '#7fb0ff'],  // blue
    ['rgba(62,207,142,0.18)',  '#5fd9a4'],  // green
    ['rgba(245,166,35,0.18)',  '#f5b649'],  // amber
    ['rgba(186,104,255,0.18)', '#c98fff'],  // purple
    ['rgba(255,105,180,0.18)', '#ff8ec4'],  // pink
    ['rgba(64,224,208,0.18)',  '#5fe0d2'],  // teal
    ['rgba(255,127,80,0.18)',  '#ff9c78'],  // coral
    ['rgba(160,160,170,0.18)', '#b8b8c0'],  // gray
];
const SINGLES_COLOR = ['rgba(160,160,170,0.15)', 'var(--text-secondary)'];

// Session state that must survive the module being re-imported.
function session() {
    if (!window.__cbmPickingSession) {
        window.__cbmPickingSession = {
            shipmentNums: {},   // shipmentKey -> pile number (stable, never reused)
            orderLetters: {},   // platform_order_id -> letter within its shipment
            nextNum: 1,
            checked: {},        // rowKey -> true
            prevLineIds: null,  // Set of order_line_item_id from snapshot before last refresh (null = no refresh yet this session)
            lastDiff: null,     // {added:[], removed:[], graduated:[]} from last refresh
        };
    }
    return window.__cbmPickingSession;
}

const state = {
    rows: [],           // picking_queue rows
    shipments: [],      // computed grouping
    pulledAt: null,
    expandedShipKey: null,
    refreshing: false,
    endpointError: null,  // string when last refresh failed
};

export async function renderPicking(container) {
    container.innerHTML = `
        <div style="display:flex; align-items:baseline; gap:16px; margin-bottom:4px;">
            <h2 style="margin:0;">Picking</h2>
            <div id="picking-summary" style="font-size:13px; color:var(--text-secondary);"></div>
            <button class="btn btn-primary" id="picking-refresh-btn" style="margin-left:auto;">⟳ Refresh</button>
        </div>
        <div id="picking-banners"></div>
        <div id="picking-content" style="margin-top:16px;"><p>Loading snapshot...</p></div>
    `;

    container.querySelector('#picking-refresh-btn')
        .addEventListener('click', () => refreshFromEbay(container));

    setupImagePreview(container);
    await loadSnapshot(container);
}

// Hover-to-zoom preview: one shared floating element, reused across renders
// (cached on window since index.html re-imports this module with a fresh
// ?v= on every navigation — same class of fix as the inventory realtime
// channel). Delegated on `container` itself, which persists across re-
// renders (only #picking-content's innerHTML is replaced), so this only
// needs to be wired once per tab mount, not once per render().
function setupImagePreview(container) {
    let preview = window.__cbmPickingPreview;
    if (!preview) {
        preview = document.createElement('div');
        preview.id = 'cbm-picking-img-preview';
        preview.style.cssText = `
            position:fixed; pointer-events:none; z-index:9999; display:none;
            border:1px solid var(--border); border-radius:6px; overflow:hidden;
            box-shadow:0 8px 28px rgba(0,0,0,0.5); background:var(--bg-secondary);
        `;
        const img = document.createElement('img');
        img.style.cssText = 'display:block; max-width:280px; max-height:390px;';
        preview.appendChild(img);
        document.body.appendChild(preview);
        window.__cbmPickingPreview = preview;
    }

    container.addEventListener('mouseover', (e) => {
        const t = e.target.closest('img.card-thumb');
        if (!t || !t.src) return;
        preview.firstChild.src = t.src;
        preview.style.display = 'block';
    });

    container.addEventListener('mousemove', (e) => {
        if (preview.style.display !== 'block') return;
        const pad = 16;
        let x = e.clientX + pad;
        let y = e.clientY + pad;
        if (x + 300 > window.innerWidth) x = e.clientX - 300 - pad;
        if (y + 400 > window.innerHeight) y = Math.max(8, window.innerHeight - 400);
        preview.style.left = `${x}px`;
        preview.style.top = `${y}px`;
    });

    container.addEventListener('mouseout', (e) => {
        if (e.target.closest('img.card-thumb')) preview.style.display = 'none';
    });
}

// ----------------------------------------------------------------
// Data
// ----------------------------------------------------------------

async function loadSnapshot(container, resequence = false) {
    const { data, error } = await supabase
        .from('picking_queue')
        .select('*')
        .order('paid_at', { ascending: true });

    if (error) {
        container.querySelector('#picking-content').innerHTML =
            `<p style="color:var(--danger)">Failed to load picking_queue: ${escapeHtml(error.message)}</p>`;
        return;
    }

    state.rows = data || [];
    state.pulledAt = state.rows.length ? state.rows[0].pulled_at : null;
    computeShipments(resequence);
    render(container);
}

async function refreshFromEbay(container) {
    if (state.refreshing) return;

    const s = session();
    const anyChecked = Object.keys(s.checked).length > 0;
    if (anyChecked && !confirm(
        'Refresh will check eBay for new and shipped orders.\n' +
        'Your checked picks and pile numbers are kept — new orders get tagged NEW.\n\nContinue?')) {
        return;
    }

    state.refreshing = true;
    state.endpointError = null;
    const btn = container.querySelector('#picking-refresh-btn');
    btn.disabled = true;
    btn.textContent = 'Pulling from eBay…';

    // Remember the current snapshot's line ids so we can diff after.
    const prevIds = new Set(state.rows.map(r => r.order_line_item_id));
    const prevShipmentsMeta = state.shipments.map(sh => ({
        key: sh.key, isSingles: sh.zone === 'S', num: sh.num,
        orderIds: sh.orders.map(o => o.orderId),
    }));

    try {
        const resp = await fetch(`${PICKING_API_URL}/api/picking/refresh`, {
            method: 'POST',
            headers: { 'x-picking-token': PICKING_API_TOKEN },
        });
        if (!resp.ok) {
            const detail = await resp.text().catch(() => '');
            throw new Error(`endpoint returned ${resp.status} ${detail.slice(0, 200)}`);
        }
    } catch (err) {
        state.endpointError = err.message;
        state.refreshing = false;
        btn.disabled = false;
        btn.textContent = '⟳ Refresh';
        render(container);  // stale banner over existing snapshot
        return;
    }

    s.prevLineIds = prevIds;
    await loadSnapshot(container, true);  // re-reads fresh snapshot, resequences unlocked piles

    // Diff summary (uses freshly computed state)
    const newIds = new Set(state.rows.map(r => r.order_line_item_id));
    const addedOrders = new Set();
    for (const r of state.rows) {
        if (!prevIds.has(r.order_line_item_id)) addedOrders.add(r.platform_order_id);
    }
    const removedShipments = prevShipmentsMeta.filter(m =>
        !m.isSingles && m.num && !state.shipments.some(sh => sh.key === m.key));
    const graduated = state.shipments.filter(sh =>
        sh.zone !== 'S' &&
        prevShipmentsMeta.some(m => m.key === sh.key && m.isSingles));

    // Surviving piles whose number changed in the resequence — the user
    // must relabel the physical piles before packing continues.
    const renumbered = [];
    for (const m of prevShipmentsMeta) {
        if (m.isSingles || !m.num) continue;
        const now = state.shipments.find(sh => sh.key === m.key);
        if (now && now.zone !== 'S' && now.num !== m.num) {
            renumbered.push({ from: m.num, to: now.num });
        }
    }
    renumbered.sort((a, b) => a.to - b.to);

    s.lastDiff = {
        addedCount: addedOrders.size,
        removedPiles: removedShipments.map(m => m.num),
        renumbered,
        graduated: graduated.map(sh => ({
            num: sh.num,
            buyer: sh.buyer,
            cards: sh.orders.flatMap(o => o.lines.map(l =>
                `${l.card_number ?? '?'} ${l.card_name ?? l.raw_variation_name}`)),
        })),
    };

    state.refreshing = false;
    const btn2 = container.querySelector('#picking-refresh-btn');
    if (btn2) { btn2.disabled = false; btn2.textContent = '⟳ Refresh'; }
    render(container);
}

// ----------------------------------------------------------------
// Shipment grouping + stable badges
// ----------------------------------------------------------------

function shipmentKeyOf(r) {
    return [r.buyer_username, r.ship_name, r.ship_postal_code, r.ship_country]
        .map(x => (x || '').toLowerCase().trim()).join('|');
}

// Identity of a pick-list row (checkbox key). Shared between buildPickList
// (aggregation) and computeShipments (lock detection) — must stay identical
// in both places or checks stop mapping back to their piles.
function cardKeyOf(r) {
    const listingKey = r.ebay_item_id || r.listing_title || '?';
    return r.matched
        ? `${listingKey}|${r.card_number}|${r.card_name}|${r.variant_label}`
        : `${listingKey}|UNMATCHED|${r.raw_variation_name}`;
}

function computeShipments(resequence = false) {
    const s = session();

    // Group rows: shipment -> orders -> lines
    const byShipment = new Map();
    for (const r of state.rows) {
        const key = shipmentKeyOf(r);
        if (!byShipment.has(key)) byShipment.set(key, new Map());
        const orders = byShipment.get(key);
        if (!orders.has(r.platform_order_id)) orders.set(r.platform_order_id, []);
        orders.get(r.platform_order_id).push(r);
    }

    // Resequence pass (refresh only — plain tab mounts keep numbers as-is):
    // shipped piles release their numbers and dead checks; every surviving
    // UNLOCKED pile is renumbered from 1 in paid order below. A pile is
    // locked while any of its cards is checked — packing in progress, the
    // physical pile label must not change under it.
    if (resequence) {
        // Which current card keys exist, and which shipments are locked.
        const validCardKeys = new Set();
        const lockedKeys = new Set();
        for (const r of state.rows) {
            const ck = cardKeyOf(r);
            validCardKeys.add(ck);
            if (s.checked[ck]) lockedKeys.add(shipmentKeyOf(r));
        }
        // Dead checks (card no longer anywhere in the queue) are purged so
        // they can't lock a resurrected buyer/address key later.
        for (const k of Object.keys(s.checked)) {
            if (!validCardKeys.has(k)) delete s.checked[k];
        }
        // Departed shipments release their keys entirely; surviving
        // unlocked piles release their numbers for reassignment.
        for (const k of Object.keys(s.shipmentNums)) {
            if (!byShipment.has(k) || !lockedKeys.has(k)) delete s.shipmentNums[k];
        }
        s.nextNum = 1;  // refill from the bottom, skipping locked numbers
    }

    // Numbers currently in use (locked survivors during a resequence; all
    // assignments otherwise) — assignment below always skips these, which
    // makes filling gaps around locked piles safe in every mode.
    const usedNums = new Set(Object.values(s.shipmentNums));

    const shipments = [];
    for (const [key, ordersMap] of byShipment) {
        const orders = [...ordersMap.entries()].map(([orderId, lines]) => ({
            orderId, lines,
            paidAt: lines.reduce((a, l) => (!a || (l.paid_at && l.paid_at < a)) ? l.paid_at : a, null),
            qty: lines.reduce((a, l) => a + l.quantity, 0),
        }));
        orders.sort((a, b) => (a.paidAt || '').localeCompare(b.paidAt || ''));

        const totalQty = orders.reduce((a, o) => a + o.qty, 0);
        const totalLines = orders.reduce((a, o) => a + o.lines.length, 0);
        const first = orders[0].lines[0];

        const sh = {
            key, orders,
            buyer: first.buyer_username,
            shipName: first.ship_name,
            city: first.ship_city, stateProv: first.ship_state,
            country: first.ship_country,
            oldestPaid: orders[0].paidAt,
            totalQty, totalLines,
            hasUnmatched: orders.some(o => o.lines.some(l => !l.matched)),
        };

        // Zone: S = one order with one line of qty 1. Everything else needs
        // a pile (even a single order, if it has multiple cards to keep together).
        if (orders.length === 1 && totalQty === 1) {
            sh.zone = 'S';
            sh.num = null;
        } else {
            sh.zone = 'pile';
            // Keep an existing assignment (locked pile, or no resequence
            // this pass), else the lowest number not already in use.
            if (!s.shipmentNums[key]) {
                while (usedNums.has(s.nextNum)) s.nextNum++;
                s.shipmentNums[key] = s.nextNum;
                usedNums.add(s.nextNum);
                s.nextNum++;
            }
            sh.num = s.shipmentNums[key];
            // Stable letters (only meaningful when >1 order)
            if (orders.length > 1) {
                const used = new Set(
                    orders.map(o => s.orderLetters[o.orderId]).filter(Boolean));
                for (const o of orders) {
                    if (!s.orderLetters[o.orderId]) {
                        let c = 0;
                        while (used.has(String.fromCharCode(97 + c))) c++;
                        s.orderLetters[o.orderId] = String.fromCharCode(97 + c);
                        used.add(s.orderLetters[o.orderId]);
                    }
                }
                for (const o of orders) o.letter = s.orderLetters[o.orderId];
                orders.sort((a, b) => a.letter.localeCompare(b.letter));
            } else {
                orders[0].letter = null;
            }
        }
        shipments.push(sh);
    }

    // Piles sorted by number, singles zone last
    shipments.sort((a, b) => {
        if (a.zone === 'S' && b.zone === 'S') return (a.oldestPaid || '').localeCompare(b.oldestPaid || '');
        if (a.zone === 'S') return 1;
        if (b.zone === 'S') return -1;
        return a.num - b.num;
    });

    state.shipments = shipments;
}

function badgeFor(sh, order) {
    if (sh.zone === 'S') return { label: 'S', colors: SINGLES_COLOR };
    const label = order && order.letter ? `${sh.num}${order.letter}` : String(sh.num);
    return { label, colors: PILE_COLORS[(sh.num - 1) % PILE_COLORS.length] };
}

function badgeHtml(b, extra = '') {
    return `<span style="display:inline-block; padding:1px 8px; border-radius:10px;
                 font-size:11px; font-weight:600; background:${b.colors[0]}; color:${b.colors[1]};
                 font-variant-numeric:tabular-nums; white-space:nowrap;">${escapeHtml(b.label)}${extra}</span>`;
}

// ----------------------------------------------------------------
// Pick list aggregation (merged batch pick)
// ----------------------------------------------------------------

function cardSortKey(num) {
    // Natural sort: leading integer first, string tail second. "146/165" -> 146.
    const m = /^(\d+)/.exec(num || '');
    return [m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER, num || ''];
}

// Unmatched lines have no card_number (only the matcher populates that), but
// eBay variation names consistently lead with it, e.g.
// "110/084 Iron Defender" or "062/084 Bastiodon RH Reverse Holo". Pull it out
// so unmatched rows can share the same cardSortKey() ordering as matched
// ones instead of all tying and falling back to snapshot/insertion order.
// Returns null (not sortable) if the variation name doesn't start with it.
function extractCardNumberFromVariation(rawVariation) {
    const m = /^(\d+\/\d+)/.exec((rawVariation || '').trim());
    return m ? m[1] : null;
}

function buildPickList() {
    const s = session();
    // shipment/order lookups per line
    const orderToShipment = new Map();
    for (const sh of state.shipments) {
        for (const o of sh.orders) orderToShipment.set(o.orderId, { sh, o });
    }

    // Merge lines by listing + card identity
    const listings = new Map(); // listingKey -> {title, itemId, rows: Map(cardKey -> agg)}
    for (const r of state.rows) {
        const listingKey = r.ebay_item_id || r.listing_title || '?';
        if (!listings.has(listingKey)) {
            listings.set(listingKey, { title: r.listing_title, itemId: r.ebay_item_id, cards: new Map() });
        }
        const cardKey = cardKeyOf(r);
        const L = listings.get(listingKey);
        if (!L.cards.has(cardKey)) {
            L.cards.set(cardKey, {
                key: cardKey,
                matched: r.matched,
                cardNumber: r.matched ? r.card_number : extractCardNumberFromVariation(r.raw_variation_name),
                cardName: r.card_name,
                imageUrl: r.image_url,
                setName: r.set_name,
                variantLabel: r.variant_label,
                rawVariation: r.raw_variation_name,
                qty: 0,
                perOrder: [],   // {orderId, qty, lineId}
                isNew: false,
            });
        }
        const agg = L.cards.get(cardKey);
        agg.qty += r.quantity;
        agg.perOrder.push({ orderId: r.platform_order_id, qty: r.quantity, lineId: r.order_line_item_id });
        if (s.prevLineIds && !s.prevLineIds.has(r.order_line_item_id)) agg.isNew = true;
    }

    // Sort cards within each listing (matched by number; unmatched last)
    const out = [];
    for (const [, L] of listings) {
        const cards = [...L.cards.values()];
        cards.sort((a, b) => {
            if (a.matched !== b.matched) return a.matched ? -1 : 1;
            const [an, as] = cardSortKey(a.cardNumber);
            const [bn, bs] = cardSortKey(b.cardNumber);
            return an - bn || as.localeCompare(bs);
        });
        out.push({ title: L.title, itemId: L.itemId, cards });
    }

    // Listing groups sort by set first (most common set_name among the
    // group's matched cards, ties alphabetical), then title — so two
    // listings selling the same set sit adjacent in the pick list even
    // when their titles don't alphabetize together. Groups with no
    // matched cards have no set and sort last.
    for (const L of out) {
        const counts = new Map();
        for (const c of L.cards) {
            if (c.matched && c.setName) {
                counts.set(c.setName, (counts.get(c.setName) || 0) + 1);
            }
        }
        L.setKey = null;
        for (const [name, n] of counts) {
            if (!L.setKey || n > counts.get(L.setKey) ||
                (n === counts.get(L.setKey) && name < L.setKey)) {
                L.setKey = name;
            }
        }
    }
    out.sort((a, b) => {
        if (!a.setKey !== !b.setKey) return a.setKey ? -1 : 1;
        return (a.setKey || '').localeCompare(b.setKey || '')
            || (a.title || '').localeCompare(b.title || '');
    });

    // attach badge info per order entry
    for (const L of out) {
        for (const c of L.cards) {
            c.badges = c.perOrder.map(po => {
                const hit = orderToShipment.get(po.orderId);
                const b = hit ? badgeFor(hit.sh, hit.o) : { label: '?', colors: SINGLES_COLOR };
                return { ...b, qty: po.qty };
            });
            // order badges: piles first (numeric), singles last
            c.badges.sort((x, y) => {
                if (x.label === 'S') return 1;
                if (y.label === 'S') return -1;
                return x.label.localeCompare(y.label, undefined, { numeric: true });
            });
        }
    }
    return out;
}

// ----------------------------------------------------------------
// Render
// ----------------------------------------------------------------

function render(container) {
    const s = session();
    const summaryEl = container.querySelector('#picking-summary');
    const orders = new Set(state.rows.map(r => r.platform_order_id)).size;
    const piles = state.shipments.filter(sh => sh.zone !== 'S').length;
    const singles = state.shipments.filter(sh => sh.zone === 'S').length;
    const lines = state.rows.length;

    summaryEl.textContent = state.pulledAt
        ? `Snapshot from ${timeAgo(state.pulledAt)} · ${orders} orders · ${piles} pile${piles === 1 ? '' : 's'}`
          + (singles ? ` + ${singles} single${singles === 1 ? '' : 's'}` : '') + ` · ${lines} lines`
        : 'No snapshot yet — hit Refresh to pull from eBay.';

    renderBanners(container);

    const content = container.querySelector('#picking-content');
    if (!state.rows.length) {
        content.innerHTML = `<p style="color:var(--text-secondary)">Nothing to pack 🎉</p>`;
        return;
    }

    const pickList = buildPickList();

    content.innerHTML = `
        <div style="font-size:11px; font-weight:600; color:var(--text-secondary);
                    text-transform:uppercase; letter-spacing:0.04em; margin-bottom:8px;">Pick list</div>
        ${pickList.map((L, i) => listingGroupHtml(L, s, i)).join('')}

        <div style="font-size:11px; font-weight:600; color:var(--text-secondary);
                    text-transform:uppercase; letter-spacing:0.04em; margin:24px 0 8px;">Pack by shipment</div>
        ${state.shipments.map(sh => shipmentHtml(sh, s)).join('')}
    `;

    // checkbox wiring
    content.querySelectorAll('input[data-pick-key]').forEach(cb => {
        cb.addEventListener('change', () => {
            const key = cb.dataset.pickKey;
            if (cb.checked) s.checked[key] = true;
            else delete s.checked[key];
            render(container);
        });
    });

    // listing header check-all: checks/unchecks every card in the group.
    // indeterminate is a JS-only property, so it's applied post-render.
    content.querySelectorAll('input[data-listing-check]').forEach(cb => {
        if (cb.dataset.indeterminate) cb.indeterminate = true;
        cb.addEventListener('change', () => {
            const L = pickList[Number(cb.dataset.listingCheck)];
            if (!L) return;
            // If everything was checked, uncheck all; otherwise check all
            // (a partial group fills in the rest rather than clearing).
            const allChecked = L.cards.every(c => !!s.checked[c.key]);
            for (const c of L.cards) {
                if (allChecked) delete s.checked[c.key];
                else s.checked[c.key] = true;
            }
            render(container);
        });
    });

    // shipment expand/collapse
    content.querySelectorAll('[data-ship-key]').forEach(el => {
        el.addEventListener('click', () => {
            const key = el.dataset.shipKey;
            state.expandedShipKey = state.expandedShipKey === key ? null : key;
            render(container);
        });
    });

    // dismiss diff banner
    const dismiss = container.querySelector('#diff-dismiss');
    if (dismiss) dismiss.addEventListener('click', () => {
        s.lastDiff = null;
        render(container);
    });
}

function renderBanners(container) {
    const s = session();
    const el = container.querySelector('#picking-banners');
    let html = '';

    if (state.endpointError) {
        html += `<div style="background:rgba(245,166,35,0.12); border:1px solid rgba(245,166,35,0.4);
                     color:var(--warning); font-size:12px; padding:8px 12px; border-radius:6px; margin-top:10px;">
            ⚠ Couldn't refresh — picking endpoint unreachable (${escapeHtml(state.endpointError)}).
            Showing snapshot from ${state.pulledAt ? timeAgo(state.pulledAt) : '—'}.
            Is picking_api.py running on the desktop?
        </div>`;
    }

    if (s.lastDiff) {
        const d = s.lastDiff;
        const parts = [];
        parts.push(d.addedCount ? `+${d.addedCount} new order${d.addedCount === 1 ? '' : 's'}` : 'no new orders');
        if (d.removedPiles.length) parts.push(`shipped: pile${d.removedPiles.length === 1 ? '' : 's'} ${d.removedPiles.join(', ')} removed`);
        let gradHtml = '';
        if (d.renumbered && d.renumbered.length) {
            gradHtml += `<div style="margin-top:4px;">⟲ <b>Renumbered:</b>
                ${d.renumbered.map(x => `${x.from}→${x.to}`).join(', ')}
                — relabel these piles before continuing</div>`;
        }
        for (const g of d.graduated) {
            gradHtml += `<div style="margin-top:4px;">⚠ <b>S → ${g.num}</b>: ${escapeHtml(g.buyer || '')} now has multiple cards —
                move ${escapeHtml(g.cards.join(', '))} from singles to pile ${g.num}</div>`;
        }
        html += `<div style="background:rgba(74,140,255,0.10); border:1px solid rgba(74,140,255,0.35);
                     color:var(--text); font-size:12px; padding:8px 12px; border-radius:6px; margin-top:10px;">
            <span style="float:right; cursor:pointer; color:var(--text-secondary);" id="diff-dismiss">✕</span>
            <b>Refreshed:</b> ${parts.join(' · ')}${gradHtml}
        </div>`;
    }

    el.innerHTML = html;
}

function listingGroupHtml(L, s, idx) {
    const rows = L.cards.map(c => {
        const checked = !!s.checked[c.key];
        const badges = c.badges.map(b =>
            badgeHtml(b, b.qty > 1 ? ` ×${b.qty}` : '')).join(' ');

        if (!c.matched) {
            return `
            <tr style="background:rgba(245,166,35,0.07);">
                <td>${c.isNew && !checked ? newTag() : ''}</td>
                <td><input type="checkbox" data-pick-key="${escapeHtml(c.key)}" ${checked ? 'checked' : ''}></td>
                <td>${imgPlaceholder()}</td>
                <td style="color:var(--warning); font-variant-numeric:tabular-nums;">${escapeHtml(c.cardNumber || '—')}</td>
                <td style="color:var(--warning);">⚠ Unmatched: ${escapeHtml(c.rawVariation || '')}</td>
                <td></td>
                <td style="text-align:center; color:var(--warning);">${c.qty}</td>
                <td>${badges}</td>
            </tr>`;
        }
        return `
        <tr>
            <td>${c.isNew && !checked ? newTag() : ''}</td>
            <td><input type="checkbox" data-pick-key="${escapeHtml(c.key)}" ${checked ? 'checked' : ''}></td>
            <td>${imgHtml(c.imageUrl)}</td>
            <td style="color:var(--text-secondary); font-variant-numeric:tabular-nums;">${escapeHtml(c.cardNumber || '—')}</td>
            <td style="${checked ? 'text-decoration:line-through; color:var(--text-secondary);' : ''}">
                ${escapeHtml(c.cardName || '')}
                <span style="font-size:15px; font-weight:700; color:var(--danger);"> · ${escapeHtml(c.variantLabel || 'Standard')}</span>
            </td>
            <td style="font-size:11px; color:var(--text-secondary);">${escapeHtml(c.setName || '')}</td>
            <td style="text-align:center; ${c.qty > 1 ? 'font-weight:700;' : ''}">${c.qty}</td>
            <td>${badges}</td>
        </tr>`;
    }).join('');

    const allChecked = L.cards.length > 0 && L.cards.every(c => !!s.checked[c.key]);
    const someChecked = L.cards.some(c => !!s.checked[c.key]);

    return `
    <div style="border:1px solid var(--border); border-radius:8px; overflow:hidden; margin-bottom:12px;">
        <div style="padding:8px 12px; background:var(--bg-secondary); font-size:13px; font-weight:600;
                    display:flex; align-items:center; gap:10px;">
            <input type="checkbox" data-listing-check="${idx}" ${allChecked ? 'checked' : ''}
                   ${!allChecked && someChecked ? 'data-indeterminate="1"' : ''}
                   title="Check/uncheck all cards in this listing">
            <span style="flex:1;">${escapeHtml(L.title || '(untitled listing)')}</span>
            <span style="color:var(--text-secondary); font-weight:400; font-size:11px;">item ${escapeHtml(L.itemId || '—')}</span>
        </div>
        <table style="table-layout:fixed;">
            <thead><tr>
                <th style="width:44px;"></th><th style="width:30px;"></th>
                <th style="width:70px;"></th>
                <th style="width:56px;">#</th><th>Card</th><th style="width:220px;">Set</th>
                <th style="width:52px; text-align:center;">Qty</th><th style="width:190px;">Ship to</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table>
    </div>`;
}

function shipmentHtml(sh, s) {
    const expanded = state.expandedShipKey === sh.key;
    const b = badgeFor(sh, null);
    const loc = [sh.city, sh.stateProv || sh.country].filter(Boolean).join(', ');

    const warn = sh.hasUnmatched
        ? `<span style="color:var(--warning); font-size:11px;">⚠ has unmatched line</span>` : '';

    const label = sh.zone === 'S'
        ? `<span style="font-weight:600;">${escapeHtml(sh.buyer || sh.shipName || '?')}</span>
           <span style="font-size:11px; color:var(--text-secondary);">single card — sleeve as picked</span>`
        : `<span style="font-weight:600;">${escapeHtml(sh.buyer || sh.shipName || '?')}</span>`;

    let html = `
    <div style="border:1px solid var(--border); border-radius:8px; margin-bottom:6px;">
        <div data-ship-key="${escapeHtml(sh.key)}" style="display:flex; align-items:center; gap:10px;
                padding:9px 12px; cursor:pointer;">
            <span style="color:var(--text-secondary); font-size:11px; width:10px;">${expanded ? '▾' : '▸'}</span>
            ${badgeHtml(b)}
            ${label}
            <span style="font-size:12px; color:var(--text-secondary);">
                ${escapeHtml(loc)} · ${sh.orders.length} order${sh.orders.length === 1 ? '' : 's'} · ${sh.totalQty} card${sh.totalQty === 1 ? '' : 's'}
                · paid ${timeAgo(sh.oldestPaid)}
            </span>
            <span style="margin-left:auto;">${warn}</span>
        </div>`;

    if (expanded) {
        html += `<div style="border-top:1px solid var(--border); padding:10px 12px 12px 34px;">`;
        for (const o of sh.orders) {
            const ob = badgeFor(sh, o);
            const isNewOrder = s.prevLineIds && o.lines.every(l => !s.prevLineIds.has(l.order_line_item_id));
            html += `
            <div style="margin-bottom:10px;">
                <div style="display:flex; align-items:center; gap:8px; margin-bottom:3px;">
                    ${isNewOrder ? newTag() : ''}
                    ${badgeHtml(ob)}
                    <span style="font-family:monospace; font-size:12px;">${escapeHtml(o.orderId)}</span>
                    <span style="font-size:11px; color:var(--text-secondary);">
                        ${o.lines.length} line${o.lines.length === 1 ? '' : 's'} · ${o.qty} card${o.qty === 1 ? '' : 's'} · paid ${timeAgo(o.paidAt)}
                    </span>
                </div>
                <div style="font-size:12px; color:var(--text-secondary); margin-left:6px; line-height:1.7;">
                    ${o.lines.map(l => l.matched
                        ? `${escapeHtml(l.card_number || '—')} ${escapeHtml(l.card_name || '')} · ${escapeHtml(l.variant_label || 'Standard')} · ×${l.quantity}
                           <span style="color:var(--text-secondary); opacity:0.7;">— ${escapeHtml(l.set_name || '')}</span>`
                        : `<span style="color:var(--warning);">⚠ ${escapeHtml(l.raw_variation_name || l.listing_title || 'unmatched')} · ×${l.quantity}</span>`
                    ).join('<br>')}
                </div>
            </div>`;
        }
        html += `</div>`;
    }

    html += `</div>`;
    return html;
}

// ----------------------------------------------------------------
// Utils
// ----------------------------------------------------------------

function imgHtml(url) {
    if (!url) return imgPlaceholder();
    return `<img src="${escapeHtml(url)}" alt="" loading="lazy" class="card-thumb"
                style="width:60px; height:84px; object-fit:cover; border-radius:3px; border:1px solid var(--border); cursor:zoom-in;"
                onerror="this.replaceWith(Object.assign(document.createElement('div'),
                    {style:'width:60px;height:84px;background:var(--bg-tertiary);border-radius:3px;border:1px solid var(--border);'}))">`;
}

function imgPlaceholder() {
    return `<div style="width:60px; height:84px; background:var(--bg-tertiary); border-radius:3px; border:1px solid var(--border);"></div>`;
}

function newTag() {
    return `<span style="display:inline-block; background:rgba(62,207,142,0.15); color:var(--success);
                border-radius:4px; padding:1px 5px; font-size:9px; font-weight:700;
                letter-spacing:0.05em;">NEW</span>`;
}

function timeAgo(ts) {
    if (!ts) return '—';
    const secs = (Date.now() - new Date(ts).getTime()) / 1000;
    if (secs < 60) return 'just now';
    if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    return `${Math.floor(secs / 86400)}d ago`;
}

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

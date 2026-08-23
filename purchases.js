// purchases.js
// Purchases page: browse purchase orders, create POs, view linked inventory lots,
// and relink (merge) one PO's lots into another.
//
// Phase 1: list / create / detail / merge / delete.
// Phase 2 (next): add cards to a PO directly (search card_master + variants).

import { supabase, debounce, formatPrice, loadAxisOptions, axisDisplay, AXIS_OPTIONS } from './shared.js';

const AXES = ['foil_type', 'foil_pattern', 'texture', 'material', 'size', 'stamp_type', 'source_type'];

// purchased_at is a calendar date, not a precise moment — the <input
// type="date"> that sets it produces a date-only string (e.g.
// "2026-08-23"), which JS parses as UTC midnight, so it's stored as
// 2026-08-23T00:00:00Z. Formatting that with the default
// .toLocaleDateString() converts to the VIEWER's local timezone, which
// rolls it back to the previous day for anyone west of UTC (e.g. UTC-4
// shows "8/22" for a purchase dated "8/23"). Format in UTC instead, so
// the displayed date always matches what was actually picked/stored.
function formatDate(isoString) {
    if (!isoString) return '—';
    return new Date(isoString).toLocaleDateString('en-US', { timeZone: 'UTC' });
}

const state = {
    rows: [],            // purchases with computed lot totals merged in
    filters: {
        search: '',
        source: 'all',
    },
    sort: { field: 'purchased_at', asc: false },
    expandedPoId: null,
};

export async function renderPurchases(container) {
    container.innerHTML = `
        <div style="display:flex; align-items:baseline; gap:16px; margin-bottom:20px;">
            <h2 style="margin:0;">Purchases</h2>
            <div id="po-summary" style="font-size:13px; color:var(--text-secondary);"></div>
        </div>
        <div class="filters-bar" id="po-filters-bar"></div>

        <!-- New PO inline panel -->
        <div id="new-po-panel" style="display:none; border:1px solid var(--border);
             border-radius:8px; padding:16px; margin-bottom:16px; background:var(--bg-secondary);">
            <div style="font-size:12px; font-weight:600; color:var(--text-secondary);
                        text-transform:uppercase; letter-spacing:0.04em; margin-bottom:12px;">
                New Purchase Order
            </div>
            <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:12px;">
                <label style="font-size:12px; color:var(--text-secondary);">Date
                    <input type="date" id="npo-date" style="width:130px; margin-top:4px; display:block;" />
                </label>
                <label style="font-size:12px; color:var(--text-secondary);">Reference #
                    <input type="text" id="npo-ref" placeholder="order # / receipt #"
                           style="width:180px; margin-top:4px; display:block;" />
                </label>
                <label style="font-size:12px; color:var(--text-secondary);">Source
                    <select id="npo-source" style="margin-top:4px; display:block;">
                        <option value="local">Local</option>
                        <option value="ebay">eBay</option>
                        <option value="tcgplayer">TCGPlayer</option>
                        <option value="other">Other</option>
                    </select>
                </label>
                <label style="font-size:12px; color:var(--text-secondary);">Type
                    <select id="npo-type" style="margin-top:4px; display:block;">
                        <option value="single">Single</option>
                        <option value="bulk">Bulk</option>
                    </select>
                </label>
                <label style="font-size:12px; color:var(--text-secondary);">Shipping
                    <input type="number" step="0.01" id="npo-shipping" placeholder="0.00"
                           style="width:90px; margin-top:4px; display:block;" />
                </label>
                <label style="font-size:12px; color:var(--text-secondary);">Tax
                    <input type="number" step="0.01" id="npo-tax" placeholder="0.00"
                           style="width:90px; margin-top:4px; display:block;" />
                </label>
                <label style="font-size:12px; color:var(--text-secondary);">Other
                    <input type="number" step="0.01" id="npo-other" placeholder="0.00"
                           style="width:90px; margin-top:4px; display:block;" />
                </label>
                <label style="font-size:12px; color:var(--text-secondary);">Notes
                    <input type="text" id="npo-notes" placeholder="optional"
                           style="width:220px; margin-top:4px; display:block;" />
                </label>
            </div>
            <div style="display:flex; gap:8px; align-items:center;">
                <button class="btn btn-primary" id="npo-save-btn">Create PO</button>
                <button class="btn" id="npo-cancel-btn">Cancel</button>
                <span id="npo-msg" style="font-size:12px; margin-left:8px;"></span>
            </div>
        </div>

        <div id="po-table-wrap"><p>Loading purchases...</p></div>
    `;

    await loadAxisOptions(true);   // variant labels + add-card axis dropdowns (with '— none —')
    renderFilters(container);
    wireNewPoPanel(container);
    await loadAndRender(container);
}

// ----------------------------------------------------------------
// Data
// ----------------------------------------------------------------

async function loadAndRender(container) {
    const wrap = container.querySelector('#po-table-wrap');
    wrap.innerHTML = '<p>Loading purchases...</p>';

    // 1. All purchase headers (client-side sort/filter — PO counts stay small)
    const { data: purchases, error: poErr } = await supabase
        .from('purchases')
        .select('*')
        .order('purchased_at', { ascending: false });

    if (poErr) {
        wrap.innerHTML = `<p style="color:var(--danger)">Failed to load purchases: ${escapeHtml(poErr.message)}</p>`;
        return;
    }

    // 2. Computed lot totals straight off inventory (cheap: three columns)
    const { data: lots, error: lotErr } = await supabase
        .from('inventory')
        .select('purchase_id, quantity, cost_basis');

    if (lotErr) {
        wrap.innerHTML = `<p style="color:var(--danger)">Failed to load lot totals: ${escapeHtml(lotErr.message)}</p>`;
        return;
    }

    const agg = {};
    for (const l of (lots || [])) {
        if (!l.purchase_id) continue;
        if (!agg[l.purchase_id]) agg[l.purchase_id] = { qty: 0, cost: 0, lots: 0 };
        agg[l.purchase_id].qty  += (l.quantity || 0);
        agg[l.purchase_id].cost += (l.cost_basis || 0) * (l.quantity || 0);
        agg[l.purchase_id].lots += 1;
    }

    state.rows = (purchases || []).map(p => ({
        ...p,
        computed_qty:  agg[p.id]?.qty  ?? 0,
        computed_cost: agg[p.id]?.cost ?? 0,
        computed_lots: agg[p.id]?.lots ?? 0,
        grand_total:   (p.total_cost || 0) + (p.shipping || 0) + (p.tax || 0) + (p.other_cost || 0),
    }));

    renderTable(container);
}

function visibleRows() {
    const f = state.filters;
    let rows = state.rows;

    if (f.source !== 'all') rows = rows.filter(r => r.source === f.source);
    if (f.search.trim()) {
        const q = f.search.trim().toLowerCase();
        rows = rows.filter(r =>
            (r.reference_id || '').toLowerCase().includes(q) ||
            (r.notes || '').toLowerCase().includes(q));
    }

    const { field, asc } = state.sort;
    rows = [...rows].sort((a, b) => {
        let av = a[field], bv = b[field];
        if (av === null || av === undefined) av = '';
        if (bv === null || bv === undefined) bv = '';
        if (typeof av === 'string') { av = av.toLowerCase(); bv = String(bv).toLowerCase(); }
        if (av < bv) return asc ? -1 : 1;
        if (av > bv) return asc ? 1 : -1;
        return 0;
    });

    return rows;
}

// ----------------------------------------------------------------
// Filters
// ----------------------------------------------------------------

function renderFilters(container) {
    const bar = container.querySelector('#po-filters-bar');
    bar.innerHTML = `
        <input type="search" id="po-search" placeholder="Search reference / notes"
               value="${escapeHtml(state.filters.search)}" style="width:220px;" />
        <select id="po-source-filter">
            <option value="all">All sources</option>
            <option value="local">Local</option>
            <option value="ebay">eBay</option>
            <option value="tcgplayer">TCGPlayer</option>
            <option value="other">Other</option>
        </select>
        <button class="btn btn-primary" id="po-new-btn" style="margin-left:auto;">+ New PO</button>
    `;

    bar.querySelector('#po-search').addEventListener('input', debounce((e) => {
        state.filters.search = e.target.value;
        renderTable(container);
    }, 250));

    bar.querySelector('#po-source-filter').value = state.filters.source;
    bar.querySelector('#po-source-filter').addEventListener('change', (e) => {
        state.filters.source = e.target.value;
        renderTable(container);
    });

    bar.querySelector('#po-new-btn').addEventListener('click', () => {
        const panel = container.querySelector('#new-po-panel');
        panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
        container.querySelector('#npo-msg').innerHTML = '';
    });
}

// ----------------------------------------------------------------
// New PO
// ----------------------------------------------------------------

function wireNewPoPanel(container) {
    const dateInput = container.querySelector('#npo-date');
    dateInput.value = new Date().toISOString().split('T')[0];

    container.querySelector('#npo-cancel-btn').addEventListener('click', () => {
        container.querySelector('#new-po-panel').style.display = 'none';
    });

    container.querySelector('#npo-save-btn').addEventListener('click', async () => {
        const msg     = container.querySelector('#npo-msg');
        const ref     = container.querySelector('#npo-ref').value.trim();
        const source  = container.querySelector('#npo-source').value;
        const type    = container.querySelector('#npo-type').value;
        const notes   = container.querySelector('#npo-notes').value.trim() || null;
        const dateVal = container.querySelector('#npo-date').value;

        if (!ref) {
            msg.innerHTML = `<span style="color:var(--danger)">Reference # is required.</span>`;
            return;
        }

        msg.innerHTML = `<span style="color:var(--text-secondary)">Creating...</span>`;

        const { data, error } = await supabase
            .from('purchases')
            .insert({
                source,
                purchase_type: type,
                reference_id:  ref,
                total_cost:    0,
                shipping:      parseFloat(container.querySelector('#npo-shipping').value) || 0,
                tax:           parseFloat(container.querySelector('#npo-tax').value) || 0,
                other_cost:    parseFloat(container.querySelector('#npo-other').value) || 0,
                card_count:    0,
                notes,
                purchased_at:  dateVal ? new Date(dateVal).toISOString() : new Date().toISOString(),
            })
            .select('id')
            .single();

        if (error) {
            msg.innerHTML = `<span style="color:var(--danger)">Failed: ${escapeHtml(error.message)}</span>`;
            return;
        }

        container.querySelector('#npo-ref').value   = '';
        container.querySelector('#npo-notes').value = '';
        container.querySelector('#npo-shipping').value = '';
        container.querySelector('#npo-tax').value   = '';
        container.querySelector('#npo-other').value = '';
        container.querySelector('#new-po-panel').style.display = 'none';
        state.expandedPoId = data.id;
        await loadAndRender(container);
    });
}

// ----------------------------------------------------------------
// Table
// ----------------------------------------------------------------

const SORTABLE_COLUMNS = [
    { field: 'purchased_at', label: 'Date' },
    { field: 'reference_id', label: 'Reference #' },
    { field: 'source',       label: 'Source' },
    { field: 'purchase_type', label: 'Type' },
    { field: 'computed_qty', label: 'Cards' },
    { field: 'total_cost',   label: 'Subtotal' },
    { field: 'grand_total',  label: 'Total' },
];

function renderTable(container) {
    const wrap = container.querySelector('#po-table-wrap');
    const rows = visibleRows();

    container.querySelector('#po-summary').textContent =
        `${rows.length} purchase order${rows.length === 1 ? '' : 's'}`;

    if (rows.length === 0) {
        wrap.innerHTML = `<p style="color:var(--text-secondary)">No purchase orders found.</p>`;
        return;
    }

    const headers = SORTABLE_COLUMNS.map(c => {
        const active = state.sort.field === c.field;
        const arrow  = active ? (state.sort.asc ? ' ▲' : ' ▼') : '';
        return `<th data-sort="${c.field}" style="cursor:pointer; user-select:none;">${c.label}${arrow}</th>`;
    }).join('');

    wrap.innerHTML = `
        <table>
            <thead><tr>${headers}<th>Notes</th></tr></thead>
            <tbody>
                ${rows.map(r => poRowHtml(r)).join('')}
            </tbody>
        </table>
    `;

    wrap.querySelectorAll('th[data-sort]').forEach(th => {
        th.addEventListener('click', () => {
            const field = th.dataset.sort;
            if (state.sort.field === field) state.sort.asc = !state.sort.asc;
            else state.sort = { field, asc: true };
            renderTable(container);
        });
    });

    wrap.querySelectorAll('tr[data-po-id]').forEach(tr => {
        tr.addEventListener('click', () => {
            const id = tr.dataset.poId;
            state.expandedPoId = state.expandedPoId === id ? null : id;
            renderTable(container);
        });
    });

    if (state.expandedPoId) {
        const detailCell = wrap.querySelector(`#po-detail-${state.expandedPoId}`);
        const po = state.rows.find(r => r.id === state.expandedPoId);
        if (detailCell && po) renderDetail(container, detailCell, po);
    }
}

function poRowHtml(r) {
    const dateStr = formatDate(r.purchased_at);
    // purchased_at is date-only (always midnight) so it can't distinguish
    // same-day entries -- created_at is a real instant, shown here in the
    // viewer's own local time (unlike purchased_at, this one legitimately
    // has a time-of-day, so no UTC-forcing needed) so multiple POs made
    // the same day can be told apart at a glance.
    const createdStr = r.created_at
        ? new Date(r.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        : '';

    const qtyMismatch  = (r.card_count ?? 0) !== r.computed_qty;
    const costMismatch = Math.abs((r.total_cost ?? 0) - r.computed_cost) > 0.005;

    const qtyCell = qtyMismatch
        ? `${r.card_count ?? 0} <span style="color:var(--warning); font-size:11px;" title="Lots actually total ${r.computed_qty}">⚠ ${r.computed_qty}</span>`
        : `${r.card_count ?? 0}`;

    const costCell = costMismatch
        ? `${formatPrice(r.total_cost)} <span style="color:var(--warning); font-size:11px;" title="Lots actually total ${formatPrice(r.computed_cost)}">⚠ ${formatPrice(r.computed_cost)}</span>`
        : formatPrice(r.total_cost);

    const expanded = state.expandedPoId === r.id;

    let html = `
        <tr data-po-id="${r.id}" style="cursor:pointer;">
            <td>${dateStr}${createdStr ? `<div style="font-size:11px; color:var(--text-secondary);">${createdStr}</div>` : ''}</td>
            <td style="font-family:monospace; font-size:12px;">${escapeHtml(r.reference_id || '—')}</td>
            <td>${sourceBadge(r.source)}</td>
            <td style="font-size:12px; color:var(--text-secondary);">${escapeHtml(r.purchase_type || '—')}</td>
            <td>${qtyCell}</td>
            <td>${costCell}</td>
            <td style="font-weight:500;">${formatPrice(r.grand_total)}</td>
            <td style="font-size:12px; color:var(--text-secondary); max-width:260px;
                       overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                ${escapeHtml(r.notes || '')}
            </td>
        </tr>
    `;

    if (expanded) {
        html += `
            <tr><td colspan="8" style="padding:0; background:var(--bg-secondary);">
                <div id="po-detail-${r.id}" style="padding:16px;">Loading...</div>
            </td></tr>
        `;
    }

    return html;
}

// ----------------------------------------------------------------
// Detail panel
// ----------------------------------------------------------------

async function renderDetail(container, cell, po) {
    cell.innerHTML = 'Loading lots...';

    const { data: lots, error } = await supabase
        .from('v_inventory')
        .select('*')
        .eq('purchase_id', po.id)
        .order('card_name', { ascending: true });

    if (error) {
        cell.innerHTML = `<span style="color:var(--danger)">Failed to load lots: ${escapeHtml(error.message)}</span>`;
        return;
    }

    const lotRows = (lots || []).map(l => `
        <tr>
            <td>
                <div style="font-weight:500; font-size:13px;">${escapeHtml(l.card_name || '')}</div>
                <div style="font-size:11px; color:var(--text-secondary);">${escapeHtml(variantLabel(l))}</div>
            </td>
            <td style="font-size:12px;">${escapeHtml(l.card_number || '—')}</td>
            <td style="font-size:12px; color:var(--text-secondary);">${escapeHtml(l.set_name || '—')}</td>
            <td style="font-size:12px;">${escapeHtml(l.condition || '—')}</td>
            <td style="text-align:right;">${l.quantity ?? '—'}</td>
            <td style="text-align:right;">${formatPrice(l.cost_basis)}</td>
            <td style="text-align:right;">${formatPrice((l.cost_basis || 0) * (l.quantity || 0))}</td>
        </tr>
    `).join('');

    cell.innerHTML = `
        <!-- Editable header -->
        <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; align-items:flex-end;">
            <label style="font-size:12px; color:var(--text-secondary);">Date
                <input type="date" id="pod-date"
                       value="${po.purchased_at ? new Date(po.purchased_at).toISOString().split('T')[0] : ''}"
                       style="width:130px; margin-top:4px; display:block;" />
            </label>
            <label style="font-size:12px; color:var(--text-secondary);">Reference #
                <input type="text" id="pod-ref" value="${escapeHtml(po.reference_id || '')}"
                       style="width:180px; margin-top:4px; display:block;" />
            </label>
            <label style="font-size:12px; color:var(--text-secondary);">Source
                <select id="pod-source" style="margin-top:4px; display:block;">
                    ${['local','ebay','tcgplayer','other'].map(s =>
                        `<option value="${s}" ${po.source === s ? 'selected' : ''}>${s}</option>`).join('')}
                </select>
            </label>
            <label style="font-size:12px; color:var(--text-secondary);">Type
                <select id="pod-type" style="margin-top:4px; display:block;">
                    ${['single','bulk'].map(t =>
                        `<option value="${t}" ${po.purchase_type === t ? 'selected' : ''}>${t}</option>`).join('')}
                </select>
            </label>
            <label style="font-size:12px; color:var(--text-secondary);">Subtotal
                <input type="number" step="0.01" id="pod-cost" value="${po.total_cost ?? ''}"
                       style="width:100px; margin-top:4px; display:block;" />
            </label>
            <label style="font-size:12px; color:var(--text-secondary);">Shipping
                <input type="number" step="0.01" id="pod-shipping" value="${po.shipping ?? 0}"
                       style="width:90px; margin-top:4px; display:block;" />
            </label>
            <label style="font-size:12px; color:var(--text-secondary);">Tax
                <input type="number" step="0.01" id="pod-tax" value="${po.tax ?? 0}"
                       style="width:90px; margin-top:4px; display:block;" />
            </label>
            <label style="font-size:12px; color:var(--text-secondary);">Other
                <input type="number" step="0.01" id="pod-other" value="${po.other_cost ?? 0}"
                       style="width:90px; margin-top:4px; display:block;" />
            </label>
            <div style="font-size:12px; color:var(--text-secondary);">Total
                <div id="pod-grand" style="width:110px; margin-top:4px; padding:6px 8px;
                     border:1px solid var(--border); border-radius:4px; background:var(--bg-tertiary);
                     color:var(--text); font-weight:600;">${formatPrice(po.grand_total)}</div>
            </div>
            <label style="font-size:12px; color:var(--text-secondary);">Card count
                <input type="number" id="pod-count" value="${po.card_count ?? ''}"
                       style="width:80px; margin-top:4px; display:block;" />
            </label>
            <label style="font-size:12px; color:var(--text-secondary); flex:1; min-width:200px;">Notes
                <input type="text" id="pod-notes" value="${escapeHtml(po.notes || '')}"
                       style="width:100%; margin-top:4px; display:block;" />
            </label>
        </div>
        <div style="display:flex; gap:8px; align-items:center; margin-bottom:16px; flex-wrap:wrap;">
            <button class="btn btn-primary" id="pod-save-btn">Save header</button>
            <button class="btn" id="pod-sync-btn"
                    title="Set subtotal / card count from the lots below (shipping, tax, other unchanged)">Set subtotal from lots</button>
            <button class="btn" id="pod-link-btn">Link lots to another PO…</button>
            ${(lots || []).length === 0
                ? `<button class="btn" id="pod-delete-btn" style="color:var(--danger);">Delete PO</button>`
                : ''}
            <span id="pod-msg" style="font-size:12px;"></span>
        </div>

        <!-- Lots -->
        <div style="font-size:12px; font-weight:600; color:var(--text-secondary);
                    text-transform:uppercase; letter-spacing:0.04em; margin-bottom:8px;">
            Lots (${(lots || []).length}) — ${po.computed_qty} cards, ${formatPrice(po.computed_cost)}
        </div>
        ${(lots || []).length === 0
            ? `<p style="font-size:13px; color:var(--text-secondary);">No inventory lots linked to this PO.</p>`
            : `<table style="margin-bottom:8px;">
                   <thead><tr>
                       <th>Card</th><th>#</th><th>Set</th><th>Condition</th>
                       <th style="text-align:right;">Qty</th>
                       <th style="text-align:right;">Cost/ea</th>
                       <th style="text-align:right;">Subtotal</th>
                   </tr></thead>
                   <tbody>${lotRows}</tbody>
               </table>`}

        <!-- Add card -->
        <div style="border-top:1px solid var(--border); padding-top:14px; margin-top:14px;">
            <div style="font-size:12px; font-weight:600; color:var(--text-secondary);
                        text-transform:uppercase; letter-spacing:0.04em; margin-bottom:8px;">
                Add card to this PO
            </div>
            <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:10px;">
                <label style="font-size:12px; color:var(--text-secondary);">Card name
                    <input type="text" id="pac-name" placeholder="search cards..." autocomplete="off"
                           style="width:220px; margin-top:4px; display:block;" />
                </label>
                <label style="font-size:12px; color:var(--text-secondary);">Set
                    <input type="text" id="pac-set" placeholder="filter (optional)"
                           style="width:160px; margin-top:4px; display:block;" />
                </label>
                <label style="font-size:12px; color:var(--text-secondary);">#
                    <input type="text" id="pac-num" placeholder="optional"
                           style="width:70px; margin-top:4px; display:block;" />
                </label>
            </div>
            <div id="pac-selected" style="font-size:12px; color:var(--text-secondary); margin-bottom:10px;">
                No card selected — search above and pick from the dropdown.
            </div>
            <div id="pac-axes" style="display:none; gap:10px; flex-wrap:wrap; margin-bottom:10px;">
                ${AXES.map(axis => `
                    <label style="font-size:12px; color:var(--text-secondary); text-transform:capitalize;">
                        ${axis.replace('_', ' ')}
                        <select id="pac-axis-${axis}" style="margin-top:4px; display:block;"></select>
                    </label>
                `).join('')}
            </div>
            <div id="pac-lot-fields" style="display:none; gap:10px; flex-wrap:wrap; margin-bottom:10px;">
                <label style="font-size:12px; color:var(--text-secondary);">Condition
                    <select id="pac-condition" style="margin-top:4px; display:block;">
                        <option value="Near Mint">Near Mint</option>
                        <option value="Lightly Played">Lightly Played</option>
                        <option value="Moderately Played">Moderately Played</option>
                        <option value="Heavily Played">Heavily Played</option>
                        <option value="Damaged">Damaged</option>
                    </select>
                </label>
                <label style="font-size:12px; color:var(--text-secondary);">Qty
                    <input type="number" id="pac-qty" min="1" value="1"
                           style="width:70px; margin-top:4px; display:block;" />
                </label>
                <label style="font-size:12px; color:var(--text-secondary);">Cost/ea
                    <input type="number" step="0.01" id="pac-cost" placeholder="0.00"
                           style="width:90px; margin-top:4px; display:block;" />
                </label>
                <label style="font-size:12px; color:var(--text-secondary);">Notes
                    <input type="text" id="pac-notes" placeholder="optional"
                           style="width:180px; margin-top:4px; display:block;" />
                </label>
            </div>
            <div style="display:flex; gap:8px; align-items:center;">
                <button class="btn btn-primary" id="pac-add-btn" disabled>Add to PO</button>
                <span id="pac-msg" style="font-size:12px;"></span>
            </div>
        </div>

        <!-- Link/merge panel -->
        <div id="pod-link-panel" style="display:none; border-top:1px solid var(--border);
             padding-top:14px; margin-top:14px;">
            <div style="font-size:12px; font-weight:600; color:var(--text-secondary);
                        text-transform:uppercase; letter-spacing:0.04em; margin-bottom:8px;">
                Link lots to another PO
            </div>
            <div style="font-size:12px; color:var(--text-secondary); margin-bottom:10px;">
                Moves all ${(lots || []).length} lot(s) to the target PO, adds this PO's stored totals
                (${formatPrice(po.total_cost)}, ${po.card_count ?? 0} cards) to the target, then deletes this PO.
            </div>
            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                <select id="pod-link-target" style="min-width:280px;">
                    <option value="">— select target PO —</option>
                    ${state.rows.filter(r => r.id !== po.id).map(r => {
                        const d = formatDate(r.purchased_at);
                        return `<option value="${r.id}">${escapeHtml(r.reference_id || '(no ref)')} · ${d} · ${escapeHtml(r.source)} · ${formatPrice(r.total_cost)}</option>`;
                    }).join('')}
                </select>
                <button class="btn btn-primary" id="pod-link-confirm-btn">Link &amp; delete this PO</button>
                <button class="btn" id="pod-link-cancel-btn">Cancel</button>
            </div>
        </div>
    `;

    const msg = cell.querySelector('#pod-msg');

    // Prevent clicks inside the detail from collapsing the row
    cell.addEventListener('click', e => e.stopPropagation());

    // Live grand-total recalc as cost fields change
    const grandDiv = cell.querySelector('#pod-grand');
    const recalcGrand = () => {
        const sub  = parseFloat(cell.querySelector('#pod-cost').value) || 0;
        const ship = parseFloat(cell.querySelector('#pod-shipping').value) || 0;
        const tax  = parseFloat(cell.querySelector('#pod-tax').value) || 0;
        const oth  = parseFloat(cell.querySelector('#pod-other').value) || 0;
        grandDiv.textContent = formatPrice(sub + ship + tax + oth);
    };
    ['#pod-cost', '#pod-shipping', '#pod-tax', '#pod-other'].forEach(sel =>
        cell.querySelector(sel).addEventListener('input', recalcGrand));

    // Save header
    cell.querySelector('#pod-save-btn').addEventListener('click', async () => {
        const dateVal = cell.querySelector('#pod-date').value;
        const patch = {
            reference_id:  cell.querySelector('#pod-ref').value.trim() || null,
            source:        cell.querySelector('#pod-source').value,
            purchase_type: cell.querySelector('#pod-type').value,
            total_cost:    parseFloat(cell.querySelector('#pod-cost').value) || 0,
            shipping:      parseFloat(cell.querySelector('#pod-shipping').value) || 0,
            tax:           parseFloat(cell.querySelector('#pod-tax').value) || 0,
            other_cost:    parseFloat(cell.querySelector('#pod-other').value) || 0,
            card_count:    parseInt(cell.querySelector('#pod-count').value) || 0,
            notes:         cell.querySelector('#pod-notes').value.trim() || null,
            purchased_at:  dateVal ? new Date(dateVal).toISOString() : po.purchased_at,
        };
        msg.innerHTML = `<span style="color:var(--text-secondary)">Saving...</span>`;
        const { error } = await supabase.from('purchases').update(patch).eq('id', po.id);
        if (error) {
            msg.innerHTML = `<span style="color:var(--danger)">Save failed: ${escapeHtml(error.message)}</span>`;
            return;
        }
        await loadAndRender(container);
    });

    // Sync totals from lots
    cell.querySelector('#pod-sync-btn').addEventListener('click', async () => {
        msg.innerHTML = `<span style="color:var(--text-secondary)">Updating...</span>`;
        const { error } = await supabase.from('purchases').update({
            total_cost: Math.round(po.computed_cost * 100) / 100,
            card_count: po.computed_qty,
        }).eq('id', po.id);
        if (error) {
            msg.innerHTML = `<span style="color:var(--danger)">Failed: ${escapeHtml(error.message)}</span>`;
            return;
        }
        await loadAndRender(container);
    });

    // Delete (only rendered when 0 lots)
    const delBtn = cell.querySelector('#pod-delete-btn');
    if (delBtn) {
        delBtn.addEventListener('click', async () => {
            if (!confirm(`Delete PO ${po.reference_id || ''}? This cannot be undone.`)) return;
            msg.innerHTML = `<span style="color:var(--text-secondary)">Deleting...</span>`;
            const { error } = await supabase.from('purchases').delete().eq('id', po.id);
            if (error) {
                msg.innerHTML = `<span style="color:var(--danger)">Delete failed: ${escapeHtml(error.message)}</span>`;
                return;
            }
            state.expandedPoId = null;
            await loadAndRender(container);
        });
    }

    // Link/merge panel toggle — the panel sits below the lots table AND the
    // full "Add card to this PO" form, so opening it can land well below
    // the fold with nothing visibly changing near the button; scroll it
    // into view so the toggle is never mistaken for "not working".
    cell.querySelector('#pod-link-btn').addEventListener('click', () => {
        const panel = cell.querySelector('#pod-link-panel');
        const opening = panel.style.display === 'none';
        panel.style.display = opening ? 'block' : 'none';
        if (opening) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    cell.querySelector('#pod-link-cancel-btn').addEventListener('click', () => {
        cell.querySelector('#pod-link-panel').style.display = 'none';
    });

    // Link/merge confirm
    cell.querySelector('#pod-link-confirm-btn').addEventListener('click', async () => {
        const targetId = cell.querySelector('#pod-link-target').value;
        if (!targetId) {
            msg.innerHTML = `<span style="color:var(--danger)">Select a target PO first.</span>`;
            return;
        }
        const target = state.rows.find(r => r.id === targetId);
        if (!confirm(
            `Move ${(lots || []).length} lot(s) into PO ${target.reference_id || ''}, ` +
            `add ${formatPrice(po.total_cost)} / ${po.card_count ?? 0} cards to its totals, ` +
            `and delete PO ${po.reference_id || ''}?`)) return;

        msg.innerHTML = `<span style="color:var(--text-secondary)">Linking...</span>`;

        // 1. Reassign lots
        const { error: moveErr } = await supabase
            .from('inventory')
            .update({ purchase_id: targetId })
            .eq('purchase_id', po.id);
        if (moveErr) {
            msg.innerHTML = `<span style="color:var(--danger)">Failed to move lots: ${escapeHtml(moveErr.message)}</span>`;
            return;
        }

        // 2. Add source totals into target (subtotal + all extra costs)
        const { error: totErr } = await supabase.from('purchases').update({
            total_cost: Math.round(((target.total_cost || 0) + (po.total_cost || 0)) * 100) / 100,
            shipping:   Math.round(((target.shipping   || 0) + (po.shipping   || 0)) * 100) / 100,
            tax:        Math.round(((target.tax        || 0) + (po.tax        || 0)) * 100) / 100,
            other_cost: Math.round(((target.other_cost || 0) + (po.other_cost || 0)) * 100) / 100,
            card_count: (target.card_count || 0) + (po.card_count || 0),
        }).eq('id', targetId);
        if (totErr) {
            msg.innerHTML = `<span style="color:var(--danger)">Lots moved, but target totals update failed: ${escapeHtml(totErr.message)}</span>`;
            return;
        }

        // 3. Delete the now-empty source PO
        const { error: delErr } = await supabase.from('purchases').delete().eq('id', po.id);
        if (delErr) {
            msg.innerHTML = `<span style="color:var(--warning)">Lots moved and totals updated, but deleting the empty PO failed: ${escapeHtml(delErr.message)}</span>`;
            state.expandedPoId = targetId;
            await loadAndRender(container);
            return;
        }

        state.expandedPoId = targetId;
        await loadAndRender(container);
    });

    // ── Add card to this PO ──────────────────────────────────────
    let selectedCard = null;

    const nameInput = cell.querySelector('#pac-name');
    const setInput  = cell.querySelector('#pac-set');
    const numInput  = cell.querySelector('#pac-num');
    const addBtn    = cell.querySelector('#pac-add-btn');
    const selDiv    = cell.querySelector('#pac-selected');
    const pacMsg    = cell.querySelector('#pac-msg');

    function fillAxisDropdowns(card) {
        for (const axis of AXES) {
            const sel = cell.querySelector(`#pac-axis-${axis}`);
            sel.innerHTML = (AXIS_OPTIONS[axis] || [['', '— none —']])
                .map(([code, label]) =>
                    `<option value="${escapeHtml(code)}">${escapeHtml(label)}</option>`)
                .join('');
            sel.value = card?.[axis] || '';
        }
    }

    function showSelected(card) {
        selectedCard = card;
        selDiv.innerHTML = `
            Selected: <strong style="color:var(--text);">${escapeHtml(card.name)}</strong>
            — ${escapeHtml(card.set_name || '?')} #${escapeHtml(card.number || '—')}
            · <span style="color:var(--accent);">${escapeHtml(card.variant_label)}</span>
            <button class="btn" id="pac-clear-btn" style="margin-left:8px; padding:2px 8px; font-size:11px;">Clear</button>
        `;
        selDiv.querySelector('#pac-clear-btn').addEventListener('click', clearSelected);
        fillAxisDropdowns(card);
        cell.querySelector('#pac-axes').style.display = 'flex';
        cell.querySelector('#pac-lot-fields').style.display = 'flex';
        addBtn.disabled = false;
    }

    function clearSelected() {
        selectedCard = null;
        selDiv.textContent = 'No card selected — search above and pick from the dropdown.';
        cell.querySelector('#pac-axes').style.display = 'none';
        cell.querySelector('#pac-lot-fields').style.display = 'none';
        addBtn.disabled = true;
    }

    wireAutocomplete({
        input: nameInput,
        container: cell,
        search: (term) => searchDB(term, numInput.value.trim() || null, setInput.value.trim() || null),
        renderItem: (c) =>
            `${c.name} — ${c.set_name || '?'} #${c.number || '—'} · ${c.variant_label}` +
            (c.rarity ? ` · ${c.rarity}` : ''),
        onSelect: showSelected,
    });

    addBtn.addEventListener('click', async () => {
        if (!selectedCard) return;

        const qty  = parseInt(cell.querySelector('#pac-qty').value);
        const cost = parseFloat(cell.querySelector('#pac-cost').value) || 0;
        if (isNaN(qty) || qty < 1) {
            pacMsg.innerHTML = `<span style="color:var(--danger)">Enter a valid quantity.</span>`;
            return;
        }

        pacMsg.innerHTML = `<span style="color:var(--text-secondary)">Adding...</span>`;

        // 1. Resolve variant from the axis dropdowns (creates it if it
        //    doesn't exist yet — the only web-side place this is allowed,
        //    same role push_staging_row_to_inventory plays for imports).
        const axisArgs = {};
        for (const axis of AXES) {
            axisArgs[`p_${axis}`] = cell.querySelector(`#pac-axis-${axis}`).value || null;
        }
        const { data: variantId, error: rpcErr } = await supabase
            .rpc('get_or_create_variant_web', { p_card_id: selectedCard.card_id, ...axisArgs });
        if (rpcErr) {
            pacMsg.innerHTML = `<span style="color:var(--danger)">Variant lookup failed: ${escapeHtml(rpcErr.message)}</span>`;
            return;
        }

        // 2. Insert the inventory lot on this PO
        const { error: invErr } = await supabase.from('inventory').insert({
            card_id:     selectedCard.card_id,
            variant_id:  variantId,
            purchase_id: po.id,
            condition:   cell.querySelector('#pac-condition').value,
            is_graded:   false,
            quantity:    qty,
            cost_basis:  cost,
            notes:       cell.querySelector('#pac-notes').value.trim() || null,
            acquired_at: po.purchased_at || new Date().toISOString(),
        });
        if (invErr) {
            pacMsg.innerHTML = `<span style="color:var(--danger)">Failed to add lot: ${escapeHtml(invErr.message)}</span>`;
            return;
        }

        // 3. Bump the PO's stored totals
        const { error: totErr } = await supabase.from('purchases').update({
            total_cost: Math.round(((po.total_cost || 0) + cost * qty) * 100) / 100,
            card_count: (po.card_count || 0) + qty,
        }).eq('id', po.id);
        if (totErr) {
            pacMsg.innerHTML = `<span style="color:var(--warning)">Lot added, but PO totals update failed: ${escapeHtml(totErr.message)}</span>`;
        }

        await loadAndRender(container);
    });
}

// ----------------------------------------------------------------
// Card search (same shape as Staging Review's searchDB, incl. the
// card_master merge for cards with no card_variants row yet)
// ----------------------------------------------------------------

async function searchDB(name, num, setName) {
    let q = supabase
        .from('v_card_variants')
        .select('card_id, variant_id, card_name, set_name, display_number, card_number, foil_label, pattern_label, texture_label, rarity, foil_type, foil_pattern, texture, material, size, stamp_type, source_type')
        .ilike('card_name', `%${name}%`)
        .limit(15);
    if (num)     q = q.eq('card_number', num);
    if (setName) q = q.ilike('set_name', `%${setName}%`);

    const { data, error } = await q;
    if (error) console.error('DB search error (variants):', error);

    const withVariants = (data || []).map(c => ({
        card_id:     c.card_id,
        variant_id:  c.variant_id,
        name:        c.card_name,
        number:      c.display_number || c.card_number,
        set_name:    c.set_name,
        rarity:      c.rarity,
        variant_label: [c.foil_label, c.pattern_label, c.texture_label].filter(Boolean).join(' · ') || 'Non-Holo',
        foil_type:    c.foil_type,
        foil_pattern: c.foil_pattern,
        texture:      c.texture,
        material:     c.material,
        size:         c.size,
        stamp_type:   c.stamp_type,
        source_type:  c.source_type,
    }));

    // card_master directly, for cards with no card_variants row yet
    let cmq = supabase
        .from('card_master')
        .select('id, name, card_number, rarity, card_sets(name)')
        .ilike('name', `%${name}%`)
        .limit(15);
    if (num) cmq = cmq.eq('card_number', num);

    const { data: cmData, error: cmError } = await cmq;
    if (cmError) console.error('DB search error (card_master):', cmError);

    const alreadyHaveVariant = new Set(withVariants.map(c => c.card_id));
    const setNameLower = (setName || '').toLowerCase();

    const withoutVariants = (cmData || [])
        .filter(c => !alreadyHaveVariant.has(c.id))
        .filter(c => !setNameLower || (c.card_sets?.name || '').toLowerCase().includes(setNameLower))
        .map(c => ({
            card_id:     c.id,
            variant_id:  null,
            name:        c.name,
            number:      c.card_number,
            set_name:    c.card_sets?.name || '',
            rarity:      c.rarity,
            variant_label: 'No variant yet',
            foil_type: null, foil_pattern: null, texture: null,
            material: null, size: null, stamp_type: null, source_type: null,
        }));

    return [...withVariants, ...withoutVariants];
}

function wireAutocomplete({ input, container, search, renderItem, onSelect }) {
    let dropdown = null;

    const removeDropdown = () => {
        dropdown?.remove();
        dropdown = null;
    };

    input.addEventListener('input', debounce(async () => {
        const term = input.value.trim();
        removeDropdown();
        if (term.length < 2) return;

        const results = await search(term);
        if (!results.length) return;

        dropdown = document.createElement('div');
        dropdown.style.cssText = `
            position: absolute;
            background: var(--bg-secondary);
            border: 1px solid var(--border);
            border-radius: 4px;
            z-index: 100;
            max-height: 200px;
            overflow-y: auto;
            width: ${Math.max(input.offsetWidth, 340)}px;
            font-size: 13px;
        `;

        results.forEach(item => {
            const div = document.createElement('div');
            div.textContent = renderItem(item);
            div.style.cssText = 'padding: 6px 10px; cursor: pointer;';
            div.addEventListener('mouseenter', () => div.style.background = 'var(--bg-tertiary)');
            div.addEventListener('mouseleave', () => div.style.background = '');
            div.addEventListener('mousedown', (e) => {
                e.preventDefault();
                onSelect(item);
                removeDropdown();
            });
            dropdown.appendChild(div);
        });

        input.parentElement.style.position = 'relative';
        input.parentElement.appendChild(dropdown);
        dropdown.style.top = input.offsetHeight + 'px';
        dropdown.style.left = '0px';
    }, 300));

    input.addEventListener('blur', () => setTimeout(removeDropdown, 150));
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

function variantLabel(row) {
    return [
        axisDisplay('foil_type', row.foil_type),
        axisDisplay('foil_pattern', row.foil_pattern),
        axisDisplay('texture', row.texture),
        axisDisplay('material', row.material),
        axisDisplay('size', row.size),
        axisDisplay('stamp_type', row.stamp_type),
        axisDisplay('source_type', row.source_type),
    ].filter(Boolean).join(' · ') || 'Non-Holo';
}

function sourceBadge(source) {
    if (!source) return '—';
    const map = {
        ebay:      { color: '#f5a623', bg: 'rgba(245,166,35,0.12)' },
        tcgplayer: { color: '#4a8cff', bg: 'rgba(74,140,255,0.12)' },
    };
    const s = map[source] || { color: 'var(--text-secondary)', bg: 'rgba(255,255,255,0.05)' };
    return `<span style="display:inline-block; padding:2px 8px; border-radius:10px;
        font-size:11px; font-weight:500; color:${s.color}; background:${s.bg};">
        ${escapeHtml(source)}
    </span>`;
}

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// sales.js
// Sales page: record sales (FIFO depletion via the record_sale RPC) and
// browse sale history grouped at ORDER level.
//
// Grouping: rows sharing a platform_order_id (per platform/account) are one
// order; rows without an order id (local/manual sales) fall back to their
// sale_group_id — displayed as single-event "orders".
//
// Fees: order-level facts (final value fee, promo fee, label cost, buyer-paid
// shipping, refunds) live in sale_orders, populated by a separate fee-sync
// process. Per-card fee shares are COMPUTED here at display time,
// proportional to each card's revenue share of the order — never stored.
//
// Expansion is two-level: order row -> cards in the order -> (click a card)
// FIFO lot breakdown for that sale event.
//
// Deleting is per sale event (sale_group_id) via the delete_sale_group RPC,
// same as before — in a multi-card order each card row has its own delete.

import { supabase, debounce, formatPrice, loadAxisOptions, axisDisplay } from './shared.js';

const state = {
    rows: [],            // v_sales rows
    orderHeaders: {},    // orderKey -> sale_orders row
    lineFees: {},         // lineFeeKey -> sale_line_item_fees row
    filters: {
        search: '',
        platform: 'all',
    },
    expandedOrderKey: null,
    expandedGroupId: null,   // second-level: which card (sale event) shows lots
};

export async function renderSales(container) {
    container.innerHTML = `
        <div style="display:flex; align-items:baseline; gap:16px; margin-bottom:20px;">
            <h2 style="margin:0;">Sales</h2>
            <div id="sales-summary" style="font-size:13px; color:var(--text-secondary);"></div>
        </div>
        <div class="filters-bar" id="sales-filters-bar"></div>

        <!-- Record sale inline panel -->
        <div id="new-sale-panel" style="display:none; border:1px solid var(--border);
             border-radius:8px; padding:16px; margin-bottom:16px; background:var(--bg-secondary);">
            <div style="font-size:12px; font-weight:600; color:var(--text-secondary);
                        text-transform:uppercase; letter-spacing:0.04em; margin-bottom:12px;">
                Record Sale
            </div>
            <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:10px;">
                <label style="font-size:12px; color:var(--text-secondary);">Card name
                    <input type="text" id="ns-name" placeholder="search cards with stock..." autocomplete="off"
                           style="width:220px; margin-top:4px; display:block;" />
                </label>
                <label style="font-size:12px; color:var(--text-secondary);">Set
                    <input type="text" id="ns-set" placeholder="filter (optional)"
                           style="width:160px; margin-top:4px; display:block;" />
                </label>
                <label style="font-size:12px; color:var(--text-secondary);">#
                    <input type="text" id="ns-num" placeholder="optional"
                           style="width:70px; margin-top:4px; display:block;" />
                </label>
            </div>
            <div id="ns-selected" style="font-size:12px; color:var(--text-secondary); margin-bottom:10px;">
                No card selected — search above and pick from the dropdown.
            </div>
            <div id="ns-sale-fields" style="display:none; gap:10px; flex-wrap:wrap; margin-bottom:10px;">
                <label style="font-size:12px; color:var(--text-secondary);">Condition
                    <select id="ns-condition" style="margin-top:4px; display:block; min-width:170px;"></select>
                </label>
                <label style="font-size:12px; color:var(--text-secondary);">Qty
                    <input type="number" id="ns-qty" min="1" value="1"
                           style="width:70px; margin-top:4px; display:block;" />
                </label>
                <label style="font-size:12px; color:var(--text-secondary);">Price/ea
                    <input type="number" step="0.01" id="ns-price" placeholder="0.00"
                           style="width:90px; margin-top:4px; display:block;" />
                </label>
                <label style="font-size:12px; color:var(--text-secondary);">Platform
                    <select id="ns-platform" style="margin-top:4px; display:block;">
                        <option value="ebay">eBay</option>
                        <option value="tcgplayer">TCGPlayer</option>
                        <option value="local">Local</option>
                        <option value="other">Other</option>
                    </select>
                </label>
                <label style="font-size:12px; color:var(--text-secondary);">Account
                    <input type="text" id="ns-account" placeholder="optional"
                           style="width:120px; margin-top:4px; display:block;" />
                </label>
                <label style="font-size:12px; color:var(--text-secondary);">Date
                    <input type="date" id="ns-date"
                           style="width:130px; margin-top:4px; display:block;" />
                </label>
                <label style="font-size:12px; color:var(--text-secondary);">Order #
                    <input type="text" id="ns-order" placeholder="optional"
                           style="width:140px; margin-top:4px; display:block;" />
                </label>
                <label style="font-size:12px; color:var(--text-secondary);">Notes
                    <input type="text" id="ns-notes" placeholder="optional"
                           style="width:180px; margin-top:4px; display:block;" />
                </label>
            </div>
            <div style="display:flex; gap:8px; align-items:center;">
                <button class="btn btn-primary" id="ns-save-btn" disabled>Record sale</button>
                <button class="btn" id="ns-cancel-btn">Cancel</button>
                <span id="ns-msg" style="font-size:12px; margin-left:8px;"></span>
            </div>
        </div>

        <div id="sales-table-wrap"><p>Loading sales...</p></div>
    `;

    await loadAxisOptions();   // variant labels
    renderFilters(container);
    wireNewSalePanel(container);
    await loadAndRender(container);
}

// ----------------------------------------------------------------
// Data
// ----------------------------------------------------------------

async function loadAndRender(container) {
    const wrap = container.querySelector('#sales-table-wrap');
    wrap.innerHTML = '<p>Loading sales...</p>';

    const [salesRes, ordersRes, lineFeesRes] = await Promise.all([
        supabase
            .from('v_sales')
            .select('*')
            .order('sold_at', { ascending: false })
            .order('created_at', { ascending: false })
            .limit(500),
        supabase
            .from('sale_orders')
            .select('*'),
        supabase
            .from('sale_line_item_fees')
            .select('*'),
    ]);

    if (salesRes.error) {
        wrap.innerHTML = `<p style="color:var(--danger)">Failed to load sales: ${escapeHtml(salesRes.error.message)}</p>`;
        return;
    }

    state.rows = salesRes.data || [];

    state.orderHeaders = {};
    if (!ordersRes.error) {
        for (const o of (ordersRes.data || [])) {
            state.orderHeaders[orderKeyFromHeader(o)] = o;
        }
    } else {
        // Non-fatal: page still works, fees just show as not synced.
        console.error('Failed to load sale_orders:', ordersRes.error);
    }

    state.lineFees = {};
    if (!lineFeesRes.error) {
        for (const lf of (lineFeesRes.data || [])) {
            state.lineFees[lineFeeKey(lf.platform, lf.account, lf.order_line_item_id)] = lf;
        }
    } else {
        // Non-fatal: page still works, per-card fee shares just fall back to
        // the order-level proportional split.
        console.error('Failed to load sale_line_item_fees:', lineFeesRes.error);
    }

    renderTable(container);
}

function orderKeyFromHeader(o) {
    return `${o.platform}|${o.account || ''}|${o.platform_order_id}`;
}

function lineFeeKey(platform, account, orderLineItemId) {
    return `${platform}|${account || ''}|${orderLineItemId}`;
}

function orderKeyFromSale(r) {
    if (r.platform_order_id) {
        return `${r.platform}|${r.account || ''}|${r.platform_order_id}`;
    }
    return `group:${r.sale_group_id}`;
}

// ----------------------------------------------------------------
// Grouping: v_sales rows -> sale events (sale_group_id) -> orders
// ----------------------------------------------------------------

function visibleOrders() {
    const f = state.filters;
    let rows = state.rows;

    if (f.platform !== 'all') rows = rows.filter(r => r.platform === f.platform);
    if (f.search.trim()) {
        const q = f.search.trim().toLowerCase();
        rows = rows.filter(r =>
            (r.card_name || '').toLowerCase().includes(q) ||
            (r.set_name || '').toLowerCase().includes(q) ||
            (r.platform_order_id || '').toLowerCase().includes(q) ||
            (r.notes || '').toLowerCase().includes(q));
    }

    // Pass 1: group v_sales rows into sale events by sale_group_id
    const events = [];
    const eventById = {};
    for (const r of rows) {
        if (!eventById[r.sale_group_id]) {
            eventById[r.sale_group_id] = { id: r.sale_group_id, rows: [] };
            events.push(eventById[r.sale_group_id]);
        }
        eventById[r.sale_group_id].rows.push(r);
    }
    for (const ev of events) {
        ev.qty         = ev.rows.reduce((a, r) => a + (r.quantity_sold || 0), 0);
        ev.revenue     = ev.rows.reduce((a, r) => a + (r.sale_price || 0) * (r.quantity_sold || 0), 0);
        ev.grossProfit = ev.rows.reduce((a, r) => a + (r.profit ?? 0), 0);
        ev.landedCost  = ev.revenue - ev.grossProfit;
        ev.hasNullCost = ev.rows.some(r => r.landed_cost_per_unit === null);
        ev.first       = ev.rows[0];

        // Real per-card fee data, looked up by order_line_item_id. A sale
        // event's rows (FIFO lots from one sale) normally share a single
        // eBay line item id, but sum across distinct ids defensively in
        // case a sale ever spans more than one.
        const lineIds = [...new Set(ev.rows.map(r => r.order_line_item_id).filter(Boolean))];
        ev.lineFVF = 0; ev.lineDiscount = 0; ev.lineRefund = 0; ev.hasLineFeeData = false;
        for (const lid of lineIds) {
            const key = lineFeeKey(ev.first.platform, ev.first.account, lid);
            const lf = state.lineFees[key];
            if (lf) {
                ev.hasLineFeeData = true;
                ev.lineFVF      += lf.final_value_fee || 0;
                ev.lineDiscount += lf.discount_amount || 0;
                ev.lineRefund   += lf.refund_amount || 0;
            }
        }
    }

    // Pass 2: group sale events into orders
    const orders = [];
    const orderByKey = {};
    for (const ev of events) {
        const key = orderKeyFromSale(ev.first);
        if (!orderByKey[key]) {
            orderByKey[key] = { key, events: [] };
            orders.push(orderByKey[key]);
        }
        orderByKey[key].events.push(ev);
    }

    for (const o of orders) {
        const first = o.events[0].first;
        o.first       = first;
        o.header      = state.orderHeaders[o.key] || null;
        o.qty         = o.events.reduce((a, ev) => a + ev.qty, 0);
        o.itemRevenue = o.events.reduce((a, ev) => a + ev.revenue, 0);
        o.grossProfit = o.events.reduce((a, ev) => a + ev.grossProfit, 0);
        o.hasNullCost = o.events.some(ev => ev.hasNullCost);

        const h = o.header;

        // Real, per-card totals (sum of what eBay actually reported per line)
        o.lineFVFTotal      = o.events.reduce((a, ev) => a + ev.lineFVF, 0);
        o.lineDiscountTotal = o.events.reduce((a, ev) => a + ev.lineDiscount, 0);  // informational only —
                                                                                    // already reflected in sale_price
        o.lineRefundTotal   = o.events.reduce((a, ev) => a + ev.lineRefund, 0);

        // Order-level facts (no per-line breakdown exists for these)
        o.shipping           = h?.shipping_charged ?? 0;
        o.labelCost          = h?.label_cost ?? 0;
        o.returnLabelCost    = h?.return_label_cost ?? 0;
        o.promoFee           = h?.promo_fee ?? 0;
        o.fvfFixed           = h?.final_value_fee_fixed ?? 0;
        o.salesTax           = h?.sales_tax ?? 0;         // pass-through, never subtracted from earnings
        o.promoDiscount      = h?.promo_discount ?? 0;    // informational — already reflected in sale_price
        o.orderCatchAllRefund = h?.refund_amount ?? 0;     // rare: refund with no per-line breakdown

        // Costs that need spreading across cards for display, proportional
        // to each card's revenue share of the order (matches how eBay itself
        // spread a shipping-related refund across line items — see project notes).
        o.spreadPool = o.labelCost + o.promoFee + o.fvfFixed;

        o.fees   = o.lineFVFTotal + o.spreadPool;
        o.refund = o.lineRefundTotal + o.returnLabelCost + o.orderCatchAllRefund;
        o.revenue = o.itemRevenue + o.shipping;
        o.net     = o.grossProfit + o.shipping - o.fees - o.refund;

        // "Fees pending" = platform order exists but no synced header yet.
        // Local/manual sales (no platform_order_id) never expect fees.
        o.isPlatformOrder = !!first.platform_order_id;
        o.feesPending = o.isPlatformOrder && !(h?.fees_synced_at);
    }

    return orders;
}

// ----------------------------------------------------------------
// Filters
// ----------------------------------------------------------------

function renderFilters(container) {
    const bar = container.querySelector('#sales-filters-bar');
    bar.innerHTML = `
        <input type="search" id="sales-search" placeholder="Search card / set / order # / notes"
               value="${escapeHtml(state.filters.search)}" style="width:250px;" />
        <select id="sales-platform-filter">
            <option value="all">All platforms</option>
            <option value="ebay">eBay</option>
            <option value="tcgplayer">TCGPlayer</option>
            <option value="local">Local</option>
            <option value="other">Other</option>
        </select>
        <button class="btn btn-primary" id="sales-new-btn" style="margin-left:auto;">+ Record sale</button>
    `;

    bar.querySelector('#sales-search').addEventListener('input', debounce((e) => {
        state.filters.search = e.target.value;
        renderTable(container);
    }, 250));

    bar.querySelector('#sales-platform-filter').value = state.filters.platform;
    bar.querySelector('#sales-platform-filter').addEventListener('change', (e) => {
        state.filters.platform = e.target.value;
        renderTable(container);
    });

    bar.querySelector('#sales-new-btn').addEventListener('click', () => {
        const panel = container.querySelector('#new-sale-panel');
        panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
        container.querySelector('#ns-msg').innerHTML = '';
    });
}

// ----------------------------------------------------------------
// Record sale panel (unchanged behavior)
// ----------------------------------------------------------------

function wireNewSalePanel(container) {
    const panel = container.querySelector('#new-sale-panel');
    let selectedCard = null;   // { variant_id, name, set_name, number, variant_label }
    let stockByCondition = {}; // condition -> remaining

    const nameInput = panel.querySelector('#ns-name');
    const setInput  = panel.querySelector('#ns-set');
    const numInput  = panel.querySelector('#ns-num');
    const saveBtn   = panel.querySelector('#ns-save-btn');
    const selDiv    = panel.querySelector('#ns-selected');
    const msg       = panel.querySelector('#ns-msg');

    panel.querySelector('#ns-date').value = new Date().toISOString().split('T')[0];

    panel.querySelector('#ns-cancel-btn').addEventListener('click', () => {
        panel.style.display = 'none';
    });

    async function showSelected(card) {
        selectedCard = card;
        selDiv.innerHTML = `
            Selected: <strong style="color:var(--text);">${escapeHtml(card.name)}</strong>
            — ${escapeHtml(card.set_name || '?')} #${escapeHtml(card.number || '—')}
            · <span style="color:var(--accent);">${escapeHtml(card.variant_label)}</span>
            <span id="ns-stock-note" style="margin-left:8px;"></span>
            <button class="btn" id="ns-clear-btn" style="margin-left:8px; padding:2px 8px; font-size:11px;">Clear</button>
        `;
        selDiv.querySelector('#ns-clear-btn').addEventListener('click', clearSelected);

        // Load available stock per condition for this variant
        const { data: lots, error } = await supabase
            .from('inventory')
            .select('condition, quantity, quantity_sold')
            .eq('variant_id', card.variant_id);
        if (error) {
            selDiv.querySelector('#ns-stock-note').innerHTML =
                `<span style="color:var(--danger)">Failed to load stock: ${escapeHtml(error.message)}</span>`;
            return;
        }

        stockByCondition = {};
        for (const l of (lots || [])) {
            const rem = (l.quantity || 0) - (l.quantity_sold || 0);
            if (rem > 0) stockByCondition[l.condition] = (stockByCondition[l.condition] || 0) + rem;
        }

        const conditions = Object.entries(stockByCondition);
        if (conditions.length === 0) {
            selDiv.querySelector('#ns-stock-note').innerHTML =
                `<span style="color:var(--danger)">No stock available for this variant.</span>`;
            panel.querySelector('#ns-sale-fields').style.display = 'none';
            saveBtn.disabled = true;
            return;
        }

        const condSel = panel.querySelector('#ns-condition');
        condSel.innerHTML = conditions
            .map(([cond, rem]) => `<option value="${escapeHtml(cond)}">${escapeHtml(cond)} (${rem} available)</option>`)
            .join('');

        panel.querySelector('#ns-sale-fields').style.display = 'flex';
        saveBtn.disabled = false;
    }

    function clearSelected() {
        selectedCard = null;
        stockByCondition = {};
        selDiv.textContent = 'No card selected — search above and pick from the dropdown.';
        panel.querySelector('#ns-sale-fields').style.display = 'none';
        saveBtn.disabled = true;
    }

    wireAutocomplete({
        input: nameInput,
        search: (term) => searchVariantsWithStock(term, numInput.value.trim() || null, setInput.value.trim() || null),
        renderItem: (c) =>
            `${c.name} — ${c.set_name || '?'} #${c.number || '—'} · ${c.variant_label}` +
            (c.available !== undefined ? ` · ${c.available} in stock` : ''),
        onSelect: showSelected,
    });

    saveBtn.addEventListener('click', async () => {
        if (!selectedCard) return;

        const condition = panel.querySelector('#ns-condition').value;
        const qty       = parseInt(panel.querySelector('#ns-qty').value);
        const price     = parseFloat(panel.querySelector('#ns-price').value);
        const available = stockByCondition[condition] || 0;

        if (isNaN(qty) || qty < 1) {
            msg.innerHTML = `<span style="color:var(--danger)">Enter a valid quantity.</span>`;
            return;
        }
        if (qty > available) {
            msg.innerHTML = `<span style="color:var(--danger)">Only ${available} available in ${escapeHtml(condition)}.</span>`;
            return;
        }
        if (isNaN(price) || price < 0) {
            msg.innerHTML = `<span style="color:var(--danger)">Enter a valid price.</span>`;
            return;
        }

        const dateVal = panel.querySelector('#ns-date').value;

        msg.innerHTML = `<span style="color:var(--text-secondary)">Recording...</span>`;

        const { data, error } = await supabase.rpc('record_sale', {
            p_variant_id:        selectedCard.variant_id,
            p_condition:         condition,
            p_quantity:          qty,
            p_sale_price:        price,
            p_platform:          panel.querySelector('#ns-platform').value,
            p_account:           panel.querySelector('#ns-account').value.trim() || null,
            p_sold_at:           dateVal ? new Date(dateVal).toISOString() : new Date().toISOString(),
            p_platform_order_id: panel.querySelector('#ns-order').value.trim() || null,
            p_notes:             panel.querySelector('#ns-notes').value.trim() || null,
        });

        if (error) {
            msg.innerHTML = `<span style="color:var(--danger)">Failed: ${escapeHtml(error.message)}</span>`;
            return;
        }

        const lotCount = (data?.lots || []).length;
        msg.innerHTML = `<span style="color:var(--success)">Recorded — depleted ${lotCount} lot${lotCount === 1 ? '' : 's'} (FIFO).</span>`;
        clearSelected();
        nameInput.value = '';
        panel.querySelector('#ns-price').value = '';
        panel.querySelector('#ns-qty').value = '1';
        panel.querySelector('#ns-order').value = '';
        panel.querySelector('#ns-notes').value = '';
        await loadAndRender(container);
    });
}

// ----------------------------------------------------------------
// Table (grouped by order)
// ----------------------------------------------------------------

function renderTable(container) {
    const wrap = container.querySelector('#sales-table-wrap');
    const orders = visibleOrders();

    const totalRevenue = orders.reduce((a, o) => a + o.revenue, 0);
    const totalFees    = orders.reduce((a, o) => a + o.fees + o.refund, 0);
    const totalNet     = orders.reduce((a, o) => a + o.net, 0);
    const anyPending   = orders.some(o => o.feesPending);
    container.querySelector('#sales-summary').textContent =
        `${orders.length} order${orders.length === 1 ? '' : 's'}`
        + ` · revenue ${formatPrice(totalRevenue)}`
        + ` · fees ${formatPrice(totalFees)}`
        + ` · net profit ${formatPrice(totalNet)}${anyPending ? '*' : ''}`;

    if (orders.length === 0) {
        wrap.innerHTML = `<p style="color:var(--text-secondary)">No sales found.</p>`;
        return;
    }

    wrap.innerHTML = `
        <table>
            <thead><tr>
                <th>Date</th><th>Order</th><th>Platform</th><th>Items</th>
                <th style="text-align:right;">Qty</th>
                <th style="text-align:right;">Revenue</th>
                <th style="text-align:right;">Fees</th>
                <th style="text-align:right;">Net</th>
            </tr></thead>
            <tbody>
                ${orders.map(o => orderRowHtml(o)).join('')}
            </tbody>
        </table>
        ${anyPending ? `<p style="font-size:12px; color:var(--text-secondary); margin-top:8px;">* fees not yet synced — net shown is gross and will decrease once fees arrive.</p>` : ''}
    `;

    wrap.querySelectorAll('tr[data-order-key]').forEach(tr => {
        tr.addEventListener('click', () => {
            const key = tr.dataset.orderKey;
            state.expandedOrderKey = state.expandedOrderKey === key ? null : key;
            state.expandedGroupId = null;
            renderTable(container);
        });
    });

    wrap.querySelectorAll('tr[data-event-id]').forEach(tr => {
        tr.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = tr.dataset.eventId;
            state.expandedGroupId = state.expandedGroupId === id ? null : id;
            renderTable(container);
        });
    });

    wrap.querySelectorAll('button[data-delete-group]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = btn.dataset.deleteGroup;
            const orders2 = visibleOrders();
            let ev = null;
            for (const o of orders2) {
                ev = o.events.find(x => x.id === id);
                if (ev) break;
            }
            if (!ev) return;
            if (!confirm(
                `Delete this sale (${ev.first.card_name}, qty ${ev.qty}, ${formatPrice(ev.revenue)})?\n` +
                `This restores the sold quantity back to inventory.`)) return;

            const { error } = await supabase.rpc('delete_sale_group', { p_sale_group_id: id });
            if (error) {
                alert('Delete failed: ' + error.message);
                return;
            }
            state.expandedGroupId = null;
            await loadAndRender(container);
        });
    });

    wrap.querySelectorAll('button[data-edit-field]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            startEditOrderField(container, btn.dataset.orderKey, btn.dataset.editField);
        });
    });
}

// Order-level fields that can be manually overridden — all cases where
// eBay's API may never report a value (label bought off-eBay, a return
// label the Finances feed didn't post, or a refund that doesn't map to
// any specific card).
const EDITABLE_ORDER_FIELDS = {
    label_cost:        { label: 'Label',          getValue: o => o.labelCost },
    return_label_cost: { label: 'Return label',   getValue: o => o.returnLabelCost },
    refund_amount:     { label: 'Manual refund',  getValue: o => o.orderCatchAllRefund },
};

// Inline edit for an order-level fee/refund field — manual override for
// cases where eBay's Finances API never reports a value, or for orders
// with no real eBay order id at all (manually-entered "orders").
function startEditOrderField(container, orderKey, field) {
    const cfg = EDITABLE_ORDER_FIELDS[field];
    const header = state.orderHeaders[orderKey] || null;

    const span = container.querySelector(
        `span[data-field-display="${field}"][data-order-key-display="${CSS.escape(orderKey)}"]`
    );
    if (!span) return;

    const currentValue = header?.[field] ?? 0;
    span.innerHTML = `
        ${cfg.label}:
        <input type="number" step="0.01" min="0" value="${currentValue.toFixed(2)}"
               style="width:70px; margin:0 4px;" class="edit-field-input" />
        <button class="btn btn-primary edit-field-save" style="padding:1px 8px; font-size:10px;">Save</button>
        <button class="btn edit-field-cancel" style="padding:1px 8px; font-size:10px;">Cancel</button>
    `;

    span.querySelector('.edit-field-cancel').addEventListener('click', (e) => {
        e.stopPropagation();
        loadAndRender(container);  // simplest way to restore the original display
    });

    span.querySelector('.edit-field-save').addEventListener('click', async (e) => {
        e.stopPropagation();
        const input = span.querySelector('.edit-field-input');
        const newValue = parseFloat(input.value);
        if (isNaN(newValue) || newValue < 0) {
            alert('Enter a valid, non-negative amount.');
            return;
        }

        let error;
        if (header) {
            ({ error } = await supabase
                .from('sale_orders')
                .update({ [field]: newValue })
                .eq('id', header.id));
        } else {
            // No header yet — likely a manually-entered sale (e.g. a local/test
            // order number) that --ebay-syncfees can never create a row for,
            // since it's not a real eBay order ID. Create a minimal header
            // just to hold this manual value.
            const [platform, account, platformOrderId] = orderKey.split('|');
            ({ error } = await supabase
                .from('sale_orders')
                .insert({
                    platform,
                    account: account || null,
                    platform_order_id: platformOrderId,
                    [field]: newValue,
                }));
        }

        if (error) {
            alert('Failed to save: ' + error.message);
            return;
        }
        await loadAndRender(container);
    });
}

function orderRowHtml(o) {
    const r = o.first;
    const dateStr = r.sold_at ? new Date(r.sold_at).toLocaleDateString() : '—';
    const expanded = state.expandedOrderKey === o.key;
    const netColor = o.net > 0 ? 'var(--success)' : (o.net < 0 ? 'var(--danger)' : 'var(--text-secondary)');

    const itemsLabel = o.events.length === 1
        ? `<div style="font-weight:500;">${escapeHtml(r.card_name || '')}</div>
           <div style="font-size:11px; color:var(--text-secondary);">
               ${escapeHtml(r.set_name || '')} #${escapeHtml(r.card_number || '—')} · ${escapeHtml(variantLabel(r))}
           </div>`
        : `<div style="font-weight:500;">${o.events.length} cards</div>
           <div style="font-size:11px; color:var(--text-secondary);">
               ${escapeHtml(o.events.map(ev => ev.first.card_name).filter(Boolean).slice(0, 3).join(', '))}${o.events.length > 3 ? '…' : ''}
           </div>`;

    const feesCell = o.feesPending
        ? `<span style="color:var(--text-secondary);" title="Fees not synced yet">—</span>`
        : (o.isPlatformOrder || o.fees > 0 ? formatPrice(o.fees + o.refund) : `<span style="color:var(--text-secondary);">—</span>`);

    let html = `
        <tr data-order-key="${escapeHtml(o.key)}" style="cursor:pointer;">
            <td>${dateStr}</td>
            <td style="font-family:monospace; font-size:11px;">${r.platform_order_id ? escapeHtml(r.platform_order_id) : '<span style="color:var(--text-secondary); font-family:inherit;">—</span>'}</td>
            <td style="font-size:12px;">${escapeHtml(r.platform || '—')}${r.account ? ` <span style="color:var(--text-secondary); font-size:11px;">(${escapeHtml(r.account)})</span>` : ''}</td>
            <td>${itemsLabel}</td>
            <td style="text-align:right;">${o.qty}</td>
            <td style="text-align:right;">${formatPrice(o.revenue)}</td>
            <td style="text-align:right;">${feesCell}</td>
            <td style="text-align:right; color:${netColor}; font-weight:500;"
                ${o.hasNullCost ? 'title="Some lots have no landed cost — profit may be incomplete"' : ''}>
                ${formatPrice(o.net)}${o.feesPending ? '*' : ''}${o.hasNullCost ? ' <span style="color:var(--warning);">⚠</span>' : ''}
            </td>
        </tr>
    `;

    if (expanded) {
        html += expandedOrderHtml(o);
    }

    return html;
}

function expandedOrderHtml(o) {
    const h = o.header;

    const eventRows = o.events.map(ev => {
        const revenueShare = o.itemRevenue > 0 ? (ev.revenue / o.itemRevenue) : (1 / o.events.length);

        // Real per-card FVF (from sale_line_item_fees) + this card's share of
        // order-level label/promo/FVF-fixed, spread proportional to revenue.
        const feeShare = ev.lineFVF + (o.spreadPool * revenueShare);

        // Real per-card refund (from sale_line_item_fees) + this card's share
        // of the return label cost — spread by refund share when any line in
        // the order has a refund (a return label only pertains to returned
        // cards), falling back to revenue share otherwise.
        const refundBasis = o.lineRefundTotal > 0 ? (ev.lineRefund / o.lineRefundTotal) : revenueShare;
        const refundShare = ev.lineRefund
            + (o.returnLabelCost * refundBasis)
            + (o.orderCatchAllRefund * revenueShare);

        const shippingShare = o.shipping * revenueShare;
        const evNet = ev.grossProfit + shippingShare - feeShare - refundShare;
        const r = ev.first;
        const lotsExpanded = state.expandedGroupId === ev.id;

        let rowHtml = `
            <tr data-event-id="${ev.id}" style="cursor:pointer;">
                <td>
                    <div>${escapeHtml(r.card_name || '')}</div>
                    <div style="font-size:11px; color:var(--text-secondary);">
                        ${escapeHtml(r.set_name || '')} #${escapeHtml(r.card_number || '—')} · ${escapeHtml(variantLabel(r))}
                        ${ev.rows.length > 1 ? ` · <span style="color:var(--accent);">${ev.rows.length} lots</span>` : ''}
                        ${ev.lineDiscount > 0 ? ` · <span style="color:var(--text-secondary);">discount ${formatPrice(ev.lineDiscount)}</span>` : ''}
                    </div>
                </td>
                <td style="font-size:12px;">${escapeHtml(r.condition || '—')}</td>
                <td style="text-align:right;">${ev.qty}</td>
                <td style="text-align:right;">${formatPrice(r.sale_price)}</td>
                <td style="text-align:right;">${ev.hasNullCost ? '—' : formatPrice(ev.landedCost)}</td>
                <td style="text-align:right;">
                    ${o.feesPending ? '<span style="color:var(--text-secondary);">—</span>' : formatPrice(feeShare)}
                    ${refundShare > 0 ? `<div style="font-size:10px; color:var(--danger);">refund ${formatPrice(refundShare)}</div>` : ''}
                </td>
                <td style="text-align:right;">${formatPrice(evNet)}${o.feesPending ? '*' : ''}</td>
                <td style="text-align:right;">
                    <button class="btn" data-delete-group="${ev.id}"
                            style="padding:2px 8px; font-size:12px;" title="Delete sale (restores stock)">🗑</button>
                </td>
            </tr>
        `;

        if (lotsExpanded) {
            rowHtml += `
                <tr><td colspan="8" style="padding:6px 12px 10px; background:var(--bg-tertiary);">
                    <div style="font-size:11px; font-weight:600; color:var(--text-secondary);
                                text-transform:uppercase; letter-spacing:0.04em; margin-bottom:6px;">
                        Lot breakdown (FIFO)
                    </div>
                    <table style="font-size:12px;">
                        <thead><tr>
                            <th>Lot</th>
                            <th style="text-align:right;">Qty</th>
                            <th style="text-align:right;">Landed/ea</th>
                            <th style="text-align:right;">Price/ea</th>
                            <th style="text-align:right;">Gross profit</th>
                        </tr></thead>
                        <tbody>
                            ${ev.rows.map(row => `
                                <tr>
                                    <td style="font-family:monospace; font-size:11px;">${escapeHtml(row.inventory_id)}</td>
                                    <td style="text-align:right;">${row.quantity_sold}</td>
                                    <td style="text-align:right;">${row.landed_cost_per_unit === null ? '—' : formatPrice(row.landed_cost_per_unit)}</td>
                                    <td style="text-align:right;">${formatPrice(row.sale_price)}</td>
                                    <td style="text-align:right;">${row.profit === null ? '—' : formatPrice(row.profit)}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </td></tr>
            `;
        }

        return rowHtml;
    }).join('');

    const factItems = [];
    factItems.push(`Shipping charged: ${h ? formatPrice(o.shipping) : '—'}`);
    factItems.push(`FVF: ${o.feesPending ? '—' : formatPrice(o.lineFVFTotal + o.fvfFixed)}`);
    factItems.push(`Promo (ads): ${o.feesPending ? '—' : formatPrice(o.promoFee)}`);
    factItems.push(`Seller discount: ${o.promoDiscount !== 0 ? formatPrice(o.promoDiscount) : '—'} (already reflected in price)`);
    factItems.push(`Sales tax: ${o.salesTax > 0 ? formatPrice(o.salesTax) : '—'} (collected & remitted by eBay, not a cost to you)`);
    factItems.push(`Total refund (all sources): ${o.refund > 0 ? formatPrice(o.refund) : '—'}`);
    if (h?.fees_synced_at) {
        factItems.push(`Synced ${new Date(h.fees_synced_at).toLocaleString()}`);
    } else if (o.isPlatformOrder) {
        factItems.push(`Not synced yet`);
    }

    // Editable order-level fields — eBay's Finances API may never report
    // these (label bought off-eBay, a return label the feed didn't post,
    // or a refund that doesn't map to any specific card). Always shown
    // (not just when nonzero) so a manual value can be entered from scratch.
    const editableFieldsHtml = o.isPlatformOrder
        ? Object.keys(EDITABLE_ORDER_FIELDS).map(field => {
            const cfg = EDITABLE_ORDER_FIELDS[field];
            const val = cfg.getValue(o);
            return `
                <span data-field-display="${field}" data-order-key-display="${escapeHtml(o.key)}">
                    ${cfg.label}: ${formatPrice(val)}
                    <button class="btn" data-edit-field="${field}" data-order-key="${escapeHtml(o.key)}"
                            style="padding:1px 6px; font-size:10px; margin-left:4px;"
                            title="Manually set ${cfg.label.toLowerCase()}">✏️</button>
                </span>
            `;
        }).join('')
        : '';

    const r = o.first;
    return `
        <tr><td colspan="8" style="padding:0; background:var(--bg-secondary);">
            <div style="padding:12px 16px;">
                <table>
                    <thead><tr>
                        <th>Card</th>
                        <th>Condition</th>
                        <th style="text-align:right;">Qty</th>
                        <th style="text-align:right;">Price/ea</th>
                        <th style="text-align:right;">Landed</th>
                        <th style="text-align:right;">Fee share</th>
                        <th style="text-align:right;">Net</th>
                        <th></th>
                    </tr></thead>
                    <tbody>${eventRows}</tbody>
                </table>
                <div style="display:flex; gap:20px; flex-wrap:wrap; align-items:center; font-size:12px; color:var(--text-secondary); margin-top:10px;">
                    ${editableFieldsHtml}
                    ${factItems.map(escapeHtml).map(s => `<span>${s}</span>`).join('')}
                </div>
                ${r.notes ? `<div style="font-size:12px; color:var(--text-secondary); margin-top:4px;">Notes: ${escapeHtml(r.notes)}</div>` : ''}
            </div>
        </td></tr>
    `;
}

// ----------------------------------------------------------------
// Card search — variants with available stock only (can't sell what
// you don't have, so no card_master "no variant yet" merge here)
// ----------------------------------------------------------------

async function searchVariantsWithStock(name, num, setName) {
    let q = supabase
        .from('v_inventory')
        .select('variant_id, card_name, set_name, card_number, condition, quantity, quantity_sold, foil_type, foil_pattern, texture, material, size, stamp_type, source_type')
        .ilike('card_name', `%${name}%`)
        .limit(40);
    if (num)     q = q.eq('card_number', num);
    if (setName) q = q.ilike('set_name', `%${setName}%`);

    const { data, error } = await q;
    if (error) {
        console.error('Stock search error:', error);
        return [];
    }

    // Collapse per-lot rows to one entry per variant with total availability
    const byVariant = {};
    for (const r of (data || [])) {
        if (!r.variant_id) continue;
        if (!byVariant[r.variant_id]) {
            byVariant[r.variant_id] = {
                variant_id: r.variant_id,
                name:       r.card_name,
                number:     r.card_number,
                set_name:   r.set_name,
                variant_label: variantLabel(r),
                available:  0,
            };
        }
        byVariant[r.variant_id].available += (r.quantity || 0) - (r.quantity_sold || 0);
    }

    return Object.values(byVariant)
        .filter(v => v.available > 0)
        .slice(0, 15);
}

function wireAutocomplete({ input, search, renderItem, onSelect }) {
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

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

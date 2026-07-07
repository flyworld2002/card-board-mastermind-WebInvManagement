// sales.js
// Sales page: record sales (FIFO depletion via the record_sale RPC) and
// browse sale history with landed-cost profit from v_sales.
//
// A single sale event can span multiple inventory lots; those rows share a
// sale_group_id and are displayed grouped. Deleting a sale deletes the whole
// group and reverses the quantity_sold depletion (delete_sale_group RPC).

import { supabase, debounce, formatPrice, loadAxisOptions, axisDisplay } from './shared.js';

const state = {
    rows: [],            // v_sales rows
    filters: {
        search: '',
        platform: 'all',
    },
    expandedGroupId: null,
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

    const { data, error } = await supabase
        .from('v_sales')
        .select('*')
        .order('sold_at', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(500);

    if (error) {
        wrap.innerHTML = `<p style="color:var(--danger)">Failed to load sales: ${escapeHtml(error.message)}</p>`;
        return;
    }

    state.rows = data || [];
    renderTable(container);
}

function visibleGroups() {
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

    // Group rows by sale_group_id, preserving order (rows already sorted desc)
    const groups = [];
    const byId = {};
    for (const r of rows) {
        if (!byId[r.sale_group_id]) {
            byId[r.sale_group_id] = { id: r.sale_group_id, rows: [] };
            groups.push(byId[r.sale_group_id]);
        }
        byId[r.sale_group_id].rows.push(r);
    }
    for (const g of groups) {
        g.qty     = g.rows.reduce((a, r) => a + (r.quantity_sold || 0), 0);
        g.revenue = g.rows.reduce((a, r) => a + (r.sale_price || 0) * (r.quantity_sold || 0), 0);
        g.profit  = g.rows.reduce((a, r) => a + (r.profit ?? 0), 0);
        g.hasNullCost = g.rows.some(r => r.landed_cost_per_unit === null);
        g.first   = g.rows[0];
    }
    return groups;
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
// Record sale panel
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
// Table (grouped by sale event)
// ----------------------------------------------------------------

function renderTable(container) {
    const wrap = container.querySelector('#sales-table-wrap');
    const groups = visibleGroups();

    const totalRevenue = groups.reduce((a, g) => a + g.revenue, 0);
    const totalProfit  = groups.reduce((a, g) => a + g.profit, 0);
    container.querySelector('#sales-summary').textContent =
        `${groups.length} sale${groups.length === 1 ? '' : 's'} · revenue ${formatPrice(totalRevenue)} · profit ${formatPrice(totalProfit)}`;

    if (groups.length === 0) {
        wrap.innerHTML = `<p style="color:var(--text-secondary)">No sales found.</p>`;
        return;
    }

    wrap.innerHTML = `
        <table>
            <thead><tr>
                <th>Date</th><th>Card</th><th>Condition</th><th>Platform</th>
                <th style="text-align:right;">Qty</th>
                <th style="text-align:right;">Price/ea</th>
                <th style="text-align:right;">Revenue</th>
                <th style="text-align:right;">Profit</th>
                <th></th>
            </tr></thead>
            <tbody>
                ${groups.map(g => groupRowHtml(g)).join('')}
            </tbody>
        </table>
    `;

    wrap.querySelectorAll('tr[data-group-id]').forEach(tr => {
        tr.addEventListener('click', () => {
            const id = tr.dataset.groupId;
            state.expandedGroupId = state.expandedGroupId === id ? null : id;
            renderTable(container);
        });
    });

    wrap.querySelectorAll('button[data-delete-group]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = btn.dataset.deleteGroup;
            const g  = groups.find(x => x.id === id);
            if (!confirm(
                `Delete this sale (${g.first.card_name}, qty ${g.qty}, ${formatPrice(g.revenue)})?\n` +
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
}

function groupRowHtml(g) {
    const r = g.first;
    const dateStr = r.sold_at ? new Date(r.sold_at).toLocaleDateString() : '—';
    const expanded = state.expandedGroupId === g.id;
    const profitColor = g.profit > 0 ? 'var(--success)' : (g.profit < 0 ? 'var(--danger)' : 'var(--text-secondary)');

    let html = `
        <tr data-group-id="${g.id}" style="cursor:pointer;">
            <td>${dateStr}</td>
            <td>
                <div style="font-weight:500;">${escapeHtml(r.card_name || '')}</div>
                <div style="font-size:11px; color:var(--text-secondary);">
                    ${escapeHtml(r.set_name || '')} #${escapeHtml(r.card_number || '—')} · ${escapeHtml(variantLabel(r))}
                    ${g.rows.length > 1 ? ` · <span style="color:var(--accent);">${g.rows.length} lots</span>` : ''}
                </div>
            </td>
            <td style="font-size:12px;">${escapeHtml(r.condition || '—')}</td>
            <td style="font-size:12px;">${escapeHtml(r.platform || '—')}${r.account ? ` <span style="color:var(--text-secondary); font-size:11px;">(${escapeHtml(r.account)})</span>` : ''}</td>
            <td style="text-align:right;">${g.qty}</td>
            <td style="text-align:right;">${formatPrice(r.sale_price)}</td>
            <td style="text-align:right;">${formatPrice(g.revenue)}</td>
            <td style="text-align:right; color:${profitColor}; font-weight:500;"
                ${g.hasNullCost ? 'title="Some lots have no landed cost — profit may be incomplete"' : ''}>
                ${formatPrice(g.profit)}${g.hasNullCost ? ' <span style="color:var(--warning);">⚠</span>' : ''}
            </td>
            <td style="text-align:right;">
                <button class="btn" data-delete-group="${g.id}"
                        style="padding:2px 8px; font-size:12px;" title="Delete sale (restores stock)">🗑</button>
            </td>
        </tr>
    `;

    if (expanded) {
        html += `
            <tr><td colspan="9" style="padding:0; background:var(--bg-secondary);">
                <div style="padding:12px 16px;">
                    <div style="font-size:12px; font-weight:600; color:var(--text-secondary);
                                text-transform:uppercase; letter-spacing:0.04em; margin-bottom:8px;">
                        Lot breakdown (FIFO)
                    </div>
                    <table>
                        <thead><tr>
                            <th>Lot</th>
                            <th style="text-align:right;">Qty</th>
                            <th style="text-align:right;">Landed/ea</th>
                            <th style="text-align:right;">Price/ea</th>
                            <th style="text-align:right;">Profit</th>
                        </tr></thead>
                        <tbody>
                            ${g.rows.map(row => `
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
                    ${r.platform_order_id ? `<div style="font-size:12px; color:var(--text-secondary); margin-top:8px;">Order #: ${escapeHtml(r.platform_order_id)}</div>` : ''}
                    ${r.notes ? `<div style="font-size:12px; color:var(--text-secondary); margin-top:4px;">Notes: ${escapeHtml(r.notes)}</div>` : ''}
                </div>
            </td></tr>
        `;
    }

    return html;
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

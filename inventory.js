// inventory.js
// Inventory page: browse, search, sort, filter, and manage inventory stock.
// Platform listing is handled inline via modals.

import { supabase, debounce, formatPrice, loadAxisOptions, axisDisplay } from './shared.js';

const PAGE_SIZES = [50, 100, 250];
const PLATFORMS  = ['ebay', 'tcgplayer', 'amazon', 'shopify', 'wix'];

const DEFAULT_VISIBLE_PLATFORMS = ['ebay', 'tcgplayer'];

function loadVisiblePlatforms() {
    try {
        const saved = localStorage.getItem('inv_visible_platforms');
        if (saved) return JSON.parse(saved);
    } catch(e) {}
    return [...DEFAULT_VISIBLE_PLATFORMS];
}

function saveVisiblePlatforms(list) {
    try { localStorage.setItem('inv_visible_platforms', JSON.stringify(list)); } catch(e) {}
}

const state = {
    page: 0,
    pageSize: 50,
    totalCount: 0,
    rows: [],
    filters: {
        search: '',
        set_name: 'all',
        condition: 'all',
        status: 'all',
        source: 'all',
        includeOOS: false,
    },
    sort: { field: 'card_name', asc: true },
    sets: [],
    visiblePlatforms: loadVisiblePlatforms(),
    expandedVariantId: null,
};

export async function renderInventory(container) {
    container.innerHTML = `
        <div style="display:flex; align-items:baseline; gap:16px; margin-bottom:20px;">
            <h2 style="margin:0;">Inventory</h2>
            <div id="inv-summary" style="font-size:13px; color:var(--text-secondary);"></div>
        </div>
        <div class="filters-bar" id="inv-filters-bar"></div>
        <div id="inv-table-wrap"><p>Loading inventory...</p></div>
        <div class="pagination" id="inv-pagination"></div>
    `;

    await loadSets();
    await loadAxisOptions();  // Inventory only reads AXIS_DISPLAY, no dropdowns needed
    renderFilters(container);
    await loadAndRender(container);
    setupRealtimeSubscription(container);
}

// ----------------------------------------------------------------
// Realtime — auto-refresh when new sales land (e.g. from the scheduled
// eBay pull running in the background)
// ----------------------------------------------------------------
//
// index.html re-imports this module with a cache-busting `?v=` on every
// navigation, so each visit gets a fresh module instance — a module-level
// variable here would "forget" the previous subscription even though it's
// still alive and listening. Stashing the channel on `window` instead lets
// us find and tear down the prior one before creating a new one.

function teardownRealtimeSubscription() {
    if (window.__cbmInventoryChannel) {
        supabase.removeChannel(window.__cbmInventoryChannel);
        window.__cbmInventoryChannel = null;
    }
    if (window.__cbmInventoryHashHandler) {
        window.removeEventListener('hashchange', window.__cbmInventoryHashHandler);
        window.__cbmInventoryHashHandler = null;
    }
}

function setupRealtimeSubscription(container) {
    teardownRealtimeSubscription(); // clear any subscription left from a previous visit

    let debounceTimer = null;

    const channel = supabase
        .channel('inventory-sales-changes')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sales' }, () => {
            // Debounce: a burst of sales (e.g. a scheduled pull recording
            // several at once) triggers one re-fetch after things settle,
            // not one per row.
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                const hash = window.location.hash.replace('#', '') || 'dashboard';
                if (hash === 'inventory' || hash === 'dashboard') {
                    loadAndRender(container);
                }
            }, 2000);
        })
        .subscribe();

    window.__cbmInventoryChannel = channel;

    // Stop listening once the person navigates away from Inventory/Dashboard,
    // so switching pages doesn't leave a stale subscription refetching
    // against a page that's no longer showing.
    const hashHandler = () => {
        const hash = window.location.hash.replace('#', '') || 'dashboard';
        if (hash !== 'inventory' && hash !== 'dashboard') {
            teardownRealtimeSubscription();
        }
    };
    window.__cbmInventoryHashHandler = hashHandler;
    window.addEventListener('hashchange', hashHandler);
}

// AXIS_DISPLAY / axisDisplay() now come from shared.js (imported above)
// rather than a local copy, so Staging Review, Inventory, and Catalog
// all read from one implementation instead of three that could drift apart.

// ----------------------------------------------------------------
// Data
// ----------------------------------------------------------------

async function loadSets() {
    const { data } = await supabase
        .from('card_sets')
        .select('name')
        .order('name', { ascending: true });
    state.sets = (data || []).map(r => r.name);
}

async function loadAndRender(container) {
    const wrap = container.querySelector('#inv-table-wrap');
    wrap.innerHTML = '<p>Loading inventory...</p>';

    const f = state.filters;

    // Fetch ALL lots matching filters — we group by variant in JS.
    // PostgREST caps unbounded queries at its configured max rows (commonly
    // 1000), so once inventory exceeds that, later pages (alphabetically,
    // whatever falls past the cutoff) would silently never arrive. Page
    // through explicitly until a page comes back short of the page size.
    const PAGE_SIZE = 1000;
    let allLots = [];
    let page = 0;

    while (true) {
        let query = supabase.from(f.includeOOS ? 'v_inventory_all' : 'v_inventory').select('*');

        if (f.search.trim())       query = query.ilike('card_name', `%${f.search.trim()}%`);
        if (f.set_name !== 'all')  query = query.eq('set_name', f.set_name);
        if (f.condition !== 'all') query = query.eq('condition', f.condition);
        if (f.status !== 'all')    query = query.eq('listing_status', f.status);
        if (f.source !== 'all')    query = query.eq('purchase_source', f.source);

        query = query
            .order('card_name', { ascending: true })
            .order('acquired_at', { ascending: true })
            .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

        const { data, error } = await query;

        if (error) {
            wrap.innerHTML = `<p style="color:var(--danger)">Error: ${error.message}</p>`;
            return;
        }

        const batch = data || [];
        allLots = allLots.concat(batch);

        if (batch.length < PAGE_SIZE) break;   // last page
        page++;
    }

    // ── Group lots by variant_id ──────────────────────────────────────────────
    const variantMap = new Map();
    for (const lot of allLots) {
        const key = lot.variant_id;
        if (!variantMap.has(key)) variantMap.set(key, []);
        variantMap.get(key).push(lot);
    }

    // ── Build one summary row per variant ────────────────────────────────────
    const grouped = [];
    for (const [variantId, lots] of variantMap) {
        const first     = lots[0];
        const totalQty  = lots.reduce((a, r) => a + (r.quantity || 0), 0);
        const totalSold = lots.reduce((a, r) => a + (r.quantity_sold || 0), 0);
        const totalAvailable = lots.reduce((a, r) => a + (r.quantity_available ?? (r.quantity - (r.quantity_sold || 0))), 0);
        // WAC excludes lots with cost_basis = 0 (eBay imports with unknown cost)
        const costLots  = lots.filter(r => (r.cost_basis || 0) > 0);
        const totalCost = costLots.reduce((a, r) => a + (r.cost_basis * (r.quantity || 0)), 0);
        const costQty   = costLots.reduce((a, r) => a + (r.quantity || 0), 0);
        const wac       = costQty > 0 ? totalCost / costQty : 0;
        const lastLot   = lots[lots.length - 1]; // most recent (sorted ASC by acquired_at)
        grouped.push({
            variant_id:        variantId,
            lots,
            card_name:         first.card_name,
            card_number:       first.card_number,
            set_name:          first.set_name,
            image_url:         first.image_url,
            rarity:            first.rarity,
            foil_type:         first.foil_type,
            foil_pattern:      first.foil_pattern,
            texture:           first.texture,
            material:          first.material,
            size:              first.size,
            stamp_type:        first.stamp_type,
            source_type:       first.source_type,
            condition:         first.condition,
            market_price:      first.market_price,
            market_updated_at: first.market_updated_at,
            listing_status:    first.listing_status,
            total_qty:         totalQty,
            total_sold:        totalSold,
            total_available:   totalAvailable,
            wac,
            last_cost:         lastLot.cost_basis,
            last_acquired_at:  lastLot.acquired_at,
        });
    }

    // ── Sort ──────────────────────────────────────────────────────────────────
    grouped.sort((a, b) => {
        const field = state.sort.field;
        const av = field === 'quantity'     ? a.total_available
                 : field === 'cost_basis'   ? a.wac
                 : field === 'market_price' ? (a.market_price ?? -1)
                 : field === 'card_number'  ? (a.card_number || '')
                 : a[field] ?? '';
        const bv = field === 'quantity'     ? b.total_available
                 : field === 'cost_basis'   ? b.wac
                 : field === 'market_price' ? (b.market_price ?? -1)
                 : field === 'card_number'  ? (b.card_number || '')
                 : b[field] ?? '';
        const cmp = field === 'card_number'
            ? av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' })
            : typeof av === 'string' ? av.localeCompare(bv) : av - bv;
        return state.sort.asc ? cmp : -cmp;
    });

    // ── Paginate ──────────────────────────────────────────────────────────────
    state.totalCount = grouped.length;
    const from       = state.page * state.pageSize;
    state.rows       = grouped.slice(from, from + state.pageSize);

    // ── Summary bar ───────────────────────────────────────────────────────────
    const totalQtyAll  = allLots.reduce((a, r) => a + (r.quantity || 0), 0);
    const totalCostAll = allLots.reduce((a, r) => a + ((r.cost_basis || 0) * (r.quantity || 0)), 0);
    const el = container.querySelector('#inv-summary');
    if (el) el.textContent = `${variantMap.size.toLocaleString()} variants · ${totalQtyAll.toLocaleString()} cards · ${formatPrice(totalCostAll)} cost basis`;

    const variantIds = state.rows.map(r => r.variant_id).filter(Boolean);
    if (variantIds.length > 0) {
        const { data: allListings } = await supabase
            .from('platform_listings')
            .select('*')
            .in('variant_id', variantIds);
        if (allListings) {
            for (const row of state.rows) {
                row._listings = allListings.filter(l => l.variant_id === row.variant_id);
            }
        }
    }

    renderTable(container);
    renderPagination(container);

    if (state.expandedVariantId) {
        const detailTr = document.getElementById(`detail-${state.expandedVariantId}`);
        if (detailTr) {
            const dataRow = detailTr.previousElementSibling;
            if (dataRow) dataRow.style.background = 'var(--bg-secondary)';
            const row = state.rows.find(r => r.variant_id === state.expandedVariantId);
            if (row) {
                detailTr.style.display = '';
                detailTr.style.background = 'var(--bg-secondary)';
                renderDetailPanel(container, row, detailTr.querySelector('td'));
            }
        }
    }
}

// ----------------------------------------------------------------
// Filters
// ----------------------------------------------------------------

function renderFilters(container) {
    const bar = container.querySelector('#inv-filters-bar');
    const f   = state.filters;
    const CONDITIONS = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];

    bar.innerHTML = `
        <input type="search" id="inv-search" placeholder="Search card name..."
               value="${escapeHtml(f.search)}" style="width:200px;" />
        <select id="inv-filter-set">
            <option value="all">All sets</option>
            ${state.sets.map(s =>
                `<option value="${escapeHtml(s)}" ${s === f.set_name ? 'selected' : ''}>${escapeHtml(s)}</option>`
            ).join('')}
        </select>
        <select id="inv-filter-condition">
            <option value="all">All conditions</option>
            ${CONDITIONS.map(c =>
                `<option value="${escapeHtml(c)}" ${c === f.condition ? 'selected' : ''}>${escapeHtml(c)}</option>`
            ).join('')}
        </select>
        <select id="inv-filter-status">
            <option value="all">All statuses</option>
            <option value="unlisted" ${f.status === 'unlisted' ? 'selected' : ''}>Unlisted</option>
            <option value="draft"       ${f.status === 'draft'       ? 'selected' : ''}>Draft</option>
            <option value="do_not_sync" ${f.status === 'do_not_sync' ? 'selected' : ''}>Do Not Sync</option>
            <option value="listed"      ${f.status === 'listed'      ? 'selected' : ''}>Listed</option>
        </select>
        <select id="inv-filter-source">
            <option value="all">All sources</option>
            <option value="ebay"      ${f.source === 'ebay'      ? 'selected' : ''}>eBay</option>
            <option value="tcgplayer" ${f.source === 'tcgplayer' ? 'selected' : ''}>TCGPlayer</option>
        </select>
        <button id="inv-reset-filters" class="btn">Reset filters</button>
        <label style="font-size:13px; color:var(--text-secondary); display:flex; align-items:center; gap:6px;">
            <input type="checkbox" id="inv-include-oos" ${f.includeOOS ? 'checked' : ''} />
            Show out of stock
        </label>
        <button id="inv-platform-settings" class="btn" title="Configure platform columns" style="margin-left:4px;">⚙ Platforms</button>
        <select id="inv-page-size" style="margin-left:auto;">
            ${PAGE_SIZES.map(s =>
                `<option value="${s}" ${s === state.pageSize ? 'selected' : ''}>${s} per page</option>`
            ).join('')}
        </select>
    `;

    bar.querySelector('#inv-search').addEventListener('input', debounce(async (e) => {
        state.filters.search = e.target.value; state.page = 0;
        await loadAndRender(container);
    }, 400));

    bar.querySelector('#inv-filter-set').addEventListener('change', async (e) => {
        state.filters.set_name = e.target.value; state.page = 0;
        await loadAndRender(container);
    });
    bar.querySelector('#inv-filter-condition').addEventListener('change', async (e) => {
        state.filters.condition = e.target.value; state.page = 0;
        await loadAndRender(container);
    });
    bar.querySelector('#inv-filter-status').addEventListener('change', async (e) => {
        state.filters.status = e.target.value; state.page = 0;
        await loadAndRender(container);
    });
    bar.querySelector('#inv-filter-source').addEventListener('change', async (e) => {
        state.filters.source = e.target.value; state.page = 0;
        await loadAndRender(container);
    });
    bar.querySelector('#inv-reset-filters').addEventListener('click', async () => {
        state.filters = { search: '', set_name: 'all', condition: 'all', status: 'all', source: 'all', includeOOS: false };
        state.page = 0;
        renderFilters(container);
        await loadAndRender(container);
    });
    bar.querySelector('#inv-include-oos').addEventListener('change', async (e) => {
        state.filters.includeOOS = e.target.checked; state.page = 0;
        await loadAndRender(container);
    });
    bar.querySelector('#inv-page-size').addEventListener('change', (e) => {
        state.pageSize = Number(e.target.value); state.page = 0;
        loadAndRender(container);
    });

    bar.querySelector('#inv-platform-settings').addEventListener('click', () => {
        openPlatformSettings(container);
    });
}

function openPlatformSettings(container) {
    const overlay = makeOverlay();
    overlay.innerHTML = `
        <div style="background:var(--bg-secondary); border:1px solid var(--border);
                    border-radius:8px; padding:24px; width:320px; max-width:90vw;">
            <h3 style="margin-top:0; margin-bottom:16px;">Platform columns</h3>
            <div style="display:flex; flex-direction:column; gap:12px; margin-bottom:20px;">
                ${PLATFORMS.map(p => `
                    <label style="display:flex; align-items:center; gap:10px; font-size:14px; cursor:pointer;">
                        <input type="checkbox" data-platform="${p}"
                               ${state.visiblePlatforms.includes(p) ? 'checked' : ''}
                               style="width:16px; height:16px; cursor:pointer;" />
                        ${p.charAt(0).toUpperCase() + p.slice(1)}
                    </label>
                `).join('')}
            </div>
            <div style="display:flex; gap:8px;">
                <button class="btn btn-primary" id="plat-save">Save</button>
                <button class="btn" id="plat-cancel">Cancel</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('#plat-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#plat-save').addEventListener('click', async () => {
        const checked = [...overlay.querySelectorAll('input[data-platform]:checked')]
            .map(el => el.dataset.platform);
        state.visiblePlatforms = checked.length > 0 ? checked : [...DEFAULT_VISIBLE_PLATFORMS];
        saveVisiblePlatforms(state.visiblePlatforms);
        overlay.remove();
        await loadAndRender(container);
    });
}

// ----------------------------------------------------------------
// Table
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

function statusBadge(status) {
    const map = {
        unlisted:    { color: 'var(--text-secondary)', bg: 'rgba(255,255,255,0.05)' },
        listed:      { color: 'var(--accent)',          bg: 'rgba(74,140,255,0.12)'  },
        draft:       { color: 'var(--warning)',          bg: 'rgba(245,166,35,0.12)'  },
        do_not_sync: { color: '#a78bfa',                bg: 'rgba(167,139,250,0.12)' },
    };
    const s = map[status] || map.unlisted;
    return `<span style="display:inline-block; padding:2px 8px; border-radius:10px;
        font-size:11px; font-weight:500; color:${s.color}; background:${s.bg};">
        ${escapeHtml(status || 'unlisted')}
    </span>`;
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

function renderTable(container) {
    const wrap = container.querySelector('#inv-table-wrap');

    if (state.rows.length === 0) {
        wrap.innerHTML = `
            <p>No inventory rows match the current filters.</p>
            <p style="color:var(--text-secondary); font-size:13px;">
                Push approved staging rows to inventory to see them here.
            </p>`;
        return;
    }

    const platCols  = state.visiblePlatforms.map(() => '<col style="width:70px"/>').join('');
    const platHeads = state.visiblePlatforms.map(p =>
        `<th style="text-align:center;">${p === 'tcgplayer' ? 'TCG' : p.charAt(0).toUpperCase() + p.slice(1)}</th>`
    ).join('');
    const totalCols = 7 + state.visiblePlatforms.length;

    wrap.innerHTML = `
        <table style="width:100%; border-collapse:collapse; table-layout:fixed;">
            <colgroup>
                <col style="width:52px"/>
                <col style="width:150px"/>
                <col style="width:50px"/>
                <col style="width:115px"/>
                <col style="width:50px"/>
                <col style="width:75px"/>
                <col style="width:75px"/>
                ${platCols}
            </colgroup>
            <thead>
                <tr>
                    <th></th>
                    <th class="sortable-header" data-field="card_name"
                        style="cursor:pointer; user-select:none;">
                        Card${state.sort.field === 'card_name' ? (state.sort.asc ? ' ↑' : ' ↓') : ''}
                    </th>
                    <th class="sortable-header" data-field="card_number"
                        style="cursor:pointer; user-select:none; text-align:center;">
                        #${state.sort.field === 'card_number' ? (state.sort.asc ? ' ↑' : ' ↓') : ''}
                    </th>
                    <th class="sortable-header" data-field="set_name"
                        style="cursor:pointer; user-select:none;">
                        Set${state.sort.field === 'set_name' ? (state.sort.asc ? ' ↑' : ' ↓') : ''}
                    </th>
                    <th class="sortable-header" data-field="quantity"
                        style="cursor:pointer; user-select:none; text-align:center;">
                        Qty${state.sort.field === 'quantity' ? (state.sort.asc ? ' ↑' : ' ↓') : ''}
                    </th>
                    <th class="sortable-header" data-field="cost_basis"
                        style="cursor:pointer; user-select:none;">
                        WAC${state.sort.field === 'cost_basis' ? (state.sort.asc ? ' ↑' : ' ↓') : ''}
                    </th>
                    <th class="sortable-header" data-field="market_price"
                        style="cursor:pointer; user-select:none;">
                        Market${state.sort.field === 'market_price' ? (state.sort.asc ? ' ↑' : ' ↓') : ''}
                    </th>
                    ${platHeads}
                </tr>
            </thead>
            <tbody id="inv-tbody"></tbody>
        </table>
    `;

    wrap.querySelectorAll('.sortable-header').forEach(th => {
        th.addEventListener('click', async () => {
            const field = th.dataset.field;
            state.sort.asc   = state.sort.field === field ? !state.sort.asc : true;
            state.sort.field = field;
            state.page = 0;
            await loadAndRender(container);
        });
    });

    const tbody = wrap.querySelector('#inv-tbody');
    for (const row of state.rows) {
        tbody.appendChild(renderRow(container, row));
        const detailTr = document.createElement('tr');
        detailTr.id = `detail-${row.variant_id}`;
        detailTr.style.display = 'none';
        const detailTd = document.createElement('td');
        detailTd.colSpan = totalCols;
        detailTd.style.padding = '0';
        detailTr.appendChild(detailTd);
        tbody.appendChild(detailTr);
    }
}

function renderRow(container, row) {
    const tr = document.createElement('tr');
    tr.dataset.variantId = row.variant_id;
    tr.style.cursor = 'pointer';
    if ((row.total_available ?? row.total_qty ?? 0) === 0) tr.style.opacity = '0.55';

    const imgCell = row.image_url
        ? `<img src="${escapeHtml(row.image_url)}" loading="lazy"
                style="width:40px; height:56px; object-fit:contain; border-radius:3px;" />`
        : `<div style="width:40px; height:56px; background:var(--bg-tertiary); border-radius:3px;
                       display:flex; align-items:center; justify-content:center;
                       color:var(--text-secondary); font-size:10px;">—</div>`;

    const marketCell = row.market_price
        ? `<div style="font-size:13px;">${formatPrice(row.market_price)}</div>
           <div style="font-size:10px; color:var(--text-secondary);">
               ${row.market_updated_at ? new Date(row.market_updated_at).toLocaleDateString() : ''}
           </div>`
        : '<span style="color:var(--text-secondary)">—</span>';

    const costCell = `
        <div style="font-size:13px;">${formatPrice(row.wac)}</div>
        ${row.lots.length > 1
            ? `<div style="font-size:10px; color:var(--text-secondary);">last: ${formatPrice(row.last_cost)}</div>`
            : ''}
    `;

    function platCell(platform) {
        const ps = row._listings ? row._listings.filter(l => l.platform === platform) : [];
        if (ps.length > 0) {
            // Only active/listed count toward displayed qty
            const active   = ps.filter(l => l.status === 'active' || l.status === 'listed');
            const totalQty = active.reduce((a, l) => a + (l.quantity_listed || 0), 0);
            const hasNoSync = ps.some(l => l.status === 'do_not_sync');
            const c = active.length > 0 ? 'var(--accent)' : hasNoSync ? '#a78bfa' : 'var(--warning)';
            const subline = active.length > 1 ? `${active.length} listings`
                          : active.length === 1 ? formatPrice(active[0].list_price)
                          : ps.length > 1 ? `${ps.length} (inactive)` : 'inactive';
            const display = active.length > 0 ? totalQty : '—';
            return `<td style="text-align:center; vertical-align:middle; padding:8px 4px;">
                <div style="font-size:13px; font-weight:600; color:${c};">
                    ${display}${active.length > 1 ? `<span style="font-size:10px; color:var(--text-secondary);"> (${active.length})</span>` : ''}
                </div>
                <div style="font-size:10px; color:var(--text-secondary);">${subline}</div>
            </td>`;
        }
        return `<td style="text-align:center; vertical-align:middle; padding:8px 4px;">
            <span style="color:var(--text-secondary); font-size:16px;">—</span>
        </td>`;
    }

    const platCells = state.visiblePlatforms.map(p => platCell(p)).join('');

    tr.innerHTML = `
        <td style="padding:8px 6px;">${imgCell}</td>
        <td style="padding:8px 6px;">
            <div style="font-weight:500; font-size:13px;">${escapeHtml(row.card_name || '')}</div>
            <div style="font-size:11px; color:var(--text-secondary);">${escapeHtml(variantLabel(row))}</div>
        </td>
        <td style="padding:8px 4px; font-size:12px; color:var(--text-secondary); text-align:center;">
            ${escapeHtml(row.card_number || '—')}
        </td>
        <td style="font-size:12px; color:var(--text-secondary); padding:8px 6px;">${escapeHtml(row.set_name || '—')}</td>
        <td style="text-align:center; padding:8px 6px;">
            <div style="font-weight:600; font-size:14px; ${(row.total_available ?? row.total_qty ?? 0) === 0 ? 'color:var(--text-secondary);' : ''}">
                ${row.total_available ?? row.total_qty ?? '—'}
            </div>
            ${(row.total_available ?? row.total_qty ?? 0) === 0
                ? `<div style="font-size:10px; color:var(--warning);">sold out</div>`
                : (row.total_sold ? `<div style="font-size:10px; color:var(--text-secondary);">sold: ${row.total_sold}</div>` : '')}
        </td>
        <td style="padding:8px 6px;">${costCell}</td>
        <td style="padding:8px 6px;">${marketCell}</td>
        ${platCells}
    `;

    tr.addEventListener('click', async () => {
        const detailTr = document.getElementById(`detail-${row.variant_id}`);
        if (!detailTr) return;
        const isOpen = detailTr.style.display !== 'none';
        if (isOpen) {
            detailTr.style.display = 'none';
            tr.style.background = '';
            state.expandedVariantId = null;
            return;
        }
        state.expandedVariantId = row.variant_id;
        tr.style.background = 'var(--bg-secondary)';
        detailTr.style.display = '';
        detailTr.style.background = 'var(--bg-secondary)';
        const { data: listings } = await supabase
            .from('platform_listings')
            .select('*')
            .eq('variant_id', row.variant_id)
            .order('platform');
        row._listings = listings || [];
        renderDetailPanel(container, row, detailTr.querySelector('td'));
    });

    return tr;
}

function renderDetailPanel(container, row, td) {
    const listings = row._listings || [];

    const listingRows = listings.length > 0
        ? listings.map(l => {
            const statusColor = (l.status === 'active' || l.status === 'listed') ? 'var(--accent)'
                              : l.status === 'do_not_sync' ? '#a78bfa' : 'var(--warning)';
            return `
            <div class="detail-listing-row" data-id="${l.id}" style="
                display:flex; align-items:center; gap:12px;
                padding:8px 12px; background:var(--bg-primary);
                border:1px solid var(--border); border-radius:6px;
                margin-bottom:6px; font-size:13px;">
                <span style="font-weight:500; min-width:80px; text-transform:capitalize;">${escapeHtml(l.platform)}</span>
                <span style="color:var(--text-secondary); font-size:12px; min-width:110px;">#${escapeHtml(l.listing_id || '—')}</span>
                <span style="color:var(--text-secondary); font-size:12px; min-width:80px;">${escapeHtml(l.account || '—')}</span>
                <span style="color:${statusColor}; font-size:11px; min-width:80px;">${escapeHtml(l.status || '—')}</span>
                <span style="font-weight:500; min-width:55px;">${formatPrice(l.list_price)}</span>
                <span style="color:var(--text-secondary); font-size:12px; min-width:90px;">Qty: ${l.quantity_listed ?? '—'} / ${l.quantity_limit ?? '—'}</span>
                <div style="margin-left:auto;">
                    <button class="btn detail-edit-listing-btn" data-lid="${l.id}"
                            style="font-size:11px; padding:3px 10px;">Edit</button>
                </div>
            </div>`;
        }).join('')
        : `<div style="font-size:13px; color:var(--text-secondary); padding:4px 0 8px;">No platform listings yet.</div>`;

    td.innerHTML = `
        <div style="padding:12px 16px 16px 58px; border-bottom:1px solid var(--border); background:var(--bg-secondary);">
            <div style="font-size:11px; font-weight:600; color:var(--text-secondary);
                        text-transform:uppercase; letter-spacing:0.05em; margin-bottom:10px;">
                Platform listings
            </div>
            ${listingRows}
            <div style="display:flex; gap:8px; margin-top:10px;">
                <button class="btn btn-primary detail-add-listing-btn"
                        style="font-size:12px; padding:4px 12px;">+ Add listing</button>
                <button class="btn detail-history-btn"
                        style="font-size:12px; padding:4px 10px;">Purchase Order</button>
                <button class="btn detail-sales-btn"
                        style="font-size:12px; padding:4px 10px;">Sales</button>
            </div>
        </div>
    `;

    td.querySelector('.detail-add-listing-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        openListModal(container, row);
    });
    td.querySelector('.detail-history-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        openHistoryModal(container, row);
    });
    td.querySelector('.detail-sales-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        openSalesModal(container, row);
    });
    td.querySelectorAll('.detail-edit-listing-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const lid = btn.dataset.lid;
            const listing = listings.find(l => String(l.id) === String(lid));
            if (listing) openInlineListingEdit(container, row, listing, btn);
        });
    });
}

// ----------------------------------------------------------------
// Inline listing edit
// ----------------------------------------------------------------

function openInlineListingEdit(container, row, l, triggerBtn) {
    document.querySelectorAll('.inline-listing-edit').forEach(el => el.remove());

    const listingRow = triggerBtn.closest('.detail-listing-row');
    if (!listingRow) return;

    const editPanel = document.createElement('div');
    editPanel.className = 'inline-listing-edit';
    editPanel.style.cssText = `
        background:var(--bg-tertiary); border:1px solid var(--border);
        border-radius:6px; padding:14px 16px; margin-top:8px;
    `;
    editPanel.innerHTML = `
        <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:10px;">
            <label style="font-size:12px; color:var(--text-secondary);">Price
                <input type="number" step="0.01" class="ile-price"
                       value="${l.list_price ?? ''}"
                       style="width:80px; margin-top:2px; display:block;" />
            </label>
            <label style="font-size:12px; color:var(--text-secondary);">Qty Listed
                <input type="number" class="ile-qty"
                       value="${l.quantity_listed ?? ''}"
                       style="width:70px; margin-top:2px; display:block;" />
            </label>
            <label style="font-size:12px; color:var(--text-secondary);">Qty Limit
                <input type="number" class="ile-limit"
                       value="${l.quantity_limit ?? ''}"
                       style="width:70px; margin-top:2px; display:block;" />
            </label>
            <label style="font-size:12px; color:var(--text-secondary);">eBay Item #
                <input type="text" class="ile-listing-id"
                       value="${escapeHtml(l.listing_id || '')}"
                       style="width:130px; margin-top:2px; display:block;" />
            </label>
            <label style="font-size:12px; color:var(--text-secondary);">Variation
                <input type="text" class="ile-external-id"
                       value="${escapeHtml(l.external_id || '')}"
                       style="width:160px; margin-top:2px; display:block;" />
            </label>
            <label style="font-size:12px; color:var(--text-secondary);">Account
                <input type="text" class="ile-account"
                       value="${escapeHtml(l.account || '')}"
                       style="width:110px; margin-top:2px; display:block;" />
            </label>
            <label style="font-size:12px; color:var(--text-secondary);">Status
                <select class="ile-status" style="margin-top:2px; display:block;">
                    <option value="active"      ${l.status === 'active'      ? 'selected' : ''}>active</option>
                    <option value="draft"       ${l.status === 'draft'       ? 'selected' : ''}>draft</option>
                    <option value="do_not_sync" ${l.status === 'do_not_sync' ? 'selected' : ''}>do_not_sync</option>
                    <option value="delisted"    ${l.status === 'delisted'    ? 'selected' : ''}>delisted</option>
                </select>
            </label>
        </div>
        <label style="font-size:12px; color:var(--text-secondary); display:block; margin-bottom:10px;">Description
            <textarea class="ile-description" rows="2"
                      style="width:100%; margin-top:2px; background:var(--bg-secondary);
                             border:1px solid var(--border); color:var(--text);
                             border-radius:4px; padding:4px 8px; font-size:12px; resize:vertical;"
            >${escapeHtml(l.description || '')}</textarea>
        </label>
        <div style="display:flex; gap:8px; align-items:center;">
            <button class="btn btn-primary ile-save-btn" style="font-size:12px; padding:4px 10px;">Save</button>
            <button class="btn ile-cancel-btn" style="font-size:12px; padding:4px 10px;">Cancel</button>
            <button class="btn ile-delete-btn"
                    style="font-size:12px; padding:4px 8px; color:var(--danger);
                           border-color:var(--danger); margin-left:auto;">Delete</button>
        </div>
        <div class="ile-msg" style="font-size:12px; margin-top:6px;"></div>
    `;

    listingRow.insertAdjacentElement('afterend', editPanel);

    editPanel.querySelector('.ile-cancel-btn').addEventListener('click', () => editPanel.remove());

    editPanel.querySelector('.ile-save-btn').addEventListener('click', async () => {
        const price   = parseFloat(editPanel.querySelector('.ile-price').value) || null;
        const qty     = parseInt(editPanel.querySelector('.ile-qty').value) || null;
        const limit   = parseInt(editPanel.querySelector('.ile-limit').value) || null;
        const listId  = editPanel.querySelector('.ile-listing-id').value.trim() || null;
        const extId   = editPanel.querySelector('.ile-external-id').value.trim() || null;
        const account = editPanel.querySelector('.ile-account').value.trim() || null;
        const status  = editPanel.querySelector('.ile-status').value;
        const desc    = editPanel.querySelector('.ile-description').value.trim() || null;
        const msg     = editPanel.querySelector('.ile-msg');

        const { error } = await supabase
            .from('platform_listings')
            .update({
                list_price:      price,
                quantity_listed: qty,
                quantity_limit:  limit,
                listing_id:      listId,
                external_id:     extId,
                account,
                status,
                description:     desc,
                synced_at:       new Date().toISOString(),
            })
            .eq('id', l.id);

        if (error) {
            msg.innerHTML = `<span style="color:var(--danger)">Save failed: ${escapeHtml(error.message)}</span>`;
            return;
        }
        editPanel.remove();

        // Refresh background table
        await loadAndRender(container);

        // Re-expand detail panel with fresh listings
        const detailTr = document.getElementById(`detail-${row.variant_id}`);
        if (detailTr) {
            const dataRow = detailTr.previousElementSibling;
            if (dataRow) dataRow.style.background = 'var(--bg-secondary)';

            const { data: listings } = await supabase
                .from('platform_listings')
                .select('*')
                .eq('variant_id', row.variant_id)
                .order('platform');
            row._listings = listings || [];
            detailTr.style.display = '';
            detailTr.style.background = 'var(--bg-secondary)';
            const td = detailTr.querySelector('td');
            renderDetailPanel(container, row, td);

            const flash = document.createElement('div');
            flash.style.cssText = `font-size:12px; color:var(--success);
                padding:6px 16px 0 58px; background:var(--bg-secondary);`;
            flash.textContent = '✓ Listing updated';
            td.querySelector('div').prepend(flash);
            setTimeout(() => flash.remove(), 2500);
        }
    });

    editPanel.querySelector('.ile-delete-btn').addEventListener('click', async () => {
        if (!window.confirm('Permanently delete this listing record? This cannot be undone.')) return;
        const btn = editPanel.querySelector('.ile-delete-btn');
        btn.disabled = true; btn.textContent = '...';
        const { error } = await supabase.rpc('delete_platform_listing', { p_id: l.id });
        if (error) {
            btn.disabled = false; btn.textContent = 'Delete';
            alert('Failed to delete: ' + error.message);
            return;
        }
        editPanel.remove();

        await loadAndRender(container);

        const detailTr = document.getElementById(`detail-${row.variant_id}`);
        if (detailTr) {
            const dataRow = detailTr.previousElementSibling;
            if (dataRow) dataRow.style.background = 'var(--bg-secondary)';

            const { data: listings } = await supabase
                .from('platform_listings')
                .select('*')
                .eq('variant_id', row.variant_id)
                .order('platform');
            row._listings = listings || [];
            detailTr.style.display = '';
            detailTr.style.background = 'var(--bg-secondary)';
            renderDetailPanel(container, row, detailTr.querySelector('td'));
        }
    });
}

// ----------------------------------------------------------------
// Edit modal
// ----------------------------------------------------------------

function openEditModal(container, row) {
    const overlay = makeOverlay();

    overlay.innerHTML = `
        <div style="background:var(--bg-secondary); border:1px solid var(--border);
                    border-radius:8px; padding:24px; width:420px; max-width:90vw;">
            <h3 style="margin-top:0;">${escapeHtml(row.card_name || '')}</h3>
            <div style="color:var(--text-secondary); font-size:13px; margin-bottom:16px;">
                ${escapeHtml(row.set_name || '')} #${escapeHtml(row.card_number || '—')}
                · ${escapeHtml(row.condition || '')}
            </div>
            <div style="display:flex; flex-direction:column; gap:12px;">
                <label style="font-size:13px;">Quantity
                    <input type="number" class="modal-qty" value="${row.quantity ?? 1}"
                           min="0" style="width:100%; margin-top:4px;" />
                </label>
                <label style="font-size:13px;">Cost basis
                    <input type="number" step="0.01" class="modal-cost"
                           value="${row.cost_basis ?? ''}" placeholder="0.00"
                           style="width:100%; margin-top:4px;" />
                </label>
                <label style="font-size:13px;">Notes
                    <input type="text" class="modal-notes"
                           value="${escapeHtml(row.notes || '')}"
                           style="width:100%; margin-top:4px;" />
                </label>
            </div>
            <div class="modal-message" style="margin-top:10px; font-size:13px;"></div>
            <div style="display:flex; gap:8px; margin-top:16px;">
                <button class="btn btn-primary modal-save-btn">Save changes</button>
                <button class="btn modal-cancel-btn">Cancel</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    overlay.querySelector('.modal-cancel-btn').addEventListener('click', () => overlay.remove());

    overlay.querySelector('.modal-save-btn').addEventListener('click', async () => {
        const qty    = parseInt(overlay.querySelector('.modal-qty').value);
        const cost   = parseFloat(overlay.querySelector('.modal-cost').value) || null;
        const notes  = overlay.querySelector('.modal-notes').value.trim() || null;
        const msgArea = overlay.querySelector('.modal-message');

        if (isNaN(qty) || qty < 0) {
            msgArea.innerHTML = `<span style="color:var(--danger)">Invalid quantity.</span>`;
            return;
        }

        const { error } = await supabase
            .from('inventory')
            .update({ quantity: qty, cost_basis: cost, notes, updated_at: new Date().toISOString() })
            .eq('id', row.id);

        if (error) {
            msgArea.innerHTML = `<span style="color:var(--danger)">Save failed: ${escapeHtml(error.message)}</span>`;
            return;
        }
        overlay.remove();
        await loadAndRender(container);
    });
}


// ----------------------------------------------------------------
// History modal — purchase lots with FIFO breakdown + inline edit
// ----------------------------------------------------------------

function openHistoryModal(container, row) {
    // Re-fetch fresh lot data then render modal
    async function fetchAndRender(existingOverlay) {
        const { data: freshLots } = await supabase
            .from('v_inventory_all')
            .select('*')
            .eq('variant_id', row.variant_id)
            .order('acquired_at', { ascending: true });

        if (freshLots && freshLots.length > 0) {
            row.lots = freshLots;
            const totalQty  = freshLots.reduce((a, r) => a + (r.quantity || 0), 0);
            const totalSold = freshLots.reduce((a, r) => a + (r.quantity_sold || 0), 0);
            const totalAvailable = freshLots.reduce((a, r) => a + (r.quantity_available ?? (r.quantity - (r.quantity_sold || 0))), 0);
            const costLots  = freshLots.filter(r => (r.cost_basis || 0) > 0);
            const totalCost = costLots.reduce((a, r) => a + (r.cost_basis * (r.quantity || 0)), 0);
            const costQty   = costLots.reduce((a, r) => a + (r.quantity || 0), 0);
            row.total_qty       = totalQty;
            row.total_sold      = totalSold;
            row.total_available = totalAvailable;
            row.wac       = costQty > 0 ? totalCost / costQty : 0;
            row.last_cost = freshLots[freshLots.length - 1].cost_basis;
        }
        renderHistoryModal(container, row, existingOverlay);
    }

    const overlay = makeOverlay();
    document.body.appendChild(overlay);
    renderHistoryModal(container, row, overlay);

    // Expose refresh so re-render can swap content in place
    overlay._refresh = () => fetchAndRender(overlay);
}

function renderHistoryModal(container, row, overlay) {
    const totalQty  = row.total_qty;
    const costLots  = row.lots.filter(r => (r.cost_basis || 0) > 0);
    const totalCost = costLots.reduce((a, r) => a + (r.cost_basis * (r.quantity || 0)), 0);
    const costQty   = costLots.reduce((a, r) => a + (r.quantity || 0), 0);
    const wac       = costQty > 0 ? totalCost / costQty : 0;

    const lotRows = row.lots.map((lot, i) => `
        <tr data-lot-index="${i}" style="font-size:13px;">
            <td style="padding:8px 10px; color:var(--text-secondary);">
                ${lot.acquired_at ? new Date(lot.acquired_at).toLocaleDateString() : '—'}
            </td>
            <td style="padding:8px 10px;">
                ${sourceBadge(lot.purchase_source)}
            </td>
            <td style="padding:8px 10px; text-align:right;">
                ${lot.quantity ?? '—'}
                ${lot.quantity_sold ? `<div style="font-size:10px; color:var(--text-secondary);">sold: ${lot.quantity_sold}</div>` : ''}
            </td>
            <td style="padding:8px 10px; text-align:right;">${formatPrice(lot.cost_basis)}</td>
            <td style="padding:8px 10px; text-align:right;">
                ${formatPrice((lot.cost_basis || 0) * (lot.quantity || 0))}
            </td>
            <td style="padding:8px 10px;">
                <button class="btn edit-lot-btn" data-lot-index="${i}"
                        style="font-size:11px; padding:3px 8px;">Edit</button>
            </td>
        </tr>
    `).join('');

    overlay.innerHTML = `
        <div style="background:var(--bg-secondary); border:1px solid var(--border);
                    border-radius:8px; padding:24px; width:620px; max-width:90vw;">
            <h3 style="margin-top:0;">Purchase Order</h3>
            <div style="font-size:13px; color:var(--text-secondary); margin-bottom:16px;">
                <strong style="color:var(--text);">${escapeHtml(row.card_name || '')}</strong>
                — ${escapeHtml(row.set_name || '')} #${escapeHtml(row.card_number || '—')}
                · ${escapeHtml(row.condition || '')}
                · <span style="color:var(--accent);">${escapeHtml(variantLabel(row))}</span>
            </div>

            <table style="width:100%; border-collapse:collapse;">
                <thead>
                    <tr style="font-size:12px; color:var(--text-secondary);
                                border-bottom:1px solid var(--border);">
                        <th style="padding:6px 10px; text-align:left; font-weight:500;">Date</th>
                        <th style="padding:6px 10px; text-align:left; font-weight:500;">Source</th>
                        <th style="padding:6px 10px; text-align:right; font-weight:500;">Qty</th>
                        <th style="padding:6px 10px; text-align:right; font-weight:500;">Cost/ea</th>
                        <th style="padding:6px 10px; text-align:right; font-weight:500;">Lot Total</th>
                        <th style="padding:6px 10px;"></th>
                    </tr>
                </thead>
                <tbody>
                    ${lotRows}
                </tbody>
                <tfoot>
                    <tr style="border-top:2px solid var(--border); font-weight:600; font-size:13px;">
                        <td style="padding:10px 10px;" colspan="2">Total</td>
                        <td style="padding:10px 10px; text-align:right;">${totalQty}</td>
                        <td style="padding:10px 10px; text-align:right; color:var(--accent);">
                            WAC ${formatPrice(wac)}
                        </td>
                        <td style="padding:10px 10px; text-align:right;">${formatPrice(totalCost)}</td>
                        <td></td>
                    </tr>
                </tfoot>
            </table>

            <!-- Inline edit panel — hidden until Edit clicked -->
            <div id="history-edit-panel" style="display:none; margin-top:16px;
                 border-top:1px solid var(--border); padding-top:16px;">
                <div style="font-size:12px; color:var(--text-secondary); margin-bottom:10px;">
                    Editing lot <span id="history-edit-label"></span>
                </div>
                <div style="display:flex; gap:12px; flex-wrap:wrap; margin-bottom:10px;">
                    <label style="font-size:13px;">Quantity
                        <input type="number" id="history-edit-qty" min="0"
                               style="width:80px; margin-top:4px; display:block;" />
                    </label>
                    <label style="font-size:13px;">Cost/ea
                        <input type="number" step="0.01" id="history-edit-cost"
                               style="width:100px; margin-top:4px; display:block;" />
                    </label>
                    <label style="font-size:13px;">Notes
                        <input type="text" id="history-edit-notes"
                               style="width:200px; margin-top:4px; display:block;" />
                    </label>
                </div>
                <div style="display:flex; gap:8px; align-items:center;">
                    <button class="btn btn-primary" id="history-save-btn">Save lot</button>
                    <button class="btn" id="history-cancel-edit-btn">Cancel</button>
                    <span id="history-edit-msg" style="font-size:12px; margin-left:8px;"></span>
                </div>
            </div>

            <!-- New Purchase inline form -->
            <div id="new-purchase-panel" style="display:none; margin-top:16px;
                 border-top:1px solid var(--border); padding-top:16px;">
                <div style="font-size:12px; font-weight:600; color:var(--text-secondary);
                            text-transform:uppercase; letter-spacing:0.04em; margin-bottom:12px;">
                    Quick Add Purchase
                </div>
                <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:10px;">
                    <label style="font-size:12px; color:var(--text-secondary);">Date
                        <input type="date" id="np-date"
                               style="width:130px; margin-top:4px; display:block;" />
                    </label>
                    <label style="font-size:12px; color:var(--text-secondary);">Source
                        <select id="np-source" style="margin-top:4px; display:block;">
                            <option value="local">Local</option>
                            <option value="ebay">eBay</option>
                            <option value="tcgplayer">TCGPlayer</option>
                            <option value="other">Other</option>
                        </select>
                    </label>
                    <label style="font-size:12px; color:var(--text-secondary);">Qty
                        <input type="number" id="np-qty" min="1" value="1"
                               style="width:70px; margin-top:4px; display:block;" />
                    </label>
                    <label style="font-size:12px; color:var(--text-secondary);">Cost/ea
                        <input type="number" step="0.01" id="np-cost" placeholder="0.00"
                               style="width:90px; margin-top:4px; display:block;" />
                    </label>
                    <label style="font-size:12px; color:var(--text-secondary);">Condition
                        <select id="np-condition" style="margin-top:4px; display:block;">
                            <option value="Near Mint">Near Mint</option>
                            <option value="Lightly Played">Lightly Played</option>
                            <option value="Moderately Played">Moderately Played</option>
                            <option value="Heavily Played">Heavily Played</option>
                            <option value="Damaged">Damaged</option>
                        </select>
                    </label>
                    <label style="font-size:12px; color:var(--text-secondary);">Notes
                        <input type="text" id="np-notes" placeholder="optional"
                               style="width:180px; margin-top:4px; display:block;" />
                    </label>
                </div>
                <div style="font-size:11px; color:var(--text-secondary); margin-bottom:10px;">
                    A temporary PO# will be auto-generated. You can link this to a real purchase order later.
                </div>
                <div style="display:flex; gap:8px; align-items:center;">
                    <button class="btn btn-primary" id="np-save-btn">Save purchase</button>
                    <button class="btn" id="np-cancel-btn">Cancel</button>
                    <span id="np-msg" style="font-size:12px; margin-left:8px;"></span>
                </div>
            </div>

            <div style="display:flex; gap:8px; margin-top:20px;">
                <button class="btn btn-primary" id="np-open-btn">+ New Purchase</button>
                <button class="btn" id="history-close-btn">Close</button>
            </div>
        </div>
    `;

    overlay.querySelector('#history-close-btn').addEventListener('click', () => {
        overlay.remove();
        loadAndRender(container);
    });

    // Default date to today
    const npDate = overlay.querySelector('#np-date');
    if (npDate) npDate.value = new Date().toISOString().split('T')[0];

    overlay.querySelector('#np-open-btn').addEventListener('click', () => {
        const panel = overlay.querySelector('#new-purchase-panel');
        panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
        overlay.querySelector('#np-msg').innerHTML = '';
    });

    overlay.querySelector('#np-cancel-btn').addEventListener('click', () => {
        overlay.querySelector('#new-purchase-panel').style.display = 'none';
    });

    overlay.querySelector('#np-save-btn').addEventListener('click', async () => {
        const qty       = parseInt(overlay.querySelector('#np-qty').value);
        const cost      = parseFloat(overlay.querySelector('#np-cost').value) || 0;
        const source    = overlay.querySelector('#np-source').value;
        const condition = overlay.querySelector('#np-condition').value;
        const notes     = overlay.querySelector('#np-notes').value.trim() || null;
        const dateVal   = overlay.querySelector('#np-date').value;
        const msg       = overlay.querySelector('#np-msg');

        if (isNaN(qty) || qty < 1) {
            msg.innerHTML = `<span style="color:var(--danger)">Enter a valid quantity.</span>`;
            return;
        }

        const acquiredAt = dateVal ? new Date(dateVal).toISOString() : new Date().toISOString();
        const tempRef    = 'PO-' + new Date().toISOString().slice(0,10).replace(/-/g,'') +
                           '-' + Math.random().toString(36).slice(2,6).toUpperCase();

        msg.innerHTML = `<span style="color:var(--text-secondary)">Saving...</span>`;

        // 1. Create purchase record
        const { data: purchase, error: purchaseErr } = await supabase
            .from('purchases')
            .insert({
                source,
                purchase_type: 'single',
                reference_id:  tempRef,
                total_cost:    cost * qty,
                card_count:    qty,
                purchased_at:  acquiredAt,
            })
            .select('id')
            .single();

        if (purchaseErr) {
            msg.innerHTML = `<span style="color:var(--danger)">Failed to create PO: ${escapeHtml(purchaseErr.message)}</span>`;
            return;
        }

        // 2. Insert inventory lot directly
        const { error: invErr } = await supabase
            .from('inventory')
            .insert({
                card_id:     row.lots[0].card_id,
                variant_id:  row.variant_id,
                purchase_id: purchase.id,
                condition,
                is_graded:   false,
                quantity:    qty,
                cost_basis:  cost,
                notes,
                acquired_at: acquiredAt,
            });

        if (invErr) {
            msg.innerHTML = `<span style="color:var(--danger)">Failed to add inventory: ${escapeHtml(invErr.message)}</span>`;
            return;
        }

        // Reset form fields
        overlay.querySelector('#np-qty').value   = '1';
        overlay.querySelector('#np-cost').value  = '';
        overlay.querySelector('#np-notes').value = '';
        overlay.querySelector('#new-purchase-panel').style.display = 'none';
        msg.innerHTML = `<span style="color:var(--success)">✓ Added! PO# ${tempRef}</span>`;

        // Refresh modal in place with new lot
        if (overlay._refresh) await overlay._refresh();
    });

    let activeLotIndex = null;

    overlay.querySelectorAll('.edit-lot-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const i   = parseInt(btn.dataset.lotIndex);
            const lot = row.lots[i];
            activeLotIndex = i;
            const panel = overlay.querySelector('#history-edit-panel');
            panel.style.display = 'block';
            overlay.querySelector('#history-edit-label').textContent =
                `${lot.acquired_at ? new Date(lot.acquired_at).toLocaleDateString() : 'unknown date'} · ${lot.purchase_source || ''}`;
            overlay.querySelector('#history-edit-qty').value   = lot.quantity ?? '';
            overlay.querySelector('#history-edit-cost').value  = lot.cost_basis ?? '';
            overlay.querySelector('#history-edit-notes').value = lot.notes ?? '';
        });
    });

    overlay.querySelector('#history-cancel-edit-btn').addEventListener('click', () => {
        overlay.querySelector('#history-edit-panel').style.display = 'none';
        activeLotIndex = null;
    });

    overlay.querySelector('#history-save-btn').addEventListener('click', async () => {
        if (activeLotIndex === null) return;
        const lot   = row.lots[activeLotIndex];
        const qty   = parseInt(overlay.querySelector('#history-edit-qty').value);
        const cost  = parseFloat(overlay.querySelector('#history-edit-cost').value) || null;
        const notes = overlay.querySelector('#history-edit-notes').value.trim() || null;
        const msg   = overlay.querySelector('#history-edit-msg');

        if (isNaN(qty) || qty < 0) {
            msg.innerHTML = `<span style="color:var(--danger)">Invalid quantity.</span>`;
            return;
        }

        const { error } = await supabase
            .from('inventory')
            .update({ quantity: qty, cost_basis: cost, notes, updated_at: new Date().toISOString() })
            .eq('id', lot.id);

        if (error) {
            msg.innerHTML = `<span style="color:var(--danger)">Save failed: ${escapeHtml(error.message)}</span>`;
            return;
        }

        // Re-fetch from DB and re-render modal in place with fresh data
        activeLotIndex = null;
        if (overlay._refresh) await overlay._refresh();
    });
}

// ----------------------------------------------------------------
// List modal — create a new platform listing
// ----------------------------------------------------------------

function openListModal(container, row) {
    const overlay = makeOverlay();

    // Margin calculation helper
    const calcMargin = (price, cost) => {
        if (!price || !cost || cost <= 0) return '';
        const margin = price - cost;
        const pct    = ((margin / cost) * 100).toFixed(0);
        const color  = margin >= 0 ? 'var(--success)' : 'var(--danger)';
        return `<span style="color:${color};">
            ${margin >= 0 ? '+' : ''}${formatPrice(margin)} (${pct}%)
        </span>`;
    };

    overlay.innerHTML = `
        <div style="background:var(--bg-secondary); border:1px solid var(--border);
                    border-radius:8px; padding:24px; width:480px; max-width:90vw;">
            <h3 style="margin-top:0;">List on platform</h3>

            <!-- Card info header -->
            <div style="background:var(--bg-tertiary); border:1px solid var(--border);
                        border-radius:6px; padding:10px 14px; margin-bottom:16px; font-size:13px;">
                <div style="font-weight:600; margin-bottom:4px;">
                    ${escapeHtml(row.card_name || '')}
                    <span style="color:var(--text-secondary); font-weight:400;">
                        — ${escapeHtml(row.set_name || '')} #${escapeHtml(row.card_number || '—')}
                        · ${escapeHtml(row.condition || '')}
                    </span>
                    · <span style="color:var(--accent);">${escapeHtml(variantLabel(row))}</span>
                    ${row.rarity ? `· <span style="color:var(--text-secondary);">${escapeHtml(row.rarity)}</span>` : ''}
                </div>
                <div style="display:flex; gap:20px; color:var(--text-secondary);">
                    <span>Cost: <strong style="color:var(--text);">${formatPrice(row.cost_basis)}</strong></span>
                    <span>Market: <strong style="color:var(--text);">${row.market_price ? formatPrice(row.market_price) : '—'}</strong>
                        ${row.market_updated_at
                            ? `<span style="font-size:11px;"> · ${new Date(row.market_updated_at).toLocaleDateString()}</span>`
                            : ''}
                    </span>
                    <span id="margin-display"></span>
                </div>
            </div>

            <div style="display:flex; flex-direction:column; gap:12px;">
                <div style="display:flex; gap:12px;">
                    <label style="font-size:13px; flex:1;">Platform
                        <select class="list-platform" style="width:100%; margin-top:4px;">
                            ${PLATFORMS.map(p => `<option value="${p}">${p}</option>`).join('')}
                        </select>
                    </label>
                    <label style="font-size:13px; flex:1;">Account <span class="ebay-required" style="color:var(--danger); display:none;">*</span>
                        <input type="text" class="list-account" placeholder="e.g. my_ebay_store"
                               style="width:100%; margin-top:4px;" />
                    </label>
                </div>
                <div style="display:flex; gap:12px;">
                    <label style="font-size:13px; flex:1;">List price
                        <input type="number" step="0.01" class="list-price"
                               value="${row.market_price ? row.market_price.toFixed(2) : ''}"
                               placeholder="0.00" style="width:100%; margin-top:4px;" />
                    </label>
                    <label style="font-size:13px; flex:1;">Quantity to list
                        <input type="number" class="list-qty" value="${row.quantity ?? 1}"
                               min="1" max="${row.quantity ?? 1}"
                               style="width:100%; margin-top:4px;" />
                    </label>
                </div>
                <div style="display:flex; gap:12px;">
                    <label style="font-size:13px; flex:1;">Quantity limit <span style="color:var(--text-secondary); font-size:12px;">(max to keep listed)</span>
                        <input type="number" class="list-qty-limit" value="${row.quantity ?? 1}"
                               min="1" style="width:100%; margin-top:4px;" />
                    </label>
                    <label style="font-size:13px; flex:1;">eBay Item # <span class="ebay-required" style="color:var(--danger); display:none;">*</span><span class="ebay-optional" style="color:var(--text-secondary);">(optional)</span>
                        <input type="text" class="list-listing-id" placeholder="e.g. 334903509883"
                               style="width:100%; margin-top:4px;" />
                    </label>
                </div>
                <label style="font-size:13px;">Variation name <span style="color:var(--text-secondary);">(optional)</span>
                    <input type="text" class="list-external-id" placeholder="e.g. 011/193 Abomasnow Holo"
                           style="width:100%; margin-top:4px;" />
                </label>
                <label style="font-size:13px;">Description <span style="color:var(--text-secondary);">(optional)</span>
                    <textarea class="list-description" rows="4"
                              placeholder="Listing description..."
                              style="width:100%; margin-top:4px; background:var(--bg-tertiary);
                                     border:1px solid var(--border); color:var(--text);
                                     border-radius:4px; padding:6px 8px; font-size:13px;
                                     resize:vertical;"></textarea>
                </label>
            </div>

            <div class="modal-message" style="margin-top:10px; font-size:13px;"></div>
            <div style="display:flex; gap:8px; margin-top:16px;">
                <button class="btn btn-primary list-save-btn" data-status="active">Create listing</button>
                <button class="btn list-draft-btn" data-status="draft" style="border-color:var(--warning); color:var(--warning);">Save as draft</button>
                <button class="btn list-nosync-btn" data-status="do_not_sync" style="border-color:#a78bfa; color:#a78bfa;">Do not sync</button>
                <button class="btn list-cancel-btn">Cancel</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    overlay.querySelector('.list-cancel-btn').addEventListener('click', () => overlay.remove());

    // Show/hide required indicators based on platform
    const toggleEbayRequired = (platform) => {
        overlay.querySelectorAll('.ebay-required').forEach(el =>
            el.style.display = platform === 'ebay' ? 'inline' : 'none');
        overlay.querySelectorAll('.ebay-optional').forEach(el =>
            el.style.display = platform === 'ebay' ? 'none' : 'inline');
    };
    overlay.querySelector('.list-platform').addEventListener('change', (e) =>
        toggleEbayRequired(e.target.value));

    // Live margin update
    overlay.querySelector('.list-price').addEventListener('input', (e) => {
        const price = parseFloat(e.target.value);
        overlay.querySelector('#margin-display').innerHTML =
            calcMargin(price, row.cost_basis);
    });
    // Init margin with market price
    if (row.market_price) {
        overlay.querySelector('#margin-display').innerHTML =
            calcMargin(row.market_price, row.cost_basis);
    }

    const handleListSave = async (status) => {
        const platform    = overlay.querySelector('.list-platform').value;
        const account     = overlay.querySelector('.list-account').value.trim() || null;
        const price       = parseFloat(overlay.querySelector('.list-price').value);
        const qty         = parseInt(overlay.querySelector('.list-qty').value);
        const listingId   = overlay.querySelector('.list-listing-id').value.trim() || null;
        const externalId  = overlay.querySelector('.list-external-id').value.trim() || null;
        const description = overlay.querySelector('.list-description').value.trim() || null;
        const msgArea     = overlay.querySelector('.modal-message');

        if (!price || isNaN(price) || price <= 0) {
            msgArea.innerHTML = `<span style="color:var(--danger)">Enter a valid list price.</span>`;
            return;
        }
        if (!qty || isNaN(qty) || qty <= 0) {
            msgArea.innerHTML = `<span style="color:var(--danger)">Enter a valid quantity.</span>`;
            return;
        }
        if (platform === 'ebay') {
            if (!account) {
                msgArea.innerHTML = `<span style="color:var(--danger)">Account is required for eBay listings.</span>`;
                return;
            }
            if (!listingId) {
                msgArea.innerHTML = `<span style="color:var(--danger)">eBay Item # is required for eBay listings.</span>`;
                return;
            }
        }
        if (!row.variant_id) {
            msgArea.innerHTML = `<span style="color:var(--danger)">This inventory row has no variant — cannot create listing.</span>`;
            return;
        }

        const { error } = await supabase
            .from('platform_listings')
            .insert({
                variant_id:      row.variant_id,
                platform,
                account,
                listing_id:      listingId,
                external_id:     externalId,
                list_price:      price,
                quantity_listed: qty,
                quantity_limit:  parseInt(overlay.querySelector('.list-qty-limit').value) || null,
                description,
                status:          status,
                listed_at:       new Date().toISOString(),
            });

        if (error) {
            msgArea.innerHTML = `<span style="color:var(--danger)">Failed: ${escapeHtml(error.message)}</span>`;
            return;
        }
        overlay.remove();

        // Refresh background table
        await loadAndRender(container);

        // Re-expand the detail panel with fresh listings
        const detailTr = document.getElementById(`detail-${row.variant_id}`);
        if (detailTr) {
            // Find the data row above and highlight it
            const dataRow = detailTr.previousElementSibling;
            if (dataRow) dataRow.style.background = 'var(--bg-secondary)';

            const { data: listings } = await supabase
                .from('platform_listings')
                .select('*')
                .eq('variant_id', row.variant_id)
                .order('platform');
            row._listings = listings || [];
            detailTr.style.display = '';
            detailTr.style.background = 'var(--bg-secondary)';
            const td = detailTr.querySelector('td');
            renderDetailPanel(container, row, td);

            // Flash a saved confirmation at the top of the panel
            const flash = document.createElement('div');
            flash.style.cssText = `font-size:12px; color:var(--success);
                padding:6px 16px 0 58px; background:var(--bg-secondary);`;
            flash.textContent = '✓ Listing saved';
            td.querySelector('div').prepend(flash);
            setTimeout(() => flash.remove(), 2500);
        }
    };

    overlay.querySelector('.list-save-btn').addEventListener('click', () => handleListSave('active'));
    overlay.querySelector('.list-draft-btn').addEventListener('click', () => handleListSave('draft'));
    overlay.querySelector('.list-nosync-btn').addEventListener('click', () => handleListSave('do_not_sync'));
}

// ----------------------------------------------------------------
// Listings modal — view & manage existing listings
// ----------------------------------------------------------------

async function openListingsModal(container, row) {
    const overlay = makeOverlay();

    overlay.innerHTML = `
        <div style="background:var(--bg-secondary); border:1px solid var(--border);
                    border-radius:8px; padding:24px; width:560px; max-width:90vw;">
            <h3 style="margin-top:0;">Active listings</h3>
            <div style="font-size:13px; color:var(--text-secondary); margin-bottom:16px;">
                <strong style="color:var(--text);">${escapeHtml(row.card_name || '')}</strong>
                — ${escapeHtml(row.set_name || '')} #${escapeHtml(row.card_number || '—')}
                · ${escapeHtml(row.condition || '')}
                · <span style="color:var(--accent);">${escapeHtml(variantLabel(row))}</span>
                ${row.rarity ? `· <span style="color:var(--text-secondary);">${escapeHtml(row.rarity)}</span>` : ''}
            </div>
            <div id="listings-list">Loading...</div>
            <div style="display:flex; gap:8px; margin-top:16px;">
                <button class="btn btn-primary add-listing-btn">+ Add listing</button>
                <button class="btn close-btn">Close</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    overlay.querySelector('.close-btn').addEventListener('click', () => overlay.remove());
    overlay.querySelector('.add-listing-btn').addEventListener('click', () => {
        overlay.remove();
        openListModal(container, row);
    });

    const { data, error } = await supabase
        .from('platform_listings')
        .select('*')
        .eq('variant_id', row.variant_id)
        .in('status', ['active', 'draft', 'do_not_sync'])
        .order('listed_at', { ascending: false });

    const listEl = overlay.querySelector('#listings-list');

    if (error || !data || data.length === 0) {
        listEl.innerHTML = `<p style="color:var(--text-secondary); font-size:13px;">No active listings found.</p>`;
        return;
    }

    listEl.innerHTML = '';

    // Render collapsible listing rows
    for (const l of data) {
        const div = document.createElement('div');
        div.className = 'listing-row';
        div.dataset.id = l.id;
        div.style.cssText = 'border-bottom:1px solid var(--border); font-size:13px;';

        const statusColor = {
            active:      'var(--success)',
            draft:       'var(--warning)',
            do_not_sync: '#a78bfa',
            delisted:    'var(--danger)',
        }[l.status] || 'var(--text-secondary)';

        div.innerHTML = `
            <!-- Collapsed header — always visible, click to expand -->
            <div class="listing-header" style="display:flex; align-items:center; gap:10px;
                         padding:10px 0; cursor:pointer; user-select:none;">
                <span style="font-weight:600; text-transform:capitalize;">${escapeHtml(l.platform)}</span>
                ${l.account ? `<span style="font-size:12px; color:var(--text-secondary);">${escapeHtml(l.account)}</span>` : ''}
                ${l.listing_id ? `<span style="font-size:12px; color:var(--text-secondary);">Item #: <span style="color:var(--accent); font-weight:600;">${escapeHtml(l.listing_id)}</span></span>` : ''}
                <span style="font-size:11px; padding:2px 6px; border-radius:8px;
                             background:rgba(255,255,255,0.05); color:${statusColor};">
                    ${escapeHtml(l.status)}
                </span>
                <span style="font-weight:600;">${formatPrice(l.list_price)}</span>
                <span style="font-size:12px; color:var(--text-secondary);">
                    Qty: ${l.quantity_listed ?? '—'}${l.quantity_limit ? ` / Limit: ${l.quantity_limit}` : ''}
                </span>
                <span style="margin-left:auto; font-size:11px; color:var(--text-secondary);">
                    ${l.listed_at ? new Date(l.listed_at).toLocaleDateString() : ''}
                </span>
                <span class="expand-icon" style="color:var(--text-secondary); font-size:11px;">▶</span>
            </div>

            <!-- Edit panel — hidden by default -->
            <div class="listing-edit-panel" style="display:none; padding-bottom:12px;">
                <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:8px;">
                    <label style="font-size:12px; color:var(--text-secondary);">Price
                        <input type="number" step="0.01" class="edit-list-price"
                               value="${l.list_price ?? ''}"
                               style="width:80px; margin-top:2px; display:block;" />
                    </label>
                    <label style="font-size:12px; color:var(--text-secondary);">Qty Listed
                        <input type="number" class="edit-list-qty"
                               value="${l.quantity_listed ?? ''}"
                               style="width:70px; margin-top:2px; display:block;" />
                    </label>
                    <label style="font-size:12px; color:var(--text-secondary);">Qty Limit
                        <input type="number" class="edit-list-limit"
                               value="${l.quantity_limit ?? ''}"
                               style="width:70px; margin-top:2px; display:block;" />
                    </label>
                    <label style="font-size:12px; color:var(--text-secondary);">eBay Item #
                        <input type="text" class="edit-listing-id"
                               value="${escapeHtml(l.listing_id || '')}"
                               style="width:130px; margin-top:2px; display:block;" />
                    </label>
                    <label style="font-size:12px; color:var(--text-secondary);">Variation
                        <input type="text" class="edit-external-id"
                               value="${escapeHtml(l.external_id || '')}"
                               style="width:160px; margin-top:2px; display:block;" />
                    </label>
                    <label style="font-size:12px; color:var(--text-secondary);">Status
                        <select class="edit-status" style="margin-top:2px; display:block;">
                            <option value="active"      ${l.status === 'active'      ? 'selected' : ''}>active</option>
                            <option value="draft"       ${l.status === 'draft'       ? 'selected' : ''}>draft</option>
                            <option value="do_not_sync" ${l.status === 'do_not_sync' ? 'selected' : ''}>do_not_sync</option>
                            <option value="delisted"    ${l.status === 'delisted'    ? 'selected' : ''}>delisted</option>
                        </select>
                    </label>
                </div>
                <label style="font-size:12px; color:var(--text-secondary); display:block; margin-bottom:8px;">Description
                    <textarea class="edit-description" rows="2"
                              style="width:100%; margin-top:2px; background:var(--bg-tertiary);
                                     border:1px solid var(--border); color:var(--text);
                                     border-radius:4px; padding:4px 8px; font-size:12px; resize:vertical;"
                    >${escapeHtml(l.description || '')}</textarea>
                </label>
                <div style="display:flex; gap:8px; align-items:center;">
                    <button class="btn btn-primary save-listing-btn"
                            style="font-size:12px; padding:4px 10px;">Save</button>
                    <button class="btn delete-listing-btn"
                            style="font-size:12px; padding:4px 8px; color:var(--danger);
                                   border-color:var(--danger); margin-left:auto;">Delete</button>
                </div>
                <div class="listing-msg" style="font-size:12px; margin-top:6px;"></div>
            </div>
        `;

        listEl.appendChild(div);

        // Toggle expand/collapse on header click
        div.querySelector('.listing-header').addEventListener('click', () => {
            const panel = div.querySelector('.listing-edit-panel');
            const icon  = div.querySelector('.expand-icon');
            const isOpen = panel.style.display !== 'none';
            panel.style.display = isOpen ? 'none' : 'block';
            icon.textContent    = isOpen ? '▶' : '▼';
        });

        // Save handler — updates all fields including status
        div.querySelector('.save-listing-btn').addEventListener('click', async () => {
            const price    = parseFloat(div.querySelector('.edit-list-price').value) || null;
            const qty      = parseInt(div.querySelector('.edit-list-qty').value) || null;
            const limit    = parseInt(div.querySelector('.edit-list-limit').value) || null;
            const listId   = div.querySelector('.edit-listing-id').value.trim() || null;
            const extId    = div.querySelector('.edit-external-id').value.trim() || null;
            const status   = div.querySelector('.edit-status').value;
            const desc     = div.querySelector('.edit-description').value.trim() || null;
            const msg      = div.querySelector('.listing-msg');

            const { error } = await supabase
                .from('platform_listings')
                .update({
                    list_price:      price,
                    quantity_listed: qty,
                    quantity_limit:  limit,
                    listing_id:      listId,
                    external_id:     extId,
                    status,
                    description:     desc,
                    synced_at:       new Date().toISOString(),
                })
                .eq('id', l.id);

            if (error) {
                msg.innerHTML = `<span style="color:var(--danger)">Save failed: ${escapeHtml(error.message)}</span>`;
                return;
            }
            msg.innerHTML = `<span style="color:var(--success)">Saved!</span>`;
            setTimeout(() => loadAndRender(container), 800);
        });

        // Delete handler — permanently removes the platform listing row
        div.querySelector('.delete-listing-btn').addEventListener('click', async () => {
            const confirmed = window.confirm('Permanently delete this listing record? This cannot be undone.');
            if (!confirmed) return;

            const btn = div.querySelector('.delete-listing-btn');
            btn.disabled    = true;
            btn.textContent = '...';

            const { error } = await supabase
                .rpc('delete_platform_listing', { p_id: l.id });

            if (error) {
                btn.disabled    = false;
                btn.textContent = 'Delete';
                alert('Failed to delete: ' + error.message);
                return;
            }

            div.remove();
            await loadAndRender(container);
        });
    }
}

// ----------------------------------------------------------------
// Pagination
// ----------------------------------------------------------------

function renderPagination(container) {
    const el          = container.querySelector('#inv-pagination');
    const totalPages  = Math.max(1, Math.ceil(state.totalCount / state.pageSize));
    const currentPage = state.page + 1;

    el.innerHTML = `
        <button class="btn" id="inv-prev" ${state.page === 0 ? 'disabled' : ''}>Previous</button>
        <span>Page ${currentPage} of ${totalPages} (${state.totalCount.toLocaleString()} rows)</span>
        <button class="btn" id="inv-next" ${currentPage >= totalPages ? 'disabled' : ''}>Next</button>
    `;

    el.querySelector('#inv-prev')?.addEventListener('click', () => {
        if (state.page > 0) { state.page -= 1; loadAndRender(container); }
    });
    el.querySelector('#inv-next')?.addEventListener('click', () => {
        state.page += 1; loadAndRender(container);
    });
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

// ----------------------------------------------------------------
// Sales modal — read-only list of recorded sales for this variant
// ----------------------------------------------------------------

async function openSalesModal(container, row) {
    const overlay = makeOverlay();

    overlay.innerHTML = `
        <div style="background:var(--bg-secondary); border:1px solid var(--border);
                    border-radius:8px; padding:24px; width:680px; max-width:90vw;
                    max-height:80vh; overflow-y:auto;">
            <h3 style="margin-top:0;">Sales</h3>
            <div style="font-size:13px; color:var(--text-secondary); margin-bottom:16px;">
                <strong style="color:var(--text);">${escapeHtml(row.card_name || '')}</strong>
                — ${escapeHtml(row.set_name || '')} #${escapeHtml(row.card_number || '—')}
                · ${escapeHtml(row.condition || '')}
                · <span style="color:var(--accent);">${escapeHtml(variantLabel(row))}</span>
            </div>
            <div id="sales-list">Loading...</div>
            <div style="display:flex; gap:8px; margin-top:16px;">
                <button class="btn close-btn">Close</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    overlay.querySelector('.close-btn').addEventListener('click', () => overlay.remove());

    const { data, error } = await supabase
        .from('sales')
        .select('*')
        .eq('variant_id', row.variant_id)
        .order('sold_at', { ascending: false });

    const listEl = overlay.querySelector('#sales-list');

    if (error) {
        listEl.innerHTML = `<p style="color:var(--danger); font-size:13px;">
            Failed to load sales: ${escapeHtml(error.message)}</p>`;
        return;
    }

    if (!data || data.length === 0) {
        listEl.innerHTML = `<p style="color:var(--text-secondary); font-size:13px;">No sales recorded yet.</p>`;
        return;
    }

    const totalQty     = data.reduce((a, s) => a + (s.quantity_sold || 0), 0);
    const totalRevenue = data.reduce((a, s) => a + (s.sale_price || 0) * (s.quantity_sold || 0), 0);

    const rows = data.map(s => {
        const revenue = (s.sale_price || 0) * (s.quantity_sold || 0);
        return `
            <tr style="font-size:13px; border-bottom:1px solid var(--border);">
                <td style="padding:8px 10px; color:var(--text-secondary);">
                    ${s.sold_at ? new Date(s.sold_at).toLocaleDateString() : '—'}
                </td>
                <td style="padding:8px 10px;">
                    <span style="text-transform:capitalize;">${escapeHtml(s.platform || '—')}</span>
                    ${s.account ? `<span style="font-size:11px; color:var(--text-secondary);"> (${escapeHtml(s.account)})</span>` : ''}
                </td>
                <td style="padding:8px 10px; color:var(--text-secondary); font-size:12px;
                           ${s.notes ? 'cursor:help; border-bottom:1px dotted var(--text-secondary);' : ''}"
                    ${s.notes ? `title="${escapeHtml(s.notes)}"` : ''}>
                    ${escapeHtml(s.platform_order_id || '—')}
                </td>
                <td style="padding:8px 10px; text-align:right;">${s.quantity_sold ?? '—'}</td>
                <td style="padding:8px 10px; text-align:right;">${formatPrice(s.sale_price)}</td>
                <td style="padding:8px 10px; text-align:right; font-weight:600;">${formatPrice(revenue)}</td>
            </tr>
        `;
    }).join('');

    listEl.innerHTML = `
        <table style="width:100%; border-collapse:collapse;">
            <thead>
                <tr style="font-size:12px; color:var(--text-secondary); border-bottom:1px solid var(--border);">
                    <th style="padding:6px 10px; text-align:left; font-weight:500;">Date</th>
                    <th style="padding:6px 10px; text-align:left; font-weight:500;">Platform</th>
                    <th style="padding:6px 10px; text-align:left; font-weight:500;">Order #</th>
                    <th style="padding:6px 10px; text-align:right; font-weight:500;">Qty</th>
                    <th style="padding:6px 10px; text-align:right; font-weight:500;">Price/ea</th>
                    <th style="padding:6px 10px; text-align:right; font-weight:500;">Revenue</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
            <tfoot>
                <tr style="border-top:2px solid var(--border); font-weight:600; font-size:13px;">
                    <td style="padding:10px 10px;" colspan="3">Total</td>
                    <td style="padding:10px 10px; text-align:right;">${totalQty}</td>
                    <td></td>
                    <td style="padding:10px 10px; text-align:right;">${formatPrice(totalRevenue)}</td>
                </tr>
            </tfoot>
        </table>
    `;
}

function makeOverlay() {
    const overlay = document.createElement('div');
    overlay.style.cssText = `position:fixed; inset:0; background:rgba(0,0,0,0.6);
        display:flex; align-items:center; justify-content:center; z-index:1000;`;
    return overlay;
}

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

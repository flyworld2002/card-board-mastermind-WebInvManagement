// staging-review.js
// Staging Review page: filter, edit, resolve, and push staging rows to inventory.

import { supabase, debounce, formatPrice, loadAxisOptions, AXIS_TABLES, AXIS_OPTIONS, AXIS_DISPLAY, axisDisplay } from './shared.js';

const PAGE_SIZES = [50, 100, 250];

// Same LAN service the Picking and Listing Pricing pages call — see
// CLAUDE.md's cross-repo contract note. Used here only to kick off the
// TCGPlayer HTML import job (importer/tcgplayer_html.py on the CBMM side).
const PICKING_API_URL = 'https://desktop-tu1m2fc.tail2c58d7.ts.net:8765';
const PICKING_API_TOKEN = 'I1knbOJAve_UZJQHAFZANds9-HalgCxcRJw1GXDg404';
const JOB_POLL_INTERVAL_MS = 2000;

const state = {
    page: 0,
    pageSize: 50,
    totalCount: 0,
    rows: [],
    filters: {
        source: 'all',
        status: 'all',
        match_status: 'all',
        import_batch: 'all',
        set_name: 'all',
        search: '',
    },
    importBatches: [],
    sets: [],
    counts: {
        // Filtered counts — used for numbers in parens when filters active
    },
    allCounts: {
        // Full unfiltered counts — used for dropdown option lists
    },
    expandedRowId: null,
    selectedIds: new Set(),
    sort: { column: null, ascending: true }, // null = default order_date/card_name sort
    // Last batch-action summary (push/delete/rematch), rendered into
    // .batch-progress by renderTable. Needed because every batch action
    // ends with loadAndRenderRows(), which wipes the whole table wrapper
    // (including .batch-progress) to refetch -- without storing the
    // message in state, it gets set and destroyed in the same tick and
    // the user never sees it.
    batchMessage: null,
};

export async function renderStagingReview(container) {
    container.innerHTML = `
        <h2 style="margin-top:0;">Staging Review</h2>
        <div class="filters-bar" id="filters-bar"></div>
        <div id="staging-table-wrap">
            <p>Loading staging rows...</p>
        </div>
        <div class="pagination" id="pagination"></div>
    `;

    await loadImportBatches();
    await loadSets();
    await loadAxisOptions(true);  // Staging's dropdowns want a leading '— none —'
    await loadFilterCounts();
    renderFilters(container);
    await loadAndRenderRows(container);
}

// Variant attribute options (AXIS_OPTIONS, AXIS_DISPLAY, loadAxisOptions,
// axisDisplay) now live in shared.js -- imported above -- rather than a
// local copy here, so Staging Review, Inventory, and Catalog all read
// from one implementation instead of three that could drift apart.

// ----------------------------------------------------------------
// Data loading
// ----------------------------------------------------------------

async function loadImportBatches() {
    // Get distinct batches from staging counts RPC (avoids row limit)
    const { data, error } = await supabase.rpc('get_staging_counts');

    if (error) {
        console.error('Failed to load import batches:', error);
        state.importBatches = [];
        return;
    }

    const batchNames = Object.keys(data?.import_batch || {}).filter(Boolean);
    if (!batchNames.length) {
        state.importBatches = [];
        return;
    }

    // Order by actual creation time (latest first), not a string sort on
    // the batch ID -- ID formats vary by source (batch_/TCGP_/ebay_ embed
    // HHMMSS, local_ embeds a random suffix instead, and a few older ones
    // are free-form) so lexicographic order doesn't reliably reflect
    // recency. The staging table is small (tens of batches), so pulling
    // just (import_batch, created_at) and taking each batch's most recent
    // row client-side is cheap and needs no new RPC/view.
    const { data: rows, error: timeErr } = await supabase
        .from('staging')
        .select('import_batch, created_at')
        .in('import_batch', batchNames)
        .order('created_at', { ascending: false });

    if (timeErr) {
        console.error('Failed to load batch timestamps, falling back to alphabetical:', timeErr);
        state.importBatches = batchNames.sort();
        return;
    }

    const seen = new Set();
    const ordered = [];
    for (const row of rows || []) {
        if (!seen.has(row.import_batch)) {
            seen.add(row.import_batch);
            ordered.push(row.import_batch);
        }
    }
    for (const b of batchNames) if (!seen.has(b)) ordered.push(b);

    state.importBatches = ordered;
}

async function loadSets() {
    // Load all sets from card_sets table — the complete catalog.
    // Filtering staging by a set with no staging rows just returns empty,
    // which is fine and keeps the dropdown comprehensive and data-driven.
    const { data, error } = await supabase
        .from('card_sets')
        .select('name')
        .order('name', { ascending: true });

    if (error) {
        console.error('Failed to load sets:', error);
        state.sets = [];
        return;
    }

    state.sets = data.map(r => r.name);
}

/**
 * Load counts for all filter options by fetching rows and grouping client-side.
 * Much simpler than trying to use grouped queries.
 */
async function loadFilterCounts() {
    state.counts = {
        source: {},
        status: {},
        match_status: {},
        import_batch: {},
        set_name: {},
    };
    state.allCounts = {
        source: {},
        status: {},
        match_status: {},
        import_batch: {},
        set_name: {},
    };

    const f = state.filters;
    const hasFilter = f.source !== 'all' || f.status !== 'all' ||
                      f.match_status !== 'all' || f.import_batch !== 'all' ||
                      f.set_name !== 'all' || f.search.trim();

    // Always get full unfiltered counts for dropdown options
    const { data: allData, error: allError } = await supabase.rpc('get_staging_counts');
    if (allError) { console.error('loadFilterCounts error:', allError); return; }
    if (!allData) return;

    state.allCounts.source       = allData.source       || {};
    state.allCounts.status       = allData.status       || {};
    state.allCounts.match_status = allData.match_status || {};
    state.allCounts.import_batch = allData.import_batch || {};
    state.allCounts.set_name     = allData.set_name     || {};

    // Also update importBatches from full counts
    state.importBatches = Object.keys(state.allCounts.import_batch).filter(Boolean).sort();

    if (hasFilter) {
        // Get filtered counts to show in parens
        const params = {
            p_source:       f.source       !== 'all' ? f.source       : null,
            p_status:       f.status       !== 'all' ? f.status       : null,
            p_match_status: f.match_status !== 'all' ? f.match_status : null,
            p_import_batch: f.import_batch !== 'all' ? f.import_batch : null,
            p_set_name:     f.set_name     !== 'all' ? f.set_name     : null,
            p_search:       f.search.trim() || null,
        };
        const { data, error } = await supabase.rpc('get_staging_counts', params);
        if (!error && data) {
            state.counts.source       = data.source       || {};
            state.counts.status       = data.status       || {};
            state.counts.match_status = data.match_status || {};
            state.counts.import_batch = data.import_batch || {};
            state.counts.set_name     = data.set_name     || {};
        }
    } else {
        // No filters — filtered counts = all counts
        state.counts = { ...state.allCounts };
    }
}

async function loadAndRenderRows(container) {
    const wrap = container.querySelector('#staging-table-wrap');
    wrap.innerHTML = '<p>Loading staging rows...</p>';

    let query = supabase
        .from('v_staging')
        .select('*', { count: 'exact' });

    const f = state.filters;

    if (f.source !== 'all') {
        query = query.eq('source', f.source);
    }
    if (f.status !== 'all') {
        query = query.eq('status', f.status);
    }
    if (f.match_status !== 'all') {
        query = query.eq('match_status', f.match_status);
    }
    if (f.import_batch !== 'all') {
        query = query.eq('import_batch', f.import_batch);
    }
    if (f.set_name !== 'all') {
        query = query.or(`matched_set_name.eq.${f.set_name},set_name.eq.${f.set_name}`);
    }
    if (f.search.trim()) {
        query = query.ilike('card_name', `%${f.search.trim()}%`);
    }

    const from = state.page * state.pageSize;
    const to = from + state.pageSize - 1;

    if (state.sort.column) {
        query = query.order(state.sort.column, { ascending: state.sort.ascending, nullsFirst: false });
    } else {
        query = query
            .order('order_date', { ascending: false })
            .order('card_name', { ascending: true });
    }
    query = query.range(from, to);

    const { data, error, count } = await query;

    if (error) {
        wrap.innerHTML = `<p style="color:var(--danger)">Error loading staging rows: ${error.message}</p>`;
        return;
    }

    state.rows = data;
    state.totalCount = count ?? 0;

    renderTable(container);
    renderPagination(container);
}

// ----------------------------------------------------------------
// Filters bar
// ----------------------------------------------------------------

function renderFilters(container) {
    const bar = container.querySelector('#filters-bar');
    const c = state.counts;

    // Helper to generate options with counts
    const makeOptions = (field, data) => {
        const options = [`<option value="all">All ${field}s</option>`];
        for (const [key, count] of Object.entries(data).sort()) {
            options.push(`<option value="${escapeHtml(key)}">${escapeHtml(key)} (${count})</option>`);
        }
        return options.join('');
    };

    bar.innerHTML = `
        <select id="filter-source">
            <option value="all">All sources</option>
            ${Object.keys(state.allCounts.source || {}).sort().map(src => {
                const n = (c.source || {})[src] || 0;
                const isSelected = src === state.filters.source;
                if (n === 0 && !isSelected) return '';
                return `<option value="${escapeHtml(src)}">${escapeHtml(src)} (${n})</option>`;
            }).filter(Boolean).join('')}
        </select>

        <select id="filter-status">
            <option value="all">All statuses</option>
            ${Object.keys(state.allCounts.status || {}).sort().map(status => {
                const n = (c.status || {})[status] || 0;
                const isSelected = status === state.filters.status;
                if (n === 0 && !isSelected) return '';
                return `<option value="${escapeHtml(status)}">${escapeHtml(status)} (${n})</option>`;
            }).filter(Boolean).join('')}
        </select>

        <select id="filter-match-status">
            <option value="all">All match statuses</option>
            ${Object.keys(state.allCounts.match_status || {}).sort().map(status => {
                const n = (c.match_status || {})[status] || 0;
                const isSelected = status === state.filters.match_status;
                if (n === 0 && !isSelected) return '';
                return `<option value="${escapeHtml(status)}">${escapeHtml(status)} (${n})</option>`;
            }).filter(Boolean).join('')}
        </select>

        <select id="filter-import-batch">
            <option value="all">All batches (${Object.values(c.import_batch || {}).reduce((a, b) => a + b, 0)})</option>
            ${(state.importBatches || []).map(b => {
                const count = (c.import_batch || {})[b] || 0;
                const isSelected = b === state.filters.import_batch;
                if (count === 0 && !isSelected) return '';
                return `<option value="${escapeHtml(b)}">${escapeHtml(b)} (${count})</option>`;
            }).filter(Boolean).join('')}
        </select>

        <select id="filter-set">
            <option value="all">All sets</option>
            ${Object.keys(state.allCounts.set_name || {}).filter(Boolean).sort().map(s => {
                const count = (c.set_name || {})[s] || 0;
                const isSelected = s === state.filters.set_name;
                if (count === 0 && !isSelected) return '';
                return `<option value="${escapeHtml(s)}">${escapeHtml(s)} (${count})</option>`;
            }).filter(Boolean).join('')}
        </select>

        <input type="search" id="filter-search" placeholder="Search card name..." />
        <button id="refresh-staging" class="btn" style="white-space:nowrap;" title="Reload data without changing filters">&#8635; Refresh</button>
        <button id="reset-filters" class="btn" style="white-space:nowrap;">Reset filters</button>
        <button id="new-local-purchase-btn" class="btn btn-primary" style="white-space:nowrap;">+ New Local Purchase</button>
        <button id="tcgplayer-import-btn" class="btn" style="white-space:nowrap;">Import from TCGPlayer</button>

        <select id="filter-page-size">
            ${PAGE_SIZES.map(s => `<option value="${s}" ${s === state.pageSize ? 'selected' : ''}>${s} per page</option>`).join('')}
        </select>
    `;

    // Restore current filter values
    bar.querySelector('#filter-source').value = state.filters.source;
    bar.querySelector('#filter-status').value = state.filters.status;
    bar.querySelector('#filter-match-status').value = state.filters.match_status;
    bar.querySelector('#filter-import-batch').value = state.filters.import_batch;
    bar.querySelector('#filter-set').value = state.filters.set_name;
    bar.querySelector('#filter-search').value = state.filters.search;

    bar.querySelector('#filter-source').addEventListener('change', async (e) => {
        state.filters.source = e.target.value;
        state.page = 0;
        await loadFilterCounts();
        renderFilters(container);
        await loadAndRenderRows(container);
    });

    bar.querySelector('#filter-status').addEventListener('change', async (e) => {
        state.filters.status = e.target.value;
        state.page = 0;
        await loadFilterCounts();
        renderFilters(container);
        await loadAndRenderRows(container);
    });

    bar.querySelector('#filter-match-status').addEventListener('change', async (e) => {
        state.filters.match_status = e.target.value;
        state.page = 0;
        await loadFilterCounts();
        renderFilters(container);
        await loadAndRenderRows(container);
    });

    bar.querySelector('#filter-import-batch').addEventListener('change', async (e) => {
        state.filters.import_batch = e.target.value;
        state.page = 0;
        await loadFilterCounts();
        renderFilters(container);
        await loadAndRenderRows(container);
    });

    bar.querySelector('#filter-set').addEventListener('change', async (e) => {
        state.filters.set_name = e.target.value;
        state.page = 0;
        await loadFilterCounts();
        renderFilters(container);
        await loadAndRenderRows(container);
    });

    bar.querySelector('#filter-page-size').addEventListener('change', (e) => {
        state.pageSize = Number(e.target.value);
        state.page = 0;
        loadAndRenderRows(container);
    });

    bar.querySelector('#filter-search').addEventListener('input', debounce(async (e) => {
        state.filters.search = e.target.value;
        state.page = 0;
        await loadFilterCounts();
        renderFilters(container);
        await loadAndRenderRows(container);
    }, 400));

    bar.querySelector('#new-local-purchase-btn').addEventListener('click', () => {
        openNewLocalPurchaseModal(container);
    });

    bar.querySelector('#tcgplayer-import-btn').addEventListener('click', () => {
        openTcgplayerImportModal(container);
    });

    bar.querySelector('#refresh-staging').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        const original = btn.textContent;
        btn.textContent = 'Refreshing...';

        await loadImportBatches();
        await loadSets();
        await loadFilterCounts();
        renderFilters(container);
        await loadAndRenderRows(container);

        // renderFilters() replaces the toolbar DOM, so re-querying isn't
        // needed — the old btn reference is gone; nothing left to reset.
    });

    bar.querySelector('#reset-filters').addEventListener('click', async () => {
        state.filters = { source: 'all', status: 'all', match_status: 'all', import_batch: 'all', set_name: 'all', search: '' };
        state.page = 0;
        await loadFilterCounts();
        renderFilters(container);
        await loadAndRenderRows(container);
    });
}

// ----------------------------------------------------------------
// Table rendering
// ----------------------------------------------------------------

function sortTh(label, column, style = '') {
    const isActive = state.sort.column === column;
    const arrow = isActive ? (state.sort.ascending ? ' ▲' : ' ▼') : '';
    return `<th class="sortable-th" data-sort-column="${column}" style="${style} cursor:pointer; user-select:none;" title="Sort by ${escapeHtml(label)}">${escapeHtml(label)}${arrow}</th>`;
}

function renderTable(container) {
    const wrap = container.querySelector('#staging-table-wrap');

    if (state.rows.length === 0) {
        wrap.innerHTML = `
            <p>No staging rows match the current filters.</p>
            <p style="color:var(--text-secondary); font-size:13px;">
                Try adjusting the status, match status, or source filters above.
            </p>
        `;
        return;
    }

    // Any non-processed row can be selected (for delete); only matched +
    // non-processed rows are actually eligible to push to inventory —
    // that filter is applied inside batchPushSelected instead.
    const selectableRows = state.rows.filter(r => r.status !== 'processed');
    const selectedOnPage = selectableRows.filter(r => state.selectedIds.has(r.staging_id));
    const allSelected = selectableRows.length > 0 && selectedOnPage.length === selectableRows.length;

    wrap.innerHTML = `
        <div class="batch-actions-bar" style="display:flex; align-items:center; gap:12px; margin-bottom:8px; min-height:32px;">
            <span style="font-size:13px; color:var(--text-secondary);">
                ${state.selectedIds.size} selected
            </span>
            <button class="btn btn-primary batch-push-btn" ${state.selectedIds.size === 0 ? 'disabled' : ''}>
                Push selected to inventory
            </button>
            <button class="btn batch-delete-btn" style="border-color:var(--danger); color:var(--danger);" ${state.selectedIds.size === 0 ? 'disabled' : ''}>
                Delete selected
            </button>
            <button class="btn batch-modify-set-btn" ${state.selectedIds.size === 0 ? 'disabled' : ''}>
                Modify set
            </button>
            <button class="btn batch-automatch-btn" ${state.selectedIds.size === 0 ? 'disabled' : ''}>
                Auto-match selected
            </button>
            <button class="btn batch-clear-btn" ${state.selectedIds.size === 0 ? 'disabled' : ''}>
                Clear selection
            </button>
            <div class="batch-progress" style="font-size:13px;">${state.batchMessage || ''}</div>
        </div>
        <table>
            <thead>
                <tr>
                    <th style="width:24px;">
                        <input type="checkbox" id="select-all-checkbox" ${allSelected ? 'checked' : ''} ${selectableRows.length === 0 ? 'disabled' : ''} />
                    </th>
                    <th style="width:24px;"></th>
                    ${sortTh('#', 'card_number_numeric', 'width:65px; color:var(--text-secondary);')}
                    ${sortTh('Card name', 'card_name')}
                    ${sortTh('Set', 'set_name')}
                    ${sortTh('Condition', 'condition')}
                    <th>Variant</th>
                    ${sortTh('Qty', 'quantity', 'width:45px;')}
                    ${sortTh('Cost', 'cost_per_card', 'width:70px;')}
                    ${sortTh('List Price', 'listing_price', 'width:70px;')}
                    ${sortTh('Match', 'match_status', 'width:80px;')}
                    ${sortTh('Status', 'status', 'width:80px;')}
                    <th style="width:32px;"></th>
                </tr>
            </thead>
            <tbody id="staging-tbody"></tbody>
        </table>
    `;

    const tbody = wrap.querySelector('#staging-tbody');

    for (const row of state.rows) {
        tbody.appendChild(renderRow(container, row));

        if (state.expandedRowId === row.staging_id) {
            tbody.appendChild(renderExpandedRow(container, row));
        }
    }

    // Sortable column headers
    wrap.querySelectorAll('.sortable-th').forEach(th => {
        th.addEventListener('click', async () => {
            const column = th.dataset.sortColumn;
            if (state.sort.column === column) {
                state.sort.ascending = !state.sort.ascending;
            } else {
                state.sort = { column, ascending: true };
            }
            state.page = 0;
            await loadAndRenderRows(container);
        });
    });

    // Select-all checkbox
    wrap.querySelector('#select-all-checkbox')?.addEventListener('change', (e) => {
        if (e.target.checked) {
            selectableRows.forEach(r => state.selectedIds.add(r.staging_id));
        } else {
            selectableRows.forEach(r => state.selectedIds.delete(r.staging_id));
        }
        renderTable(container);
    });

    // Clear selection
    wrap.querySelector('.batch-clear-btn')?.addEventListener('click', () => {
        state.selectedIds.clear();
        state.batchMessage = null;
        renderTable(container);
    });

    // Batch push
    wrap.querySelector('.batch-push-btn')?.addEventListener('click', () => batchPushSelected(container));

    // Batch delete
    wrap.querySelector('.batch-delete-btn')?.addEventListener('click', () => batchDeleteSelected(container));

    // Batch modify set
    wrap.querySelector('.batch-modify-set-btn')?.addEventListener('click', () => openBatchModifySetModal(container));

    // Batch auto-match
    wrap.querySelector('.batch-automatch-btn')?.addEventListener('click', () => batchAutoMatchSelected(container));
}

// ── Variant display helpers ───────────────────────────────────────────────────
// Display labels come from AXIS_DISPLAY / axisDisplay(), imported from
// shared.js (loaded once via loadAxisOptions() at page mount).

function variantLabel(row) {
    const parts = [
        axisDisplay('foil_type', row.foil_type),
        axisDisplay('foil_pattern', row.foil_pattern),
        axisDisplay('texture', row.texture),
        axisDisplay('material', row.material),
        axisDisplay('size', row.size),
        axisDisplay('stamp_type', row.stamp_type),
        axisDisplay('source_type', row.source_type),
    ].filter(Boolean);
    return parts.join(' · ') || '-';
}

function variantLabelFromCode(code) {
    for (const axis of Object.keys(AXIS_TABLES)) {
        if (AXIS_DISPLAY[axis] && AXIS_DISPLAY[axis][code]) return AXIS_DISPLAY[axis][code];
    }
    return code || '-';
}

function renderAxesSummary(row) {
    const axes = [
        ['Foil',     axisDisplay('foil_type', row.foil_type)],
        ['Pattern',  axisDisplay('foil_pattern', row.foil_pattern)],
        ['Texture',  axisDisplay('texture', row.texture)],
        ['Material', axisDisplay('material', row.material)],
        ['Size',     axisDisplay('size', row.size)],
        ['Stamp',    axisDisplay('stamp_type', row.stamp_type)],
        ['Source',   axisDisplay('source_type', row.source_type)],
    ].filter(([, v]) => v);
    return axes.map(([k, v]) => `<span>${k}: ${escapeHtml(v)}</span>`).join('');
}

function renderAxesInputs(row) {
    const foilOpts     = AXIS_OPTIONS.foil_type    || [['', '— none —']];
    const patternOpts  = AXIS_OPTIONS.foil_pattern || [['', '— none —']];
    const textureOpts  = AXIS_OPTIONS.texture      || [['', '— none —']];
    const materialOpts = AXIS_OPTIONS.material     || [['', '— none —']];
    const sizeOpts     = AXIS_OPTIONS.size         || [['', '— none —']];
    const stampOpts    = AXIS_OPTIONS.stamp_type   || [['', '— none —']];
    const sourceOpts   = AXIS_OPTIONS.source_type  || [['', '— none —']];

    function sel(cls, opts, val) {
        const knownVals = opts.map(([v]) => v);
        const isCustom = val && !knownVals.includes(val);
        return `
            <select class="${cls}-select" onchange="
                const inp = this.parentElement.querySelector('.${cls}-custom');
                if (this.value === '__custom__') { inp.style.display='inline'; inp.focus(); }
                else { inp.style.display='none'; inp.value=''; }
            ">
                ${opts.map(([v, l]) => `<option value="${v}" ${(!isCustom && v === (val || '')) ? 'selected' : ''}>${l}</option>`).join('')}
                <option value="__custom__" ${isCustom ? 'selected' : ''}>Custom...</option>
            </select>
            <input type="text" class="${cls}-custom" placeholder="enter value"
                value="${isCustom ? escapeHtml(val) : ''}"
                style="display:${isCustom ? 'inline' : 'none'}; width:120px; margin-left:4px;" />
        `;
    }

    return `
        <label>Foil type ${sel('edit-foil-type', foilOpts, row.foil_type)}</label>
        <label>Pattern ${sel('edit-foil-pattern', patternOpts, row.foil_pattern)}</label>
        <label>Texture ${sel('edit-texture', textureOpts, row.texture)}</label>
        <label>Material ${sel('edit-material', materialOpts, row.material)}</label>
        <label>Size ${sel('edit-size', sizeOpts, row.size)}</label>
        <label>Stamp ${sel('edit-stamp-type', stampOpts, row.stamp_type)}</label>
        <label>Source ${sel('edit-source-type', sourceOpts, row.source_type)}</label>
    `;
}

function renderAxesDisplay(row) {
    return `
        <span>Foil: ${escapeHtml(axisDisplay('foil_type', row.foil_type) || row.foil_type || '-')}</span>
        ${row.foil_pattern ? `<span>Pattern: ${escapeHtml(axisDisplay('foil_pattern', row.foil_pattern))}</span>` : ''}
        ${row.texture      ? `<span>Texture: ${escapeHtml(axisDisplay('texture', row.texture))}</span>` : ''}
        ${row.material     ? `<span>Material: ${escapeHtml(axisDisplay('material', row.material))}</span>` : ''}
        ${row.size         ? `<span>Size: ${escapeHtml(axisDisplay('size', row.size))}</span>` : ''}
        ${row.stamp_type   ? `<span>Stamp: ${escapeHtml(axisDisplay('stamp_type', row.stamp_type))}</span>` : ''}
        ${row.source_type  ? `<span>Source: ${escapeHtml(axisDisplay('source_type', row.source_type))}</span>` : ''}
    `;
}

function hasNumberMismatch(row) {
    return row.match_status === 'matched'
        && row.card_number && row.matched_number
        && String(row.card_number).trim() !== String(row.matched_number).trim();
}

function renderRow(container, row) {
    const tr = document.createElement('tr');
    tr.dataset.stagingId = row.staging_id;

    const matchBadge = `<span class="badge badge-${row.match_status || 'not_found'}">${row.match_status || 'not_found'}</span>`
        + (hasNumberMismatch(row) ? `<span title="Staging #${escapeHtml(row.card_number)} but matched to #${escapeHtml(row.matched_number)}" style="margin-left:4px; cursor:help;">⚠️</span>` : '');
    const selectable = row.status !== 'processed';
    const checked = state.selectedIds.has(row.staging_id);
    const cardNum = row.card_number || row.matched_number || '-';

    tr.innerHTML = `
        <td>
            <input type="checkbox" class="row-select-checkbox" ${selectable ? '' : 'disabled'} ${checked ? 'checked' : ''} />
        </td>
        <td style="cursor:pointer;">${state.expandedRowId === row.staging_id ? '&#9660;' : '&#9656;'}</td>
        <td style="cursor:pointer; color:var(--text-secondary); font-size:12px;">${escapeHtml(cardNum)}</td>
        <td style="cursor:pointer;">${escapeHtml(row.card_name || '')}</td>
        <td style="cursor:pointer;">${escapeHtml(row.set_name || row.matched_set_name || '-')}</td>
        <td style="cursor:pointer;">${escapeHtml(row.condition || '-')}</td>
        <td style="cursor:pointer; font-size:12px;">${escapeHtml(variantLabel(row))}</td>
        <td style="cursor:pointer;">${row.quantity ?? '-'}</td>
        <td style="cursor:pointer;">${formatPrice(row.cost_per_card)}</td>
        <td style="cursor:pointer;">${formatPrice(row.listing_price)}</td>
        <td style="cursor:pointer;">${matchBadge}</td>
        <td style="cursor:pointer;">${escapeHtml(row.status || '-')}</td>
        <td>
            <button class="row-delete-btn" title="Remove from staging" style="background:none; border:none; cursor:pointer; font-size:14px;">&#128465;</button>
        </td>
    `;

    // Checkbox toggling shouldn't expand/collapse the row
    const checkboxTd = tr.querySelector('td:first-child');
    checkboxTd.addEventListener('click', (e) => e.stopPropagation());
    tr.querySelector('.row-select-checkbox').addEventListener('change', (e) => {
        if (e.target.checked) {
            state.selectedIds.add(row.staging_id);
        } else {
            state.selectedIds.delete(row.staging_id);
        }
        renderTable(container);
    });

    // Inline delete icon shouldn't expand/collapse the row
    const deleteTd = tr.querySelector('td:last-child');
    deleteTd.addEventListener('click', (e) => e.stopPropagation());
    tr.querySelector('.row-delete-btn').addEventListener('click', () => quickDeleteRow(container, row));

    // Remaining cells expand/collapse
    for (const td of tr.querySelectorAll('td:not(:first-child):not(:last-child)')) {
        td.addEventListener('click', () => {
            state.expandedRowId = state.expandedRowId === row.staging_id ? null : row.staging_id;
            renderTable(container);
        });
    }

    return tr;
}

// ----------------------------------------------------------------
// Expanded row (edit + resolve + push)
// ----------------------------------------------------------------

function renderExpandedRow(container, row) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 9;
    td.style.background = 'var(--bg-secondary)';
    td.style.padding = '16px';

    // Processed rows are read-only -- editing or pushing again would not
    // propagate to inventory (already pushed) and could confuse the user.
    // Skipped rows remain fully editable/re-pushable, since the user may
    // resolve the match and want to push them after all.
    if (row.status === 'processed') {
        const label = 'This row has already been pushed to inventory.';

        td.innerHTML = `
            <div class="expanded-row" data-staging-id="${row.staging_id}">
                <p style="color:var(--text-secondary); margin:0 0 12px;">${label}</p>
                ${row.match_status === 'matched' && row.matched_card_name ? `
                <div style="background:var(--bg-tertiary); border:1px solid var(--border); border-radius:6px;
                            padding:10px 14px; margin-bottom:12px; font-size:13px;">
                    <span style="color:var(--success); font-weight:600;">✅ Matched to:</span>
                    <span style="margin-left:8px;">
                        <strong>${escapeHtml(row.matched_card_name)}</strong>
                        #${escapeHtml(row.matched_number || '')}
                        — ${escapeHtml(row.matched_set_name || '')}
                        ${row.rarity ? `<span style="color:var(--text-secondary);">(${escapeHtml(row.rarity)})</span>` : ''}
                    </span>
                    ${hasNumberMismatch(row) ? `
                    <div style="color:var(--danger); margin-top:6px;">
                        ⚠️ Number mismatch: staging listing says #${escapeHtml(row.card_number)}, but this is matched to #${escapeHtml(row.matched_number)}.
                    </div>` : ''}
                </div>` : ''}
                <div style="display:flex; gap:16px; flex-wrap:wrap; color:var(--text-secondary); font-size:13px;">
                    <span>Card: ${escapeHtml(row.card_name || '-')} #${escapeHtml(row.card_number || row.matched_number || '-')}</span>
                    <span>Condition: ${escapeHtml(row.condition || '-')}</span>
                    <span>Quantity: ${row.quantity ?? '-'}</span>
                    <span>Cost: ${formatPrice(row.cost_per_card)}</span>
                    <span>Listing Price: ${formatPrice(row.listing_price)}</span>
                    ${renderAxesDisplay(row)}
                </div>
                ${row.notes ? `<p style="color:var(--text-secondary); font-size:13px; margin-top:8px;">Notes: ${escapeHtml(row.notes)}</p>` : ''}
            </div>
        `;

        tr.appendChild(td);
        return tr;
    }

    td.innerHTML = `
        <div class="expanded-row" data-staging-id="${row.staging_id}">

            ${row.match_status === 'matched' && row.matched_card_name ? `
            <div style="background:var(--bg-tertiary); border:1px solid var(--border); border-radius:6px;
                        padding:8px 14px; margin-bottom:12px; font-size:13px;">
                <span style="color:var(--success); font-weight:600;">✅ Matched:</span>
                <span style="margin-left:8px;">
                    <strong>${escapeHtml(row.matched_card_name)}</strong>
                    #${escapeHtml(row.matched_number || '')}
                    — ${escapeHtml(row.matched_set_name || '')}
                    ${row.rarity ? `<span style="color:var(--text-secondary);">(${escapeHtml(row.rarity)})</span>` : ''}
                </span>
                ${hasNumberMismatch(row) ? `
                <div style="color:var(--danger); margin-top:6px;">
                    ⚠️ Number mismatch: staging listing says #${escapeHtml(row.card_number)}, but this is matched to #${escapeHtml(row.matched_number)}.
                    Use Rematch below or fix the match manually.
                </div>` : ''}
            </div>` : ''}

            <!-- Row 1: Set, Card Name, Card Number, Rematch -->
            <div style="display:flex; gap:12px; flex-wrap:wrap; margin-bottom:12px; align-items:flex-end;">
                <label>Set
                    <input type="text" class="edit-set-name"
                           value="${escapeHtml(row.set_name || row.matched_set_name || '')}"
                           style="width:200px;" placeholder="Type or click to filter..." />
                </label>
                <label>Card name
                    <input type="text" class="edit-card-name"
                           value="${escapeHtml(row.card_name || '')}"
                           style="width:160px;" placeholder="Type to search Pokémon..." />
                </label>
                <label>#
                    <input type="text" class="edit-card-number"
                           value="${escapeHtml(row.card_number || row.matched_number || '')}"
                           style="width:65px;" />
                </label>
                <label style="align-self:flex-end;">
                    <button class="btn rematch-btn">🔍 Rematch</button>
                </label>
            </div>

            <!-- Row 2: Condition, Qty, Cost, Listing Price -->
            <div style="display:flex; gap:12px; flex-wrap:wrap; margin-bottom:12px; align-items:flex-end;">
                <label>Condition
                    <select class="edit-condition">
                        ${['Near Mint','Lightly Played','Moderately Played','Heavily Played','Damaged']
                            .map(c => `<option value="${c}" ${c === row.condition ? 'selected' : ''}>${c}</option>`)
                            .join('')}
                    </select>
                </label>
                <label>Qty
                    <input type="number" class="edit-quantity" value="${row.quantity ?? 1}" min="1" style="width:60px;" />
                </label>
                <label>Cost
                    <input type="number" step="0.01" class="edit-cost" value="${row.cost_per_card ?? ''}" style="width:80px;" placeholder="0.00" />
                </label>
                <label>Listing Price
                    <input type="number" step="0.01" class="edit-listing-price" value="${row.listing_price ?? ''}" style="width:80px;" placeholder="0.00" />
                </label>
            </div>

            <!-- Row 3: Variant axes -->
            <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:12px; align-items:flex-end;">
                ${renderAxesInputs(row)}
            </div>

            <!-- Row 4: Notes -->
            <div style="margin-bottom:12px;">
                <label style="display:block;">Notes
                    <input type="text" class="edit-notes" value="${escapeHtml(row.notes || '')}" style="width:100%;max-width:600px;" />
                </label>
            </div>

            <div class="match-resolution"></div>
            <div class="rematch-results" style="margin-bottom:8px;"></div>

            <div style="display:flex; gap:8px; margin-top:12px;">
                <button class="btn save-btn">Save changes</button>
                <button class="btn btn-primary push-btn" ${(row.match_status !== 'matched' || row.status === 'processed') ? 'disabled' : ''}>
                    Push to inventory
                </button>
                <button class="btn skip-btn">Skip</button>
                <button class="btn delete-btn" style="margin-left:auto; border-color:var(--danger); color:var(--danger);">Delete</button>
            </div>
            <div class="row-message" style="margin-top:8px; font-size:13px;"></div>
        </div>
    `;

    tr.appendChild(td);

    // Wire up match resolution UI for ambiguous/not_found rows
    const matchDiv = td.querySelector('.match-resolution');
    if (row.match_status === 'ambiguous') {
        renderAmbiguousResolution(container, td, row, matchDiv);
    } else if (row.match_status === 'not_found') {
        renderNotFoundResolution(container, td, row, matchDiv);
    } else if (row.match_status === 'matched') {
        // Matched rows don't get search/create tools by default -- but a
        // match can be wrong (e.g. linked to the wrong card_number), and
        // if the correct card isn't in the API or DB yet, Rematch alone
        // can't fix it. Give an explicit way in to the same tools.
        matchDiv.innerHTML = `<button class="btn fix-match-btn" style="font-size:12px;">⚠️ Wrong match? Fix it</button>`;
        matchDiv.querySelector('.fix-match-btn').addEventListener('click', () => {
            renderWrongMatchResolution(container, td, row, matchDiv);
        });
    }

    // Save changes
    td.querySelector('.save-btn').addEventListener('click', () => saveRowChanges(container, td, row));

    // Push to inventory
    td.querySelector('.push-btn').addEventListener('click', () => pushRowToInventory(container, td, row));

    // Skip
    td.querySelector('.skip-btn').addEventListener('click', () => skipRow(container, td, row));

    // Delete
    td.querySelector('.delete-btn').addEventListener('click', () => deleteRow(container, td, row));

    // Rematch — DB search first, pokemontcg.io API fallback
    td.querySelector('.rematch-btn').addEventListener('click', () =>
        runRematch(container, td, row)
    );

    // Card name autocomplete
    // Card name autocomplete — card_master first, then characters
    // Filters by Set/# if those fields already have values, narrowing results.
    // When both Set and # are filled, shows ALL variants of that specific card.
    wireAutocomplete({
        input: td.querySelector('.edit-card-name'),
        container: td,
        search: async (term) => {
            const setVal = td.querySelector('.edit-set-name').value.trim();
            const numVal = td.querySelector('.edit-card-number').value.trim();

            let cardQuery = supabase
                .from('v_card_variants')
                .select('card_id, variant_id, card_name, set_name, display_number, card_number, rarity, foil_type, foil_pattern, texture, material, size, stamp_type, source_type, foil_label, pattern_label, texture_label, material_label, size_label, stamp_label, source_label')
                .ilike('card_name', `%${term}%`)
                .order('card_name')
                .order('foil_type');
            if (setVal) cardQuery = cardQuery.ilike('set_name', `%${setVal}%`);
            if (numVal) cardQuery = cardQuery.eq('card_number', numVal);
            cardQuery = cardQuery.limit((setVal && numVal) ? 30 : 8);

            let cmQuery = supabase
                .from('card_master')
                .select('id, name, card_number, rarity, card_sets(name)')
                .ilike('name', `%${term}%`)
                .limit(8);
            if (numVal) cmQuery = cmQuery.eq('card_number', numVal);

            const [cardRes, charRes, cmRes] = await Promise.all([
                cardQuery,
                supabase
                    .from('characters')
                    .select('name')
                    .ilike('name', `%${term}%`)
                    .limit(5),
                cmQuery,
            ]);

            const cards = (cardRes.data || []).map(c => ({
                _type: 'card', ...c,
                variant_label: [c.foil_label, c.pattern_label, c.texture_label, c.material_label, c.size_label, c.stamp_label, c.source_label]
                    .filter(Boolean).join(' · ') || 'Non-Holo',
            }));

            // Card_master rows with no card_variants row yet (custom-created,
            // not pushed to inventory) — invisible to v_card_variants above.
            const seenCardIds = new Set(cards.map(c => c.card_id));
            const setValLower = (setVal || '').toLowerCase();
            const noVariantCards = (cmRes.data || [])
                .filter(c => !seenCardIds.has(c.id))
                .filter(c => !setValLower || (c.card_sets?.name || '').toLowerCase().includes(setValLower))
                .map(c => ({
                    _type: 'card',
                    card_id: c.id, variant_id: null,
                    card_name: c.name, set_name: c.card_sets?.name || '',
                    display_number: c.card_number, card_number: c.card_number,
                    rarity: c.rarity,
                    foil_type: null, foil_pattern: null, texture: null,
                    material: null, size: null, stamp_type: null, source_type: null,
                    variant_label: 'No variant yet',
                }));

            const chars = (charRes.data || [])
                .map(ch => ({ _type: 'character', card_name: ch.name }));

            return [...cards, ...noVariantCards, ...chars];
        },
        renderItem: (c) => c._type === 'card'
            ? `${c.card_name} — ${c.set_name} #${c.display_number || ''} · ${c.variant_label}`
            : `✦ ${c.card_name}`,
        onSelect: (c) => {
            td.querySelector('.edit-card-name').value = c.card_name;
            if (c._type === 'card') {
                td.querySelector('.edit-set-name').value = c.set_name || '';
                td.querySelector('.edit-card-number').value = c.card_number || c.display_number || '';
                // Populate variant axis dropdowns from the selected variant
                const setSel = (cls, val) => { const el = td.querySelector(cls); if (el && val !== undefined && val !== null) el.value = val; };
                setSel('.edit-foil-type', c.foil_type || 'non_holo');
                setSel('.edit-foil-pattern', c.foil_pattern || '');
                setSel('.edit-texture', c.texture || '');
                setSel('.edit-material', c.material || '');
                setSel('.edit-size', c.size || '');
                setSel('.edit-stamp-type', c.stamp_type || '');
                setSel('.edit-source-type', c.source_type || '');
            }
        },
    });

    // Set name autocomplete
    wireAutocomplete({
        input: td.querySelector('.edit-set-name'),
        container: td,
        search: async (term) => {
            const { data } = await supabase
                .from('card_sets')
                .select('name')
                .ilike('name', `%${term}%`)
                .limit(10);
            return data || [];
        },
        renderItem: (s) => s.name,
        onSelect: (s) => {
            td.querySelector('.edit-set-name').value = s.name;
        },
    });

    return tr;
}

// ----------------------------------------------------------------
// Autocomplete helper
// ----------------------------------------------------------------

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
            width: ${input.offsetWidth}px;
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

        // Position below the input
        input.parentElement.style.position = 'relative';
        input.parentElement.appendChild(dropdown);
        dropdown.style.top = input.offsetHeight + 'px';
        dropdown.style.left = '0px';
    }, 300));

    input.addEventListener('blur', () => setTimeout(removeDropdown, 150));
}

function renderAmbiguousResolution(container, td, row, matchDiv) {
    const options = row.match_options || [];

    if (!Array.isArray(options) || options.length === 0) {
        matchDiv.innerHTML = `<p style="color:var(--warning)">Ambiguous match, but no candidate options found. Use manual search below.</p>`;
        renderManualSearch(container, td, row, matchDiv, true);
        return;
    }

    matchDiv.innerHTML = `
        <p style="color:var(--warning); margin-bottom:6px;">Multiple possible matches — select the correct one:</p>
        <div class="match-options" style="display:flex; flex-direction:column; gap:6px;">
            ${options.map((opt, i) => `
                <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
                    <input type="radio" name="match-option-${row.staging_id}" value="${i}" />
                    <span>${escapeHtml(formatMatchOption(opt))}</span>
                </label>
            `).join('')}
        </div>
        <button class="btn select-match-btn" style="margin-top:8px;">Use selected match</button>
        <div style="margin-top:8px;">
            <button class="btn manual-search-toggle-btn">Search manually instead</button>
        </div>
        <div class="manual-search-area"></div>
    `;

    matchDiv.querySelector('.select-match-btn').addEventListener('click', async () => {
        const selected = matchDiv.querySelector(`input[name="match-option-${row.staging_id}"]:checked`);
        if (!selected) {
            showRowMessage(td, 'Select an option first.', 'warning');
            return;
        }
        const opt = options[Number(selected.value)];
        await resolveStagingMatch(container, td, row, opt);
    });

    matchDiv.querySelector('.manual-search-toggle-btn').addEventListener('click', () => {
        renderManualSearch(container, td, row, matchDiv.querySelector('.manual-search-area'), false);
    });
}

function renderNotFoundResolution(container, td, row, matchDiv) {
    matchDiv.innerHTML = `
        <p style="color:var(--danger); margin-bottom:6px;">No match found in catalog.</p>
        <div class="manual-search-area"></div>
        <button class="btn create-card-btn" style="margin-top:8px;">Create new card</button>
    `;

    renderManualSearch(container, td, row, matchDiv.querySelector('.manual-search-area'), false);

    matchDiv.querySelector('.create-card-btn').addEventListener('click', () => {
        openCreateCardModal(container, td, row);
    });
}

/**
 * Same tools as renderNotFoundResolution (manual search + create new card),
 * but for a row that's currently matched — just matched to the wrong card.
 * Reuses linkStagingToCard/openCreateCardModal unchanged; neither checks
 * the row's current match_status, so re-linking or creating a fresh card
 * here overwrites the bad match the same way it would set a fresh one.
 */
function renderWrongMatchResolution(container, td, row, matchDiv) {
    matchDiv.innerHTML = `
        <p style="color:var(--warning); margin-bottom:6px;">
            Search for the correct card, or create it if it's not in your catalog or the API.
        </p>
        <div class="manual-search-area"></div>
        <button class="btn create-card-btn" style="margin-top:8px;">Create new card</button>
        <button class="btn fix-match-cancel-btn" style="margin-top:8px;">Cancel</button>
    `;

    renderManualSearch(container, td, row, matchDiv.querySelector('.manual-search-area'), false);

    matchDiv.querySelector('.create-card-btn').addEventListener('click', () => {
        openCreateCardModal(container, td, row);
    });

    matchDiv.querySelector('.fix-match-cancel-btn').addEventListener('click', () => {
        matchDiv.innerHTML = `<button class="btn fix-match-btn" style="font-size:12px;">⚠️ Wrong match? Fix it</button>`;
        matchDiv.querySelector('.fix-match-btn').addEventListener('click', () => {
            renderWrongMatchResolution(container, td, row, matchDiv);
        });
    });
}

function renderManualSearch(container, td, row, target, replace) {
    const html = `
        <div class="manual-search" style="margin-top:8px;">
            <input type="text" class="manual-search-input" placeholder="Search card name..." style="width:250px;" />
            <div class="manual-search-results" style="margin-top:6px; max-height:180px; overflow-y:auto;"></div>
        </div>
    `;

    if (replace) {
        target.innerHTML = html;
    } else {
        target.innerHTML = html;
    }

    const input = target.querySelector('.manual-search-input');
    const results = target.querySelector('.manual-search-results');

    input.value = row.card_name || '';

    const doSearch = debounce(async () => {
        const term = input.value.trim();
        if (!term) {
            results.innerHTML = '';
            return;
        }

        const { data, error } = await supabase
            .from('v_card_variants')
            .select('*')
            .ilike('card_name', `%${term}%`)
            .limit(15);

        if (error) {
            results.innerHTML = `<p style="color:var(--danger)">${error.message}</p>`;
            return;
        }

        // Also search card_master directly, for cards with no card_variants
        // row yet (e.g. custom-created but not pushed to inventory) — these
        // don't appear in v_card_variants since it requires a variant match.
        const { data: cmData, error: cmError } = await supabase
            .from('card_master')
            .select('id, name, card_number, rarity, card_sets(name)')
            .ilike('name', `%${term}%`)
            .limit(15);

        if (cmError) console.error('Manual search error (card_master):', cmError);

        const seenIds = new Set((data || []).map(c => c.card_id));
        const noVariantMatches = (cmData || [])
            .filter(c => !seenIds.has(c.id))
            .map(c => ({
                card_id: c.id, variant_id: '',
                card_name: c.name, set_name: c.card_sets?.name || '',
                display_number: c.card_number, rarity: c.rarity,
                foil_label: 'No variant yet',
                pattern_label: null, texture_label: null, material_label: null,
                size_label: null, stamp_label: null, source_label: null,
            }));

        const combined = [...(data || []), ...noVariantMatches];

        if (combined.length === 0) {
            results.innerHTML = '<p style="color:var(--text-secondary)">No matches found.</p>';
            return;
        }

        results.innerHTML = combined.map(c => {
            const vLabel = [c.foil_label, c.pattern_label, c.texture_label,
                            c.material_label, c.size_label, c.stamp_label,
                            c.source_label].filter(Boolean).join(' · ') || 'Non-Holo';
            return `
            <div class="search-result-item" data-card-id="${c.card_id}" data-variant-id="${c.variant_id}"
                 style="padding:6px; border:1px solid var(--border); border-radius:4px; margin-bottom:4px; cursor:pointer;">
                ${escapeHtml(c.card_name)} — ${escapeHtml(c.set_name)} #${escapeHtml(c.display_number || '')}
                <span style="color:var(--text-secondary);">(${escapeHtml(vLabel)}, ${escapeHtml(c.rarity || '')})</span>
            </div>`;
        }).join('');

        results.querySelectorAll('.search-result-item').forEach(el => {
            el.addEventListener('click', async () => {
                const cardId = el.dataset.cardId;
                await resolveStagingMatch(container, td, row, { id: cardId });
            });
        });
    }, 350);

    input.addEventListener('input', doSearch);
    doSearch();
}

function formatMatchOption(opt) {
    if (!opt) return 'Unknown option';
    const parts = [];
    if (opt.name) parts.push(opt.name);
    if (opt.api_number) parts.push('#' + opt.api_number);
    if (opt.api_set) parts.push(opt.api_set);
    if (opt.api_rarity) parts.push(opt.api_rarity);
    if (opt.market_price) parts.push(formatPrice(opt.market_price));
    return parts.length ? parts.join(' — ') : JSON.stringify(opt);
}

// ----------------------------------------------------------------
// Rematch: DB search first, pokemontcg.io API fallback
// ----------------------------------------------------------------

const POKEMON_TCG_API = 'https://api.pokemontcg.io/v2/cards';

async function runRematch(container, td, row) {
    const btn     = td.querySelector('.rematch-btn');
    const results = td.querySelector('.rematch-results');
    const name    = td.querySelector('.edit-card-name').value.trim();
    const num     = td.querySelector('.edit-card-number').value.trim();
    const setName = td.querySelector('.edit-set-name').value.trim();

    if (!name) {
        results.innerHTML = `<p style="color:var(--warning); font-size:13px;">Enter a card name to search.</p>`;
        return;
    }

    btn.disabled    = true;
    btn.textContent = 'Searching DB...';
    results.innerHTML = '';

    // ── Step 1: DB search ────────────────────────────────────────────────────
    const dbResults = await searchDB(name, num, setName);

    if (dbResults.length > 0) {
        btn.disabled    = false;
        btn.textContent = '🔍 Rematch';
        renderRematchResults(container, td, row, results, dbResults, 'db');
        return;
    }

    // ── Step 2: pokemontcg.io API fallback ───────────────────────────────────
    btn.textContent = 'Not in DB — searching API...';
    let apiResults;
    try {
        apiResults = await searchPokemonTcgApi(name, num, setName);
    } catch (e) {
        btn.disabled    = false;
        btn.textContent = '🔍 Rematch';
        results.innerHTML = `<p style="color:var(--danger); font-size:13px;">pokemontcg.io API error: ${escapeHtml(e.message)}. Try again.</p>`;
        return;
    }

    btn.disabled    = false;
    btn.textContent = '🔍 Rematch';

    if (apiResults.length === 0) {
        results.innerHTML = `
            <p style="color:var(--warning); font-size:13px;">
                Not found in DB or pokemontcg.io API for
                "<strong>${escapeHtml(name)}</strong>"
                ${num ? `#${escapeHtml(num)}` : ''}
                ${setName ? `(${escapeHtml(setName)})` : ''}.
                Try different search terms, or create it below.
            </p>
            <button class="btn rematch-create-card-btn" style="margin-top:6px;">Create new card</button>`;
        results.querySelector('.rematch-create-card-btn').addEventListener('click', () => {
            openCreateCardModal(container, td, row);
        });
        return;
    }

    renderRematchResults(container, td, row, results, apiResults, 'api');
}


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
        source:      'db',
        card_id:     c.card_id,
        variant_id:  c.variant_id,
        name:        c.card_name,
        number:      c.display_number || c.card_number,  // for display text
        card_number: c.card_number,                       // bare number, for the # input field
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
        _raw: c,
    }));

    // ── Also search card_master directly, for cards with no card_variants
    // row yet (e.g. just custom-created, not pushed to inventory) — these
    // don't show up in v_card_variants at all since that view requires a
    // matching variant row to exist.
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
            source:      'db',
            card_id:     c.id,
            variant_id:  null,
            name:        c.name,
            number:      c.card_number,
            card_number: c.card_number,
            set_name:    c.card_sets?.name || '',
            rarity:      c.rarity,
            variant_label: 'No variant yet',
            foil_type:    null,
            foil_pattern: null,
            texture:      null,
            material:     null,
            size:         null,
            stamp_type:   null,
            source_type:  null,
            _raw: c,
        }));

    return [...withVariants, ...withoutVariants];
}


/**
 * Throws on any failure (network error, non-2xx status, bad JSON) instead
 * of swallowing it -- a failed request must never look like a genuine
 * zero-result search to the caller. This matters most for bulk rematch,
 * which fires real concurrent requests against pokemontcg.io's anonymous
 * tier: those calls can legitimately take 30s+ under load (verified
 * directly against the live API), and any that fail need to show up as
 * "errored," not silently count as "not found." Every call site below
 * catches this explicitly.
 */
async function searchPokemonTcgApi(name, num, setName) {
    // Build query — pokemontcg.io uses Lucene syntax
    let q = `name:"${name}"`;
    if (num) q += ` number:${num}`;
    // Note: we don't filter by set name here because the API set name may differ
    // from what's stored (e.g. "151" vs "Scarlet & Violet 151"). Better to show
    // all results and let the user pick the right one.

    const url = `${POKEMON_TCG_API}?q=${encodeURIComponent(q)}&pageSize=12`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`pokemontcg.io API returned ${resp.status}`);
    const json = await resp.json();

    return (json.data || []).map(c => ({
        source:         'api',
        card_id:        null,   // not yet in DB
        variant_id:     null,
        name:           c.name,
        number:         c.number,
        set_name:       c.set?.name || '',
        set_id:         c.set?.id || '',
        set_code:       c.set?.id || '',
        set_total:      c.set?.total,
        rarity:         c.rarity || '',
        image_url:      c.images?.large || c.images?.small || null,
        external_id:    c.id,
        variant_label:  'Non-Holo',  // API doesn't know the variant; user can adjust
        _raw:           c,
    }));
}


function renderRematchResults(container, td, row, resultsEl, items, source) {
    const sourceLabel = source === 'db'
        ? `<span style="color:var(--success); font-size:12px;">📦 From your catalog</span>`
        : `<span style="color:var(--text-secondary); font-size:12px;">🌐 From pokemontcg.io API — will be added to your catalog on link</span>`;

    resultsEl.innerHTML = `
        <div style="margin-bottom:6px;">${sourceLabel}</div>
        <p style="font-size:13px; color:var(--text-secondary); margin:0 0 6px;">
            ${items.length} result${items.length === 1 ? '' : 's'} — click to link:
        </p>
        ${items.map((c, i) => `
            <div class="rematch-result-item" data-idx="${i}"
                 style="padding:6px 8px; border:1px solid var(--border); border-radius:4px;
                        margin-bottom:4px; cursor:pointer; font-size:13px; display:flex; align-items:center; gap:10px;"
                 onmouseover="this.style.background='var(--bg-tertiary)'"
                 onmouseout="this.style.background=''">
                ${c.image_url ? `<img src="${c.image_url}" style="height:40px; border-radius:3px; flex-shrink:0;" />` : ''}
                <div>
                    <strong>${escapeHtml(c.name)}</strong>
                    — ${escapeHtml(c.set_name)} #${escapeHtml(c.number || '')}
                    <span style="color:var(--text-secondary);">(${escapeHtml(c.variant_label)}, ${escapeHtml(c.rarity)})</span>
                    ${source === 'api' ? `<span style="color:var(--text-secondary); font-size:11px; display:block;">API ID: ${escapeHtml(c.external_id)}</span>` : ''}
                </div>
            </div>
        `).join('')}
        ${source === 'db' ? `
            <button class="btn try-api-btn" style="margin-top:8px; font-size:12px;">
                Not what you're looking for? Search pokemontcg.io API →
            </button>` : ''}
    `;

    // Wire "Search API" button if shown
    resultsEl.querySelector('.try-api-btn')?.addEventListener('click', async () => {
        const name    = td.querySelector('.edit-card-name').value.trim();
        const num     = td.querySelector('.edit-card-number').value.trim();
        const setName = td.querySelector('.edit-set-name').value.trim();
        const btn     = td.querySelector('.rematch-btn');

        btn.disabled    = true;
        btn.textContent = 'Searching API...';
        resultsEl.innerHTML = '';

        let apiResults;
        try {
            apiResults = await searchPokemonTcgApi(name, num, setName);
        } catch (e) {
            btn.disabled    = false;
            btn.textContent = '🔍 Rematch';
            resultsEl.innerHTML = `<p style="color:var(--danger); font-size:13px;">pokemontcg.io API error: ${escapeHtml(e.message)}. Try again.</p>`;
            return;
        }
        btn.disabled    = false;
        btn.textContent = '🔍 Rematch';

        if (apiResults.length === 0) {
            resultsEl.innerHTML = `<p style="color:var(--warning); font-size:13px;">Not found on pokemontcg.io either. Check spelling or try without the set filter.</p>`;
            return;
        }
        renderRematchResults(container, td, row, resultsEl, apiResults, 'api');
    });

    // Wire result item clicks
    resultsEl.querySelectorAll('.rematch-result-item').forEach(el => {
        el.addEventListener('click', async () => {
            const item = items[Number(el.dataset.idx)];
            await linkStagingToCard(container, td, row, resultsEl, item);
        });
    });
}


/**
 * Links a staging row to a matched card (DB or API result) and writes it.
 * DOM-free — used by both the single-row Rematch click flow and bulk
 * rematch, so both share the exact same write instead of two copies that
 * could drift. `fieldOverrides` lets a caller with a live edit form (the
 * single-row flow) fold in unsaved edits to card_name/card_number/set_name;
 * bulk rematch omits it and keeps the row's already-saved values.
 * Returns { success: true, cardId } or { success: false, error }.
 */
async function linkStagingRowToItem(row, item, fieldOverrides = {}) {
    let cardId = item.card_id;

    // ── API result: create card_master (+ card_sets if needed) in DB first ───
    if (item.source === 'api') {
        const api = item._raw;

        // 1. Find or create the set
        let { data: setRow } = await supabase
            .from('card_sets')
            .select('id')
            .eq('set_code', item.set_code)
            .maybeSingle();

        if (!setRow) {
            // Create the set from API data
            const { data: newSet, error: setErr } = await supabase
                .from('card_sets')
                .insert({
                    name:        item.set_name,
                    set_code:    item.set_code,
                    total_cards: item.set_total || null,
                    game_id:     await getGameId(),
                })
                .select('id')
                .single();

            if (setErr) return { success: false, error: 'Failed to create set: ' + setErr.message };
            setRow = newSet;
        }

        // 2. Upsert card_master
        const { data: cardRow, error: cardErr } = await supabase
            .from('card_master')
            .upsert({
                set_id:      setRow.id,
                name:        api.name,
                card_number: api.number,
                rarity:      api.rarity || null,
                image_url:   api.images?.large || api.images?.small || null,
                external_id: api.id,
            }, { onConflict: 'external_id' })
            .select('id')
            .single();

        if (cardErr) return { success: false, error: 'Failed to create card: ' + cardErr.message };
        cardId = cardRow.id;

        // Variant creation is deferred to push_staging_row_to_inventory
        // to avoid orphan card_variants rows with incorrect foil types.
    }

    const updates = {
        card_id:      cardId,
        match_status: 'matched',
        status:       'approved',
        updated_at:   new Date().toISOString(),
        ...fieldOverrides,
    };

    // ── Update staging row ────────────────────────────────────────────────────
    const { error: saveErr } = await supabase.from('staging').update(updates).eq('id', row.staging_id);

    if (saveErr) return { success: false, error: 'Failed to link: ' + saveErr.message };

    Object.assign(row, updates);
    return { success: true, cardId };
}

async function linkStagingToCard(container, td, row, resultsEl, item) {
    resultsEl.innerHTML = `<p style="color:var(--text-secondary); font-size:13px;">Linking...</p>`;

    const result = await linkStagingRowToItem(row, item, {
        card_name:   td.querySelector('.edit-card-name').value.trim()   || row.card_name,
        card_number: td.querySelector('.edit-card-number').value.trim() || row.card_number,
        set_name:    td.querySelector('.edit-set-name').value.trim()    || row.set_name,
    });

    if (!result.success) {
        resultsEl.innerHTML = `<p style="color:var(--danger)">${escapeHtml(result.error)}</p>`;
        return;
    }

    const source = item.source === 'api' ? ' (added to catalog)' : '';
    resultsEl.innerHTML = `<p style="color:var(--success); font-size:13px;">✅ Linked${source} — ready to push to inventory.</p>`;

    // Enable push button
    const pushBtn = td.querySelector('.push-btn');
    if (pushBtn) pushBtn.disabled = false;

    renderTable(container);
}

// ----------------------------------------------------------------
// Auto-match: bulk card_master-only match, run across every selected row.
// Deliberately ignores card_variants and the 7 axis columns entirely --
// matching only ever needs to resolve card_id; the specific variant
// (foil_type, pattern, texture, etc.) is resolved separately at push time
// from the staging row's own axis columns (see
// push_staging_row_to_inventory.sql step 3), so two card_variants rows for
// the same card in different foils are not a real ambiguity here. This is
// also why it's a separate function from the single-row Rematch button
// (runRematch/searchDB), which stays variant-aware for manual use as-is.
// Auto-writes only when the search comes back with exactly one card_master
// hit -- anything with zero or multiple candidates is left completely
// untouched for manual review, same as today's default state, and the 7
// axis columns are never written by this path either way.
// ----------------------------------------------------------------

/**
 * Looks up card_master (joined to card_sets for the set name) by
 * name+number+set, ignoring card_variants entirely. One candidate per
 * distinct card, unlike searchDB which returns one row per variant.
 */
async function searchCardMasterOnly(name, num, setName) {
    let q = supabase
        .from('card_master')
        .select('id, name, card_number, rarity, card_sets(name)')
        .ilike('name', `%${name}%`)
        .limit(15);
    if (num) q = q.eq('card_number', num);

    const { data, error } = await q;
    if (error) console.error('Card master search error:', error);

    const setNameLower = (setName || '').toLowerCase();

    return (data || [])
        .filter(c => !setNameLower || (c.card_sets?.name || '').toLowerCase().includes(setNameLower))
        .map(c => ({
            source:   'db',
            card_id:  c.id,
            name:     c.name,
            number:   c.card_number,
            set_name: c.card_sets?.name || '',
            rarity:   c.rarity,
        }));
}

/**
 * Auto-matches one staging row against card_master only (searchCardMasterOnly),
 * pokemontcg.io API fallback if that doesn't confidently resolve to exactly
 * one hit (whether zero or multiple). Auto-links only on exactly one
 * result. Never throws -- errors are returned so one bad row can't abort a
 * batch.
 */
async function autoMatchStagingRow(row) {
    const name    = (row.card_name || '').trim();
    const num     = (row.card_number || '').trim();
    const setName = (row.set_name || '').trim();

    if (!name) return { staging_id: row.staging_id, outcome: 'needs_review', count: 0 };

    try {
        let results = await searchCardMasterOnly(name, num, setName);
        let source = 'db';
        if (results.length !== 1) {
            results = await searchPokemonTcgApi(name, num, setName);
            source = 'api';
        }

        if (results.length !== 1) {
            if (results.length > 1) {
                console.log(
                    `Auto-match: "${name}" #${num || '?'} (${setName || 'no set'}) — ` +
                    `${results.length} ${source.toUpperCase()} candidates:`,
                    results.map(r => `${r.name} — ${r.set_name} #${r.number}`)
                );
            }
            return { staging_id: row.staging_id, outcome: 'needs_review', count: results.length, source };
        }

        const result = await linkStagingRowToItem(row, results[0]);
        if (!result.success) {
            console.error(`Auto-match link failed for staging row ${row.staging_id} (${name}):`, result.error);
            return { staging_id: row.staging_id, outcome: 'error', reason: result.error };
        }
        return { staging_id: row.staging_id, outcome: 'matched' };
    } catch (e) {
        console.error(`Auto-match failed for staging row ${row.staging_id} (${name}):`, e);
        return { staging_id: row.staging_id, outcome: 'error', reason: e.message };
    }
}

const AUTO_MATCH_CHUNK_SIZE = 15;

/**
 * Runs autoMatchStagingRow across every selected staging row, 15 at a
 * time. Selection survives filter/page changes by design, so a selected
 * row may not be among the currently-loaded state.rows -- those are
 * fetched from v_staging by id first rather than silently skipped.
 * Already-processed rows are excluded (auto-matching would incorrectly
 * flip status back to 'approved'); they shouldn't be selectable in the
 * first place, but a row could have been processed elsewhere after it was
 * selected.
 */
async function batchAutoMatchSelected(container) {
    const ids = [...state.selectedIds];
    if (ids.length === 0) return;

    const wrap = container.querySelector('#staging-table-wrap');
    const progressEl = wrap.querySelector('.batch-progress');
    const pushBtn = wrap.querySelector('.batch-push-btn');
    const deleteBtn = wrap.querySelector('.batch-delete-btn');
    const autoMatchBtn = wrap.querySelector('.batch-automatch-btn');
    const clearBtn = wrap.querySelector('.batch-clear-btn');

    pushBtn.disabled = true;
    deleteBtn.disabled = true;
    autoMatchBtn.disabled = true;
    clearBtn.disabled = true;

    const loadedIds = new Set(state.rows.map(r => r.staging_id));
    const offPageIds = ids.filter(id => !loadedIds.has(id));

    let offPageRows = [];
    if (offPageIds.length > 0) {
        progressEl.textContent = `Loading ${offPageIds.length} selected row${offPageIds.length === 1 ? '' : 's'} from other pages...`;
        const { data, error } = await supabase
            .from('v_staging')
            .select('staging_id, card_name, card_number, set_name, status, match_status')
            .in('staging_id', offPageIds);
        if (error) console.error('Failed to load off-page selected rows:', error);
        offPageRows = data || [];
    }

    const allSelectedRows = ids
        .map(id => state.rows.find(r => r.staging_id === id) || offPageRows.find(r => r.staging_id === id))
        .filter(Boolean);

    const rows = allSelectedRows.filter(r => r.status !== 'processed');
    const skippedProcessed = allSelectedRows.length - rows.length;

    // Split "needs review" into zero-result vs multi-candidate, and track
    // which step (db/api) each came from -- this is the only way to tell
    // "genuinely nothing found" apart from "found too many to auto-pick"
    // without opening devtools, since both looked identical as one bucket.
    let matched = 0, zeroResult = 0, multiResult = 0, errored = 0;
    let dbHits = 0, apiHits = 0;
    let firstError = null;

    for (let i = 0; i < rows.length; i += AUTO_MATCH_CHUNK_SIZE) {
        const chunk = rows.slice(i, i + AUTO_MATCH_CHUNK_SIZE);
        progressEl.textContent = `Auto-matching ${Math.min(i + AUTO_MATCH_CHUNK_SIZE, rows.length)} of ${rows.length}...`;

        const results = await Promise.all(chunk.map(row => autoMatchStagingRow(row)));
        for (const r of results) {
            if (r.outcome === 'matched') {
                matched++;
                state.selectedIds.delete(r.staging_id);
            } else if (r.outcome === 'error') {
                errored++;
                if (!firstError) firstError = r.reason;
            } else {
                if (r.count === 0) zeroResult++; else multiResult++;
                if (r.source === 'db') dbHits++; else if (r.source === 'api') apiHits++;
            }
        }
    }

    const skippedNote = skippedProcessed > 0
        ? ` (${skippedProcessed} already-processed row${skippedProcessed === 1 ? '' : 's'} skipped)`
        : '';
    const errorNote = errored > 0 && firstError ? ` First error: ${escapeHtml(firstError)}` : '';

    state.batchMessage = `<span style="color:var(${errored > 0 ? '--danger' : '--success'})">
        ${rows.length} auto-matched → ${matched} matched, ${zeroResult} zero-result, ${multiResult} multi-candidate${errored > 0 ? `, ${errored} errored` : ''}.${escapeHtml(skippedNote)}${errorNote}
        <br><span style="font-size:11px; color:var(--text-secondary);">(of the non-matches, ${dbHits} were resolved by the catalog search alone, never reaching the API)</span>
    </span>`;

    await loadAndRenderRows(container);
}


// Cache the Pokemon game_id so we don't look it up on every API card create
let _gameId = null;
async function getGameId() {
    if (_gameId) return _gameId;
    const { data } = await supabase.from('card_games').select('id').eq('name', 'Pokemon').maybeSingle();
    _gameId = data?.id || null;
    return _gameId;
}


// ----------------------------------------------------------------
// Actions: save, resolve, push, skip
// ----------------------------------------------------------------

/**
 * Reads a variant axis <select>+custom-<input> pair's current value from
 * an expanded row's edit form (see renderAxesInputs' `sel()`). Shared by
 * saveRowChanges and runRematch so both read live edits the same way.
 */
function getEditedAxisVal(td, cls) {
    const sel = td.querySelector(`.${cls}-select`);
    const inp = td.querySelector(`.${cls}-custom`);
    if (!sel) return null;
    const v = sel.value === '__custom__' ? (inp ? inp.value.trim() : '') : sel.value;
    return v || null;
}

async function saveRowChanges(container, td, row) {
    const updates = {
        card_name:    td.querySelector('.edit-card-name')?.value.trim()   || row.card_name,
        card_number:  td.querySelector('.edit-card-number')?.value.trim() || row.card_number,
        set_name:     td.querySelector('.edit-set-name')?.value.trim()    || row.set_name,
        condition:    td.querySelector('.edit-condition').value,
        quantity:     Number(td.querySelector('.edit-quantity').value) || 1,
        price:        Number(td.querySelector('.edit-cost').value) || 0,
        listing_price: td.querySelector('.edit-listing-price').value !== ''
                       ? Number(td.querySelector('.edit-listing-price').value)
                       : null,
        foil_type:    getEditedAxisVal(td, 'edit-foil-type'),
        foil_pattern: getEditedAxisVal(td, 'edit-foil-pattern'),
        texture:      getEditedAxisVal(td, 'edit-texture'),
        material:     getEditedAxisVal(td, 'edit-material'),
        size:         getEditedAxisVal(td, 'edit-size'),
        stamp_type:   getEditedAxisVal(td, 'edit-stamp-type'),
        source_type:  getEditedAxisVal(td, 'edit-source-type'),
        notes:        td.querySelector('.edit-notes').value || null,
        updated_at:   new Date().toISOString(),
    };

    const { error } = await supabase
        .from('staging')
        .update(updates)
        .eq('id', row.staging_id);

    if (error) {
        showRowMessage(td, 'Save failed: ' + error.message, 'danger');
        return;
    }

    showRowMessage(td, 'Saved.', 'success');

    Object.assign(row, {
        card_name:     updates.card_name,
        card_number:   updates.card_number,
        set_name:      updates.set_name,
        condition:     updates.condition,
        quantity:      updates.quantity,
        cost_per_card: updates.price,
        listing_price: updates.listing_price,
        foil_type:     updates.foil_type,
        foil_pattern:  updates.foil_pattern,
        texture:       updates.texture,
        material:      updates.material,
        size:          updates.size,
        stamp_type:    updates.stamp_type,
        source_type:   updates.source_type,
        notes:         updates.notes,
    });
}

async function resolveStagingMatch(container, td, row, option) {
    if (!option || !option.id) {
        showRowMessage(td, 'Invalid match option.', 'danger');
        return;
    }

    const { error } = await supabase
        .from('staging')
        .update({
            card_id: option.id,
            match_status: 'matched',
            updated_at: new Date().toISOString(),
        })
        .eq('id', row.staging_id);

    if (error) {
        showRowMessage(td, 'Failed to resolve match: ' + error.message, 'danger');
        return;
    }

    row.card_id = option.id;
    row.match_status = 'matched';

    showRowMessage(td, 'Match resolved. You can now push to inventory.', 'success');
    renderTable(container);
}

/**
 * Calls the push_staging_row_to_inventory RPC for a single staging row.
 * Returns { success: true } or { success: false, error: string }.
 */
async function pushStagingRowRpc(stagingId) {
    const { error } = await supabase.rpc('push_staging_row_to_inventory', {
        p_staging_id: stagingId,
    });

    if (error) {
        return { success: false, error: error.message };
    }
    return { success: true };
}

async function pushRowToInventory(container, td, row) {
    const btn = td.querySelector('.push-btn');
    btn.disabled = true;
    btn.textContent = 'Pushing...';

    const result = await pushStagingRowRpc(row.staging_id);

    if (!result.success) {
        showRowMessage(td, 'Push failed: ' + result.error, 'danger');
        btn.disabled = false;
        btn.textContent = 'Push to inventory';
        return;
    }

    showRowMessage(td, 'Pushed to inventory successfully.', 'success');

    // Auto-advance: collapse this row, advance to next pending row
    setTimeout(async () => {
        advanceToNextRow(container, row.staging_id);
    }, 400);
}

/**
 * Pushes all currently-selected staging rows to inventory, one at a time,
 * showing progress as it goes. Stops on first error but reports how many
 * succeeded before the failure.
 */
async function batchPushSelected(container) {
    const wrap = container.querySelector('#staging-table-wrap');
    const progressEl = wrap.querySelector('.batch-progress');
    const pushBtn = wrap.querySelector('.batch-push-btn');
    const deleteBtn = wrap.querySelector('.batch-delete-btn');
    const clearBtn = wrap.querySelector('.batch-clear-btn');

    // Selection can include unmatched/not_found rows (needed so they're
    // selectable for delete) — only matched, non-processed rows can
    // actually be pushed. Silently skip the rest and report the count.
    const allIds = [...state.selectedIds];
    const pushable = allIds.filter(id => {
        const row = state.rows.find(r => r.staging_id === id);
        return row && row.match_status === 'matched' && row.status !== 'processed';
    });
    const skipped = allIds.length - pushable.length;

    if (pushable.length === 0) {
        state.batchMessage = `<span style="color:var(--danger)">
            None of the selected rows are matched — nothing to push.
        </span>`;
        progressEl.innerHTML = state.batchMessage;
        return;
    }

    pushBtn.disabled = true;
    deleteBtn.disabled = true;
    clearBtn.disabled = true;

    let succeeded = 0;
    let failed = 0;
    let firstError = null;

    for (let i = 0; i < pushable.length; i++) {
        progressEl.textContent = `Pushing ${i + 1} of ${pushable.length}...`;

        const result = await pushStagingRowRpc(pushable[i]);

        if (result.success) {
            succeeded++;
            state.selectedIds.delete(pushable[i]);
        } else {
            failed++;
            if (!firstError) firstError = result.error;
            // Stop on first error -- remaining rows are left selected
            // so the user can retry or investigate.
            break;
        }
    }

    const skippedNote = skipped > 0 ? ` (${skipped} unmatched row${skipped === 1 ? '' : 's'} skipped)` : '';

    if (failed > 0) {
        state.batchMessage = `<span style="color:var(--danger)">
            Pushed ${succeeded} of ${pushable.length}. Stopped on error: ${escapeHtml(firstError)}${escapeHtml(skippedNote)}
        </span>`;
    } else {
        state.batchMessage = `<span style="color:var(--success)">
            Pushed ${succeeded} row${succeeded === 1 ? '' : 's'} to inventory.${escapeHtml(skippedNote)}
        </span>`;
    }

    await loadAndRenderRows(container);
}

/**
 * Deletes all currently-selected staging rows, one at a time, showing
 * progress as it goes. Stops on first error but reports how many
 * succeeded before the failure. Unlike push, delete works on any
 * non-processed row regardless of match status.
 */
async function batchDeleteSelected(container) {
    const ids = [...state.selectedIds];
    if (ids.length === 0) return;

    const confirmed = window.confirm(
        `Delete ${ids.length} row${ids.length === 1 ? '' : 's'} from staging? This cannot be undone.`
    );
    if (!confirmed) return;

    const wrap = container.querySelector('#staging-table-wrap');
    const progressEl = wrap.querySelector('.batch-progress');
    const pushBtn = wrap.querySelector('.batch-push-btn');
    const deleteBtn = wrap.querySelector('.batch-delete-btn');
    const clearBtn = wrap.querySelector('.batch-clear-btn');

    pushBtn.disabled = true;
    deleteBtn.disabled = true;
    clearBtn.disabled = true;

    let succeeded = 0;
    let failed = 0;
    let firstError = null;

    for (let i = 0; i < ids.length; i++) {
        progressEl.textContent = `Deleting ${i + 1} of ${ids.length}...`;

        const { error } = await supabase.rpc('delete_staging_row', { p_id: ids[i] });

        if (!error) {
            succeeded++;
            state.selectedIds.delete(ids[i]);
        } else {
            failed++;
            if (!firstError) firstError = error.message;
            break;
        }
    }

    if (failed > 0) {
        state.batchMessage = `<span style="color:var(--danger)">
            Deleted ${succeeded} of ${ids.length}. Stopped on error: ${escapeHtml(firstError)}
        </span>`;
    } else {
        state.batchMessage = `<span style="color:var(--success)">
            Deleted ${succeeded} row${succeeded === 1 ? '' : 's'} from staging.
        </span>`;
    }

    await loadAndRenderRows(container);
}

/**
 * Bulk-reassigns the set_name for all currently-selected staging rows.
 * Since a set change can invalidate whatever card_master match a row
 * already had, this also clears card_id/match_status back to not_found
 * so the rows get properly re-matched (via Rematch or Create new card)
 * against the corrected set, rather than silently keeping a stale link.
 */
function openBatchModifySetModal(container) {
    const ids = [...state.selectedIds];
    if (ids.length === 0) return;

    const overlay = document.createElement('div');
    overlay.style.cssText = `
        position: fixed; inset: 0; background: rgba(0,0,0,0.6);
        display: flex; align-items: center; justify-content: center; z-index: 1000;
    `;

    overlay.innerHTML = `
        <div style="background:var(--bg-secondary); border:1px solid var(--border); border-radius:8px; padding:20px; width:420px; max-width:90vw;">
            <h3 style="margin-top:0;">Modify set for ${ids.length} row${ids.length === 1 ? '' : 's'}</h3>
            <p style="font-size:13px; color:var(--text-secondary); margin-top:-8px;">
                This will also clear the existing match on these rows, since the old match
                may no longer be correct once the set changes.
            </p>
            <label>New set name
                <input type="text" class="bms-set-name" style="width:100%;" placeholder="Start typing to search..." />
                <div class="bms-set-results" style="max-height:140px; overflow-y:auto; margin-top:4px;"></div>
            </label>
            <div class="bms-message" style="margin-top:8px; font-size:13px;"></div>
            <div style="display:flex; gap:8px; margin-top:14px;">
                <button class="btn btn-primary bms-apply-btn" disabled>Apply to ${ids.length} row${ids.length === 1 ? '' : 's'}</button>
                <button class="btn bms-cancel-btn">Cancel</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    const setInput    = overlay.querySelector('.bms-set-name');
    const resultsEl    = overlay.querySelector('.bms-set-results');
    const msgEl        = overlay.querySelector('.bms-message');
    const applyBtn     = overlay.querySelector('.bms-apply-btn');
    let chosenSetName  = null;

    const searchSets = debounce(async () => {
        const term = setInput.value.trim();
        chosenSetName = null;
        applyBtn.disabled = true;

        if (!term) {
            resultsEl.innerHTML = '';
            return;
        }

        const { data, error } = await supabase
            .from('card_sets')
            .select('name')
            .ilike('name', `%${term}%`)
            .limit(10);

        if (error) {
            resultsEl.innerHTML = `<p style="color:var(--danger); font-size:12px;">${escapeHtml(error.message)}</p>`;
            return;
        }

        if (!data || data.length === 0) {
            resultsEl.innerHTML = `<p style="color:var(--warning); font-size:12px;">No existing set matches. Create it in Configuration first, or check spelling.</p>`;
            return;
        }

        resultsEl.innerHTML = data.map(s => `
            <div class="bms-set-item" data-name="${escapeHtml(s.name)}"
                 style="padding:5px 6px; border:1px solid var(--border); border-radius:4px;
                        margin-bottom:3px; cursor:pointer; font-size:13px;">
                ${escapeHtml(s.name)}
            </div>
        `).join('');

        resultsEl.querySelectorAll('.bms-set-item').forEach(el => {
            el.addEventListener('click', () => {
                chosenSetName = el.dataset.name;
                setInput.value = chosenSetName;
                resultsEl.innerHTML = '';
                applyBtn.disabled = false;
            });
        });
    }, 300);

    setInput.addEventListener('input', searchSets);

    overlay.querySelector('.bms-cancel-btn').addEventListener('click', () => overlay.remove());

    applyBtn.addEventListener('click', async () => {
        if (!chosenSetName) return;

        applyBtn.disabled = true;
        applyBtn.textContent = 'Applying...';

        let succeeded = 0;
        let failed = 0;
        let firstError = null;

        for (let i = 0; i < ids.length; i++) {
            msgEl.textContent = `Updating ${i + 1} of ${ids.length}...`;

            const { error } = await supabase
                .from('staging')
                .update({
                    set_name:     chosenSetName,
                    card_id:      null,
                    match_status: 'not_found',
                    status:       'pending',
                    updated_at:   new Date().toISOString(),
                })
                .eq('id', ids[i]);

            if (!error) {
                succeeded++;
            } else {
                failed++;
                if (!firstError) firstError = error.message;
                break;
            }
        }

        if (failed > 0) {
            msgEl.innerHTML = `<span style="color:var(--danger)">
                Updated ${succeeded} of ${ids.length}. Stopped on error: ${escapeHtml(firstError)}
            </span>`;
            applyBtn.disabled = false;
            applyBtn.textContent = `Apply to ${ids.length} row${ids.length === 1 ? '' : 's'}`;
            return;
        }

        msgEl.innerHTML = `<span style="color:var(--success)">Updated ${succeeded} row${succeeded === 1 ? '' : 's'}.</span>`;
        state.selectedIds.clear();

        setTimeout(async () => {
            overlay.remove();
            await loadAndRenderRows(container);
        }, 500);
    });
}

/**
 * Deletes a single row directly from the collapsed table view, without
 * requiring the row to be expanded first. Mirrors deleteRow() but reports
 * via a transient toast on the toolbar instead of an expanded-row message.
 */
async function quickDeleteRow(container, row) {
    const confirmed = window.confirm(`Delete "${row.card_name}" from staging? This cannot be undone.`);
    if (!confirmed) return;

    const { error } = await supabase.rpc('delete_staging_row', { p_id: row.staging_id });

    if (error) {
        alert('Failed to delete: ' + error.message);
        return;
    }

    state.selectedIds.delete(row.staging_id);
    if (state.expandedRowId === row.staging_id) state.expandedRowId = null;

    await loadAndRenderRows(container);
}

async function skipRow(container, td, row) {
    const { error } = await supabase
        .from('staging')
        .update({ status: 'skipped', updated_at: new Date().toISOString() })
        .eq('id', row.staging_id);

    if (error) {
        showRowMessage(td, 'Failed to skip: ' + error.message, 'danger');
        return;
    }

    advanceToNextRow(container, row.staging_id);
}

async function deleteRow(container, td, row) {
    const confirmed = window.confirm(`Delete "${row.card_name}" from staging? This cannot be undone.`);
    if (!confirmed) return;

    const { error } = await supabase
        .rpc('delete_staging_row', { p_id: row.staging_id });

    if (error) {
        showRowMessage(td, 'Failed to delete: ' + error.message, 'danger');
        return;
    }

    advanceToNextRow(container, row.staging_id);
}

async function advanceToNextRow(container, currentStagingId) {
    const idx = state.rows.findIndex(r => r.staging_id === currentStagingId);
    const next = state.rows[idx + 1];

    state.expandedRowId = next ? next.staging_id : null;

    await loadAndRenderRows(container);
}

// ----------------------------------------------------------------
// Create card modal (for not_found rows)
// ----------------------------------------------------------------

function openCreateCardModal(container, td, row) {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
        position: fixed; inset: 0; background: rgba(0,0,0,0.6);
        display: flex; align-items: center; justify-content: center; z-index: 1000;
    `;

    overlay.innerHTML = `
        <div style="background:var(--bg-secondary); border:1px solid var(--border); border-radius:8px; padding:20px; width:480px; max-width:90vw;">
            <h3 style="margin-top:0;">Create new card</h3>
            <div style="display:flex; flex-direction:column; gap:8px;">
                <label>Card name
                    <input type="text" class="modal-card-name" value="${escapeHtml(row.card_name || '')}" style="width:100%;" />
                </label>
                <label>Set name
                    <input type="text" class="modal-set-name" value="${escapeHtml(row.set_name || '')}" style="width:100%;" />
                </label>
                <label>Card number
                    <input type="text" class="modal-card-number" value="${escapeHtml(row.card_number || '')}" placeholder="e.g. 045/198" style="width:100%;" />
                </label>
                <label>Rarity
                    <input type="text" class="modal-rarity" value="${escapeHtml(row.api_rarity || '')}" style="width:100%;" />
                </label>
                <label style="display:flex; align-items:center; gap:6px; flex-direction:row;">
                    <input type="checkbox" class="modal-is-promo" />
                    Promo card
                </label>
                <label style="display:flex; align-items:center; gap:6px; flex-direction:row;">
                    <input type="checkbox" class="modal-is-first-edition" />
                    1st Edition
                </label>
                <label style="display:flex; align-items:center; gap:6px; flex-direction:row;">
                    <input type="checkbox" class="modal-is-shiny" />
                    Shiny
                </label>
            </div>
            <div class="modal-dedup-results" style="margin-top:10px; max-height:160px; overflow-y:auto;"></div>
            <div class="modal-message" style="margin-top:8px; font-size:13px;"></div>
            <div style="display:flex; gap:8px; margin-top:14px;">
                <button class="btn btn-primary modal-create-btn">Create card</button>
                <button class="btn modal-cancel-btn">Cancel</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    const nameInput = overlay.querySelector('.modal-card-name');
    const setInput = overlay.querySelector('.modal-set-name');
    const dedupArea = overlay.querySelector('.modal-dedup-results');
    const msgArea = overlay.querySelector('.modal-message');

    const runDedupCheck = debounce(async () => {
        const name = nameInput.value.trim();
        if (!name) {
            dedupArea.innerHTML = '';
            return;
        }

        const { data, error } = await supabase
            .from('v_card_variants')
            .select('*')
            .ilike('card_name', `%${name}%`)
            .limit(10);

        if (error) console.error('Dedup check error (variants):', error);

        // Also check card_master directly, for cards created but not yet
        // pushed to inventory — those have no card_variants row yet and
        // wouldn't otherwise show up as a dedup warning here.
        const { data: cmData, error: cmError } = await supabase
            .from('card_master')
            .select('id, name, card_number, card_sets(name)')
            .ilike('name', `%${name}%`)
            .limit(10);

        if (cmError) console.error('Dedup check error (card_master):', cmError);

        const seenIds = new Set((data || []).map(c => c.card_id));
        const noVariantMatches = (cmData || [])
            .filter(c => !seenIds.has(c.id))
            .map(c => ({
                card_name: c.name,
                set_name: c.card_sets?.name || '',
                display_number: c.card_number,
                foil_label: 'No variant yet',
                pattern_label: null, texture_label: null, material_label: null, size_label: null,
            }));

        const combined = [...(data || []), ...noVariantMatches];

        if (combined.length === 0) {
            dedupArea.innerHTML = '';
            return;
        }

        dedupArea.innerHTML = `
            <p style="color:var(--warning); font-size:13px;">Possible existing matches — verify this isn't a duplicate:</p>
            ${combined.map(c => {
                const vLabel = [c.foil_label, c.pattern_label, c.texture_label,
                                c.material_label, c.size_label].filter(Boolean).join(' · ') || 'Non-Holo';
                return `
                <div style="padding:4px; font-size:12px; color:var(--text-secondary);">
                    ${escapeHtml(c.card_name)} — ${escapeHtml(c.set_name)} #${escapeHtml(c.display_number || '')}
                    (${escapeHtml(vLabel)})
                </div>`;
            }).join('')}
        `;
    }, 350);

    nameInput.addEventListener('input', runDedupCheck);
    runDedupCheck();

    overlay.querySelector('.modal-cancel-btn').addEventListener('click', () => overlay.remove());

    overlay.querySelector('.modal-create-btn').addEventListener('click', async () => {
        const cardName = nameInput.value.trim();
        const setName = setInput.value.trim();
        const cardNumber = overlay.querySelector('.modal-card-number').value.trim();
        const rarity = overlay.querySelector('.modal-rarity').value.trim();
        const isPromo = overlay.querySelector('.modal-is-promo').checked;
        const isFirstEdition = overlay.querySelector('.modal-is-first-edition').checked;
        const isShiny = overlay.querySelector('.modal-is-shiny').checked;

        if (!cardName || !setName || !cardNumber) {
            msgArea.innerHTML = `<span style="color:var(--danger)">Card name, set name, and card number are required.</span>`;
            return;
        }

        // Guard against double-submit: the two awaits below take long enough
        // that a second click would otherwise insert a duplicate card_master row.
        const createBtn = overlay.querySelector('.modal-create-btn');
        if (createBtn.disabled) return;
        createBtn.disabled = true;
        msgArea.innerHTML = `<span style="color:var(--text-secondary)">Creating...</span>`;

        // Find or create the set
        let { data: setRow, error: setErr } = await supabase
            .from('card_sets')
            .select('id')
            .ilike('name', setName)
            .maybeSingle();

        if (setErr) {
            createBtn.disabled = false;
            msgArea.innerHTML = `<span style="color:var(--danger)">Set lookup failed: ${setErr.message}</span>`;
            return;
        }

        if (!setRow) {
            createBtn.disabled = false;
            msgArea.innerHTML = `<span style="color:var(--danger)">Set "${escapeHtml(setName)}" not found. Create it on the Sets page first.</span>`;
            return;
        }

        const { data: newCard, error: createErr } = await supabase
            .from('card_master')
            .insert({
                set_id: setRow.id,
                name: cardName,
                card_number: cardNumber,
                rarity: rarity || null,
                is_promo: isPromo,
                is_first_edition: isFirstEdition,
                is_shiny: isShiny,
            })
            .select('id')
            .single();

        if (createErr) {
            createBtn.disabled = false;
            msgArea.innerHTML = `<span style="color:var(--danger)">Failed to create card: ${createErr.message}</span>`;
            return;
        }

        await resolveStagingMatch(container, td, row, { id: newCard.id });
        overlay.remove();
    });
}

// ----------------------------------------------------------------
// Pagination
// ----------------------------------------------------------------

function renderPagination(container) {
    const el = container.querySelector('#pagination');
    const totalPages = Math.max(1, Math.ceil(state.totalCount / state.pageSize));
    const currentPage = state.page + 1;

    el.innerHTML = `
        <button class="btn" id="prev-page" ${state.page === 0 ? 'disabled' : ''}>Previous</button>
        <span>Page ${currentPage} of ${totalPages} (${state.totalCount} rows)</span>
        <button class="btn" id="next-page" ${currentPage >= totalPages ? 'disabled' : ''}>Next</button>
    `;

    el.querySelector('#prev-page')?.addEventListener('click', () => {
        if (state.page > 0) {
            state.page -= 1;
            state.expandedRowId = null;
            loadAndRenderRows(container);
        }
    });

    el.querySelector('#next-page')?.addEventListener('click', () => {
        state.page += 1;
        state.expandedRowId = null;
        loadAndRenderRows(container);
    });
}

// ----------------------------------------------------------------
// Import from TCGPlayer modal — uploads a saved TCGPlayer order page
// (File > Save Page As > Webpage, HTML only) to picking_api.py, which
// runs it through importer/tcgplayer_html.py (the same code the CLI's
// --tcgplayer-html flag calls) on a background thread and lands results
// straight in staging. Same job-polling convention as jobs.js's Excel
// import (POST /api/jobs/tcgplayer-html-import, then GET /api/jobs/{id}
// until status leaves 'running'), just scoped to this page instead of
// the Jobs page since staging is where the user actually wants to land.
// ----------------------------------------------------------------

async function pollTcgplayerImportJob(jobId, onProgress) {
    while (true) {
        const resp = await fetch(`${PICKING_API_URL}/api/jobs/${jobId}`, {
            headers: { 'x-picking-token': PICKING_API_TOKEN },
        });
        if (!resp.ok) {
            const detail = await resp.text().catch(() => '');
            throw new Error(`${resp.status} ${detail}`);
        }
        const job = await resp.json();
        if (job.status !== 'running') return job;
        if (onProgress) onProgress(job.progress || {});
        await new Promise(r => setTimeout(r, JOB_POLL_INTERVAL_MS));
    }
}

function openTcgplayerImportModal(container) {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
        position:fixed; inset:0; background:rgba(0,0,0,0.7);
        display:flex; align-items:center; justify-content:center;
        z-index:1000; padding:16px;
    `;

    overlay.innerHTML = `
        <div style="background:var(--bg-secondary); border:1px solid var(--border);
                    border-radius:8px; padding:24px; width:560px; max-width:95vw;
                    max-height:90vh; overflow-y:auto;">
            <h3 style="margin-top:0;">Import from TCGPlayer</h3>
            <p style="font-size:12px; color:var(--text-secondary); margin-top:0;">
                Save the order confirmation page from TCGPlayer (File &gt; Save Page As
                &gt; Webpage, HTML only), then upload it here. Cards land in Staging
                Review just like <code>--tcgplayer-html</code> from the CLI — matched
                rows are auto-approved, ambiguous/not-found ones need review here.
            </p>

            <div style="display:flex; flex-direction:column; gap:10px; margin:16px 0;">
                <input type="file" id="tcgi-file" accept=".html" />
                <label style="font-size:12px; color:var(--text-secondary); display:flex; align-items:center; gap:6px;">
                    <input type="checkbox" id="tcgi-dryrun" checked /> Dry run (preview only, writes nothing)
                </label>
            </div>

            <div id="tcgi-result" style="font-size:12px; margin-bottom:12px;"></div>

            <div style="display:flex; gap:8px; align-items:center; border-top:1px solid var(--border); padding-top:16px;">
                <button class="btn btn-primary" id="tcgi-start-btn">Start import</button>
                <button class="btn" id="tcgi-close-btn">Close</button>
                <span id="tcgi-msg" style="font-size:12px; margin-left:8px; color:var(--danger);"></span>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    const fileInput  = overlay.querySelector('#tcgi-file');
    const dryRunBox  = overlay.querySelector('#tcgi-dryrun');
    const resultDiv  = overlay.querySelector('#tcgi-result');
    const startBtn   = overlay.querySelector('#tcgi-start-btn');
    const msgSpan    = overlay.querySelector('#tcgi-msg');
    let anyWrote = false;

    overlay.querySelector('#tcgi-close-btn').addEventListener('click', async () => {
        overlay.remove();
        if (anyWrote) {
            await loadImportBatches();
            await loadSets();
            await loadFilterCounts();
            renderFilters(container);
            await loadAndRenderRows(container);
        }
    });

    startBtn.addEventListener('click', async () => {
        msgSpan.textContent = '';
        const file = fileInput.files && fileInput.files[0];
        if (!file) { msgSpan.textContent = 'Choose a saved order page first.'; return; }
        const dryRun = dryRunBox.checked;

        startBtn.disabled = true;
        fileInput.disabled = true;
        dryRunBox.disabled = true;
        resultDiv.style.color = 'var(--text-secondary)';
        resultDiv.textContent = 'Uploading...';

        try {
            const form = new FormData();
            form.append('file', file);
            form.append('dry_run', String(dryRun));
            const resp = await fetch(`${PICKING_API_URL}/api/jobs/tcgplayer-html-import`, {
                method: 'POST',
                headers: { 'x-picking-token': PICKING_API_TOKEN },
                body: form,
            });
            if (!resp.ok) {
                const detail = await resp.text().catch(() => '');
                throw new Error(`${resp.status} ${detail}`);
            }
            const { job_id } = await resp.json();
            resultDiv.textContent = 'Processing...';
            const job = await pollTcgplayerImportJob(job_id, (progress) => {
                if (progress.total != null) {
                    const parts = [`${progress.done ?? 0}/${progress.total} cards`];
                    if (progress.matched) parts.push(`${progress.matched} matched`);
                    if (progress.not_found) parts.push(`${progress.not_found} not found`);
                    resultDiv.textContent = parts.join(' · ');
                }
            });

            if (job.status === 'failed') {
                resultDiv.style.color = 'var(--danger)';
                resultDiv.textContent = job.error || 'Import failed.';
            } else {
                const r = job.result || {};
                resultDiv.style.color = '';
                resultDiv.textContent = `${dryRun ? '[Dry run] ' : ''}Staged: ${r.staged ?? 0} · `
                    + `Matched: ${r.matched ?? 0} · Ambiguous: ${r.ambiguous ?? 0} · Not found: ${r.not_found ?? 0}`;
                if (!dryRun && (r.staged ?? 0) > 0) anyWrote = true;
            }
        } catch (err) {
            resultDiv.style.color = 'var(--danger)';
            resultDiv.textContent = `Failed: ${err.message} — is picking_api.py running and reachable at ${PICKING_API_URL}?`;
        }

        startBtn.disabled = false;
        fileInput.disabled = false;
        dryRunBox.disabled = false;
    });
}

// New Local Purchase modal — reuses the exact same searchDB,
// searchPokemonTcgApi, and getGameId functions as the staging
// rematch flow, so behavior is identical: DB search first, API
// fallback, clickable results list, manual create as last resort.
// ----------------------------------------------------------------

// FOIL_LABELS_NLP and NLP_*_OPTS pull from the same DB-driven AXIS_OPTIONS /
// AXIS_DISPLAY loaded once at page mount (see loadAxisOptions()), rather
// than a separate hardcoded copy that could drift from the main editor.
// NLP_FOIL_OPTS deliberately excludes the '— none —' entry present in the
// other axes -- a local purchase always has a definite foil status.
function nlpFoilLabels()   { return AXIS_DISPLAY.foil_type || {}; }
function nlpFoilOpts()     { return (AXIS_OPTIONS.foil_type    || [['', '— none —']]).filter(([v]) => v !== ''); }
function nlpPatternOpts()  { return AXIS_OPTIONS.foil_pattern || [['', '— none —']]; }
function nlpTextureOpts()  { return AXIS_OPTIONS.texture      || [['', '— none —']]; }
function nlpMaterialOpts() { return AXIS_OPTIONS.material     || [['', '— none —']]; }
function nlpSizeOpts()     { return AXIS_OPTIONS.size         || [['', '— none —']]; }
function nlpStampOpts()    { return AXIS_OPTIONS.stamp_type   || [['', '— none —']]; }
function nlpSourceOpts()   { return AXIS_OPTIONS.source_type  || [['', '— none —']]; }

function openNewLocalPurchaseModal(container) {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
        position:fixed; inset:0; background:rgba(0,0,0,0.7);
        display:flex; align-items:center; justify-content:center;
        z-index:1000; padding:16px;
    `;

    const batchId = 'local_' + new Date().toISOString().slice(0,10).replace(/-/g,'') +
                    '_' + Math.random().toString(36).slice(2,6).toUpperCase();

    const addedCards = [];

    overlay.innerHTML = `
        <div style="background:var(--bg-secondary); border:1px solid var(--border);
                    border-radius:8px; padding:24px; width:680px; max-width:95vw;
                    max-height:90vh; overflow-y:auto;">
            <h3 style="margin-top:0;">New Local Purchase</h3>

            <div style="display:flex; gap:12px; flex-wrap:wrap; margin-bottom:16px;
                        padding-bottom:16px; border-bottom:1px solid var(--border);">
                <label style="font-size:12px; color:var(--text-secondary);">Batch / PO Reference
                    <input type="text" id="nlp-batch" value="${escapeHtml(batchId)}"
                           style="width:220px; margin-top:4px; display:block; font-size:12px;" />
                </label>
                <label style="font-size:12px; color:var(--text-secondary);">Date
                    <input type="date" id="nlp-date"
                           style="width:140px; margin-top:4px; display:block;" />
                </label>
            </div>

            <div style="font-size:12px; font-weight:600; color:var(--text-secondary);
                        text-transform:uppercase; letter-spacing:0.04em; margin-bottom:8px;">
                Add a card
            </div>
            <div id="nlp-form"></div>

            <div style="margin:16px 0;">
                <div style="font-size:12px; font-weight:600; color:var(--text-secondary);
                            text-transform:uppercase; letter-spacing:0.04em; margin-bottom:8px;">
                    Cards in this purchase
                </div>
                <div id="nlp-added-list">
                    <div id="nlp-empty-msg" style="font-size:12px; color:var(--text-secondary); padding:8px 0;">
                        No cards added yet.
                    </div>
                </div>
            </div>

            <div style="display:flex; gap:8px; align-items:center; border-top:1px solid var(--border); padding-top:16px;">
                <button class="btn btn-primary" id="nlp-save-btn">Save purchase</button>
                <button class="btn" id="nlp-cancel-btn">Cancel</button>
                <span id="nlp-msg" style="font-size:12px; margin-left:8px;"></span>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    overlay.querySelector('#nlp-date').value = new Date().toISOString().split('T')[0];
    overlay.querySelector('#nlp-cancel-btn').addEventListener('click', () => overlay.remove());

    const formDiv      = overlay.querySelector('#nlp-form');
    const addedListDiv = overlay.querySelector('#nlp-added-list');

    // A "virtual row" object so we can reuse the exact same wireAutocomplete,
    // runRematch, and renderRematchResults functions the staging table uses.
    let vRow = { card_id: null, _matchedItem: null };

    function renderForm() {
        formDiv.innerHTML = `
            <!-- Row 0: Quick Search — searches name, card number, AND variant
                 type (foil/pattern/texture/etc.) at once; picking a result
                 fills in every field below exactly like Card name's own
                 autocomplete does. Separate from Card name/Set/# on purpose
                 (kept as an additional field, not a replacement). -->
            <div style="display:flex; gap:12px; flex-wrap:wrap; margin-bottom:10px; align-items:flex-end;">
                <label>Quick Search
                    <input type="text" class="nlp-edit-quick-search" style="width:320px;"
                           placeholder='Name, number, or variant — e.g. "clefable 103 holo"' autocomplete="off" />
                </label>
            </div>

            <!-- Row 1: Set (own row) -->
            <div style="display:flex; gap:12px; flex-wrap:wrap; margin-bottom:10px; align-items:flex-end;">
                <label>Set
                    <input type="text" class="nlp-edit-set-name" style="width:200px;" placeholder="Type or click to filter..." />
                </label>
            </div>

            <!-- Row 1b: Card Name, #, Rematch -->
            <div style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:12px; align-items:flex-end;">
                <label>Card name
                    <input type="text" class="nlp-edit-card-name" style="width:200px;" placeholder="Type to search Pokémon..." autocomplete="off" />
                </label>
                <label>#
                    <input type="text" class="nlp-edit-card-number" style="width:65px;" />
                </label>
                <label style="align-self:flex-end; margin-left:6px;">
                    <button class="btn nlp-rematch-btn">🔍 Rematch</button>
                </label>
            </div>

            <!-- Row 2: Condition, Qty, Cost, Listing Price -->
            <div style="display:flex; gap:12px; flex-wrap:wrap; margin-bottom:12px; align-items:flex-end;">
                <label>Condition
                    <select class="nlp-edit-condition">
                        ${['Near Mint','Lightly Played','Moderately Played','Heavily Played','Damaged']
                            .map(c => `<option value="${c}">${c}</option>`).join('')}
                    </select>
                </label>
                <label>Qty
                    <input type="number" class="nlp-edit-quantity" value="1" min="1" style="width:60px;" />
                </label>
                <label>Cost
                    <input type="number" step="0.01" class="nlp-edit-cost" style="width:80px;" placeholder="0.00" />
                </label>
                <label>Listing Price <span class="nlp-listing-price-required" style="color:var(--danger); display:none;">*</span>
                    <input type="number" step="0.01" class="nlp-edit-listing-price" style="width:80px;" placeholder="0.00" />
                </label>
            </div>

            <!-- Row 3: Variant axes -->
            <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:12px; align-items:flex-end;">
                <label>Foil type
                    <select class="nlp-edit-foil-type">
                        ${nlpFoilOpts().map(([v,l]) => `<option value="${v}">${l}</option>`).join('')}
                    </select>
                </label>
                <label>Pattern
                    <select class="nlp-edit-foil-pattern">
                        ${nlpPatternOpts().map(([v,l]) => `<option value="${v}">${l}</option>`).join('')}
                    </select>
                </label>
                <label>Texture
                    <select class="nlp-edit-texture">
                        ${nlpTextureOpts().map(([v,l]) => `<option value="${v}">${l}</option>`).join('')}
                    </select>
                </label>
                <label>Material
                    <select class="nlp-edit-material">
                        ${nlpMaterialOpts().map(([v,l]) => `<option value="${v}">${l}</option>`).join('')}
                    </select>
                </label>
                <label>Size
                    <select class="nlp-edit-size">
                        ${nlpSizeOpts().map(([v,l]) => `<option value="${v}">${l}</option>`).join('')}
                    </select>
                </label>
            </div>

            <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:12px; align-items:flex-end;">
                <label>Stamp
                    <select class="nlp-edit-stamp-type">
                        ${nlpStampOpts().map(([v,l]) => `<option value="${v}">${l}</option>`).join('')}
                    </select>
                </label>
                <label>Source
                    <select class="nlp-edit-source-type">
                        ${nlpSourceOpts().map(([v,l]) => `<option value="${v}">${l}</option>`).join('')}
                    </select>
                </label>
            </div>

            <div style="margin-bottom:12px;">
                <label style="display:block;">Notes
                    <input type="text" class="nlp-edit-notes" style="width:100%; max-width:600px;" />
                </label>
            </div>

            <div style="margin-bottom:12px; padding:10px; border:1px solid var(--border); border-radius:6px;">
                <label style="font-size:13px; display:flex; align-items:center; gap:6px;">
                    <input type="checkbox" class="nlp-edit-ebay-link" />
                    Link to an eBay listing (resolves an "unmatched" Issue for this exact variation on approval)
                </label>
                <div class="nlp-ebay-link-fields" style="display:none; gap:12px; margin-top:8px; flex-wrap:wrap;">
                    <label>eBay Item ID
                        <input type="text" class="nlp-edit-ebay-item-id" style="width:160px;" placeholder="e.g. 335777076705" />
                    </label>
                    <label>eBay variation name
                        <input type="text" class="nlp-edit-ebay-variation-name" style="width:320px;"
                               placeholder="exact string from the Issue, e.g. 072/131 Drakloak Master Ball RH Reverse Holo" />
                    </label>
                </div>
            </div>

            <div class="nlp-rematch-results" style="margin-bottom:8px;"></div>
            <div class="nlp-vp-msg" style="margin-bottom:8px; font-size:13px;"></div>

            <div style="display:flex; gap:8px; margin-top:12px;">
                <button class="btn btn-primary nlp-add-btn">Add to purchase</button>
            </div>
        `;

        const nameInput  = formDiv.querySelector('.nlp-edit-card-name');
        const setInput   = formDiv.querySelector('.nlp-edit-set-name');
        const numInput   = formDiv.querySelector('.nlp-edit-card-number');
        const quickInput = formDiv.querySelector('.nlp-edit-quick-search');
        const resultsEl  = formDiv.querySelector('.nlp-rematch-results');

        formDiv.querySelector('.nlp-edit-ebay-link').addEventListener('change', (e) => {
            formDiv.querySelector('.nlp-ebay-link-fields').style.display = e.target.checked ? 'flex' : 'none';
            formDiv.querySelector('.nlp-listing-price-required').style.display = e.target.checked ? 'inline' : 'none';
        });

        // Reset match state for this fresh card
        vRow = { card_id: null, _matchedItem: null };

        // Shared select handler — fills name/set/number/variant-axis fields
        // from a picked search result. Used by both the Card name
        // autocomplete and the Quick Search autocomplete below, so picking
        // a card behaves identically no matter which box found it.
        const selectCard = (c) => {
            nameInput.value = c.card_name;
            if (c._type === 'card') {
                setInput.value = c.set_name || '';
                numInput.value = c.card_number || '';
                vRow.card_id = c.card_id || null;
                vRow._matchedItem = { card_id: c.card_id, source: 'db' };

                const setSel = (cls, val) => {
                    const el = formDiv.querySelector(cls);
                    if (el) el.value = val || '';
                };
                setSel('.nlp-edit-foil-type', c.foil_type || 'non_holo');
                setSel('.nlp-edit-foil-pattern', c.foil_pattern || '');
                setSel('.nlp-edit-texture', c.texture || '');
                setSel('.nlp-edit-material', c.material || '');
                setSel('.nlp-edit-size', c.size || '');
                setSel('.nlp-edit-stamp-type', c.stamp_type || '');
                setSel('.nlp-edit-source-type', c.source_type || '');
            }
        };

        // ── Card name autocomplete — identical to staging row ──────────────────
        wireAutocomplete({
            input: nameInput,
            container: formDiv,
            search: async (term) => {
                const setVal = setInput.value.trim();
                const numVal = numInput.value.trim();

                let cardQuery = supabase
                    .from('v_card_variants')
                    .select('card_id, variant_id, card_name, set_name, display_number, card_number, rarity, foil_type, foil_pattern, texture, material, size, stamp_type, source_type, foil_label, pattern_label, texture_label, material_label, size_label, stamp_label, source_label')
                    .ilike('card_name', `%${term}%`)
                    .order('card_name')
                    .order('foil_type');
                if (setVal) cardQuery = cardQuery.ilike('set_name', `%${setVal}%`);
                if (numVal) cardQuery = cardQuery.eq('card_number', numVal);
                // When narrowed to a specific card (set + number), show ALL its
                // variants rather than capping — that's the whole point of asking.
                cardQuery = cardQuery.limit((setVal && numVal) ? 30 : 8);

                let cmQuery = supabase
                    .from('card_master')
                    .select('id, name, card_number, rarity, card_sets(name)')
                    .ilike('name', `%${term}%`)
                    .limit(8);
                if (numVal) cmQuery = cmQuery.eq('card_number', numVal);

                const [cardRes, charRes, cmRes] = await Promise.all([
                    cardQuery,
                    supabase
                        .from('characters')
                        .select('name')
                        .ilike('name', `%${term}%`)
                        .limit(5),
                    cmQuery,
                ]);
                const cards = (cardRes.data || []).map(c => ({
                    _type: 'card', ...c,
                    variant_label: [c.foil_label, c.pattern_label, c.texture_label, c.material_label, c.size_label, c.stamp_label, c.source_label]
                        .filter(Boolean).join(' · ') || 'Non-Holo',
                }));

                // Card_master rows with no card_variants row yet.
                const seenCardIds = new Set(cards.map(c => c.card_id));
                const setValLower = (setVal || '').toLowerCase();
                const noVariantCards = (cmRes.data || [])
                    .filter(c => !seenCardIds.has(c.id))
                    .filter(c => !setValLower || (c.card_sets?.name || '').toLowerCase().includes(setValLower))
                    .map(c => ({
                        _type: 'card',
                        card_id: c.id, variant_id: null,
                        card_name: c.name, set_name: c.card_sets?.name || '',
                        display_number: c.card_number, card_number: c.card_number,
                        rarity: c.rarity,
                        foil_type: null, foil_pattern: null, texture: null,
                        material: null, size: null, stamp_type: null, source_type: null,
                        variant_label: 'No variant yet',
                    }));

                const chars = (charRes.data || []).map(ch => ({ _type: 'character', card_name: ch.name }));
                return [...cards, ...noVariantCards, ...chars];
            },
            renderItem: (c) => c._type === 'card'
                ? `${c.card_name} — ${c.set_name} #${c.display_number || ''} · ${c.variant_label}`
                : `✦ ${c.card_name}`,
            onSelect: selectCard,
        });

        // ── Quick Search — one box searching name, card number, AND variant
        // type together. Server-side query narrows on the first typed word
        // (OR'd across card_name/card_number/every variant-label column);
        // any additional words then AND-filter client-side against those
        // same fields, so "clefable 103 holo" only keeps results matching
        // all three, without depending on chaining multiple .or() calls
        // server-side (not a pattern used anywhere else in this codebase).
        wireAutocomplete({
            input: quickInput,
            container: formDiv,
            search: async (term) => {
                const words = term.trim().toLowerCase().split(/\s+/).filter(Boolean);
                if (!words.length) return [];

                const VARIANT_LABEL_COLS = ['foil_label', 'pattern_label', 'texture_label', 'material_label', 'size_label', 'stamp_label', 'source_label'];
                const orExpr = (w) => ['card_name', 'card_number', ...VARIANT_LABEL_COLS]
                    .map(col => `${col}.ilike.%${w}%`).join(',');

                const [cardRes, cmRes] = await Promise.all([
                    supabase
                        .from('v_card_variants')
                        .select('card_id, variant_id, card_name, set_name, display_number, card_number, rarity, foil_type, foil_pattern, texture, material, size, stamp_type, source_type, foil_label, pattern_label, texture_label, material_label, size_label, stamp_label, source_label')
                        .or(orExpr(words[0]))
                        .order('card_name')
                        .order('foil_type')
                        .limit(40),
                    supabase
                        .from('card_master')
                        .select('id, name, card_number, rarity, card_sets(name)')
                        .or(`name.ilike.%${words[0]}%,card_number.ilike.%${words[0]}%`)
                        .limit(25),
                ]);

                const matchesAllWords = (text) => words.every(w => text.includes(w));

                const cards = (cardRes.data || [])
                    .map(c => ({
                        _type: 'card', ...c,
                        variant_label: [c.foil_label, c.pattern_label, c.texture_label, c.material_label, c.size_label, c.stamp_label, c.source_label]
                            .filter(Boolean).join(' · ') || 'Non-Holo',
                    }))
                    .filter(c => matchesAllWords([c.card_name, c.card_number, c.variant_label].join(' ').toLowerCase()))
                    .slice(0, 15);

                const seenCardIds = new Set(cards.map(c => c.card_id));
                const noVariantCards = (cmRes.data || [])
                    .filter(c => !seenCardIds.has(c.id))
                    .map(c => ({
                        _type: 'card',
                        card_id: c.id, variant_id: null,
                        card_name: c.name, set_name: c.card_sets?.name || '',
                        display_number: c.card_number, card_number: c.card_number,
                        rarity: c.rarity,
                        foil_type: null, foil_pattern: null, texture: null,
                        material: null, size: null, stamp_type: null, source_type: null,
                        variant_label: 'No variant yet',
                    }))
                    .filter(c => matchesAllWords([c.card_name, c.card_number].join(' ').toLowerCase()))
                    .slice(0, 8);

                return [...cards, ...noVariantCards];
            },
            renderItem: (c) => `${c.card_name} — ${c.set_name} #${c.display_number || ''} · ${c.variant_label}`,
            onSelect: (c) => {
                selectCard(c);
                quickInput.value = '';
            },
        });

        // ── Set name autocomplete — identical to staging row ───────────────────
        wireAutocomplete({
            input: setInput,
            container: formDiv,
            search: async (term) => {
                const { data } = await supabase
                    .from('card_sets').select('name').ilike('name', `%${term}%`).limit(10);
                return data || [];
            },
            renderItem: (s) => s.name,
            onSelect: (s) => { setInput.value = s.name; },
        });

        // ── Rematch button — manual trigger, same DB-then-API flow ─────────────
        formDiv.querySelector('.nlp-rematch-btn').addEventListener('click', async () => {
            const btn = formDiv.querySelector('.nlp-rematch-btn');
            const name = nameInput.value.trim();
            const num  = numInput.value.trim();
            const setN = setInput.value.trim();

            if (!name) {
                resultsEl.innerHTML = `<p style="color:var(--warning); font-size:13px;">Enter a card name to search.</p>`;
                return;
            }

            btn.disabled = true;
            btn.textContent = 'Searching DB...';
            resultsEl.innerHTML = '';

            const dbResults = await searchDB(name, num, setN);

            if (dbResults.length > 0) {
                btn.disabled = false;
                btn.textContent = '🔍 Rematch';
                renderLocalRematchResults(dbResults, 'db', name, num, setN, resultsEl, nameInput, setInput, numInput);
                return;
            }

            btn.textContent = 'Not in DB — searching API...';
            let apiResults;
            try {
                apiResults = await searchPokemonTcgApi(name, num, setN);
            } catch (e) {
                btn.disabled = false;
                btn.textContent = '🔍 Rematch';
                resultsEl.innerHTML = `<p style="color:var(--danger); font-size:13px;">pokemontcg.io API error: ${escapeHtml(e.message)}. Try again.</p>`;
                return;
            }
            btn.disabled = false;
            btn.textContent = '🔍 Rematch';

            if (apiResults.length === 0) {
                resultsEl.innerHTML = `
                    <p style="color:var(--warning); font-size:13px;">
                        Not found in DB or pokemontcg.io API for
                        "<strong>${escapeHtml(name)}</strong>"
                        ${num ? `#${escapeHtml(num)}` : ''}
                        ${setN ? `(${escapeHtml(setN)})` : ''}.
                        Fill in the fields manually and click Add to purchase to create it.
                    </p>`;
                return;
            }

            renderLocalRematchResults(apiResults, 'api', name, num, setN, resultsEl, nameInput, setInput, numInput);
        });

        // ── Add to purchase ─────────────────────────────────────────────────────
        formDiv.querySelector('.nlp-add-btn').addEventListener('click', async () => {
            const msg = formDiv.querySelector('.nlp-vp-msg');
            let cardId = vRow.card_id;

            const setName    = setInput.value.trim();
            const cardName    = nameInput.value.trim();
            const cardNumber  = numInput.value.trim();

            if (!cardName || !setName || !cardNumber) {
                msg.innerHTML = `<span style="color:var(--danger)">Card name, set, and number are required.</span>`;
                return;
            }

            // Matched from API but not yet created in DB — create now (mirrors linkStagingToCard)
            if (vRow._matchedItem && vRow._matchedItem.source === 'api' && !cardId) {
                msg.innerHTML = `<span style="color:var(--text-secondary)">Adding to catalog...</span>`;
                const item = vRow._matchedItem;
                const api  = item._raw;

                let { data: setRow } = await supabase
                    .from('card_sets').select('id').eq('set_code', item.set_code).maybeSingle();

                if (!setRow) {
                    const { data: newSet, error: setErr } = await supabase
                        .from('card_sets')
                        .insert({
                            name: item.set_name, set_code: item.set_code,
                            total_cards: item.set_total || null, game_id: await getGameId(),
                        })
                        .select('id').single();
                    if (setErr) {
                        msg.innerHTML = `<span style="color:var(--danger)">${escapeHtml(setErr.message)}</span>`;
                        return;
                    }
                    setRow = newSet;
                }

                // A card can already exist locally at this set+number without
                // matching by external_id (e.g. hand-entered earlier because
                // the API didn't index this printing yet — common for
                // secret rares) — check the natural key idx_card_master_unique
                // itself enforces before upserting, otherwise a real
                // external_id mismatch still collides on (set_id, card_number).
                const { data: existingByNumber, error: existingErr } = await supabase
                    .from('card_master')
                    .select('id, name, rarity, image_url, external_id')
                    .eq('set_id', setRow.id)
                    .eq('card_number', api.number)
                    .maybeSingle();
                if (existingErr) {
                    msg.innerHTML = `<span style="color:var(--danger)">${escapeHtml(existingErr.message)}</span>`;
                    return;
                }

                if (existingByNumber) {
                    cardId = existingByNumber.id;
                    // Backfill whatever this row was missing (image,
                    // external_id, rarity) from this fresh API match —
                    // reusing the id alone never applies the API's data.
                    // Only fills currently-null fields, so a manually
                    // curated value is never clobbered.
                    const backfill = {};
                    if (!existingByNumber.name && api.name) backfill.name = api.name;
                    if (!existingByNumber.rarity && api.rarity) backfill.rarity = api.rarity;
                    if (!existingByNumber.image_url) {
                        const img = api.images?.large || api.images?.small || null;
                        if (img) backfill.image_url = img;
                    }
                    if (!existingByNumber.external_id) backfill.external_id = api.id;
                    if (Object.keys(backfill).length) {
                        const { error: backfillErr } = await supabase
                            .from('card_master').update(backfill).eq('id', cardId);
                        if (backfillErr) console.error('Failed to backfill card_master fields:', backfillErr);
                    }
                } else {
                    const { data: cardRow, error: cardErr } = await supabase
                        .from('card_master')
                        .upsert({
                            set_id: setRow.id, name: api.name, card_number: api.number,
                            rarity: api.rarity || null,
                            image_url: api.images?.large || api.images?.small || null,
                            external_id: api.id,
                        }, { onConflict: 'external_id' })
                        .select('id').single();

                    if (cardErr) {
                        msg.innerHTML = `<span style="color:var(--danger)">${escapeHtml(cardErr.message)}</span>`;
                        return;
                    }
                    cardId = cardRow.id;
                }
            }

            // Still nothing matched — create fresh from typed fields
            if (!cardId) {
                msg.innerHTML = `<span style="color:var(--text-secondary)">Creating card...</span>`;

                let { data: setRow, error: setErr } = await supabase
                    .from('card_sets').select('id').ilike('name', setName).maybeSingle();

                if (setErr) {
                    msg.innerHTML = `<span style="color:var(--danger)">${escapeHtml(setErr.message)}</span>`;
                    return;
                }
                if (!setRow) {
                    msg.innerHTML = `<span style="color:var(--danger)">Set "${escapeHtml(setName)}" not found. Create it on the Sets page first, or use Rematch to pick an existing card.</span>`;
                    return;
                }

                // Same fallback as above — a plain insert here has no
                // conflict handling at all, so an existing card at this
                // set+number (any external_id state) must be caught first.
                const { data: existingByNumber, error: existingErr } = await supabase
                    .from('card_master')
                    .select('id')
                    .eq('set_id', setRow.id)
                    .eq('card_number', cardNumber)
                    .maybeSingle();
                if (existingErr) {
                    msg.innerHTML = `<span style="color:var(--danger)">${escapeHtml(existingErr.message)}</span>`;
                    return;
                }

                if (existingByNumber) {
                    cardId = existingByNumber.id;
                } else {
                    const { data: newCard, error: createErr } = await supabase
                        .from('card_master')
                        .insert({ set_id: setRow.id, name: cardName, card_number: cardNumber })
                        .select('id').single();

                    if (createErr) {
                        msg.innerHTML = `<span style="color:var(--danger)">${escapeHtml(createErr.message)}</span>`;
                        return;
                    }
                    cardId = newCard.id;
                }
            }

            const condition    = formDiv.querySelector('.nlp-edit-condition').value;
            const qty          = parseInt(formDiv.querySelector('.nlp-edit-quantity').value) || 1;
            const cost         = parseFloat(formDiv.querySelector('.nlp-edit-cost').value) || 0;
            const listingPrice = parseFloat(formDiv.querySelector('.nlp-edit-listing-price').value) || null;
            const foilType     = formDiv.querySelector('.nlp-edit-foil-type').value;
            const pattern      = formDiv.querySelector('.nlp-edit-foil-pattern').value || null;
            const texture      = formDiv.querySelector('.nlp-edit-texture').value || null;
            const material     = formDiv.querySelector('.nlp-edit-material').value || null;
            const size         = formDiv.querySelector('.nlp-edit-size').value || null;
            const stamp        = formDiv.querySelector('.nlp-edit-stamp-type').value || null;
            const srcType      = formDiv.querySelector('.nlp-edit-source-type').value || null;
            const notes        = formDiv.querySelector('.nlp-edit-notes').value.trim() || null;

            const linkToEbay   = formDiv.querySelector('.nlp-edit-ebay-link').checked;
            const ebayItemId   = formDiv.querySelector('.nlp-edit-ebay-item-id').value.trim() || null;
            const ebayVarName  = formDiv.querySelector('.nlp-edit-ebay-variation-name').value.trim() || null;
            if (linkToEbay && (!ebayItemId || !ebayVarName)) {
                msg.innerHTML = `<span style="color:var(--danger)">eBay Item ID and variation name are both required to link a listing.</span>`;
                return;
            }
            if (linkToEbay && !listingPrice) {
                msg.innerHTML = `<span style="color:var(--danger)">Listing Price is required when linking to an eBay listing (platform_listings.list_price can't be blank).</span>`;
                return;
            }

            addedCards.push({
                card_id: cardId, card_name: cardName, set_name: setName, card_number: cardNumber,
                condition, foil_type: foilType, foil_pattern: pattern, texture, material, size,
                stamp_type: stamp, source_type: srcType, notes, qty, cost, listing_price: listingPrice,
                ebay_item_id: linkToEbay ? ebayItemId : null,
                ebay_variation_name: linkToEbay ? ebayVarName : null,
            });

            renderAddedList();
            renderForm();
            // renderForm() rebuilds the whole form fresh, so the old quickInput
            // reference is now detached — re-query for the new one so the next
            // card can be typed immediately without an extra click.
            formDiv.querySelector('.nlp-edit-quick-search')?.focus();
        });
    }

    function renderLocalRematchResults(items, source, name, num, setN, resultsEl, nameInput, setInput, numInput) {
        const sourceLabel = source === 'db'
            ? `<span style="color:var(--success); font-size:12px;">📦 From your catalog</span>`
            : `<span style="color:var(--text-secondary); font-size:12px;">🌐 From pokemontcg.io API — will be added to your catalog on link</span>`;

        resultsEl.innerHTML = `
            <div style="margin-bottom:6px;">${sourceLabel}</div>
            <p style="font-size:13px; color:var(--text-secondary); margin:0 0 6px;">
                ${items.length} result${items.length === 1 ? '' : 's'} — click to link:
            </p>
            ${items.map((c, i) => `
                <div class="nlp-result-item" data-idx="${i}"
                     style="padding:6px 8px; border:1px solid var(--border); border-radius:4px;
                            margin-bottom:4px; cursor:pointer; font-size:13px; display:flex; align-items:center; gap:10px;"
                     onmouseover="this.style.background='var(--bg-tertiary)'"
                     onmouseout="this.style.background=''">
                    ${c.image_url ? `<img src="${escapeHtml(c.image_url)}" style="height:40px; border-radius:3px; flex-shrink:0;" />` : ''}
                    <div>
                        <strong>${escapeHtml(c.name)}</strong>
                        — ${escapeHtml(c.set_name)} #${escapeHtml(c.number || '')}
                        <span style="color:var(--text-secondary);">(${escapeHtml(c.variant_label)}${c.rarity ? ', ' + escapeHtml(c.rarity) : ''})</span>
                        ${source === 'api' ? `<span style="color:var(--text-secondary); font-size:11px; display:block;">API ID: ${escapeHtml(c.external_id)}</span>` : ''}
                    </div>
                </div>
            `).join('')}
            ${source === 'db' ? `
                <button class="btn nlp-try-api-btn" style="margin-top:8px; font-size:12px;">
                    Not what you're looking for? Search pokemontcg.io API →
                </button>` : ''}
        `;

        resultsEl.querySelector('.nlp-try-api-btn')?.addEventListener('click', async () => {
            resultsEl.innerHTML = `<p style="font-size:13px; color:var(--text-secondary);">Searching pokemontcg.io...</p>`;
            let apiResults;
            try {
                apiResults = await searchPokemonTcgApi(name, num, setN);
            } catch (e) {
                resultsEl.innerHTML = `<p style="color:var(--danger); font-size:13px;">pokemontcg.io API error: ${escapeHtml(e.message)}. Try again.</p>`;
                return;
            }
            if (apiResults.length === 0) {
                resultsEl.innerHTML = `<p style="color:var(--warning); font-size:13px;">Not found on pokemontcg.io either.</p>`;
                return;
            }
            renderLocalRematchResults(apiResults, 'api', name, num, setN, resultsEl, nameInput, setInput, numInput);
        });

        resultsEl.querySelectorAll('.nlp-result-item').forEach(el => {
            el.addEventListener('click', () => {
                const item = items[Number(el.dataset.idx)];
                // Fill the form fields, mark as matched, do NOT auto-create yet —
                // creation happens on "Add to purchase" (mirrors linkStagingToCard timing)
                nameInput.value = item.name;
                setInput.value  = item.set_name;
                numInput.value  = item.number || '';
                vRow.card_id = item.card_id || null;
                vRow._matchedItem = item;

                // Populate variant axis dropdowns when available (DB matches only —
                // API results don't know the variant, so leave those as default)
                if (item.source === 'db') {
                    const formRoot = el.closest('#nlp-form') || el.closest('div').parentElement.parentElement;
                    const setSel = (cls, val) => {
                        const elx = document.querySelector(cls);
                        if (elx) elx.value = val || '';
                    };
                    setSel('.nlp-edit-foil-type', item.foil_type || 'non_holo');
                    setSel('.nlp-edit-foil-pattern', item.foil_pattern || '');
                    setSel('.nlp-edit-texture', item.texture || '');
                    setSel('.nlp-edit-material', item.material || '');
                    setSel('.nlp-edit-size', item.size || '');
                    setSel('.nlp-edit-stamp-type', item.stamp_type || '');
                    setSel('.nlp-edit-source-type', item.source_type || '');
                }

                resultsEl.innerHTML = `<p style="color:var(--success); font-size:13px;">✅ Selected — fill in qty/cost below and click Add to purchase.</p>`;
            });
        });
    }

    function renderAddedList() {
        if (addedCards.length === 0) {
            addedListDiv.innerHTML = `<div id="nlp-empty-msg" style="font-size:12px; color:var(--text-secondary); padding:8px 0;">No cards added yet.</div>`;
            return;
        }
        addedListDiv.innerHTML = addedCards.map((c, i) => `
            <div style="display:flex; align-items:center; gap:10px; padding:8px 10px;
                        background:var(--bg-tertiary); border-radius:6px; margin-bottom:6px; font-size:13px;">
                <div style="flex:1;">
                    <strong>${escapeHtml(c.card_name)}</strong>
                    <span style="color:var(--text-secondary); font-size:11px;">
                        ${escapeHtml(c.set_name)} #${escapeHtml(c.card_number)} · ${escapeHtml(variantLabel(c))}
                    </span>
                    ${c.ebay_item_id ? `<span style="color:var(--accent); font-size:11px; display:block;">🔗 linked to eBay item ${escapeHtml(c.ebay_item_id)}</span>` : ''}
                </div>
                <span style="font-size:12px; color:var(--text-secondary);">${c.qty} × ${formatPrice(c.cost)}</span>
                <button class="btn nlp-remove-added-btn" data-idx="${i}" style="font-size:11px; padding:2px 8px; color:var(--danger); border-color:var(--danger);">✕</button>
            </div>
        `).join('');

        addedListDiv.querySelectorAll('.nlp-remove-added-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                addedCards.splice(Number(btn.dataset.idx), 1);
                renderAddedList();
            });
        });
    }

    overlay.querySelector('#nlp-save-btn').addEventListener('click', async () => {
        const msg = overlay.querySelector('#nlp-msg');
        if (addedCards.length === 0) {
            msg.innerHTML = `<span style="color:var(--danger)">Add at least one card.</span>`;
            return;
        }

        const batchRef  = overlay.querySelector('#nlp-batch').value.trim() || batchId;
        const dateVal   = overlay.querySelector('#nlp-date').value;
        const orderDate = dateVal ? new Date(dateVal).toISOString() : new Date().toISOString();

        msg.innerHTML = `<span style="color:var(--text-secondary)">Saving ${addedCards.length} card(s)...</span>`;

        // A card checked "Link to an eBay listing" needs source='ebay' with
        // order_number/variation_name set to the exact (item_id, variation
        // name) pair — push_staging_row_to_inventory's step 7 only inserts
        // into ebay_listing_map (and platform_listings) when source='ebay',
        // so every other card in the batch is completely unaffected and
        // keeps today's plain 'local' behavior.
        const rows = addedCards.map(c => ({
            import_batch: batchRef,
            order_number: c.ebay_item_id || batchRef,
            order_date: orderDate,
            source: c.ebay_item_id ? 'ebay' : 'local',
            variation_name: c.ebay_variation_name || null,
            card_name: c.card_name, set_name: c.set_name, card_number: c.card_number,
            condition: c.condition, quantity: c.qty, price: c.cost, listing_price: c.listing_price,
            card_id: c.card_id, match_status: 'matched', status: 'approved',
            foil_type: c.foil_type, foil_pattern: c.foil_pattern, texture: c.texture,
            material: c.material, size: c.size, stamp_type: c.stamp_type, source_type: c.source_type,
            notes: c.notes,
        }));

        const { error } = await supabase.from('staging').insert(rows);

        if (error) {
            msg.innerHTML = `<span style="color:var(--danger)">Failed: ${escapeHtml(error.message)}</span>`;
            return;
        }

        overlay.remove();

        state.filters.import_batch = batchRef;
        state.filters.source = 'local';
        state.filters.match_status = 'all';
        state.filters.status = 'all';
        state.page = 0;
        await loadFilterCounts();
        renderFilters(container);
        await loadAndRenderRows(container);
    });

    renderForm();
}

// ----------------------------------------------------------------
// Small helpers
// ----------------------------------------------------------------

function showRowMessage(td, message, type) {
    const el = td.querySelector('.row-message');
    const colors = { success: 'var(--success)', danger: 'var(--danger)', warning: 'var(--warning)' };
    el.style.color = colors[type] || 'var(--text-secondary)';
    el.textContent = message;
}

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// staging-review.js
// Staging Review page: filter, edit, resolve, and push staging rows to inventory.

import { supabase, debounce, formatPrice } from './shared.js';

const PAGE_SIZES = [50, 100, 250];

const state = {
    page: 0,
    pageSize: 50,
    totalCount: 0,
    rows: [],
    filters: {
        source: 'all',
        status: 'pending',
        match_status: 'all',
        import_batch: 'all',
        search: '',
    },
    importBatches: [],
    expandedRowId: null,
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
    renderFilters(container);
    await loadAndRenderRows(container);
}

// ----------------------------------------------------------------
// Data loading
// ----------------------------------------------------------------

async function loadImportBatches() {
    const { data, error } = await supabase
        .from('staging')
        .select('import_batch')
        .not('import_batch', 'is', null);

    if (error) {
        console.error('Failed to load import batches:', error);
        state.importBatches = [];
        return;
    }

    state.importBatches = [...new Set(data.map(r => r.import_batch))].sort();
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
    if (f.search.trim()) {
        query = query.ilike('card_name', `%${f.search.trim()}%`);
    }

    const from = state.page * state.pageSize;
    const to = from + state.pageSize - 1;

    query = query
        .order('order_date', { ascending: false })
        .order('card_name', { ascending: true })
        .range(from, to);

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

    bar.innerHTML = `
        <select id="filter-source">
            <option value="all">All sources</option>
            <option value="ebay">eBay</option>
            <option value="tcgplayer">TCGPlayer</option>
        </select>

        <select id="filter-status">
            <option value="all">All statuses</option>
            <option value="pending" selected>Pending</option>
            <option value="approved">Approved</option>
            <option value="processed">Processed</option>
            <option value="skipped">Skipped</option>
        </select>

        <select id="filter-match-status">
            <option value="all">All match statuses</option>
            <option value="matched">Matched</option>
            <option value="ambiguous">Ambiguous</option>
            <option value="not_found">Not found</option>
        </select>

        <select id="filter-import-batch">
            <option value="all">All batches</option>
            ${state.importBatches.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('')}
        </select>

        <input type="search" id="filter-search" placeholder="Search card name..." />

        <select id="filter-page-size">
            ${PAGE_SIZES.map(s => `<option value="${s}" ${s === state.pageSize ? 'selected' : ''}>${s} per page</option>`).join('')}
        </select>
    `;

    // Restore current filter values
    bar.querySelector('#filter-source').value = state.filters.source;
    bar.querySelector('#filter-status').value = state.filters.status;
    bar.querySelector('#filter-match-status').value = state.filters.match_status;
    bar.querySelector('#filter-import-batch').value = state.filters.import_batch;
    bar.querySelector('#filter-search').value = state.filters.search;

    bar.querySelector('#filter-source').addEventListener('change', (e) => {
        state.filters.source = e.target.value;
        state.page = 0;
        loadAndRenderRows(container);
    });

    bar.querySelector('#filter-status').addEventListener('change', (e) => {
        state.filters.status = e.target.value;
        state.page = 0;
        loadAndRenderRows(container);
    });

    bar.querySelector('#filter-match-status').addEventListener('change', (e) => {
        state.filters.match_status = e.target.value;
        state.page = 0;
        loadAndRenderRows(container);
    });

    bar.querySelector('#filter-import-batch').addEventListener('change', (e) => {
        state.filters.import_batch = e.target.value;
        state.page = 0;
        loadAndRenderRows(container);
    });

    bar.querySelector('#filter-page-size').addEventListener('change', (e) => {
        state.pageSize = Number(e.target.value);
        state.page = 0;
        loadAndRenderRows(container);
    });

    bar.querySelector('#filter-search').addEventListener('input', debounce((e) => {
        state.filters.search = e.target.value;
        state.page = 0;
        loadAndRenderRows(container);
    }, 400));
}

// ----------------------------------------------------------------
// Table rendering
// ----------------------------------------------------------------

function renderTable(container) {
    const wrap = container.querySelector('#staging-table-wrap');

    if (state.rows.length === 0) {
        wrap.innerHTML = '<p>No staging rows match the current filters.</p>';
        return;
    }

    wrap.innerHTML = `
        <table>
            <thead>
                <tr>
                    <th style="width:24px;"></th>
                    <th>Card name</th>
                    <th>Set</th>
                    <th>Condition</th>
                    <th>Foil</th>
                    <th>Qty</th>
                    <th>Price</th>
                    <th>Match</th>
                    <th>Status</th>
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
}

function renderRow(container, row) {
    const tr = document.createElement('tr');
    tr.dataset.stagingId = row.staging_id;
    tr.style.cursor = 'pointer';

    const foil = [row.foil_pattern, row.foil_type].filter(Boolean).join(' / ') || '-';
    const matchBadge = `<span class="badge badge-${row.match_status || 'not_found'}">${row.match_status || 'not_found'}</span>`;

    tr.innerHTML = `
        <td>${state.expandedRowId === row.staging_id ? '&#9660;' : '&#9656;'}</td>
        <td>${escapeHtml(row.card_name || '')}</td>
        <td>${escapeHtml(row.set_name || row.matched_set_name || '-')}</td>
        <td>${escapeHtml(row.condition || '-')}</td>
        <td>${escapeHtml(foil)}</td>
        <td>${row.quantity ?? '-'}</td>
        <td>${formatPrice(row.cost_per_card)}</td>
        <td>${matchBadge}</td>
        <td>${escapeHtml(row.status || '-')}</td>
    `;

    tr.addEventListener('click', () => {
        state.expandedRowId = state.expandedRowId === row.staging_id ? null : row.staging_id;
        renderTable(container);
    });

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

    td.innerHTML = `
        <div class="expanded-row" data-staging-id="${row.staging_id}">
            <div style="display:flex; gap:16px; flex-wrap:wrap; margin-bottom:12px;">
                <label>Condition
                    <select class="edit-condition">
                        ${['Near Mint','Lightly Played','Moderately Played','Heavily Played','Damaged']
                            .map(c => `<option value="${c}" ${c === row.condition ? 'selected' : ''}>${c}</option>`)
                            .join('')}
                    </select>
                </label>
                <label>Quantity
                    <input type="number" class="edit-quantity" value="${row.quantity ?? 1}" min="1" style="width:70px;" />
                </label>
                <label>Foil type
                    <input type="text" class="edit-foil-type" value="${escapeHtml(row.foil_type || '')}" style="width:120px;" />
                </label>
                <label>Foil pattern
                    <input type="text" class="edit-foil-pattern" value="${escapeHtml(row.foil_pattern || '')}" style="width:140px;" />
                </label>
                <label>Override price
                    <input type="number" step="0.01" class="edit-override-price" value="${row.override_price ?? ''}" style="width:90px;" />
                </label>
            </div>
            <div style="margin-bottom:12px;">
                <label style="display:block;">Notes
                    <input type="text" class="edit-notes" value="${escapeHtml(row.notes || '')}" style="width:100%;max-width:500px;" />
                </label>
            </div>

            <div class="match-resolution"></div>

            <div style="display:flex; gap:8px; margin-top:12px;">
                <button class="btn save-btn">Save changes</button>
                <button class="btn btn-primary push-btn" ${row.match_status !== 'matched' ? 'disabled' : ''}>
                    Push to inventory
                </button>
                <button class="btn skip-btn">Skip</button>
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
    }

    // Save changes
    td.querySelector('.save-btn').addEventListener('click', () => saveRowChanges(container, td, row));

    // Push to inventory
    td.querySelector('.push-btn').addEventListener('click', () => pushRowToInventory(container, td, row));

    // Skip
    td.querySelector('.skip-btn').addEventListener('click', () => skipRow(container, td, row));

    return tr;
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

        if (data.length === 0) {
            results.innerHTML = '<p style="color:var(--text-secondary)">No matches found.</p>';
            return;
        }

        results.innerHTML = data.map(c => `
            <div class="search-result-item" data-card-id="${c.card_id}" data-variant-id="${c.variant_id}"
                 style="padding:6px; border:1px solid var(--border); border-radius:4px; margin-bottom:4px; cursor:pointer;">
                ${escapeHtml(c.card_name)} — ${escapeHtml(c.set_name)} #${escapeHtml(c.display_number || '')}
                <span style="color:var(--text-secondary);">(${escapeHtml(c.variant_type || 'Non-Holo')}, ${escapeHtml(c.rarity || '')})</span>
            </div>
        `).join('');

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
// Actions: save, resolve, push, skip
// ----------------------------------------------------------------

async function saveRowChanges(container, td, row) {
    const updates = {
        condition: td.querySelector('.edit-condition').value,
        quantity: Number(td.querySelector('.edit-quantity').value) || 1,
        foil_type: td.querySelector('.edit-foil-type').value || null,
        foil_pattern: td.querySelector('.edit-foil-pattern').value || null,
        notes: td.querySelector('.edit-notes').value || null,
        updated_at: new Date().toISOString(),
    };

    const overridePriceRaw = td.querySelector('.edit-override-price').value;
    updates.override_price = overridePriceRaw === '' ? null : Number(overridePriceRaw);

    const { error } = await supabase
        .from('staging')
        .update(updates)
        .eq('id', row.staging_id);

    if (error) {
        showRowMessage(td, 'Save failed: ' + error.message, 'danger');
        return;
    }

    showRowMessage(td, 'Saved.', 'success');

    // Reflect changes in local state row so re-render shows updated values
    Object.assign(row, {
        condition: updates.condition,
        quantity: updates.quantity,
        foil_type: updates.foil_type,
        foil_pattern: updates.foil_pattern,
        notes: updates.notes,
        override_price: updates.override_price,
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

async function pushRowToInventory(container, td, row) {
    const btn = td.querySelector('.push-btn');
    btn.disabled = true;
    btn.textContent = 'Pushing...';

    const { data, error } = await supabase.rpc('push_staging_row_to_inventory', {
        p_staging_id: row.staging_id,
    });

    if (error) {
        showRowMessage(td, 'Push failed: ' + error.message, 'danger');
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
                    <input type="text" class="modal-card-number" placeholder="e.g. 045/198" style="width:100%;" />
                </label>
                <label>Rarity
                    <input type="text" class="modal-rarity" style="width:100%;" />
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

        if (error || !data || data.length === 0) {
            dedupArea.innerHTML = '';
            return;
        }

        dedupArea.innerHTML = `
            <p style="color:var(--warning); font-size:13px;">Possible existing matches — verify this isn't a duplicate:</p>
            ${data.map(c => `
                <div style="padding:4px; font-size:12px; color:var(--text-secondary);">
                    ${escapeHtml(c.card_name)} — ${escapeHtml(c.set_name)} #${escapeHtml(c.display_number || '')}
                    (${escapeHtml(c.variant_type || 'Non-Holo')})
                </div>
            `).join('')}
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

        if (!cardName || !setName || !cardNumber) {
            msgArea.innerHTML = `<span style="color:var(--danger)">Card name, set name, and card number are required.</span>`;
            return;
        }

        // Find or create the set
        let { data: setRow, error: setErr } = await supabase
            .from('card_sets')
            .select('id')
            .ilike('name', setName)
            .maybeSingle();

        if (setErr) {
            msgArea.innerHTML = `<span style="color:var(--danger)">Set lookup failed: ${setErr.message}</span>`;
            return;
        }

        if (!setRow) {
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
            })
            .select('id')
            .single();

        if (createErr) {
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

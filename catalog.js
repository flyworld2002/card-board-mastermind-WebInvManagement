// catalog.js
// Workflow > Catalog — browse card_master, expand a card to view/edit its
// card_variants rows (the seven-axis variant system: foil_type, foil_pattern,
// texture, material, size, stamp_type, source_type).
//
// NOTE: card_variants columns below are confirmed against the live
// get_or_create_variant() Postgres function seen in this project's session
// history. card_master columns (rarity, image_url, external_id) are taken
// from schema.sql, which has been stale before — verify against your live
// schema if anything here errors on load.

import { supabase, debounce, loadAxisOptions, AXIS_OPTIONS } from './shared.js';

// AXIS_OPTIONS now comes from shared.js (loaded once via loadAxisOptions()
// at page mount below) rather than a local copy, so Staging Review,
// Inventory, and Catalog all read from one implementation instead of
// three that could drift apart.

const PAGE_SIZE = 50;

// Columns sortable via the clickable headers in renderTable(). 'set' is a
// special case -- card_sets is an embedded/joined resource in the select(),
// so sorting by its name needs supabase-js's { foreignTable } option
// rather than a plain column name.
function applySort(query, sort) {
    if (sort.column === 'set') {
        return query.order('name', { ascending: sort.ascending, foreignTable: 'card_sets' });
    }
    return query.order(sort.column, { ascending: sort.ascending, nullsFirst: false });
}

function catalogSortTh(label, column, style = '') {
    const isActive = state.sort.column === column;
    const arrow = isActive ? (state.sort.ascending ? ' ▲' : ' ▼') : '';
    return `<th class="catalog-sortable-th" data-sort-column="${column}" style="${style} cursor:pointer; user-select:none;" title="Sort by ${escapeHTML(label)}">${escapeHTML(label)}${arrow}</th>`;
}

let state = {
    rows: [],
    sets: [],
    search: '',
    setFilter: '',
    page: 0,
    hasMore: true,
    expandedCardId: null,
    variantsByCard: {},   // card_id -> array of card_variants rows
    sort: { column: 'name', ascending: true },
};

export async function renderCatalog(container) {
    state = { rows: [], sets: [], search: '', setFilter: '', page: 0, hasMore: true, expandedCardId: null, variantsByCard: {}, sort: { column: 'name', ascending: true } };
    container.innerHTML = shellHTML();
    await loadAxisOptions();
    await loadSetsFilter(container);
    wireControls(container);
    await loadPage(container, { reset: true });
}

function shellHTML() {
    return `
        <h2 style="margin:0 0 16px;">Catalog</h2>
        <div class="filters-bar">
            <input type="search" id="catalog-search" placeholder="Search by name or card number..." style="min-width:200px; flex:1;" />
            <select id="catalog-set-filter">
                <option value="">All sets</option>
            </select>
        </div>
        <div id="catalog-table-wrap"><p>Loading...</p></div>
        <div id="catalog-load-more-wrap" style="text-align:center; margin-top:16px;"></div>
        <style>
            /* ── Mobile: collapse the catalog table into stacked cards ── */
            @media (max-width: 700px) {
                #catalog-table-wrap table.catalog-main-table thead { display: none; }
                #catalog-table-wrap table.catalog-main-table,
                #catalog-table-wrap table.catalog-main-table tbody,
                #catalog-table-wrap table.catalog-main-table tr,
                #catalog-table-wrap table.catalog-main-table td {
                    display: block;
                    width: 100%;
                }
                #catalog-table-wrap table.catalog-main-table tr[data-card-row] {
                    border: 1px solid var(--border);
                    border-radius: 8px;
                    margin-bottom: 8px;
                    padding: 10px 12px;
                }
                #catalog-table-wrap table.catalog-main-table tr[data-card-row] td {
                    border-bottom: none;
                    padding: 2px 0;
                }
                #catalog-table-wrap table.catalog-main-table td[data-label]:before {
                    content: attr(data-label) ": ";
                    color: var(--text-secondary);
                    font-size: 11px;
                }
                #catalog-table-wrap table.catalog-main-table td.catalog-thumb-cell { float: right; margin-top: -34px; }
                #catalog-table-wrap table.catalog-main-table td.catalog-expand-cell {
                    position: absolute; top: 8px; right: 12px; border: none; padding: 0;
                }
                #catalog-table-wrap table.catalog-main-table tr[data-card-row] { position: relative; }
                .variant-row td { display: block; width: 100%; }
            }

            /* ── Variant editor: flex-wrap fields instead of a rigid table ── */
            .variant-card {
                display: flex;
                flex-wrap: wrap;
                gap: 10px;
                align-items: flex-end;
                border: 1px solid var(--border);
                border-radius: 8px;
                padding: 10px;
                margin-bottom: 8px;
            }
            .variant-field { display: flex; flex-direction: column; gap: 3px; min-width: 110px; flex: 1 1 110px; }
            .variant-field label { font-size: 11px; color: var(--text-secondary); }
            .variant-actions { display: flex; gap: 4px; align-items: flex-end; }
        </style>
    `;
}

async function loadSetsFilter(container) {
    const { data, error } = await supabase.from('card_sets').select('id, name').order('name');
    if (error) {
        console.error(error);
        return;
    }
    state.sets = data || [];
    const sel = container.querySelector('#catalog-set-filter');
    sel.innerHTML = `<option value="">All sets</option>` +
        state.sets.map(s => `<option value="${s.id}">${escapeHTML(s.name)}</option>`).join('');
}

function wireControls(container) {
    container.querySelector('#catalog-search').addEventListener('input', debounce((e) => {
        state.search = e.target.value.trim();
        loadPage(container, { reset: true });
    }, 250));

    container.querySelector('#catalog-set-filter').addEventListener('change', (e) => {
        state.setFilter = e.target.value;
        // Browsing one set reads better in card-number order than
        // alphabetically -- but only switch if the sort is still at its
        // untouched default, so a manually-chosen sort isn't overridden.
        const isDefaultSort = state.sort.column === 'name' && state.sort.ascending === true;
        if (state.setFilter && isDefaultSort) {
            state.sort = { column: 'card_number_numeric', ascending: true };
        } else if (!state.setFilter && state.sort.column === 'card_number_numeric' && state.sort.ascending === true) {
            state.sort = { column: 'name', ascending: true };
        }
        loadPage(container, { reset: true });
    });
}

async function loadPage(container, { reset = false } = {}) {
    const wrap = container.querySelector('#catalog-table-wrap');
    const moreWrap = container.querySelector('#catalog-load-more-wrap');
    if (reset) {
        state.page = 0;
        state.rows = [];
        state.expandedCardId = null;
        wrap.innerHTML = '<p>Loading...</p>';
    }

    try {
        let query = supabase
            .from('card_master')
            .select('id, name, card_number, card_number_numeric, rarity, image_url, external_id, set_id, card_sets(name)')
            .range(state.page * PAGE_SIZE, state.page * PAGE_SIZE + PAGE_SIZE - 1);

        query = applySort(query, state.sort);

        if (state.search) {
            query = query.or(`name.ilike.%${state.search}%,card_number.ilike.%${state.search}%`);
        }
        if (state.setFilter) {
            query = query.eq('set_id', state.setFilter);
        }

        const { data, error } = await query;
        if (error) throw error;

        state.rows = reset ? (data || []) : state.rows.concat(data || []);
        state.hasMore = (data || []).length === PAGE_SIZE;

        renderTable(container);

        moreWrap.innerHTML = state.hasMore
            ? `<button class="btn" id="catalog-load-more">Load more</button>`
            : (state.rows.length ? `<span style="color:var(--text-secondary); font-size:12px;">All results loaded (${state.rows.length})</span>` : '');

        if (state.hasMore) {
            moreWrap.querySelector('#catalog-load-more').addEventListener('click', () => {
                state.page += 1;
                loadPage(container, { reset: false });
            });
        }
    } catch (err) {
        console.error(err);
        wrap.innerHTML = `<p style="color:var(--danger)">Failed to load catalog: ${err.message}</p>`;
    }
}

function renderTable(container) {
    const wrap = container.querySelector('#catalog-table-wrap');

    if (!state.rows.length) {
        wrap.innerHTML = `<p style="color:var(--text-secondary)">No cards found.</p>`;
        return;
    }

    wrap.innerHTML = `
        <table class="catalog-main-table">
            <thead>
                <tr>
                    <th style="width:40px;"></th>
                    ${catalogSortTh('Name', 'name')}
                    ${catalogSortTh('#', 'card_number_numeric')}
                    ${catalogSortTh('Set', 'set')}
                    ${catalogSortTh('Rarity', 'rarity')}
                    <th>External ID</th>
                    <th style="width:40px;"></th>
                </tr>
            </thead>
            <tbody>
                ${state.rows.map(r => `
                    <tr data-card-row="${r.id}">
                        <td class="catalog-thumb-cell">${r.image_url ? `<img src="${escapeAttr(r.image_url)}" style="width:28px; border-radius:2px;" />` : ''}</td>
                        <td data-label="Name">${escapeHTML(r.name)}</td>
                        <td data-label="#">${escapeHTML(r.card_number)}</td>
                        <td data-label="Set" style="color:var(--text-secondary);">${escapeHTML(r.card_sets?.name || '-')}</td>
                        <td data-label="Rarity" style="color:var(--text-secondary);">${escapeHTML(r.rarity || '-')}</td>
                        <td data-label="External ID" style="font-family:monospace; font-size:11px; color:var(--text-secondary);">${escapeHTML(r.external_id || '-')}</td>
                        <td class="catalog-expand-cell"><button class="btn expand-card-btn" data-id="${r.id}">${state.expandedCardId === r.id ? '▾' : '▸'}</button></td>
                    </tr>
                    <tr class="variant-row" data-variant-row-for="${r.id}" style="${state.expandedCardId === r.id ? '' : 'display:none;'}">
                        <td colspan="7" style="background:var(--bg-tertiary);">
                            <div id="variants-wrap-${r.id}" style="padding:12px;"><p style="color:var(--text-secondary);">Loading variants...</p></div>
                        </td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;

    wrap.querySelectorAll('.catalog-sortable-th').forEach(th => {
        th.addEventListener('click', () => {
            const column = th.dataset.sortColumn;
            if (state.sort.column === column) {
                state.sort.ascending = !state.sort.ascending;
            } else {
                state.sort = { column, ascending: true };
            }
            loadPage(container, { reset: true });
        });
    });

    wrap.querySelectorAll('.expand-card-btn').forEach(btn => {
        btn.addEventListener('click', () => toggleExpand(container, btn.dataset.id));
    });

    // Re-open whichever row was expanded before a reload (e.g. after saving a variant edit)
    if (state.expandedCardId && state.variantsByCard[state.expandedCardId]) {
        renderVariants(container, state.expandedCardId);
    }
}

async function toggleExpand(container, cardId) {
    const isOpen = state.expandedCardId === cardId;
    state.expandedCardId = isOpen ? null : cardId;

    container.querySelectorAll('.variant-row').forEach(row => {
        row.style.display = row.dataset.variantRowFor === state.expandedCardId ? '' : 'none';
    });
    container.querySelectorAll('.expand-card-btn').forEach(btn => {
        btn.textContent = btn.dataset.id === state.expandedCardId ? '▾' : '▸';
    });

    if (!isOpen) {
        await loadVariants(container, cardId);
    }
}

async function loadVariants(container, cardId) {
    try {
        const { data, error } = await supabase
            .from('card_variants')
            .select('id, card_id, foil_type, foil_pattern, texture, material, size, stamp_type, source_type, created_at')
            .eq('card_id', cardId)
            .order('created_at');
        if (error) throw error;
        state.variantsByCard[cardId] = data || [];
        renderVariants(container, cardId);
    } catch (err) {
        console.error(err);
        const wrap = container.querySelector(`#variants-wrap-${cardId}`);
        if (wrap) wrap.innerHTML = `<p style="color:var(--danger)">Failed to load variants: ${err.message}</p>`;
    }
}

function renderVariants(container, cardId) {
    const wrap = container.querySelector(`#variants-wrap-${cardId}`);
    if (!wrap) return;
    const variants = state.variantsByCard[cardId] || [];

    wrap.innerHTML = `
        ${variants.length
            ? variants.map(v => variantCardHTML(v)).join('')
            : `<p style="color:var(--text-secondary); margin-bottom:10px;">No variants yet for this card.</p>`}
        <button class="btn" id="add-variant-btn-${cardId}">+ Add variant</button>
        <div id="new-variant-form-${cardId}"></div>
    `;

    variants.forEach(v => wireVariantRow(container, cardId, v.id));

    wrap.querySelector(`#add-variant-btn-${cardId}`).addEventListener('click', () => {
        showNewVariantForm(container, cardId);
    });
}

function variantCardHTML(v) {
    return `
        <div class="variant-card" data-variant-id="${v.id}">
            ${axisField('foil_type', 'Foil type', AXIS_OPTIONS.foil_type, v.foil_type)}
            ${axisField('foil_pattern', 'Foil pattern', AXIS_OPTIONS.foil_pattern, v.foil_pattern)}
            ${axisField('texture', 'Texture', AXIS_OPTIONS.texture, v.texture)}
            ${axisField('material', 'Material', AXIS_OPTIONS.material, v.material)}
            ${axisField('size', 'Size', AXIS_OPTIONS.size, v.size)}
            ${axisField('stamp_type', 'Stamp', AXIS_OPTIONS.stamp_type, v.stamp_type)}
            ${axisField('source_type', 'Source', AXIS_OPTIONS.source_type, v.source_type)}
            <div class="variant-actions">
                <button class="btn save-variant-btn" data-id="${v.id}" style="padding:6px 10px;">Save</button>
                <button class="btn delete-variant-btn" data-id="${v.id}" title="Delete variant"
                        style="padding:6px 9px; color:var(--danger); border-color:var(--danger); font-size:14px; line-height:1;">🗑</button>
            </div>
        </div>
    `;
}

function axisField(name, label, options, current) {
    return `
        <div class="variant-field">
            <label>${label}</label>
            ${axisSelect(name, options, current)}
        </div>
    `;
}

function axisSelect(name, options, current) {
    return `
        <select data-axis="${name}" style="font-size:12px;">
            <option value="">-</option>
            ${options.map(([code, label]) => `<option value="${code}" ${current === code ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
    `;
}

function wireVariantRow(container, cardId, variantId) {
    const row = container.querySelector(`.variant-card[data-variant-id="${variantId}"]`);
    if (!row) return;
    row.querySelector('.save-variant-btn').addEventListener('click', async () => {
        const payload = {};
        row.querySelectorAll('select[data-axis]').forEach(sel => {
            payload[sel.dataset.axis] = sel.value || null;
        });
        try {
            const { error } = await supabase.from('card_variants').update(payload).eq('id', variantId);
            if (error) throw error;
            await loadVariants(container, cardId);
        } catch (err) {
            console.error(err);
            window.alert(`Failed to save variant: ${err.message}`);
        }
    });

    row.querySelector('.delete-variant-btn').addEventListener('click', async () => {
        if (!window.confirm('Delete this variant? This can\'t be undone, and will fail if inventory or listings still reference it.')) return;
        try {
            const { error } = await supabase.from('card_variants').delete().eq('id', variantId);
            if (error) throw error;
            await loadVariants(container, cardId);
        } catch (err) {
            console.error(err);
            const isFkViolation = (err.code === '23503') || /foreign key/i.test(err.message || '');
            window.alert(isFkViolation
                ? 'Can\'t delete this variant — it still has inventory or platform listings referencing it. Remove those first.'
                : `Failed to delete variant: ${err.message}`);
        }
    });
}

function showNewVariantForm(container, cardId) {
    const formWrap = container.querySelector(`#new-variant-form-${cardId}`);
    formWrap.innerHTML = `
        <div class="variant-card">
            ${axisField('foil_type', 'Foil type', AXIS_OPTIONS.foil_type, '')}
            ${axisField('foil_pattern', 'Foil pattern', AXIS_OPTIONS.foil_pattern, '')}
            ${axisField('texture', 'Texture', AXIS_OPTIONS.texture, '')}
            ${axisField('material', 'Material', AXIS_OPTIONS.material, '')}
            ${axisField('size', 'Size', AXIS_OPTIONS.size, '')}
            ${axisField('stamp_type', 'Stamp', AXIS_OPTIONS.stamp_type, '')}
            ${axisField('source_type', 'Source', AXIS_OPTIONS.source_type, '')}
            <div class="variant-actions">
                <button class="btn btn-primary" id="create-variant-btn-${cardId}" style="padding:6px 10px;">Create</button>
                <button class="btn" id="cancel-variant-btn-${cardId}" style="padding:6px 10px;">Cancel</button>
            </div>
        </div>
        <div id="new-variant-error-${cardId}" style="color:var(--danger); font-size:12px; margin-top:4px;"></div>
    `;

    formWrap.querySelector(`#cancel-variant-btn-${cardId}`).addEventListener('click', () => {
        formWrap.innerHTML = '';
    });

    formWrap.querySelector(`#create-variant-btn-${cardId}`).addEventListener('click', async () => {
        const errBox = formWrap.querySelector(`#new-variant-error-${cardId}`);
        errBox.textContent = '';
        const payload = { card_id: cardId };
        formWrap.querySelectorAll('select[data-axis]').forEach(sel => {
            payload[sel.dataset.axis] = sel.value || null;
        });
        try {
            const { error } = await supabase.from('card_variants').insert(payload);
            if (error) throw error;
            formWrap.innerHTML = '';
            await loadVariants(container, cardId);
        } catch (err) {
            console.error(err);
            const isDupe = (err.code === '23505') || /duplicate|unique/i.test(err.message || '');
            errBox.textContent = isDupe
                ? 'A variant with this exact combination already exists for this card.'
                : (err.message || 'Failed to create variant.');
        }
    });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function escapeHTML(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function escapeAttr(str) {
    return escapeHTML(str);
}

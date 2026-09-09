// sold-out.js
// Sold Out tab — cards showing quantity_listed = 0 on their live listing
// AND zero inventory available anywhere (v_restock_candidates' mirror
// image). A purchasing/reorder signal: what to buy more of, not what to
// push. Each row carries its most recent sale (any platform/listing,
// since inventory is shared across listings) straight from the sales
// table via v_sold_out — see sql/v_sold_out.sql.

import { supabase } from './shared.js';

function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

// Same 40x56 thumbnail + lazy-load + broken-image-fallback convention as
// listing-pricing.js's imgHtml() and issues.js's inline thumb markup.
function imgHtml(url) {
    if (!url) return `<div style="width:40px; height:56px; background:var(--bg-tertiary); border-radius:3px; border:1px solid var(--border);"></div>`;
    return `<img src="${escapeHtml(url)}" alt="" loading="lazy"
                style="width:40px; height:56px; object-fit:cover; border-radius:3px; border:1px solid var(--border);"
                onerror="this.replaceWith(Object.assign(document.createElement('div'),
                    {style:'width:40px;height:56px;background:var(--bg-tertiary);border-radius:3px;border:1px solid var(--border);'}))">`;
}

function timeAgo(iso) {
    if (!iso) return '';
    const diffMs = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 60) return `${Math.max(mins, 0)} min ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
    const years = Math.floor(months / 12);
    return `${years} year${years === 1 ? '' : 's'} ago`;
}

const PAGE_SIZES = [25, 50, 100, 200];

let state = {
    rows: [],
    page: 0,
    pageSize: 50,
    sets: [],        // full card_sets catalog (id, name, series) — Set/Era filters are
                      // data-driven from this, not from whatever's currently sold out,
                      // same convention as catalog.js's loadSetsFilter().
    filter: '',
    setFilter: '',    // set_id, or '' for all
    eraFilter: '',    // card_sets.series ("Era" in the UI), or '' for all
    rarityFilters: new Set(), // rarity strings; empty Set = all rarities
    // Default sort per Fei's spec: most recently sold first.
    sort: { key: 'last_sold_at', dir: 'desc' },
};

const distinctVals = (key) =>
    [...new Set(state.rows.map(r => r[key]).filter(Boolean))].sort();

const SORT_COLUMNS = [
    ['card_name', 'Card'],
    ['template_name', 'Listing'],
    ['last_sold_price', 'Last sold price'],
    ['last_sold_at', 'Last sold'],
];

function sortRows(rows) {
    const { key, dir } = state.sort;
    const mul = dir === 'asc' ? 1 : -1;
    const sorted = [...rows];
    sorted.sort((a, b) => {
        let av = a[key];
        let bv = b[key];
        if (key === 'last_sold_at') {
            av = av ? new Date(av).getTime() : -Infinity;
            bv = bv ? new Date(bv).getTime() : -Infinity;
        } else if (key === 'last_sold_price') {
            av = av == null ? -Infinity : Number(av);
            bv = bv == null ? -Infinity : Number(bv);
        } else {
            av = (av ?? '').toString().toLowerCase();
            bv = (bv ?? '').toString().toLowerCase();
        }
        if (av < bv) return -1 * mul;
        if (av > bv) return 1 * mul;
        return 0;
    });
    return sorted;
}

function filteredRows() {
    const q = state.filter.trim().toLowerCase();
    return state.rows.filter(r => {
        if (state.setFilter && r.set_id !== state.setFilter) return false;
        if (state.eraFilter && r.series !== state.eraFilter) return false;
        if (state.rarityFilters.size > 0 && !state.rarityFilters.has(r.rarity)) return false;
        if (q && !`${r.card_name} ${r.card_number ?? ''} ${r.template_name ?? ''} ${r.listing_id ?? ''}`
                .toLowerCase().includes(q)) return false;
        return true;
    });
}

// Multi-select checkbox dropdown for Rarity. Uses a native <details> so
// open/closed state lives in the DOM itself (no JS state, no document-level
// click listener to leak across page navigations) -- checkbox changes only
// patch the summary label and re-render the table, never the filter bar
// itself, so the <details> element's own open state is never disturbed.
function rarityFilterHtml() {
    const rarities = distinctVals('rarity');
    const label = state.rarityFilters.size > 0 ? `Rarity (${state.rarityFilters.size})` : 'Rarity (all)';
    return `
        <details id="so-rarity-details" style="display:inline-block; position:relative; font-size:12px;">
            <summary class="btn" id="so-rarity-summary" style="display:inline-block; cursor:pointer;">${label}</summary>
            <div style="position:absolute; top:calc(100% + 4px); left:0; z-index:20; background:var(--bg-secondary);
                        border:1px solid var(--border); border-radius:6px; padding:8px; min-width:210px;
                        max-height:300px; overflow-y:auto; box-shadow:0 8px 24px rgba(0,0,0,0.3);">
                <div style="display:flex; gap:6px; margin-bottom:6px;">
                    <input type="text" id="so-rarity-search" placeholder="Search..." autocomplete="off"
                           style="flex:1; padding:3px 6px; font-size:12px;" />
                    <button type="button" class="btn" id="so-rarity-clear" style="padding:2px 8px; font-size:11px; flex-shrink:0;">Clear</button>
                </div>
                ${rarities.map(r => `
                    <label class="so-rarity-row" data-search="${escapeHtml(r.toLowerCase())}"
                           style="display:flex; align-items:center; gap:6px; font-size:13px; padding:3px 0; cursor:pointer; color:var(--text);">
                        <input type="checkbox" class="so-rarity-check" value="${escapeHtml(r)}" ${state.rarityFilters.has(r) ? 'checked' : ''} />
                        ${escapeHtml(r)}
                    </label>
                `).join('')}
            </div>
        </details>
    `;
}

export async function renderSoldOut(container) {
    container.innerHTML = `
        <h2 style="margin:0 0 4px;">Sold Out</h2>
        <p style="color:var(--text-secondary); font-size:13px; margin:0 0 16px;">
            Zero copies left anywhere, zero listed live. Last-sold price and date for each —
            a reorder view, not a push worklist (that's Listing pricing's restock badge).
        </p>
        <div id="so-filters"></div>
        <div id="so-table-wrap"><p>Loading...</p></div>
        <div class="pagination" id="so-pagination"></div>
    `;

    const [soldOutRes, setsRes] = await Promise.all([
        supabase.from('v_sold_out').select('*'),
        supabase.from('card_sets').select('id, name, series').order('name'),
    ]);

    if (soldOutRes.error) {
        container.querySelector('#so-table-wrap').innerHTML =
            `<p style="color:var(--danger)">Failed to load sold-out cards: ${escapeHtml(soldOutRes.error.message)}</p>`;
        return;
    }
    state.rows = soldOutRes.data || [];
    state.sets = setsRes.data || [];
    renderFilters(container);
    renderTable(container);
}

function renderFilters(container) {
    const bar = container.querySelector('#so-filters');
    bar.innerHTML = `
        <div class="filters-bar">
            <input type="text" id="so-filter" placeholder="Filter by card or listing..."
                   value="${escapeHtml(state.filter)}" style="min-width:220px;" />
            <label style="font-size:12px; color:var(--text-secondary);">Era
                <select id="so-filter-era" style="margin-left:4px;">
                    <option value="">(all)</option>
                    ${[...new Set(state.sets.map(s => s.series).filter(Boolean))].sort().map(era =>
                        `<option value="${escapeHtml(era)}" ${state.eraFilter === era ? 'selected' : ''}>${escapeHtml(era)}</option>`
                    ).join('')}
                </select>
            </label>
            <label style="font-size:12px; color:var(--text-secondary);">Set
                <select id="so-filter-set" style="margin-left:4px;">
                    <option value="">(all)</option>
                    ${state.sets.map(s => `<option value="${s.id}" ${state.setFilter === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
                </select>
            </label>
            ${rarityFilterHtml()}
            <select id="so-page-size" style="margin-left:auto;">
                ${PAGE_SIZES.map(s =>
                    `<option value="${s}" ${s === state.pageSize ? 'selected' : ''}>${s} per page</option>`
                ).join('')}
            </select>
        </div>
    `;

    bar.querySelector('#so-filter').addEventListener('input', (e) => {
        state.filter = e.target.value;
        state.page = 0;
        renderTable(container);
    });
    bar.querySelector('#so-filter-era').addEventListener('change', (e) => {
        state.eraFilter = e.target.value;
        state.page = 0;
        renderTable(container);
    });
    bar.querySelector('#so-filter-set').addEventListener('change', (e) => {
        state.setFilter = e.target.value;
        state.page = 0;
        renderTable(container);
    });
    bar.querySelector('#so-page-size').addEventListener('change', (e) => {
        state.pageSize = Number(e.target.value);
        state.page = 0;
        renderTable(container);
    });

    const updateRaritySummary = () => {
        const summary = bar.querySelector('#so-rarity-summary');
        if (summary) summary.textContent = state.rarityFilters.size > 0 ? `Rarity (${state.rarityFilters.size})` : 'Rarity (all)';
    };

    bar.querySelectorAll('.so-rarity-check').forEach(cb => {
        cb.addEventListener('change', (e) => {
            if (e.target.checked) state.rarityFilters.add(e.target.value);
            else state.rarityFilters.delete(e.target.value);
            updateRaritySummary();
            state.page = 0;
            renderTable(container);
        });
    });
    bar.querySelector('#so-rarity-clear').addEventListener('click', () => {
        state.rarityFilters.clear();
        bar.querySelectorAll('.so-rarity-check').forEach(cb => { cb.checked = false; });
        updateRaritySummary();
        state.page = 0;
        renderTable(container);
    });

    // Narrows the checkbox list in place -- only hides non-matching rows,
    // never touches their checked state, so searching doesn't lose a
    // selection that scrolls out of view.
    bar.querySelector('#so-rarity-search').addEventListener('input', (e) => {
        const q = e.target.value.trim().toLowerCase();
        bar.querySelectorAll('.so-rarity-row').forEach(row => {
            row.style.display = row.dataset.search.includes(q) ? 'flex' : 'none';
        });
    });
}

function renderTable(container) {
    const wrap = container.querySelector('#so-table-wrap');
    const allRows = sortRows(filteredRows());
    const totalPages = Math.max(1, Math.ceil(allRows.length / state.pageSize));
    if (state.page >= totalPages) state.page = totalPages - 1; // e.g. a filter shrank the result set past the current page
    const rows = allRows.slice(state.page * state.pageSize, state.page * state.pageSize + state.pageSize);

    const sortArrow = (key) => state.sort.key !== key ? ''
        : (state.sort.dir === 'asc' ? ' &#9650;' : ' &#9660;');

    wrap.innerHTML = rows.length ? `
        <table>
            <thead><tr>
                <th>Picture</th>
                ${SORT_COLUMNS.map(([key, label]) => `
                    <th class="so-sort-th" data-key="${key}" style="cursor:pointer; user-select:none;">${label}${sortArrow(key)}</th>
                `).join('')}
            </tr></thead>
            <tbody>
                ${rows.map(r => `
                    <tr>
                        <td>${imgHtml(r.image_url)}</td>
                        <td>${escapeHtml(r.card_number ? `${r.card_number} ${r.card_name}` : r.card_name)}</td>
                        <td>${escapeHtml(r.template_name || '')}</td>
                        <td style="font-variant-numeric:tabular-nums; font-weight:600;">
                            ${r.last_sold_price != null ? `$${Number(r.last_sold_price).toFixed(2)}` : '<span style="color:var(--text-secondary);">—</span>'}
                        </td>
                        <td style="color:var(--text-secondary); font-size:12px;">
                            ${r.last_sold_at ? escapeHtml(timeAgo(r.last_sold_at)) : '<span>no sale on record</span>'}
                        </td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    ` : `<p style="color:var(--text-secondary)">${state.rows.length ? 'No sold-out cards match this filter.' : 'Nothing sold out right now.'}</p>`;

    wrap.querySelectorAll('.so-sort-th').forEach(th => {
        th.addEventListener('click', () => {
            const key = th.dataset.key;
            if (state.sort.key === key) {
                state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
            } else {
                // Price/date default to descending (highest/most-recent first);
                // text columns default to ascending (A-Z) — matches how each
                // column is actually read.
                state.sort = { key, dir: (key === 'last_sold_price' || key === 'last_sold_at') ? 'desc' : 'asc' };
            }
            renderTable(container);
        });
    });

    renderPagination(container, allRows.length, totalPages);
}

// Same Previous/Next + "Page X of Y (N rows)" + per-page selector pattern
// as inventory.js's renderPagination()/PAGE_SIZES.
function renderPagination(container, totalCount, totalPages) {
    const el = container.querySelector('#so-pagination');
    const currentPage = state.page + 1;

    el.innerHTML = totalCount > state.pageSize ? `
        <button class="btn" id="so-prev" ${state.page === 0 ? 'disabled' : ''}>Previous</button>
        <span>Page ${currentPage} of ${totalPages} (${totalCount.toLocaleString()} rows)</span>
        <button class="btn" id="so-next" ${currentPage >= totalPages ? 'disabled' : ''}>Next</button>
    ` : '';

    el.querySelector('#so-prev')?.addEventListener('click', () => {
        if (state.page > 0) { state.page -= 1; renderTable(container); }
    });
    el.querySelector('#so-next')?.addEventListener('click', () => {
        state.page += 1; renderTable(container);
    });
}

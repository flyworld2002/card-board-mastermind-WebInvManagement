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

let state = {
    rows: [],
    sets: [],        // full card_sets catalog (id, name) — Set filter is data-driven
                      // from this, not from whatever's currently sold out, same
                      // convention as catalog.js's loadSetsFilter().
    filter: '',
    setFilter: '',    // set_id, or '' for all
    rarityFilter: '',
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
        if (state.rarityFilter && r.rarity !== state.rarityFilter) return false;
        if (q && !`${r.card_name} ${r.card_number ?? ''} ${r.template_name ?? ''} ${r.listing_id ?? ''}`
                .toLowerCase().includes(q)) return false;
        return true;
    });
}

function filterSelect(id, label, current, options) {
    return `
        <label style="font-size:12px; color:var(--text-secondary);">${label}
            <select id="${id}" style="margin-left:4px;">
                <option value="">(all)</option>
                ${options.map(o => `<option value="${escapeHtml(o)}" ${current === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}
            </select>
        </label>
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
    `;

    const [soldOutRes, setsRes] = await Promise.all([
        supabase.from('v_sold_out').select('*'),
        supabase.from('card_sets').select('id, name').order('name'),
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
            <label style="font-size:12px; color:var(--text-secondary);">Set
                <select id="so-filter-set" style="margin-left:4px;">
                    <option value="">(all)</option>
                    ${state.sets.map(s => `<option value="${s.id}" ${state.setFilter === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
                </select>
            </label>
            ${filterSelect('so-filter-rarity', 'Rarity', state.rarityFilter, distinctVals('rarity'))}
        </div>
    `;

    bar.querySelector('#so-filter').addEventListener('input', (e) => {
        state.filter = e.target.value;
        renderTable(container);
    });
    bar.querySelector('#so-filter-set').addEventListener('change', (e) => {
        state.setFilter = e.target.value;
        renderTable(container);
    });
    bar.querySelector('#so-filter-rarity').addEventListener('change', (e) => {
        state.rarityFilter = e.target.value;
        renderTable(container);
    });
}

function renderTable(container) {
    const wrap = container.querySelector('#so-table-wrap');
    const rows = sortRows(filteredRows());

    const sortArrow = (key) => state.sort.key !== key ? ''
        : (state.sort.dir === 'asc' ? ' &#9650;' : ' &#9660;');

    wrap.innerHTML = rows.length ? `
        <table>
            <thead><tr>
                ${SORT_COLUMNS.map(([key, label]) => `
                    <th class="so-sort-th" data-key="${key}" style="cursor:pointer; user-select:none;">${label}${sortArrow(key)}</th>
                `).join('')}
            </tr></thead>
            <tbody>
                ${rows.map(r => `
                    <tr>
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
}

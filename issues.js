import { supabase } from './shared.js';

// ── Issues tab ────────────────────────────────────────────────────────────
// Lists rows from ebay_order_issues. Bookkeeping only: Resolve/Ignore just
// update status + closed_at here — they do not attempt to fix the
// underlying problem (e.g. creating a missing platform_listings row for a
// listing_gap). Root-cause fixes happen elsewhere; this page just tracks
// which issues still need a human look.

let currentFilter = 'open';
let showPreInventory = false;
let contentEl = null;

const REASON_LABELS = {
    unmatched: 'unmatched',
    insufficient_stock: 'insufficient stock',
    listing_gap: 'listing gap',
    pre_inventory: 'pre inventory',
};

const REASON_BADGE_CLASS = {
    unmatched: 'badge-not_found',
    insufficient_stock: 'badge-ambiguous',
    listing_gap: 'badge-listing_gap',
    pre_inventory: 'badge-matched',
};

export async function renderIssues(content) {
    contentEl = content;
    content.innerHTML = `
        <h2 style="margin-top:0;">Issues</h2>
        <div class="filters-bar">
            <div id="status-tabs" style="display:flex; gap:6px;"></div>
            <label style="font-size:13px; color:var(--text-secondary); display:flex; align-items:center; gap:6px; margin-left:auto;">
                <input type="checkbox" id="show-pre-inventory" />
                Show pre_inventory
            </label>
        </div>
        <div id="issues-table-wrap"><p>Loading...</p></div>
    `;

    document.getElementById('show-pre-inventory').addEventListener('change', (e) => {
        showPreInventory = e.target.checked;
        loadIssues();
    });

    renderTabs();
    await loadIssues();
}

function renderTabs() {
    const tabsEl = document.getElementById('status-tabs');
    const options = [
        { key: 'open', label: 'Open' },
        { key: 'resolved', label: 'Resolved' },
        { key: 'ignored', label: 'Ignored' },
        { key: 'all', label: 'All' },
    ];
    tabsEl.innerHTML = options.map(opt => `
        <button class="btn ${opt.key === currentFilter ? 'btn-primary' : ''}" data-filter="${opt.key}">
            ${opt.label}
        </button>
    `).join('');

    tabsEl.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', () => {
            currentFilter = btn.dataset.filter;
            renderTabs();
            loadIssues();
        });
    });
}

async function loadIssues() {
    const wrap = document.getElementById('issues-table-wrap');
    wrap.innerHTML = '<p>Loading...</p>';

    let query = supabase
        .from('ebay_order_issues')
        .select('*')
        .order('created_at', { ascending: false });

    if (currentFilter !== 'all') {
        query = query.eq('status', currentFilter);
    }
    if (!showPreInventory) {
        query = query.neq('reason', 'pre_inventory');
    }

    const { data, error } = await query;

    if (error) {
        wrap.innerHTML = `<p style="color:var(--danger)">Failed to load issues: ${error.message}</p>`;
        return;
    }

    if (!data || data.length === 0) {
        wrap.innerHTML = '<p style="color:var(--text-secondary)">No issues here.</p>';
        return;
    }

    const rows = data.map(rowHtml).join('');
    wrap.innerHTML = `
        <table>
            <thead>
                <tr>
                    <th style="width:130px;">Reason</th>
                    <th>Listing / card</th>
                    <th style="width:130px;">Order</th>
                    <th style="width:50px;">Qty</th>
                    <th style="width:80px;">Price</th>
                    <th style="width:90px;">Filed</th>
                    <th style="width:150px;"></th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    `;

    wrap.querySelectorAll('button[data-action]').forEach(btn => {
        btn.addEventListener('click', () => handleAction(btn.dataset.id, btn.dataset.action));
    });
}

function rowHtml(row) {
    const badgeClass = REASON_BADGE_CLASS[row.reason] || 'badge-ambiguous';
    const reasonLabel = REASON_LABELS[row.reason] || row.reason;
    const filedDate = row.created_at
        ? new Date(row.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        : '';
    const price = row.sale_price != null ? `$${Number(row.sale_price).toFixed(2)}` : '';
    const title = row.variation_name ? `${row.title} — ${row.variation_name}` : (row.title || '');

    const isOpen = row.status === 'open';
    const actions = isOpen
        ? `
            <button class="btn btn-primary" data-action="resolve" data-id="${row.id}">Resolve</button>
            <button class="btn" data-action="ignore" data-id="${row.id}">Ignore</button>
          `
        : `<button class="btn" data-action="reopen" data-id="${row.id}">Reopen</button>`;

    return `
        <tr>
            <td><span class="badge ${badgeClass}">${reasonLabel}</span></td>
            <td>
                <div>${escapeHtml(title)}</div>
                ${row.detail ? `<div style="color:var(--text-secondary); font-size:12px;">${escapeHtml(row.detail)}</div>` : ''}
            </td>
            <td style="font-family:monospace; font-size:12px;">${escapeHtml(row.order_id || '')}</td>
            <td>${row.quantity ?? ''}</td>
            <td>${price}</td>
            <td style="color:var(--text-secondary);">${filedDate}</td>
            <td style="text-align:right;">${actions}</td>
        </tr>
    `;
}

async function handleAction(id, action) {
    const statusMap = { resolve: 'resolved', ignore: 'ignored', reopen: 'open' };
    const newStatus = statusMap[action];
    const closed_at = newStatus === 'open' ? null : new Date().toISOString();

    const { error } = await supabase
        .from('ebay_order_issues')
        .update({ status: newStatus, closed_at, updated_at: new Date().toISOString() })
        .eq('id', id);

    if (error) {
        alert(`Failed to update issue: ${error.message}`);
        return;
    }

    loadIssues();
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

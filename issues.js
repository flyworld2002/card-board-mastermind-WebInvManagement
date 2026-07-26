import { supabase, debounce } from './shared.js';

// ── Issues tab ────────────────────────────────────────────────────────────
// Lists rows from ebay_order_issues. Bookkeeping only: Resolve/Ignore just
// update status + closed_at here — they do not attempt to fix the
// underlying problem (e.g. creating a missing platform_listings row for a
// listing_gap). Root-cause fixes happen elsewhere; this page just tracks
// which issues still need a human look.

let currentFilter = 'open';
let showPreInventory = false;
let contentEl = null;
let issuesById = new Map();     // id -> full issue row, refreshed each load
let refundByLineId = new Map(); // order_line_item_id -> synced refund_amount (cancelled_after_recording rows only)
let imageByKey = new Map();     // "item_id|variation_name" -> image_url

const REASON_LABELS = {
    unmatched: 'unmatched',
    insufficient_stock: 'insufficient stock',
    listing_gap: 'listing gap',
    pre_inventory: 'pre inventory',
    cancelled: 'cancelled (no sale)',
    cancelled_after_recording: 'cancelled — reverse?',
};

const REASON_BADGE_CLASS = {
    unmatched: 'badge-not_found',
    insufficient_stock: 'badge-ambiguous',
    listing_gap: 'badge-listing_gap',
    pre_inventory: 'badge-matched',
    cancelled: 'badge-matched',
    cancelled_after_recording: 'badge-not_found',
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
        issuesById.clear();
        return;
    }

    issuesById = new Map(data.map(r => [r.id, r]));

    // Refund cross-reference: only relevant for cancelled_after_recording rows,
    // and only informational — it's context for the reversal decision, not a
    // precondition (a cancelled-before-shipping order never generated a real
    // payout to refund in the first place, so absence of synced data here
    // doesn't mean anything's wrong).
    const cancelledLineIds = data
        .filter(r => r.reason === 'cancelled_after_recording')
        .map(r => r.order_line_item_id)
        .filter(Boolean);

    refundByLineId = new Map();
    if (cancelledLineIds.length) {
        const { data: fees, error: feesErr } = await supabase
            .from('sale_line_item_fees')
            .select('order_line_item_id, refund_amount')
            .in('order_line_item_id', cancelledLineIds);
        if (!feesErr && fees) {
            fees.forEach(f => {
                if (f.refund_amount != null) refundByLineId.set(f.order_line_item_id, f.refund_amount);
            });
        }
    }

    imageByKey = await fetchCardImages(data);

    const rows = data.map(rowHtml).join('');
    wrap.innerHTML = `
        <table>
            <thead>
                <tr>
                    <th style="width:48px;"></th>
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

async function fetchCardImages(rows) {
    // Two-hop client-side join, same shape as the backend's matching logic:
    // (item_id, variation_name) -> ebay_listing_map -> variant_id -> image_url.
    // Rows that never matched a variant (e.g. 'unmatched' issues) simply
    // won't resolve here — the row render falls back to a placeholder.
    const itemIds = [...new Set(rows.map(r => r.item_id).filter(Boolean))];
    if (!itemIds.length) return new Map();

    const { data: mapRows, error: mapErr } = await supabase
        .from('ebay_listing_map')
        .select('item_id, variation_name, variant_id')
        .in('item_id', itemIds);
    if (mapErr || !mapRows || !mapRows.length) return new Map();

    const variantByKey = new Map(
        mapRows.map(m => [`${m.item_id}|${m.variation_name}`, m.variant_id])
    );

    const variantIds = [...new Set(mapRows.map(m => m.variant_id).filter(Boolean))];
    if (!variantIds.length) return new Map();

    const { data: variants, error: vErr } = await supabase
        .from('v_card_variants')
        .select('variant_id, image_url')
        .in('variant_id', variantIds);
    if (vErr || !variants) return new Map();

    const imageByVariant = new Map(variants.map(v => [v.variant_id, v.image_url]));

    const result = new Map();
    for (const [key, variantId] of variantByKey) {
        if (imageByVariant.has(variantId)) result.set(key, imageByVariant.get(variantId));
    }
    return result;
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
    const isReversible = row.reason === 'cancelled_after_recording' && isOpen;

    const isUnmatched = row.reason === 'unmatched' && isOpen;

    const actions = isOpen
        ? `
            ${isReversible ? `<button class="btn" style="color:var(--danger); border-color:var(--danger);" data-action="reverse_sale" data-id="${row.id}">Reverse Sale</button>` : ''}
            ${isUnmatched ? `<button class="btn" style="color:var(--accent); border-color:var(--accent);" data-action="add_mapping" data-id="${row.id}">Add mapping</button>` : ''}
            <button class="btn btn-primary" data-action="resolve" data-id="${row.id}">Resolve</button>
            <button class="btn" data-action="ignore" data-id="${row.id}">Ignore</button>
          `
        : `<button class="btn" data-action="reopen" data-id="${row.id}">Reopen</button>`;

    let refundLine = '';
    if (row.reason === 'cancelled_after_recording') {
        const synced = refundByLineId.get(row.order_line_item_id);
        refundLine = synced != null
            ? `<div style="color:var(--success); font-size:12px;">Synced refund: $${Number(synced).toFixed(2)}</div>`
            : `<div style="color:var(--text-secondary); font-size:12px;">No refund synced yet (run --ebay-syncfees, or proceed on cancellation status alone)</div>`;
    }

    const imgUrl = imageByKey.get(`${row.item_id}|${row.variation_name}`);
    const thumb = imgUrl
        ? `<img src="${escapeHtml(imgUrl)}" alt="" loading="lazy"
                style="width:40px; height:56px; object-fit:cover; border-radius:4px; border:1px solid var(--border);"
                onerror="this.replaceWith(Object.assign(document.createElement('div'),
                    {style:'width:40px;height:56px;background:var(--bg-tertiary);border-radius:4px;border:1px solid var(--border);'}))">`
        : `<div style="width:40px; height:56px; background:var(--bg-tertiary); border-radius:4px; border:1px solid var(--border);"></div>`;

    return `
        <tr>
            <td>${thumb}</td>
            <td><span class="badge ${badgeClass}">${reasonLabel}</span></td>
            <td>
                <div>${escapeHtml(title)}</div>
                ${row.detail ? `<div style="color:var(--text-secondary); font-size:12px;">${escapeHtml(row.detail)}</div>` : ''}
                ${refundLine}
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
    if (action === 'reverse_sale') {
        await handleReverseSale(id);
        return;
    }
    if (action === 'add_mapping') {
        openAddMappingModal(id);
        return;
    }

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

async function handleReverseSale(id) {
    const row = issuesById.get(id);
    if (!row) return;

    const synced = refundByLineId.get(row.order_line_item_id);
    const refundNote = synced != null
        ? `\nSynced refund: $${Number(synced).toFixed(2)}`
        : `\n(No refund synced yet — proceeding on the cancellation status alone.)`;

    const confirmed = confirm(
        `Reverse this sale?\n\n` +
        `${row.quantity ?? '?'} × ${row.title || '(untitled)'}\n` +
        `This deletes the recorded sale and restores the quantity to inventory.${refundNote}\n\n` +
        `This cannot be undone. Continue?`
    );
    if (!confirmed) return;

    // Look up the sale_group_id this issue's line belongs to. If nothing
    // comes back, the sale was likely already removed manually (e.g. via
    // the Sales tab trash button) — nothing left to reverse here.
    const { data: saleRows, error: saleErr } = await supabase
        .from('sales')
        .select('sale_group_id')
        .eq('order_line_item_id', row.order_line_item_id)
        .limit(1);

    if (saleErr) {
        alert(`Failed to look up the sale: ${saleErr.message}`);
        return;
    }
    if (!saleRows || saleRows.length === 0) {
        alert('No matching sale row found — it may have already been reversed or removed manually. Marking this issue resolved.');
        await supabase
            .from('ebay_order_issues')
            .update({ status: 'resolved', closed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
            .eq('id', id);
        loadIssues();
        return;
    }

    const { error: rpcErr } = await supabase.rpc('delete_sale_group', {
        p_sale_group_id: saleRows[0].sale_group_id,
    });
    if (rpcErr) {
        alert(`Failed to reverse the sale: ${rpcErr.message}`);
        return;
    }

    const { error: resolveErr } = await supabase
        .from('ebay_order_issues')
        .update({ status: 'resolved', closed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', id);
    if (resolveErr) {
        alert(`Sale reversed, but failed to mark the issue resolved: ${resolveErr.message}`);
    }

    loadIssues();
}

// ── Add mapping modal ────────────────────────────────────────────────────
// For an 'unmatched' issue where the card/variant and its inventory ALREADY
// exist correctly — the gap is purely a missing/wrong ebay_listing_map row
// (e.g. pushed live before that got wired up, or eBay's variation text
// changed after the fact). Unlike the "New Local Purchase" path in Staging
// Review, this never touches inventory/purchases — it only searches for an
// EXISTING variant and upserts the mapping. Doesn't touch this issue's own
// status either (same bookkeeping-only philosophy as Resolve/Ignore) —
// retry_open_issues() on the next --ebay-pullorders run is what actually
// re-matches and resolves it.
function openAddMappingModal(id) {
    const row = issuesById.get(id);
    if (!row) return;

    const overlay = document.createElement('div');
    overlay.style.cssText = `
        position:fixed; inset:0; background:rgba(0,0,0,0.6);
        display:flex; align-items:center; justify-content:center;
        z-index:1000; padding:16px;
    `;
    overlay.innerHTML = `
        <div style="background:var(--bg-secondary); border:1px solid var(--border);
                    border-radius:8px; padding:20px; width:520px; max-width:95vw;
                    max-height:85vh; overflow-y:auto;">
            <h3 style="margin:0 0 4px;">Add mapping</h3>
            <p style="color:var(--text-secondary); font-size:12px; margin:0 0 14px;">
                Links this exact eBay item/variation to an EXISTING catalog variant —
                use this only when the card and its inventory are already correct and
                the gap is purely a missing mapping. For a card that needs new
                inventory too, use "New Local Purchase" on the Staging Review page instead.
            </p>
            <div style="background:var(--bg-tertiary); border:1px solid var(--border); border-radius:6px;
                        padding:8px 10px; margin-bottom:14px; font-size:12px;">
                <div><strong>Item ID:</strong> ${escapeHtml(row.item_id || '')}</div>
                <div><strong>Variation:</strong> ${escapeHtml(row.variation_name || '')}</div>
            </div>
            <label style="font-size:12px; color:var(--text-secondary); display:block; margin-bottom:4px;">
                Search for the card
            </label>
            <input type="text" id="am-search" placeholder="Card name..." style="width:100%; margin-bottom:10px;" autocomplete="off" />
            <div id="am-results" style="max-height:260px; overflow-y:auto; margin-bottom:10px;"></div>
            <div id="am-selected" style="font-size:13px; margin-bottom:10px;"></div>
            <div id="am-msg" style="font-size:12px; margin-bottom:10px;"></div>
            <div style="display:flex; gap:8px;">
                <button class="btn btn-primary" id="am-save-btn" disabled>Save mapping</button>
                <button class="btn" id="am-cancel-btn">Cancel</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    let selected = null;
    const resultsEl  = overlay.querySelector('#am-results');
    const selectedEl = overlay.querySelector('#am-selected');
    const msgEl      = overlay.querySelector('#am-msg');
    const saveBtn    = overlay.querySelector('#am-save-btn');

    overlay.querySelector('#am-cancel-btn').addEventListener('click', () => overlay.remove());

    overlay.querySelector('#am-search').addEventListener('input', debounce(async (e) => {
        const term = e.target.value.trim();
        if (!term) { resultsEl.innerHTML = ''; return; }

        const { data, error } = await supabase
            .from('v_card_variants')
            .select('card_id, variant_id, card_name, set_name, display_number, rarity, image_url, '
                   + 'foil_label, pattern_label, texture_label, material_label, size_label, stamp_label, source_label')
            .ilike('card_name', `%${term}%`)
            .order('card_name')
            .limit(30);

        if (error) {
            resultsEl.innerHTML = `<p style="color:var(--danger); font-size:12px;">${escapeHtml(error.message)}</p>`;
            return;
        }
        if (!data || !data.length) {
            resultsEl.innerHTML = `<p style="color:var(--text-secondary); font-size:12px;">No matches.</p>`;
            return;
        }

        resultsEl.innerHTML = data.map((v, i) => {
            const variantLabel = [v.foil_label, v.pattern_label, v.texture_label, v.material_label, v.size_label, v.stamp_label, v.source_label]
                .filter(Boolean).join(' · ') || 'Non-Holo';
            return `
                <div class="am-result" data-idx="${i}"
                     style="padding:6px 8px; border:1px solid var(--border); border-radius:4px;
                            margin-bottom:4px; cursor:pointer; font-size:13px;">
                    <strong>${escapeHtml(v.card_name)}</strong>
                    — ${escapeHtml(v.set_name || '')} #${escapeHtml(v.display_number || '')}
                    <span style="color:var(--text-secondary);">(${escapeHtml(variantLabel)}${v.rarity ? ', ' + escapeHtml(v.rarity) : ''})</span>
                </div>
            `;
        }).join('');

        resultsEl.querySelectorAll('.am-result').forEach(el => {
            el.addEventListener('click', () => {
                selected = data[Number(el.dataset.idx)];
                const variantLabel = [selected.foil_label, selected.pattern_label, selected.texture_label,
                                       selected.material_label, selected.size_label, selected.stamp_label, selected.source_label]
                    .filter(Boolean).join(' · ') || 'Non-Holo';
                selectedEl.innerHTML = `<span style="color:var(--success);">Selected:</span> ${escapeHtml(selected.card_name)} `
                    + `— ${escapeHtml(selected.set_name || '')} #${escapeHtml(selected.display_number || '')} `
                    + `(${escapeHtml(variantLabel)})`;
                saveBtn.disabled = false;
            });
        });
    }, 300));

    saveBtn.addEventListener('click', async () => {
        if (!selected) return;
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';
        msgEl.textContent = '';

        const { error } = await supabase
            .from('ebay_listing_map')
            .upsert({
                item_id: row.item_id,
                variation_name: row.variation_name,
                variant_id: selected.variant_id,
                condition: 'Near Mint',
                source: 'manual_map',
                last_synced_at: new Date().toISOString(),
            }, { onConflict: 'item_id,variation_name' });

        if (error) {
            msgEl.innerHTML = `<span style="color:var(--danger);">Failed: ${escapeHtml(error.message)}</span>`;
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save mapping';
            return;
        }

        msgEl.innerHTML = `<span style="color:var(--success);">Mapping saved — this issue will auto-resolve on the next --ebay-pullorders run.</span>`;
        setTimeout(() => overlay.remove(), 1800);
    });
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

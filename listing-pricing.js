// listing-pricing.js
// Listing pricing page — docs/plans/listing-pricing-system.md (Card-Board-MasterMind repo).
//
// Post-pivot model: a listing_templates row IS the listing (template.listing_id
// == the eBay Item #). The card roster is explicit (listing_card_assignments),
// not inferred from whatever happens to be synced in platform_listings —
// a roster row can be 'active' (live, has a platform_listings row) or
// 'queued' (planned, not live on eBay yet). Grouping is manual:
// listing_card_groups are created inline on this page, cards are assigned
// to a group by selection, and a group's profile_id IS the pricing rule.
//
// Resolution ALWAYS comes from the resolve_listing_prices() Postgres RPC —
// never recomputed here — so this page and the Python push job can never
// disagree.

import { supabase, formatPrice } from './shared.js';

// picking_api.py config — mirrors picking.js's constants (same service,
// same shared secret). Keep these two in sync with picking.js if the
// desktop's LAN IP or token ever changes.
const PICKING_API_URL = 'http://192.168.1.186:8765';
const PICKING_API_TOKEN = 'I1knbOJAve_UZJQHAFZANds9-HalgCxcRJw1GXDg404';

function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

let state = {
    platform: 'ebay',
    listingId: '',
    accountNum: 1,
    templates: [],           // all listing_templates rows (landing view)
    template: null,          // the one currently open, or null when on the landing view
    resolvedRows: [],        // resolve_listing_prices() output
    listingRowsByPLId: {},   // platform_listing_id -> platform_listings row (sync_enabled/status/manual_price/etc.)
    groups: [],              // listing_card_groups for this template
    profiles: [],
    unimportedCount: 0,      // platform_listings rows for this listing_id not yet in the roster
    selected: new Set(),     // selected listing_card_assignments.row_id values
};

// Shift-click range-select anchor — index into the flat, top-to-bottom
// checkbox list (spans group boundaries), not part of `state` since it's
// pure UI interaction state, not data.
let lastClickedCheckboxIndex = null;

export async function renderListingPricing(container) {
    container.innerHTML = shellHTML();
    const { data } = await supabase.from('pricing_profiles').select('*').order('name');
    state.profiles = data || [];
    await renderTemplatesList(container);
}

function shellHTML() {
    return `
        <h2 style="margin:0 0 4px;">Listing pricing</h2>
        <p style="color:var(--text-secondary); font-size:13px; margin:0 0 16px;">
            docs/plans/listing-pricing-system.md — a template IS the listing;
            cards belong to it via an explicit roster, grouped however you like.
        </p>
        <div id="lp-body"></div>
    `;
}

// ----------------------------------------------------------------
// Landing view — list of templates (= listings). Click one to open its
// roster/groups view; "+ New template" to create one.
// ----------------------------------------------------------------

async function renderTemplatesList(container) {
    const body = container.querySelector('#lp-body');
    body.innerHTML = '<p>Loading templates...</p>';
    state.template = null;

    const { data, error } = await supabase.from('listing_templates').select('*').order('platform').order('name');
    if (error) {
        body.innerHTML = `<p style="color:var(--danger)">Failed to load templates: ${escapeHtml(error.message)}</p>`;
        return;
    }
    state.templates = data || [];

    body.innerHTML = `
        <div class="filters-bar" style="justify-content:flex-end;">
            <button class="btn btn-primary" id="lp-new-template-btn">+ New template</button>
        </div>
        ${state.templates.length ? `
            <table>
                <thead><tr>
                    <th>Name</th><th>eBay Item #</th><th>Platform</th><th>Account</th><th>Kind</th><th style="width:60px;"></th>
                </tr></thead>
                <tbody>
                    ${state.templates.map(t => `
                        <tr class="lp-template-row" data-id="${t.id}" style="cursor:pointer;">
                            <td>${escapeHtml(t.name)}</td>
                            <td>${t.listing_id ? escapeHtml(t.listing_id) : '<span style="color:var(--text-secondary);">(draft — no listing yet)</span>'}</td>
                            <td>${escapeHtml(t.platform)}</td>
                            <td>${t.account ? escapeHtml(t.account) : '<span style="color:var(--text-secondary);">All accounts</span>'}</td>
                            <td>${escapeHtml(t.listing_kind || 'variation')}</td>
                            <td><button class="btn lp-edit-template-btn" data-id="${t.id}">Edit</button></td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        ` : `<p style="color:var(--text-secondary)">No listing templates yet.</p>`}
        <div id="lp-modal-root"></div>
    `;

    body.querySelector('#lp-new-template-btn').addEventListener('click', () => openTemplateModal(container, null));
    body.querySelectorAll('.lp-edit-template-btn').forEach(btn => {
        btn.addEventListener('click', (e) => { e.stopPropagation(); openTemplateModal(container, btn.dataset.id); });
    });
    body.querySelectorAll('.lp-template-row').forEach(tr => {
        tr.addEventListener('click', () => openTemplate(container, tr.dataset.id));
    });
}

async function openTemplate(container, templateId) {
    const t = state.templates.find(x => x.id === templateId);
    if (!t) return;
    state.platform = t.platform;
    state.listingId = t.listing_id || '';
    if (!state.listingId) {
        window.alert('This template has no eBay Item # (listing_id) yet — edit it first to set one.');
        return;
    }
    await loadListing(container);
}

function openTemplateModal(container, templateId) {
    const isEdit = !!templateId;
    const existing = isEdit ? state.templates.find(t => t.id === templateId) : null;
    const root = container.querySelector('#lp-modal-root');
    const f = (label, type, name, value, placeholder = '', step = '', optional = false) => `
        <label style="font-size:12px; color:var(--text-secondary); flex:${optional ? '1' : 'initial'};">
            ${label}
            <input type="${type}" name="${name}" ${step ? `step="${step}"` : ''} ${optional ? '' : (type === 'number' ? '' : 'required')}
                   value="${escapeHtml(value ?? '')}" placeholder="${escapeHtml(placeholder)}" style="width:100%; margin-top:4px;" />
        </label>
    `;

    root.innerHTML = `
        <div style="position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:100;">
            <div style="background:var(--bg-secondary); border:1px solid var(--border); border-radius:8px; padding:20px; width:460px; max-width:90vw; max-height:85vh; overflow-y:auto;">
                <h3 style="margin:0 0 16px;">${isEdit ? 'Edit listing template' : 'New listing template'}</h3>
                <form id="lp-template-form">
                    <div style="display:flex; flex-direction:column; gap:10px;">
                        ${f('Platform', 'text', 'platform', existing?.platform || 'ebay')}
                        ${f('Account (blank = applies to all accounts)', 'text', 'account', existing?.account || '', 'e.g. BIGGYFISH', '', true)}
                        ${f('Name', 'text', 'name', existing?.name || '', 'e.g. commons')}
                        ${f('eBay Item # (listing_id) — this template IS that listing', 'text', 'listing_id', existing?.listing_id || '', 'e.g. 336691917730', '', true)}
                        ${f('Description', 'text', 'description', existing?.description || '', '', '', true)}
                        <label style="font-size:12px; color:var(--text-secondary);">
                            Listing kind
                            <select name="listing_kind" style="width:100%; margin-top:4px;">
                                <option value="variation" ${(existing?.listing_kind || 'variation') === 'variation' ? 'selected' : ''}>variation (multi-variation listing)</option>
                                <option value="single" ${existing?.listing_kind === 'single' ? 'selected' : ''}>single (one card per listing)</option>
                            </select>
                        </label>
                        ${f('Base price ($) — sync price floor, raise-only', 'number', 'base_price', existing?.base_price, '', '0.01', true)}
                        ${f('Default quantity limit (per variation)', 'number', 'default_quantity_limit', existing?.default_quantity_limit, '', '', true)}
                        <div style="display:flex; gap:10px;">
                            ${f('Low-stock threshold', 'number', 'low_stock_threshold', existing?.low_stock_threshold ?? 8, '', '', true)}
                            ${f('Low-stock bump ($)', 'number', 'low_stock_bump', existing?.low_stock_bump ?? 1, '', '0.01', true)}
                        </div>
                        <label style="font-size:12px; color:var(--text-secondary);">
                            Display sort (buyer-facing dropdown order)
                            <select name="display_sort" style="width:100%; margin-top:4px;">
                                <option value="card_number" ${(existing?.display_sort || 'card_number') === 'card_number' ? 'selected' : ''}>card_number</option>
                                <option value="alpha" ${existing?.display_sort === 'alpha' ? 'selected' : ''}>alpha</option>
                                <option value="release_date" ${existing?.display_sort === 'release_date' ? 'selected' : ''}>release_date (reserved — future themed listings)</option>
                            </select>
                        </label>
                        ${f('Name format', 'text', 'name_format', existing?.name_format || '{number}/{set_total} {name} {suffix}', '', '', true)}
                    </div>
                    <div id="lp-template-form-error" style="color:var(--danger); font-size:12px; margin-top:10px;"></div>
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:18px;">
                        ${isEdit ? `<button type="button" class="btn" id="lp-template-delete" style="color:var(--danger); border-color:var(--danger);">Delete</button>` : '<span></span>'}
                        <div style="display:flex; gap:8px;">
                            <button type="button" class="btn" id="lp-template-cancel">Cancel</button>
                            <button type="submit" class="btn btn-primary">${isEdit ? 'Save changes' : 'Create'}</button>
                        </div>
                    </div>
                </form>
            </div>
        </div>
    `;

    root.querySelector('#lp-template-cancel').addEventListener('click', () => { root.innerHTML = ''; });
    if (isEdit) {
        root.querySelector('#lp-template-delete').addEventListener('click', async () => {
            if (!window.confirm(`Delete template "${existing.name}"? This can't be undone.`)) return;
            const { error } = await supabase.from('listing_templates').delete().eq('id', templateId);
            if (error) { window.alert(`Failed to delete: ${error.message}`); return; }
            root.innerHTML = '';
            await renderTemplatesList(container);
        });
    }
    root.querySelector('#lp-template-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errBox = root.querySelector('#lp-template-form-error');
        errBox.textContent = '';
        const fd = new FormData(e.target);
        const num = (name) => fd.get(name) ? parseFloat(fd.get(name)) : null;
        const int = (name) => fd.get(name) ? parseInt(fd.get(name), 10) : null;
        const payload = {
            platform: fd.get('platform').trim(),
            account: fd.get('account').trim() || null,
            name: fd.get('name').trim(),
            listing_id: fd.get('listing_id').trim() || null,
            description: fd.get('description').trim() || null,
            listing_kind: fd.get('listing_kind') || 'variation',
            base_price: num('base_price'),
            default_quantity_limit: int('default_quantity_limit'),
            low_stock_threshold: int('low_stock_threshold') ?? 8,
            low_stock_bump: num('low_stock_bump') ?? 1,
            display_sort: fd.get('display_sort') || 'card_number',
            name_format: fd.get('name_format').trim() || '{number}/{set_total} {name} {suffix}',
            updated_at: new Date().toISOString(),
        };
        try {
            const { error } = isEdit
                ? await supabase.from('listing_templates').update(payload).eq('id', templateId)
                : await supabase.from('listing_templates').insert(payload);
            if (error) throw error;
            root.innerHTML = '';
            await renderTemplatesList(container);
        } catch (err) {
            console.error(err);
            errBox.textContent = err.message || 'Failed to save listing template.';
        }
    });
}

// ----------------------------------------------------------------
// Roster/groups view for one template
// ----------------------------------------------------------------

async function loadListing(container) {
    const body = container.querySelector('#lp-body');
    body.innerHTML = '<p>Loading...</p>';
    state.selected = new Set();

    try {
        const { data: template, error: tErr } = await supabase
            .from('listing_templates').select('*')
            .eq('platform', state.platform).eq('listing_id', state.listingId)
            .maybeSingle();
        if (tErr) throw tErr;

        state.template = template;

        if (!template) {
            body.innerHTML = noTemplateHTML();
            body.querySelector('#lp-create-template-btn').addEventListener('click', () => createTemplate(container));
            return;
        }

        const [{ data: resolved, error: rErr }, { data: groups, error: gErr }, { count: platformCount }] = await Promise.all([
            supabase.rpc('resolve_listing_prices', { p_platform: state.platform, p_listing_id: state.listingId }),
            supabase.from('listing_card_groups').select('*').eq('template_id', template.id).order('name'),
            supabase.from('platform_listings').select('id', { count: 'exact', head: true })
                .eq('platform', state.platform).eq('listing_id', state.listingId),
        ]);
        if (rErr) throw rErr;
        if (gErr) throw gErr;

        state.resolvedRows = resolved || [];
        state.groups = groups || [];

        const plIds = (resolved || []).map(r => r.platform_listing_id).filter(Boolean);
        if (plIds.length) {
            const { data: listingRows } = await supabase
                .from('platform_listings')
                .select('id, external_id, manual_price, pushed_price, pushed_qty, pushed_at, sync_enabled, status')
                .in('id', plIds);
            state.listingRowsByPLId = Object.fromEntries((listingRows || []).map(r => [r.id, r]));
        } else {
            state.listingRowsByPLId = {};
        }

        const rosterPLIds = new Set(plIds);
        state.unimportedCount = Math.max((platformCount || 0) - rosterPLIds.size, 0);

        renderBody(container);
    } catch (err) {
        console.error(err);
        body.innerHTML = `<p style="color:var(--danger)">Failed to load listing: ${escapeHtml(err.message)}</p>`;
    }
}

function noTemplateHTML() {
    return `
        <div style="border:1px solid var(--border); border-radius:8px; padding:20px; max-width:480px;">
            <p style="margin-top:0;">No template exists for ${escapeHtml(state.platform)} listing
                <strong>${escapeHtml(state.listingId)}</strong> yet. A template IS the listing — create one to start
                setting up groups and a card roster.</p>
            <label style="font-size:13px; display:block; margin-bottom:10px;">Template name
                <input type="text" id="lp-new-template-name" placeholder="e.g. this listing's name"
                       style="width:100%; margin-top:4px;" />
            </label>
            <label style="font-size:13px; display:block; margin-bottom:10px;">Listing kind
                <select id="lp-new-template-kind" style="width:100%; margin-top:4px;">
                    <option value="variation">variation (multi-variation listing)</option>
                    <option value="single">single (one card per listing)</option>
                </select>
            </label>
            <button class="btn btn-primary" id="lp-create-template-btn">Create template</button>
        </div>
    `;
}

async function createTemplate(container) {
    const body = container.querySelector('#lp-body');
    const name = body.querySelector('#lp-new-template-name').value.trim() || state.listingId;
    const kind = body.querySelector('#lp-new-template-kind').value;
    const { error } = await supabase.from('listing_templates').insert({
        platform: state.platform, listing_id: state.listingId, name, listing_kind: kind,
    });
    if (error) {
        window.alert(`Failed to create template: ${error.message}`);
        return;
    }
    await loadListing(container);
}

// ----------------------------------------------------------------
// Render
// ----------------------------------------------------------------

function needsPush(r) {
    const row = state.listingRowsByPLId[r.platform_listing_id];
    if (!row) return false;
    if (row.pushed_at == null) return true;
    const priceDiff = row.pushed_price == null || Math.abs(Number(row.pushed_price) - Number(r.resolved_price)) >= 0.005;
    const available = r.available_qty ?? 0;
    const gated = r.low_stock_qty == null ? available : Math.max(available - r.low_stock_qty, 0);
    const qtyDiff = row.pushed_qty == null || row.pushed_qty !== gated;
    return priceDiff || qtyDiff;
}

function isGatedIn(r) {
    const row = state.listingRowsByPLId[r.platform_listing_id];
    if (!row) return false;
    return !!row.sync_enabled && row.status === 'active';
}

function sourceBadge(source) {
    if (source === 'pin') return `<span class="badge" style="background:rgba(167,139,250,0.15); color:#a78bfa;">pinned</span>`;
    if (source === 'default') return `<span class="badge badge-ambiguous">default</span>`;
    return `<span class="badge badge-matched">group</span>`;
}

function statusBadge(status) {
    const map = {
        active: { c: 'var(--success)', label: 'active' },
        queued: { c: 'var(--warning)', label: 'queued' },
        sold_out_retained: { c: 'var(--text-secondary)', label: 'sold out (kept)' },
    };
    const s = map[status] || { c: 'var(--text-secondary)', label: status };
    return `<span style="color:${s.c}; font-size:12px;">${s.label}</span>`;
}

function renderBody(container) {
    const body = container.querySelector('#lp-body');
    const rows = state.resolvedRows;
    const pending = rows.filter(r => r.status === 'active' && needsPush(r));
    const pendingGated = pending.filter(r => isGatedIn(r));

    const byGroup = {};
    const ungrouped = [];
    for (const r of rows) {
        if (r.group_id) (byGroup[r.group_id] ??= []).push(r);
        else ungrouped.push(r);
    }

    body.innerHTML = `
        <button class="btn" id="lp-back-to-templates-btn" style="margin-bottom:12px;">&larr; Back to templates</button>
        <div style="display:flex; align-items:center; gap:12px; margin:16px 0; flex-wrap:wrap;">
            <h3 style="margin:0;">${escapeHtml(state.template.name)}</h3>
            <span style="font-size:12px; color:var(--text-secondary);">${escapeHtml(state.template.listing_kind)} listing</span>
            <span style="font-size:13px; color:var(--text-secondary);">
                ${rows.length} card(s) on roster
                ${pendingGated.length > 0 ? ` · <span style="color:var(--warning);">${pendingGated.length} need push</span>` : ' · in sync'}
            </span>
            <button class="btn btn-primary" id="lp-push-btn" style="margin-left:auto;" ${pendingGated.length === 0 ? 'disabled' : ''}>
                Push ${pendingGated.length > 0 ? `(${pendingGated.length})` : ''}
            </button>
            <button class="btn" id="lp-push-dryrun-btn">Dry-run</button>
        </div>
        <div id="lp-push-msg" style="font-size:13px; margin-bottom:12px;"></div>

        ${state.unimportedCount > 0 ? `
            <div style="padding:10px 14px; background:rgba(74,140,255,0.1); border:1px solid var(--accent); border-radius:6px; margin-bottom:14px; display:flex; align-items:center; gap:12px;">
                <span style="font-size:13px;">${state.unimportedCount} existing platform_listings row(s) for this Item # aren't on the roster yet.</span>
                <button class="btn btn-primary" id="lp-import-existing-btn" style="margin-left:auto;">Import into roster</button>
            </div>
        ` : ''}

        <div style="display:flex; gap:8px; margin-bottom:14px; flex-wrap:wrap;">
            <button class="btn" id="lp-new-group-btn">+ New group</button>
            <button class="btn" id="lp-add-card-btn">+ Add card to listing</button>
            <span style="margin-left:auto; font-size:12px; color:var(--text-secondary); align-self:center;">
                ${state.selected.size} selected
            </span>
            <select id="lp-bulk-group-select" style="font-size:12px;" ${state.selected.size === 0 ? 'disabled' : ''}>
                <option value="">Assign selected to group...</option>
                <option value="__none__">(no group)</option>
                ${state.groups.map(g => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('')}
            </select>
        </div>

        ${state.groups.map(g => groupSectionHTML(g, byGroup[g.id] || [])).join('')}
        ${groupSectionHTML(null, ungrouped)}

        <div id="lp-modal-root"></div>
    `;

    wireControls(container, body);
}

function groupSectionHTML(group, rows) {
    const title = group ? escapeHtml(group.name) : '(no group)';
    const profile = group && group.profile_id ? state.profiles.find(p => p.id === group.profile_id) : null;

    return `
        <div class="lp-group" style="border:1px solid var(--border); border-radius:8px; margin-bottom:14px; overflow:hidden;">
            <div style="display:flex; align-items:center; gap:12px; padding:10px 14px; background:var(--bg-tertiary); flex-wrap:wrap;">
                <span class="badge" style="background:rgba(74,140,255,0.15); color:var(--accent);">${title}</span>
                <span style="font-size:12px; color:var(--text-secondary);">${rows.length} card(s)</span>
                ${group ? `
                    <label style="font-size:12px; color:var(--text-secondary); margin-left:auto;">Profile
                        <select class="lp-group-profile-picker" data-group-id="${group.id}" style="margin-left:6px;">
                            <option value="">(none — falls to platform default)</option>
                            ${state.profiles.map(p => `<option value="${p.id}" ${profile && profile.id === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
                        </select>
                    </label>
                    <button class="btn lp-rename-group-btn" data-group-id="${group.id}" style="font-size:12px; padding:3px 8px;">Rename</button>
                    <button class="btn lp-delete-group-btn" data-group-id="${group.id}" style="font-size:12px; padding:3px 8px; color:var(--danger);">Delete</button>
                ` : ''}
            </div>
            ${rows.length ? `
                <table>
                    <thead><tr>
                        <th style="width:24px;"></th><th>Variation</th><th>Status</th><th>Market</th><th>Resolved</th><th>Source</th><th>Synced?</th><th>Available</th><th>Low-stock qty</th><th>Manual pin</th>
                    </tr></thead>
                    <tbody>${rows.map(r => rowHTML(r)).join('')}</tbody>
                </table>
            ` : `<p style="color:var(--text-secondary); font-size:13px; padding:10px 14px;">No cards here yet.</p>`}
        </div>
    `;
}

function rowHTML(r) {
    const listingRow = state.listingRowsByPLId[r.platform_listing_id] || {};
    const stale = r.status === 'active' && needsPush(r);
    const isActive = r.status === 'active';
    return `
        <tr data-row-id="${r.row_id}" ${stale ? 'style="background:rgba(245,166,35,0.06);"' : ''}>
            <td><input type="checkbox" class="lp-row-checkbox" data-row-id="${r.row_id}" ${state.selected.has(r.row_id) ? 'checked' : ''} /></td>
            <td>${escapeHtml(listingRow.external_id || r.derived_label)}</td>
            <td>${statusBadge(r.status)}</td>
            <td>${r.market_price != null ? formatPrice(r.market_price) : '-'}</td>
            <td style="font-weight:600;">${formatPrice(r.resolved_price)}</td>
            <td>${sourceBadge(r.price_source)}</td>
            <td>${isActive
                ? (isGatedIn(r) ? '<span style="color:var(--success); font-size:12px;">yes</span>' : '<span style="color:var(--text-secondary); font-size:12px;">no</span>')
                : '<span style="color:var(--text-secondary); font-size:12px;">n/a</span>'}</td>
            <td>${r.available_qty ?? '-'}</td>
            <td><input type="number" class="lp-low-stock-input" data-row-id="${r.row_id}" data-pl-id="${r.platform_listing_id || ''}"
                       value="${r.low_stock_qty ?? ''}" placeholder="-" style="width:60px;" ${isActive ? '' : 'disabled title="only editable once live"'} /></td>
            <td><input type="number" step="0.01" class="lp-pin-input" data-pl-id="${r.platform_listing_id || ''}"
                       value="${listingRow.manual_price ?? ''}" placeholder="${isActive ? 'unpinned' : 'n/a'}" style="width:80px;" ${isActive ? '' : 'disabled'} /></td>
        </tr>
    `;
}

// ----------------------------------------------------------------
// Wiring
// ----------------------------------------------------------------

function wireControls(container, body) {
    body.querySelector('#lp-back-to-templates-btn').addEventListener('click', () => renderTemplatesList(container));

    // Shift-click range select: click (not change, so we can read e.shiftKey)
    // on a checkbox with shift held toggles every checkbox between it and
    // the last one clicked, matching the state the just-clicked box ended
    // up in — same convention as file-manager-style multi-select.
    const checkboxes = [...body.querySelectorAll('.lp-row-checkbox')];
    checkboxes.forEach((cb, index) => {
        cb.addEventListener('click', (e) => {
            if (e.shiftKey && lastClickedCheckboxIndex !== null) {
                const [start, end] = [lastClickedCheckboxIndex, index].sort((a, b) => a - b);
                const checked = cb.checked;
                for (let i = start; i <= end; i++) {
                    checkboxes[i].checked = checked;
                    if (checked) state.selected.add(checkboxes[i].dataset.rowId);
                    else state.selected.delete(checkboxes[i].dataset.rowId);
                }
            } else {
                if (cb.checked) state.selected.add(cb.dataset.rowId);
                else state.selected.delete(cb.dataset.rowId);
            }
            lastClickedCheckboxIndex = index;
            renderBody(container);
        });
    });

    body.querySelector('#lp-bulk-group-select').addEventListener('change', async (e) => {
        const value = e.target.value;
        if (!value) return;
        const groupId = value === '__none__' ? null : value;
        const { error } = await supabase.from('listing_card_assignments')
            .update({ group_id: groupId })
            .in('id', [...state.selected]);
        if (error) {
            window.alert(`Failed to assign group: ${error.message}`);
            return;
        }
        state.selected = new Set();
        await loadListing(container);
    });

    body.querySelector('#lp-new-group-btn').addEventListener('click', () => openNewGroupModal(container, body));

    body.querySelectorAll('.lp-rename-group-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const group = state.groups.find(g => g.id === btn.dataset.groupId);
            const name = window.prompt('Rename group:', group?.name || '');
            if (!name || !name.trim()) return;
            const { error } = await supabase.from('listing_card_groups').update({ name: name.trim() }).eq('id', btn.dataset.groupId);
            if (error) { window.alert(`Failed to rename: ${error.message}`); return; }
            await loadListing(container);
        });
    });

    body.querySelectorAll('.lp-delete-group-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (!window.confirm('Delete this group? Cards in it become ungrouped, not deleted.')) return;
            const { error } = await supabase.from('listing_card_groups').delete().eq('id', btn.dataset.groupId);
            if (error) { window.alert(`Failed to delete: ${error.message}`); return; }
            await loadListing(container);
        });
    });

    body.querySelectorAll('.lp-group-profile-picker').forEach(sel => {
        sel.addEventListener('change', async () => {
            const { error } = await supabase.from('listing_card_groups')
                .update({ profile_id: sel.value || null }).eq('id', sel.dataset.groupId);
            if (error) { window.alert(`Failed to assign profile: ${error.message}`); return; }
            await loadListing(container);
        });
    });

    body.querySelectorAll('.lp-pin-input').forEach(input => {
        input.addEventListener('change', async () => {
            const plId = input.dataset.plId;
            if (!plId) return;
            const raw = input.value.trim();
            const manualPrice = raw === '' ? null : parseFloat(raw);
            const { error } = await supabase.from('platform_listings').update({ manual_price: manualPrice }).eq('id', plId);
            if (error) { window.alert(`Failed to save pin: ${error.message}`); return; }
            await loadListing(container);
        });
    });

    body.querySelectorAll('.lp-low-stock-input').forEach(input => {
        input.addEventListener('change', async () => {
            const plId = input.dataset.plId;
            if (!plId) return;
            const raw = input.value.trim();
            const lowStockQty = raw === '' ? null : parseInt(raw, 10);
            const { error } = await supabase.from('platform_listings').update({ low_stock_qty: lowStockQty }).eq('id', plId);
            if (error) { window.alert(`Failed to save low-stock qty: ${error.message}`); return; }
            await loadListing(container);
        });
    });

    const importBtn = body.querySelector('#lp-import-existing-btn');
    if (importBtn) importBtn.addEventListener('click', () => importExisting(container));

    body.querySelector('#lp-add-card-btn').addEventListener('click', () => openAddCardModal(container, body));

    body.querySelector('#lp-push-btn').addEventListener('click', () => doPush(container, false));
    body.querySelector('#lp-push-dryrun-btn').addEventListener('click', () => doPush(container, true));
}

// ----------------------------------------------------------------
// Import existing platform_listings rows into the roster
// ----------------------------------------------------------------

async function importExisting(container) {
    const { data: existing, error: fetchErr } = await supabase
        .from('platform_listings')
        .select('id, variant_id')
        .eq('platform', state.platform).eq('listing_id', state.listingId);
    if (fetchErr) {
        window.alert(`Failed to fetch existing listings: ${fetchErr.message}`);
        return;
    }

    const { data: existingRoster } = await supabase
        .from('listing_card_assignments')
        .select('platform_listing_id')
        .eq('template_id', state.template.id);
    const already = new Set((existingRoster || []).map(r => r.platform_listing_id));

    const toImport = (existing || []).filter(r => !already.has(r.id));
    if (!toImport.length) {
        window.alert('Nothing new to import.');
        return;
    }
    if (!window.confirm(`Import ${toImport.length} existing card(s) into the roster as 'active'?`)) return;

    const rows = toImport.map((r, i) => ({
        template_id: state.template.id,
        platform_listing_id: r.id,
        variant_id: r.variant_id,
        priority_rank: i,
        status: 'active',
    }));
    const { error } = await supabase.from('listing_card_assignments').insert(rows);
    if (error) {
        window.alert(`Import failed: ${error.message}`);
        return;
    }
    await loadListing(container);
}

// ----------------------------------------------------------------
// New group — group NAMES are reusable/consistent across listings (a
// custom dropdown, expanded on focus, suggests every name used anywhere),
// but each pick always creates a separate row scoped to THIS template,
// with its own profile assignment. This intentionally does NOT share
// pricing across listings — see the conversation in the plan doc for why.
//
// Uses a hand-rolled dropdown instead of a native <datalist>: datalists
// only reliably show suggestions once you start typing in most browsers,
// and Fei specifically wants the full list on focus.
// ----------------------------------------------------------------

async function openNewGroupModal(container, body) {
    const { data } = await supabase.from('listing_card_groups').select('name');
    const names = [...new Set((data || []).map(r => r.name))].sort();

    const root = body.querySelector('#lp-modal-root');
    root.innerHTML = `
        <div style="position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:100;">
            <div style="background:var(--bg-secondary); border:1px solid var(--border); border-radius:8px; padding:20px; width:400px; max-width:90vw;">
                <h3 style="margin:0 0 12px;">New group</h3>
                <p style="color:var(--text-secondary); font-size:12px; margin:0 0 10px;">
                    Type a new name or pick a name you've used on another listing to stay consistent —
                    this always creates a separate group scoped to this listing, with its own profile.
                </p>
                <div style="position:relative;">
                    <input type="text" id="lp-new-group-name" placeholder="e.g. Bulk Holos" autocomplete="off" style="width:100%;" />
                    <div id="lp-group-name-dropdown" style="display:none; position:absolute; top:100%; left:0; right:0;
                         background:var(--bg-tertiary); border:1px solid var(--border); border-radius:4px;
                         max-height:180px; overflow-y:auto; z-index:10;"></div>
                </div>
                <div id="lp-new-group-error" style="color:var(--danger); font-size:12px; margin-top:8px;"></div>
                <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:16px;">
                    <button type="button" class="btn" id="lp-new-group-cancel">Cancel</button>
                    <button type="button" class="btn btn-primary" id="lp-new-group-create">Create</button>
                </div>
            </div>
        </div>
    `;

    const input = root.querySelector('#lp-new-group-name');
    const dropdown = root.querySelector('#lp-group-name-dropdown');

    function showSuggestions(filterText) {
        const filtered = filterText
            ? names.filter(n => n.toLowerCase().includes(filterText.toLowerCase()))
            : names;
        if (!filtered.length) { dropdown.style.display = 'none'; return; }
        dropdown.innerHTML = filtered.map(n => `
            <div class="lp-group-suggestion" data-name="${escapeHtml(n)}"
                 style="padding:6px 10px; cursor:pointer; font-size:13px;">${escapeHtml(n)}</div>
        `).join('');
        dropdown.style.display = 'block';
        dropdown.querySelectorAll('.lp-group-suggestion').forEach(el => {
            // mousedown (not click) fires before the input's blur, so the
            // selection registers before we hide the dropdown on blur.
            el.addEventListener('mousedown', (e) => {
                e.preventDefault();
                input.value = el.dataset.name;
                dropdown.style.display = 'none';
            });
        });
    }

    input.addEventListener('focus', () => showSuggestions(input.value));
    input.addEventListener('input', () => showSuggestions(input.value));
    input.addEventListener('blur', () => setTimeout(() => { dropdown.style.display = 'none'; }, 150));

    root.querySelector('#lp-new-group-cancel').addEventListener('click', () => { root.innerHTML = ''; });
    root.querySelector('#lp-new-group-create').addEventListener('click', async () => {
        const name = input.value.trim();
        const errBox = root.querySelector('#lp-new-group-error');
        if (!name) { errBox.textContent = 'Enter a name.'; return; }

        const { error } = await supabase.from('listing_card_groups').insert({
            template_id: state.template.id, name,
        });
        if (error) {
            errBox.textContent = error.code === '23505' ? `A group named "${name}" already exists on this listing.` : error.message;
            return;
        }
        root.innerHTML = '';
        await loadListing(container);
    });
}

// ----------------------------------------------------------------
// Add card to listing (queued — not live yet)
// ----------------------------------------------------------------

function openAddCardModal(container, body) {
    const root = body.querySelector('#lp-modal-root');
    root.innerHTML = `
        <div style="position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:100;">
            <div style="background:var(--bg-secondary); border:1px solid var(--border); border-radius:8px; padding:20px; width:480px; max-width:90vw; max-height:80vh; overflow-y:auto;">
                <h3 style="margin:0 0 12px;">Add card to listing</h3>
                <p style="color:var(--text-secondary); font-size:12px; margin:0 0 10px;">
                    Adds as <strong>queued</strong> (planned, not live on eBay yet). Search by card name.
                </p>
                <input type="search" id="lp-card-search" placeholder="Card name..." style="width:100%; margin-bottom:10px;" />
                <div id="lp-card-search-results" style="max-height:320px; overflow-y:auto;"></div>
                <div style="display:flex; justify-content:flex-end; margin-top:14px;">
                    <button type="button" class="btn" id="lp-add-card-cancel">Close</button>
                </div>
            </div>
        </div>
    `;
    root.querySelector('#lp-add-card-cancel').addEventListener('click', () => { root.innerHTML = ''; });

    let debounceTimer = null;
    root.querySelector('#lp-card-search').addEventListener('input', (e) => {
        clearTimeout(debounceTimer);
        const q = e.target.value.trim();
        debounceTimer = setTimeout(() => runCardSearch(container, root, q), 300);
    });
}

async function runCardSearch(container, root, query) {
    const resultsEl = root.querySelector('#lp-card-search-results');
    if (!query) { resultsEl.innerHTML = ''; return; }

    const { data: cards, error } = await supabase
        .from('card_master').select('id, name, card_number, set_id')
        .ilike('name', `%${query}%`).limit(15);
    if (error) {
        resultsEl.innerHTML = `<p style="color:var(--danger); font-size:12px;">${escapeHtml(error.message)}</p>`;
        return;
    }
    if (!cards || !cards.length) {
        resultsEl.innerHTML = `<p style="color:var(--text-secondary); font-size:12px;">No matches.</p>`;
        return;
    }

    const setIds = [...new Set(cards.map(c => c.set_id).filter(Boolean))];
    const { data: sets } = await supabase.from('card_sets').select('id, name').in('id', setIds);
    const setNameById = Object.fromEntries((sets || []).map(s => [s.id, s.name]));

    resultsEl.innerHTML = cards.map(c => `
        <div class="lp-card-result" data-card-id="${c.id}" style="padding:8px; border-bottom:1px solid var(--border); cursor:pointer; font-size:13px;">
            ${escapeHtml(c.name)} #${escapeHtml(c.card_number || '?')}
            <span style="color:var(--text-secondary);">${escapeHtml(setNameById[c.set_id] || '')}</span>
        </div>
    `).join('');

    resultsEl.querySelectorAll('.lp-card-result').forEach(el => {
        el.addEventListener('click', () => showVariantPicker(container, root, el.dataset.cardId));
    });
}

async function showVariantPicker(container, root, cardId) {
    const resultsEl = root.querySelector('#lp-card-search-results');
    const { data: variants, error } = await supabase
        .from('card_variants').select('id, foil_type, foil_pattern, texture, stamp_type')
        .eq('card_id', cardId);
    if (error) {
        resultsEl.innerHTML = `<p style="color:var(--danger); font-size:12px;">${escapeHtml(error.message)}</p>`;
        return;
    }

    resultsEl.innerHTML = `
        <p style="font-size:12px; color:var(--text-secondary);">Pick a variant:</p>
        ${(variants || []).map(v => {
            const parts = [v.foil_type, v.foil_pattern, v.texture, v.stamp_type].filter(Boolean);
            return `<div class="lp-variant-result" data-variant-id="${v.id}" style="padding:8px; border-bottom:1px solid var(--border); cursor:pointer; font-size:13px;">
                ${escapeHtml(parts.join(' · ') || 'Standard')}
            </div>`;
        }).join('')}
    `;

    resultsEl.querySelectorAll('.lp-variant-result').forEach(el => {
        el.addEventListener('click', async () => {
            const { count } = await supabase.from('listing_card_assignments')
                .select('id', { count: 'exact', head: true }).eq('template_id', state.template.id);
            const { error: insErr } = await supabase.from('listing_card_assignments').insert({
                template_id: state.template.id,
                variant_id: el.dataset.variantId,
                priority_rank: count || 0,
                status: 'queued',
            });
            if (insErr) {
                window.alert(`Failed to add card: ${insErr.message}`);
                return;
            }
            root.innerHTML = '';
            await loadListing(container);
        });
    });
}

// ----------------------------------------------------------------
// Push
// ----------------------------------------------------------------

async function doPush(container, dryRun) {
    const body = container.querySelector('#lp-body');
    const msg = body.querySelector('#lp-push-msg');
    const pushBtn = body.querySelector('#lp-push-btn');
    const dryBtn = body.querySelector('#lp-push-dryrun-btn');

    if (!dryRun) {
        const confirmed = window.confirm(
            `This will send live price/quantity changes to eBay listing ${state.listingId}. `
            + `Only rows with sync_enabled=true and status='active' will actually be pushed — `
            + `run Dry-run first if you haven't already. Continue?`
        );
        if (!confirmed) return;
    }

    pushBtn.disabled = true;
    dryBtn.disabled = true;
    msg.innerHTML = `<span style="color:var(--text-secondary);">${dryRun ? 'Checking' : 'Pushing'}...</span>`;

    try {
        const resp = await fetch(`${PICKING_API_URL}/api/push-prices`, {
            method: 'POST',
            headers: { 'x-picking-token': PICKING_API_TOKEN, 'content-type': 'application/json' },
            body: JSON.stringify({ listing_id: state.listingId, account_num: state.accountNum, dry_run: dryRun }),
        });
        if (!resp.ok) {
            const detail = await resp.text().catch(() => '');
            throw new Error(`${resp.status} ${detail}`);
        }
        const result = await resp.json();
        const warningsNote = result.warnings && result.warnings.length
            ? ` — ${result.warnings.length} warning(s): ${escapeHtml(result.warnings.join('; '))}` : '';
        msg.innerHTML = `<span style="color:var(--success);">
            ${dryRun ? 'Would push' : 'Pushed'} ${result.pushed} of ${result.resolved} row(s)${warningsNote}
        </span>`;
        if (!dryRun) await loadListing(container);
    } catch (err) {
        console.error(err);
        msg.innerHTML = `<span style="color:var(--danger)">Push failed: ${escapeHtml(err.message)}
            — is picking_api.py running and reachable at ${PICKING_API_URL}?</span>`;
    } finally {
        pushBtn.disabled = false;
        dryBtn.disabled = false;
    }
}

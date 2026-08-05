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
// desktop's Tailscale address or token ever changes.
const PICKING_API_URL = 'https://desktop-tu1m2fc.tail2c58d7.ts.net:8765';
const PICKING_API_TOKEN = 'I1knbOJAve_UZJQHAFZANds9-HalgCxcRJw1GXDg404';

function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function cardLabel(r) {
    return r.card_name ? `${r.card_number ?? ''} ${r.card_name}`.trim() : r.derived_label;
}

// Same thumbnail + hover-zoom convention as picking.js: a small fixed
// image (class="card-thumb") that a page-level mouseover listener blows
// up into a floating preview near the cursor.
function imgHtml(url) {
    if (!url) return `<div style="width:40px; height:56px; background:var(--bg-tertiary); border-radius:3px; border:1px solid var(--border);"></div>`;
    return `<img src="${escapeHtml(url)}" alt="" loading="lazy" class="card-thumb"
                style="width:40px; height:56px; object-fit:cover; border-radius:3px; border:1px solid var(--border); cursor:zoom-in;"
                onerror="this.replaceWith(Object.assign(document.createElement('div'),
                    {style:'width:40px;height:56px;background:var(--bg-tertiary);border-radius:3px;border:1px solid var(--border);'}))">`;
}

// Shared between rowHTML() (full render) and refreshRowDerivedCells()
// (in-place patch after staging a picture) so the two never drift.
function thumbTitle(r) {
    return r.eps_picture_url
        ? 'Picture staged for eBay — click to replace'
        : 'Click to stage a picture for eBay (uploads to EPS now, attaches when this card is pushed live)';
}

function thumbInnerHTML(r) {
    return `
        ${imgHtml(r.eps_picture_url || r.image_url)}
        ${r.eps_picture_url ? '<span style="position:absolute; top:-4px; right:-4px; background:var(--success); color:#000; font-size:10px; font-weight:700; border-radius:50%; width:14px; height:14px; display:flex; align-items:center; justify-content:center;">&#10003;</span>' : ''}
    `;
}

// Hover-to-zoom preview, one shared floating element cached on window
// (index.html re-imports this module with a fresh ?v= on every
// navigation) — mirrors picking.js's setupImagePreview() exactly.
function setupImagePreview(container) {
    let preview = window.__cbmListingPricingPreview;
    if (!preview) {
        preview = document.createElement('div');
        preview.id = 'cbm-listing-pricing-img-preview';
        preview.style.cssText = `
            position:fixed; pointer-events:none; z-index:9999; display:none;
            border:1px solid var(--border); border-radius:6px; overflow:hidden;
            box-shadow:0 8px 28px rgba(0,0,0,0.5); background:var(--bg-secondary);
        `;
        const img = document.createElement('img');
        img.style.cssText = 'display:block; max-width:280px; max-height:390px;';
        preview.appendChild(img);
        document.body.appendChild(preview);
        window.__cbmListingPricingPreview = preview;
    }

    container.addEventListener('mouseover', (e) => {
        const t = e.target.closest('img.card-thumb');
        if (!t || !t.src) return;
        preview.firstChild.src = t.src;
        preview.style.display = 'block';
    });

    container.addEventListener('mousemove', (e) => {
        if (preview.style.display !== 'block') return;
        const pad = 16;
        let x = e.clientX + pad;
        let y = e.clientY + pad;
        if (x + 300 > window.innerWidth) x = e.clientX - 300 - pad;
        if (y + 400 > window.innerHeight) y = Math.max(8, window.innerHeight - 400);
        preview.style.left = `${x}px`;
        preview.style.top = `${y}px`;
    });

    container.addEventListener('mouseout', (e) => {
        if (e.target.closest('img.card-thumb')) preview.style.display = 'none';
    });
}

let state = {
    platform: 'ebay',
    listingId: '',
    templateId: null,        // primary lookup key once a template is open — set by
                              // openTemplate(), works whether or not listing_id is set yet
    accountNum: 1,
    templates: [],           // all listing_templates rows (landing view)
    template: null,          // the one currently open, or null when on the landing view
    resolvedRows: [],        // resolve_listing_prices() output
    listingRowsByPLId: {},   // platform_listing_id -> platform_listings row (sync_enabled/status/pushed_*/external_id)
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
    setupImagePreview(container);
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
    state.templateId = null;

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
                    <th>Name</th><th>eBay Item #</th><th>Platform</th><th>Account</th><th>Kind</th><th style="width:130px;"></th>
                </tr></thead>
                <tbody>
                    ${state.templates.map(t => `
                        <tr class="lp-template-row" data-id="${t.id}" style="cursor:pointer;">
                            <td>${escapeHtml(t.name)}</td>
                            <td>${t.listing_id ? escapeHtml(t.listing_id) : '<span style="color:var(--text-secondary);">(draft — no listing yet)</span>'}</td>
                            <td>${escapeHtml(t.platform)}</td>
                            <td>${t.account ? escapeHtml(t.account) : '<span style="color:var(--text-secondary);">All accounts</span>'}</td>
                            <td>${escapeHtml(t.listing_kind || 'variation')}</td>
                            <td>
                                <button class="btn lp-edit-template-btn" data-id="${t.id}">Edit</button>
                                <button class="btn lp-duplicate-template-btn" data-id="${t.id}">Duplicate</button>
                            </td>
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
    body.querySelectorAll('.lp-duplicate-template-btn').forEach(btn => {
        btn.addEventListener('click', (e) => { e.stopPropagation(); openTemplateModal(container, null, btn.dataset.id); });
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
    state.templateId = t.id;
    await loadListing(container);
}

// `duplicateFromId` seeds the form from an existing template's config
// (name/platform/account/listing_kind/base_price/default_quantity_limit/
// low_stock_*/display_sort/name_format) while still creating a brand-new
// row (isEdit stays false — plain INSERT) — name gets "(copy)" appended
// and listing_id is forced blank, since the duplicate isn't tied to a
// real eBay listing yet. The roster itself (listing_card_assignments)
// stays empty, built fresh via "Add card to listing" — but the group
// SHELLS (listing_card_groups: name + linked pricing_profile) ARE copied,
// since the whole point of duplicating a template is usually "same
// rarity-tier grouping/pricing structure, different physical eBay
// listing" — recreating every group + profile link by hand for each new
// listing would defeat that. Groups copy empty (no roster rows point at
// them yet) — cards get assigned into them normally once added.
function openTemplateModal(container, templateId, duplicateFromId = null) {
    const isEdit = !!templateId;
    const duplicateSource = duplicateFromId ? state.templates.find(t => t.id === duplicateFromId) : null;
    const existing = isEdit ? state.templates.find(t => t.id === templateId) : duplicateSource;
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
                <h3 style="margin:0 0 16px;">${isEdit ? 'Edit listing template' : duplicateSource ? 'Duplicate listing template' : 'New listing template'}</h3>
                ${duplicateSource ? `<p style="color:var(--text-secondary); font-size:12px; margin:0 0 12px;">Copied from "${escapeHtml(duplicateSource.name)}" — groups and their pricing profile links are copied (empty, no cards yet); the roster itself is NOT copied.</p>` : ''}
                <form id="lp-template-form">
                    <div style="display:flex; flex-direction:column; gap:10px;">
                        ${f('Platform', 'text', 'platform', existing?.platform || 'ebay')}
                        ${f('Account (blank = applies to all accounts)', 'text', 'account', existing?.account || '', 'e.g. BIGGYFISH', '', true)}
                        ${f('Name', 'text', 'name', duplicateSource ? `${duplicateSource.name} (copy)` : (existing?.name || ''), 'e.g. commons')}
                        ${f('eBay Item # (listing_id) — this template IS that listing', 'text', 'listing_id', duplicateSource ? '' : (existing?.listing_id || ''), 'e.g. 336691917730', '', true)}
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
            // Both listing_card_assignments.template_id and
            // platform_listings.template_id are NO ACTION FKs — a plain
            // DELETE on listing_templates fails outright the moment any
            // roster row or platform_listings row still references it
            // (confirmed live: every real template already has active
            // roster rows, so the old plain-delete button never actually
            // worked for a template anyone had used). Show the real
            // counts, confirm explicitly, then clean up in order:
            // detach platform_listings (kept as history, not deleted —
            // template_id just goes NULL) -> delete the roster
            // (listing_card_groups already cascades on its own) ->
            // delete the template itself.
            const [{ count: activeCount }, { count: queuedCount }, { count: soldOutCount }, { count: platformCount }] = await Promise.all([
                supabase.from('listing_card_assignments').select('id', { count: 'exact', head: true }).eq('template_id', templateId).eq('status', 'active'),
                supabase.from('listing_card_assignments').select('id', { count: 'exact', head: true }).eq('template_id', templateId).eq('status', 'queued'),
                supabase.from('listing_card_assignments').select('id', { count: 'exact', head: true }).eq('template_id', templateId).eq('status', 'sold_out_retained'),
                supabase.from('platform_listings').select('id', { count: 'exact', head: true }).eq('template_id', templateId),
            ]);
            const totalRoster = (activeCount || 0) + (queuedCount || 0) + (soldOutCount || 0);

            let confirmMsg = `Delete template "${existing.name}"? This can't be undone.`;
            if (totalRoster > 0 || platformCount > 0) {
                confirmMsg = `Delete template "${existing.name}"?\n\n`
                    + `It still has ${activeCount || 0} active, ${queuedCount || 0} queued, and ${soldOutCount || 0} `
                    + `sold-out-retained roster row(s)${platformCount ? `, and ${platformCount} platform_listings row(s) referencing it` : ''}.\n\n`
                    + `This does NOT remove anything from eBay itself — only this app's tracking/pricing for it. `
                    + `The roster will be deleted; platform_listings rows are kept as history but detached from this template.\n\n`
                    + `This cannot be undone. Continue?`;
            }
            if (!window.confirm(confirmMsg)) return;

            if (platformCount > 0) {
                const { error: detachErr } = await supabase.from('platform_listings')
                    .update({ template_id: null }).eq('template_id', templateId);
                if (detachErr) { window.alert(`Failed to detach platform listings: ${detachErr.message}`); return; }
            }
            if (totalRoster > 0) {
                const { error: rosterErr } = await supabase.from('listing_card_assignments')
                    .delete().eq('template_id', templateId);
                if (rosterErr) { window.alert(`Failed to clear roster: ${rosterErr.message}`); return; }
            }
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
            if (isEdit) {
                const { error } = await supabase.from('listing_templates').update(payload).eq('id', templateId);
                if (error) throw error;
            } else {
                const { data: newTemplate, error } = await supabase.from('listing_templates').insert(payload).select().single();
                if (error) throw error;

                if (duplicateSource) {
                    const { data: sourceGroups, error: groupsErr } = await supabase
                        .from('listing_card_groups')
                        .select('name, profile_id')
                        .eq('template_id', duplicateSource.id);
                    if (groupsErr) throw groupsErr;

                    if (sourceGroups?.length) {
                        const { error: copyErr } = await supabase.from('listing_card_groups').insert(
                            sourceGroups.map(g => ({ template_id: newTemplate.id, name: g.name, profile_id: g.profile_id }))
                        );
                        if (copyErr) throw copyErr;
                    }
                }
            }
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
        // Once a template's been opened once, state.templateId is the
        // reliable lookup key — works whether or not listing_id is set
        // yet (a draft template's listing_id is NULL, and Supabase's
        // .eq('listing_id', null) never matches, same as raw SQL). Falls
        // back to the old (platform, listing_id) lookup only for the
        // legacy "typed an Item # with no template yet" path, where the
        // template's id isn't known until after createTemplate() inserts it.
        const { data: template, error: tErr } = state.templateId
            ? await supabase.from('listing_templates').select('*').eq('id', state.templateId).maybeSingle()
            : await supabase.from('listing_templates').select('*')
                  .eq('platform', state.platform).eq('listing_id', state.listingId).maybeSingle();
        if (tErr) throw tErr;

        state.template = template;

        if (!template) {
            body.innerHTML = noTemplateHTML();
            body.querySelector('#lp-create-template-btn').addEventListener('click', () => createTemplate(container));
            return;
        }

        state.templateId = template.id;
        // A draft template (no eBay Item # yet) can't be resolved via the
        // (platform, listing_id) RPC path — migration 016 added a
        // p_template_id path for exactly this. Nothing about the
        // "unimported existing platform_listings rows" check applies
        // either — there's no live listing yet for anything to be
        // unimported from.
        const isDraft = !template.listing_id;

        const [{ data: resolved, error: rErr }, { data: groups, error: gErr }, platformCountResult] = await Promise.all([
            supabase.rpc('resolve_listing_prices', isDraft
                ? { p_platform: state.platform, p_template_id: template.id }
                : { p_platform: state.platform, p_listing_id: state.listingId }),
            supabase.from('listing_card_groups').select('*').eq('template_id', template.id).order('name'),
            // Excludes 'delisted' rows — those are cards Remove-from-listing
            // already pulled off eBay, retained purely as history. They're
            // NOT unimported: the card is already correctly represented as
            // a 'queued' roster row (platform_listing_id cleared), just not
            // pointing at this now-dead row. Counting them here would offer
            // "Import into roster" as if they were new, which would create
            // a duplicate 'active' roster entry for a listing that isn't
            // actually live on eBay.
            isDraft ? Promise.resolve({ count: 0 }) : supabase.from('platform_listings')
                .select('id', { count: 'exact', head: true })
                .eq('platform', state.platform).eq('listing_id', state.listingId).neq('status', 'delisted'),
        ]);
        if (rErr) throw rErr;
        if (gErr) throw gErr;

        state.resolvedRows = resolved || [];
        state.groups = groups || [];

        const plIds = (resolved || []).map(r => r.platform_listing_id).filter(Boolean);
        if (plIds.length) {
            const { data: listingRows } = await supabase
                .from('platform_listings')
                .select('id, external_id, pushed_price, pushed_qty, pushed_at, sync_enabled, status')
                .in('id', plIds);
            state.listingRowsByPLId = Object.fromEntries((listingRows || []).map(r => [r.id, r]));
        } else {
            state.listingRowsByPLId = {};
        }

        const rosterPLIds = new Set(plIds);
        state.unimportedCount = isDraft ? 0 : Math.max((platformCountResult.count || 0) - rosterPLIds.size, 0);

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
    const qtyDiff = row.pushed_qty == null || row.pushed_qty !== resolvedQty(r);
    return priceDiff || qtyDiff;
}

function resolvedQty(r) {
    const available = r.available_qty ?? 0;
    let qty = r.low_stock_qty != null ? Math.max(available - r.low_stock_qty, 0) : available;
    if (r.quantity_limit != null) qty = Math.min(qty, r.quantity_limit);
    return qty;
}

// Re-resolves ONE row from the server (still the only place derived
// values — tier lookups, floors, the shared-inventory subtraction, etc.
// — ever get computed, so this never duplicates that logic in JS) and
// patches just its already-rendered <td> cells in place, instead of
// reloading/rebuilding the whole table. Used after the per-cell pin
// edits (low-stock, manual price, qty limit, custom name, market price)
// so a fast edit doesn't blow away scroll position or drop focus across
// the whole grid. Deliberately does NOT touch any input's own DOM node
// or re-wire any listeners — only text/attribute content of derived,
// non-input cells changes, so nothing needs re-wiring.
async function refreshRowDerivedCells(container, rowId) {
    const isDraft = !state.template?.listing_id;
    const { data, error } = await supabase.rpc('resolve_listing_prices', isDraft
        ? { p_platform: state.platform, p_template_id: state.template.id }
        : { p_platform: state.platform, p_listing_id: state.listingId });
    if (error) { console.error('Failed to refresh row:', error); return; }

    const fresh = (data || []).find(r => r.row_id === rowId);
    if (!fresh) return; // row no longer exists (deleted/status changed elsewhere) — next full reload will catch it

    const idx = state.resolvedRows.findIndex(r => r.row_id === rowId);
    if (idx !== -1) state.resolvedRows[idx] = fresh;

    const tr = container.querySelector(`tr[data-row-id="${rowId}"]`);
    if (!tr) return;

    const stale = fresh.status === 'active' && needsPush(fresh);
    tr.style.background = stale ? 'rgba(245,166,35,0.06)' : '';

    const resolvedCell = tr.querySelector('.lp-resolved-price-cell');
    if (resolvedCell) resolvedCell.textContent = formatPrice(fresh.resolved_price);

    const sourceCell = tr.querySelector('.lp-source-cell');
    if (sourceCell) sourceCell.innerHTML = sourceBadge(fresh.price_source);

    const availableCell = tr.querySelector('.lp-available-cell');
    if (availableCell) availableCell.textContent = fresh.available_qty ?? '-';

    const resolvedQtyCell = tr.querySelector('.lp-resolved-qty-cell');
    if (resolvedQtyCell) resolvedQtyCell.textContent = resolvedQty(fresh);

    const syncedCell = tr.querySelector('.lp-synced-cell');
    if (syncedCell) {
        const isActive = fresh.status === 'active';
        syncedCell.innerHTML = isActive
            ? (isGatedIn(fresh) ? '<span style="color:var(--success); font-size:12px;">yes</span>' : '<span style="color:var(--text-secondary); font-size:12px;">no</span>')
            : '<span style="color:var(--text-secondary); font-size:12px;">n/a</span>';
    }

    // Market price cell shows a "manually set" highlight — refresh that
    // too since editing OTHER pins never changes it, but editing the
    // market price itself needs its own input's styling/title updated.
    const marketInput = tr.querySelector('.lp-market-price-input');
    if (marketInput) {
        marketInput.title = fresh.market_price_source === 'manual' ? 'Manually set' : '';
        marketInput.style.background = fresh.market_price_source === 'manual' ? 'rgba(167,139,250,0.12)' : '';
        marketInput.style.borderColor = fresh.market_price_source === 'manual' ? '#a78bfa' : '';
    }

    // Thumbnail (image + "staged" checkmark badge) — only relevant for
    // queued rows (see rowHTML()), but harmless to check regardless.
    const thumbWrapper = tr.querySelector('.lp-thumb-upload');
    if (thumbWrapper) {
        thumbWrapper.title = thumbTitle(fresh);
        thumbWrapper.innerHTML = thumbInnerHTML(fresh);
    }
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
    const isDraft = !state.template.listing_id;
    const pending = rows.filter(r => r.status === 'active' && needsPush(r));
    const pendingGated = pending.filter(r => isGatedIn(r));
    // Queued rows might get promoted by a push (250-cap logic, decided
    // live against eBay's actual variation count) — the exact count isn't
    // knowable client-side, so just treat "any queued rows exist" as a
    // reason the Push button shouldn't be disabled. doPush()'s dry-run
    // pre-check catches the case where nothing actually happens.
    const queuedCount = rows.filter(r => r.status === 'queued').length;
    const pushEnabled = pendingGated.length > 0 || queuedCount > 0;

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
            ${isDraft
                ? `<span class="badge" style="background:rgba(245,166,35,0.15); color:var(--warning);">draft — not live on eBay yet</span>
                   <span style="font-size:13px; color:var(--text-secondary);">${rows.length} card(s) queued</span>`
                : `<span style="font-size:13px; color:var(--text-secondary);">
                       ${rows.length} card(s) on roster
                       ${pendingGated.length > 0 ? ` · <span style="color:var(--warning);">${pendingGated.length} need push</span>` : ''}
                       ${queuedCount > 0 ? ` · <span style="color:var(--warning);">${queuedCount} queued</span>` : ''}
                       ${pendingGated.length === 0 && queuedCount === 0 ? ' · in sync' : ''}
                   </span>
                   <button class="btn btn-primary" id="lp-push-btn" style="margin-left:auto;" ${pushEnabled ? '' : 'disabled'}>
                       Push ${pendingGated.length > 0 ? `(${pendingGated.length})` : ''}
                   </button>
                   <button class="btn" id="lp-push-dryrun-btn">Dry-run</button>`}
        </div>
        <div id="lp-push-msg" style="font-size:13px; margin-bottom:12px;"></div>

        <div style="display:flex; align-items:center; gap:10px; margin-bottom:6px; flex-wrap:wrap; padding-bottom:12px; border-bottom:1px solid var(--border);">
            ${metadataPanelHTML(isDraft)}
        </div>
        <div id="lp-create-listing-msg" style="font-size:13px; margin-bottom:14px;"></div>

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
            <button class="btn" id="lp-bulk-sync-on-btn" style="font-size:12px;" ${state.selected.size === 0 ? 'disabled' : ''}>Enable sync</button>
            <button class="btn" id="lp-bulk-sync-off-btn" style="font-size:12px;" ${state.selected.size === 0 ? 'disabled' : ''}>Disable sync</button>
        </div>

        ${state.groups.map(g => groupSectionHTML(g, byGroup[g.id] || [])).join('')}
        ${groupSectionHTML(null, ungrouped)}

        <div id="lp-modal-root"></div>
    `;

    wireControls(container, body);
    wireMetadataControls(container, body, isDraft);
}

// ----------------------------------------------------------------
// Draft templates — a template with no listing_id yet. Cards go on the
// roster (queued) exactly like normal, but instead of Push/Push-live
// there's a listing-metadata panel (clone from an existing listing, or
// fill in by hand) and a "Create listing" batch action that submits
// AddFixedPriceItem for the first time — see
// docs/plans/listing-pricing-system.md, PLANNING session 14 / BUILT
// session 15, and importer/ebay_create_listing.py in the CBMM repo.
// ----------------------------------------------------------------

const METADATA_FIELDS = [
    ['category_id', 'Category ID'],
    ['title', 'Title'],
    ['description_html', 'Description'],
    ['listing_duration', 'Duration'],
    ['item_location', 'Location'],
    ['item_country', 'Country'],
    ['item_postal_code', 'Postal code'],
    ['condition_id', 'Condition ID'],
    ['payment_policy_id', 'Payment policy'],
    ['return_policy_id', 'Return policy'],
    ['shipping_policy_id', 'Shipping policy'],
];

// Inline header-level content — NOT a boxed panel, deliberately (Fei's
// call: this is top-level listing identity, not roster-page furniture,
// so it lives directly in the header area renderBody() wraps this in,
// not buried in its own box further down the page). Shown for BOTH
// draft templates (pre-creation: clone/edit + preview + create) and
// already-live ones (post-creation: edit + revise only — no
// clone/preview/create, since the listing already exists). Same "Edit
// fields" modal either way; only what happens on Save differs (DB-only
// for a draft, a real ReviseFixedPriceItem call for a live listing —
// see openManualMetadataModal's isDraft param).
function metadataPanelHTML(isDraft) {
    const t = state.template;
    const missing = METADATA_FIELDS.filter(([key]) => !t[key]).map(([, label]) => label);

    const selfSynced = t.source === 'cloned' && t.cloned_from_listing_id === t.listing_id;

    return `
        <span style="font-size:12px; color:var(--text-secondary);">
            ${t.title ? `"${escapeHtml(t.title)}"` : '<em>No title set</em>'}
            ${t.title ? (
                selfSynced ? ' — header synced from eBay'
                : t.source === 'cloned' ? ` — cloned from ${escapeHtml(t.cloned_from_listing_id || '?')}`
                : ' — set manually'
            ) : ''}
        </span>
        ${isDraft ? `
            <span style="font-size:12px; color:${missing.length ? 'var(--warning)' : 'var(--success)'};">
                ${missing.length ? `Missing: ${escapeHtml(missing.join(', '))}` : 'Metadata complete'}
            </span>
        ` : ''}
        ${isDraft ? `<button class="btn" id="lp-clone-metadata-btn" style="margin-left:auto;">Clone from existing listing</button>` : ''}
        ${!isDraft ? `<button class="btn" id="lp-sync-metadata-btn" style="margin-left:auto;"
                              title="Re-fetch this listing's header info (title/description/category/location/policies) from eBay, overwriting anything stored locally — does not touch cards, roster, pricing, or quantities">
                          Sync header from eBay
                      </button>` : ''}
        <button class="btn" id="lp-manual-metadata-btn">Edit fields</button>
        ${isDraft ? `
            <button class="btn" id="lp-preview-listing-btn">Preview readiness</button>
            <button class="btn btn-primary" id="lp-create-listing-btn" ${missing.length ? 'disabled' : ''}
                    title="${missing.length ? 'Fill in the missing metadata above first' : ''}">
                Create listing
            </button>
        ` : ''}
    `;
}

function wireMetadataControls(container, body, isDraft) {
    const cloneBtn = body.querySelector('#lp-clone-metadata-btn');
    if (cloneBtn) cloneBtn.addEventListener('click', () => openCloneMetadataModal(container, body));
    const syncBtn = body.querySelector('#lp-sync-metadata-btn');
    if (syncBtn) syncBtn.addEventListener('click', () => doSyncFromEbay(container));
    body.querySelector('#lp-manual-metadata-btn').addEventListener('click', () => openManualMetadataModal(container, body, isDraft));
    const previewBtn = body.querySelector('#lp-preview-listing-btn');
    if (previewBtn) previewBtn.addEventListener('click', () => doPreviewNewListing(container));
    const createBtn = body.querySelector('#lp-create-listing-btn');
    if (createBtn && !createBtn.disabled) createBtn.addEventListener('click', () => doCreateListing(container));
}

async function doSyncFromEbay(container) {
    const body = container.querySelector('#lp-body');
    const msg = body.querySelector('#lp-create-listing-msg');
    const listingId = state.template.listing_id;

    const confirmed = window.confirm(
        `Re-fetch header info (title/description/category/location/policies) for eBay listing `
        + `${listingId} and overwrite whatever's stored locally? Cards, roster, pricing, and `
        + `quantities are untouched. This only updates our own record — nothing is sent to eBay.`
    );
    if (!confirmed) return;

    msg.innerHTML = `<span style="color:var(--text-secondary);">Syncing from eBay...</span>`;
    try {
        await callCloneMetadata(listingId);
        msg.innerHTML = `<span style="color:var(--success);">Synced.</span>`;
        await loadListing(container);
    } catch (err) {
        console.error(err);
        msg.innerHTML = `<span style="color:var(--danger)">Sync failed: ${escapeHtml(err.message)}</span>`;
    }
}

async function callBusinessPolicies() {
    const resp = await fetch(`${PICKING_API_URL}/api/business-policies?account_num=${state.accountNum}`, {
        headers: { 'x-picking-token': PICKING_API_TOKEN },
    });
    if (!resp.ok) throw new Error(`${resp.status} ${await resp.text().catch(() => '')}`);
    return resp.json();
}

async function callCloneMetadata(sourceListingId) {
    const resp = await fetch(`${PICKING_API_URL}/api/listing-metadata/clone`, {
        method: 'POST',
        headers: { 'x-picking-token': PICKING_API_TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({
            template_id: state.template.id, source_listing_id: sourceListingId, account_num: state.accountNum,
        }),
    });
    if (!resp.ok) throw new Error(`${resp.status} ${await resp.text().catch(() => '')}`);
    return resp.json();
}

async function callSetMetadata(fields) {
    const resp = await fetch(`${PICKING_API_URL}/api/listing-metadata/manual`, {
        method: 'POST',
        headers: { 'x-picking-token': PICKING_API_TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({ template_id: state.template.id, ...fields }),
    });
    if (!resp.ok) throw new Error(`${resp.status} ${await resp.text().catch(() => '')}`);
    return resp.json();
}

async function callReviseMetadata(fields, dryRun) {
    const resp = await fetch(`${PICKING_API_URL}/api/listing-metadata/revise`, {
        method: 'POST',
        headers: { 'x-picking-token': PICKING_API_TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({
            template_id: state.template.id, account_num: state.accountNum, dry_run: dryRun, ...fields,
        }),
    });
    if (!resp.ok) throw new Error(`${resp.status} ${await resp.text().catch(() => '')}`);
    return resp.json();
}

async function callPreviewNewListing() {
    const resp = await fetch(
        `${PICKING_API_URL}/api/preview-new-listing/${state.template.id}?account_num=${state.accountNum}`,
        { headers: { 'x-picking-token': PICKING_API_TOKEN } },
    );
    if (!resp.ok) throw new Error(`${resp.status} ${await resp.text().catch(() => '')}`);
    return resp.json();
}

async function callCreateListing(dryRun) {
    const resp = await fetch(`${PICKING_API_URL}/api/create-listing`, {
        method: 'POST',
        headers: { 'x-picking-token': PICKING_API_TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({ template_id: state.template.id, account_num: state.accountNum, dry_run: dryRun }),
    });
    if (!resp.ok) throw new Error(`${resp.status} ${await resp.text().catch(() => '')}`);
    return resp.json();
}

async function openCloneMetadataModal(container, body) {
    const root = body.querySelector('#lp-modal-root');
    root.innerHTML = `
        <div style="position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:100;">
            <div style="background:var(--bg-secondary); border:1px solid var(--border); border-radius:8px; padding:20px; width:420px; max-width:90vw;">
                <h3 style="margin:0 0 12px;">Clone listing metadata</h3>
                <p style="color:var(--text-secondary); font-size:12px; margin:0 0 10px;">
                    Copies category, description, location, duration, and business policies from an
                    existing live listing — you can review/edit anything afterward before creating.
                </p>
                <label style="font-size:13px; display:block; margin-bottom:10px;">Existing eBay Item #
                    <input type="text" id="lp-clone-source-id" placeholder="e.g. 336204674240" style="width:100%; margin-top:4px;" />
                </label>
                <div id="lp-clone-error" style="color:var(--danger); font-size:12px; margin-bottom:8px;"></div>
                <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:8px;">
                    <button type="button" class="btn" id="lp-clone-cancel">Cancel</button>
                    <button type="button" class="btn btn-primary" id="lp-clone-go">Clone</button>
                </div>
            </div>
        </div>
    `;

    root.querySelector('#lp-clone-cancel').addEventListener('click', () => { root.innerHTML = ''; });
    root.querySelector('#lp-clone-go').addEventListener('click', async () => {
        const sourceId = root.querySelector('#lp-clone-source-id').value.trim();
        const errBox = root.querySelector('#lp-clone-error');
        if (!sourceId) { errBox.textContent = 'Enter an Item #.'; return; }

        const goBtn = root.querySelector('#lp-clone-go');
        goBtn.disabled = true;
        errBox.textContent = '';
        try {
            await callCloneMetadata(sourceId);
            root.innerHTML = '';
            await loadListing(container);
        } catch (err) {
            errBox.textContent = err.message;
            goBtn.disabled = false;
        }
    });
}

async function openManualMetadataModal(container, body, isDraft) {
    const t = state.template;
    let policies = { payment: [], return: [], shipping: [] };
    let priorTemplates = [];
    try {
        [policies, priorTemplates] = await Promise.all([
            callBusinessPolicies(),
            supabase.from('listing_templates')
                .select('category_id, listing_duration, item_location, item_country, item_postal_code, condition_id')
                .then(({ data }) => data || []),
        ]);
    } catch (err) {
        console.error('Failed to load business policies / prior templates:', err);
    }

    // Distinct non-null values already used on ANY template — for fields
    // that are almost always the same across Fei's listings (category,
    // duration, location, policies are already dropdowns for the same
    // reason), a dropdown of "what you've used before" beats retyping a
    // raw ID/code every time, with an escape hatch for a genuinely new one.
    const priorValues = (key) => [...new Set(priorTemplates.map(r => r[key]).filter(Boolean))].sort();

    const root = body.querySelector('#lp-modal-root');
    const OTHER = '__other__';
    const policySelect = (id, label, current, options) => `
        <label style="font-size:13px; display:block; margin-bottom:10px;">${label}
            <select id="${id}" style="width:100%; margin-top:4px;">
                <option value="">(none)</option>
                ${options.map(o => `<option value="${escapeHtml(o.profile_id)}" ${String(current) === String(o.profile_id) ? 'selected' : ''}>
                    ${escapeHtml(o.profile_name)}
                </option>`).join('')}
            </select>
        </label>
    `;
    // A dropdown of previously-used values plus "Other (type new)..." —
    // selecting Other reveals a paired free-text input. wireSelectOrOther()
    // toggles that input's visibility; valOrOther() reads whichever is active.
    const selectOrOtherField = (id, label, value, options) => {
        const known = options.includes(value);
        return `
            <label style="font-size:13px; display:block; margin-bottom:10px;">${label}
                <select id="${id}" style="width:100%; margin-top:4px;">
                    <option value="">(none)</option>
                    ${options.map(o => `<option value="${escapeHtml(o)}" ${value === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}
                    <option value="${OTHER}" ${value && !known ? 'selected' : ''}>Other (type new)...</option>
                </select>
                <input type="text" id="${id}-other" placeholder="Type a new value"
                       value="${escapeHtml(value && !known ? value : '')}"
                       style="width:100%; margin-top:4px; display:${value && !known ? 'block' : 'none'};" />
            </label>
        `;
    };
    const textField = (id, label, value, multiline = false) => `
        <label style="font-size:13px; display:block; margin-bottom:10px;">${label}
            ${multiline
                ? `<textarea id="${id}" rows="4" style="width:100%; margin-top:4px;">${escapeHtml(value || '')}</textarea>`
                : `<input type="text" id="${id}" value="${escapeHtml(value || '')}" style="width:100%; margin-top:4px;" />`}
        </label>
    `;

    root.innerHTML = `
        <div style="position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:100; overflow-y:auto;">
            <div style="background:var(--bg-secondary); border:1px solid var(--border); border-radius:8px; padding:20px; width:480px; max-width:90vw; max-height:85vh; overflow-y:auto;">
                <h3 style="margin:0 0 12px;">Edit listing metadata</h3>
                ${!isDraft ? `<p style="color:var(--warning); font-size:12px; margin:0 0 10px;">
                    This listing is already live — saving revises it on eBay for real
                    (${escapeHtml(t.listing_id || '')}), not just a local edit.
                </p>` : ''}
                ${selectOrOtherField('lp-meta-category', 'Category ID', t.category_id, priorValues('category_id'))}
                ${textField('lp-meta-title', 'Title', t.title)}
                ${textField('lp-meta-description', 'Description (HTML)', t.description_html, true)}
                ${selectOrOtherField('lp-meta-duration', 'Listing duration', t.listing_duration, priorValues('listing_duration'))}
                ${selectOrOtherField('lp-meta-location', 'Location', t.item_location, priorValues('item_location'))}
                ${selectOrOtherField('lp-meta-country', 'Country', t.item_country, priorValues('item_country'))}
                ${selectOrOtherField('lp-meta-postal', 'Postal code', t.item_postal_code, priorValues('item_postal_code'))}
                ${selectOrOtherField('lp-meta-condition', 'Condition ID', t.condition_id, priorValues('condition_id'))}
                ${policySelect('lp-meta-payment', 'Payment policy', t.payment_policy_id, policies.payment)}
                ${policySelect('lp-meta-return', 'Return policy', t.return_policy_id, policies.return)}
                ${policySelect('lp-meta-shipping', 'Shipping policy', t.shipping_policy_id, policies.shipping)}
                <div id="lp-meta-error" style="color:var(--danger); font-size:12px; margin-bottom:8px;"></div>
                <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:8px;">
                    <button type="button" class="btn" id="lp-meta-cancel">Cancel</button>
                    <button type="button" class="btn btn-primary" id="lp-meta-save">Save</button>
                </div>
            </div>
        </div>
    `;

    const wireSelectOrOther = (id) => {
        const select = root.querySelector(`#${id}`);
        const other = root.querySelector(`#${id}-other`);
        select.addEventListener('change', () => {
            other.style.display = select.value === OTHER ? 'block' : 'none';
        });
    };
    ['lp-meta-category', 'lp-meta-duration', 'lp-meta-location', 'lp-meta-country',
     'lp-meta-postal', 'lp-meta-condition'].forEach(wireSelectOrOther);

    const valOrOther = (id) => {
        const select = root.querySelector(`#${id}`);
        if (select.value === OTHER) return root.querySelector(`#${id}-other`).value.trim() || null;
        return select.value || null;
    };

    root.querySelector('#lp-meta-cancel').addEventListener('click', () => { root.innerHTML = ''; });
    root.querySelector('#lp-meta-save').addEventListener('click', async () => {
        const val = id => root.querySelector(id).value.trim() || null;
        const fields = {
            category_id: valOrOther('lp-meta-category'),
            title: val('#lp-meta-title'),
            description_html: val('#lp-meta-description'),
            listing_duration: valOrOther('lp-meta-duration'),
            item_location: valOrOther('lp-meta-location'),
            item_country: valOrOther('lp-meta-country'),
            item_postal_code: valOrOther('lp-meta-postal'),
            condition_id: valOrOther('lp-meta-condition'),
            payment_policy_id: val('#lp-meta-payment'),
            return_policy_id: val('#lp-meta-return'),
            shipping_policy_id: val('#lp-meta-shipping'),
        };
        const saveBtn = root.querySelector('#lp-meta-save');
        const errBox = root.querySelector('#lp-meta-error');
        saveBtn.disabled = true;
        errBox.textContent = '';

        // Drop unset fields so a blank input doesn't overwrite an already
        // -good value with null — same partial-update semantics either way.
        const changed = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null));

        try {
            if (isDraft) {
                await callSetMetadata(changed);
                root.innerHTML = '';
                await loadListing(container);
                return;
            }

            // Live listing: dry-run first so the confirm dialog can show
            // exactly what's about to change on a real listing, same
            // pattern as doPush()/doCreateListing().
            const preview = await callReviseMetadata(changed, true);
            const confirmed = window.confirm(
                `This revises live eBay listing ${t.listing_id} — fields: ${Object.keys(changed).join(', ') || '(none)'}. `
                + `Continue?`
            );
            if (!confirmed) { saveBtn.disabled = false; return; }

            await callReviseMetadata(changed, false);
            root.innerHTML = '';
            await loadListing(container);
        } catch (err) {
            errBox.textContent = err.message;
            saveBtn.disabled = false;
        }
    });
}

async function doPreviewNewListing(container) {
    const body = container.querySelector('#lp-body');
    const msg = body.querySelector('#lp-create-listing-msg');
    msg.innerHTML = `<span style="color:var(--text-secondary);">Checking...</span>`;
    try {
        const result = await callPreviewNewListing();
        const readyLines = result.ready.map(r => `${cardLabel(r)}: ${formatPrice(r.resolved_price)} x${r.available_qty}`);
        const notReadyLines = result.not_ready.map(r => `${cardLabel(r)}: ${r.reason}`);
        msg.innerHTML = `
            <div style="color:var(--success);">Ready: ${result.ready.length}</div>
            ${readyLines.length ? `<ul style="margin:4px 0 8px; padding-left:18px;">${readyLines.map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ul>` : ''}
            ${result.not_ready.length ? `
                <div style="color:var(--warning);">Not ready: ${result.not_ready.length}</div>
                <ul style="margin:4px 0; padding-left:18px;">${notReadyLines.map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
            ` : ''}
        `;
    } catch (err) {
        console.error(err);
        msg.innerHTML = `<span style="color:var(--danger)">Preview failed: ${escapeHtml(err.message)}</span>`;
    }
}

async function doCreateListing(container) {
    const body = container.querySelector('#lp-body');
    const msg = body.querySelector('#lp-create-listing-msg');
    const createBtn = body.querySelector('#lp-create-listing-btn');
    if (createBtn) createBtn.disabled = true;

    try {
        msg.innerHTML = `<span style="color:var(--text-secondary);">Checking...</span>`;
        const preview = await callCreateListing(true);
        if (!preview.ready_count) {
            msg.innerHTML = `<span style="color:var(--warning);">No ready cards — use Preview readiness above to see why.</span>`;
            return;
        }
        const notReadyNote = preview.not_ready_count
            ? ` (${preview.not_ready_count} card(s) staying queued — 0 available quantity)` : '';
        const confirmed = window.confirm(
            `This creates a brand-new, LIVE eBay listing with ${preview.ready_count} card(s)${notReadyNote}. `
            + `This is real and public — continue?`
        );
        if (!confirmed) { msg.innerHTML = ''; return; }

        msg.innerHTML = `<span style="color:var(--text-secondary);">Creating listing...</span>`;
        const result = await callCreateListing(false);
        msg.innerHTML = `<span style="color:var(--success);">
            Created eBay listing ${escapeHtml(result.listing_id)} with ${result.ready_count} card(s).
        </span>`;
        await loadListing(container);
    } catch (err) {
        console.error(err);
        msg.innerHTML = `<span style="color:var(--danger)">Create failed: ${escapeHtml(err.message)}
            — is picking_api.py running and reachable at ${PICKING_API_URL}?</span>`;
    } finally {
        if (createBtn) createBtn.disabled = false;
    }
}

function groupSectionHTML(group, rows) {
    const title = group ? escapeHtml(group.name) : '(no group)';
    const profile = group && group.profile_id ? state.profiles.find(p => p.id === group.profile_id) : null;
    const groupKey = group ? group.id : '__ungrouped__';
    const allSelected = rows.length > 0 && rows.every(r => state.selected.has(r.row_id));

    return `
        <div class="lp-group" style="border:1px solid var(--border); border-radius:8px; margin-bottom:14px; overflow:hidden;">
            <div style="display:flex; align-items:center; gap:12px; padding:10px 14px; background:var(--bg-tertiary); flex-wrap:wrap;">
                <input type="checkbox" class="lp-group-select-all" data-group-key="${groupKey}"
                       title="Select all in this group" ${allSelected ? 'checked' : ''} ${rows.length === 0 ? 'disabled' : ''} />
                <span class="badge" style="background:rgba(74,140,255,0.15); color:var(--accent);">${title}</span>
                <span style="font-size:12px; color:var(--text-secondary);">${rows.length} card(s)</span>
                ${group ? `
                    <label style="font-size:12px; color:var(--text-secondary); margin-left:auto;">Profile
                        <select class="lp-group-profile-picker" data-group-id="${group.id}" style="margin-left:6px;">
                            <option value="">(none — falls to platform default)</option>
                            ${state.profiles.map(p => `<option value="${p.id}" ${profile && profile.id === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
                            <option value="__new__">+ New profile...</option>
                        </select>
                    </label>
                    ${profile ? `<button class="btn lp-edit-tiers-btn" data-profile-id="${profile.id}" style="font-size:12px; padding:3px 8px;">Edit tiers</button>` : ''}
                    <button class="btn lp-rename-group-btn" data-group-id="${group.id}" style="font-size:12px; padding:3px 8px;">Rename</button>
                    <button class="btn lp-delete-group-btn" data-group-id="${group.id}" style="font-size:12px; padding:3px 8px; color:var(--danger);">Delete</button>
                ` : ''}
            </div>
            ${rows.length ? `
                <table>
                    <thead><tr>
                        <th style="width:24px;"></th><th></th><th>Variation</th><th>Set</th><th>Status</th><th>Market</th><th>Resolved</th><th>Source</th><th>Synced?</th><th>Available</th><th>Resolved Qty</th><th>Low-stock qty</th><th>Manual pin</th><th>Qty Limit pin</th><th>Actions</th>
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
            <td>${r.status === 'queued'
                ? `<div class="lp-thumb-upload" data-row-id="${r.row_id}" style="cursor:pointer; position:relative; width:fit-content;"
                        title="${escapeHtml(thumbTitle(r))}">
                      ${thumbInnerHTML(r)}
                  </div>`
                : imgHtml(r.image_url)}</td>
            <td>${r.status === 'queued'
                ? `<input type="text" class="lp-custom-name-input" data-row-id="${r.row_id}"
                          value="${escapeHtml(r.custom_name || '')}"
                          placeholder="${escapeHtml(cardLabel(r))} (auto-named at push)"
                          title="eBay variation name at push time — leave blank to auto-generate"
                          style="width:100%; font-size:13px; background:transparent; border:1px solid var(--border); border-radius:3px; padding:2px 4px;" />`
                : escapeHtml(listingRow.external_id || cardLabel(r))}
                <div style="font-size:11px; color:var(--text-secondary);">${escapeHtml(r.derived_label)}</div>
            </td>
            <td style="font-size:12px; color:var(--text-secondary);">${escapeHtml(r.set_name || '-')}</td>
            <td>${statusBadge(r.status)}</td>
            <td><input type="number" step="0.01" class="lp-market-price-input" data-variant-id="${r.variant_id}" data-row-id="${r.row_id}"
                       value="${r.market_price ?? ''}" placeholder="none"
                       title="${r.market_price_source === 'manual' ? 'Manually set' : ''}"
                       style="width:70px; ${r.market_price_source === 'manual' ? 'background:rgba(167,139,250,0.12); border-color:#a78bfa;' : ''}" /></td>
            <td class="lp-resolved-price-cell" style="font-weight:600;">${formatPrice(r.resolved_price)}</td>
            <td class="lp-source-cell">${sourceBadge(r.price_source)}</td>
            <td class="lp-synced-cell">${isActive
                ? (isGatedIn(r) ? '<span style="color:var(--success); font-size:12px;">yes</span>' : '<span style="color:var(--text-secondary); font-size:12px;">no</span>')
                : '<span style="color:var(--text-secondary); font-size:12px;">n/a</span>'}</td>
            <td><span class="lp-available-cell">${r.available_qty ?? '-'}</span>
                <a href="#" class="lp-balance-qty-link" data-variant-id="${r.variant_id}" data-card-label="${escapeHtml(cardLabel(r))}" data-row-id="${r.row_id}"
                   style="font-size:10px; margin-left:4px; color:var(--accent);" title="Balance quantity across every listing that offers this card">Balance</a>
            </td>
            <td class="lp-resolved-qty-cell">${resolvedQty(r)}</td>
            <td><input type="number" class="lp-low-stock-input" data-row-id="${r.row_id}"
                       value="${r.row_low_stock_qty ?? ''}" placeholder="-" style="width:60px;" /></td>
            <td><input type="number" step="0.01" class="lp-pin-input" data-row-id="${r.row_id}"
                       value="${r.manual_price ?? ''}" placeholder="unpinned" style="width:80px;" /></td>
            <td><input type="number" class="lp-qty-limit-input" data-row-id="${r.row_id}"
                       value="${r.row_quantity_limit ?? ''}" placeholder="default" style="width:70px;" /></td>
            <td style="white-space:nowrap;">${actionsHTML(r)}</td>
        </tr>
    `;
}

function actionsHTML(r) {
    if (r.status === 'active') {
        return `<button class="btn lp-remove-card-btn" data-row-id="${r.row_id}" style="font-size:11px; padding:2px 8px; color:var(--danger);">Remove</button>`;
    }
    if (r.status === 'queued') {
        // "Push live" adds ONE variation to an ALREADY-LIVE listing —
        // meaningless (and would fail server-side) for a draft template
        // that has no listing_id yet. Those cards go live as a batch via
        // the "Create listing" flow instead (see draftMetadataHTML()).
        const isDraft = !state.template?.listing_id;
        return `
            ${isDraft ? '' : `<button class="btn lp-push-card-btn" data-row-id="${r.row_id}" style="font-size:11px; padding:2px 8px;">Push live</button>`}
            <button class="btn lp-fix-card-btn" data-row-id="${r.row_id}" data-current-label="${escapeHtml(cardLabel(r))}" style="font-size:11px; padding:2px 8px;">Fix card</button>
            <button class="btn lp-delete-roster-btn" data-row-id="${r.row_id}" style="font-size:11px; padding:2px 8px; color:var(--danger);">Remove from roster</button>
        `;
    }
    // sold_out_retained — already off eBay, nothing left to push live again for this row.
    return `<button class="btn lp-delete-roster-btn" data-row-id="${r.row_id}" style="font-size:11px; padding:2px 8px; color:var(--danger);">Remove from roster</button>`;
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

    body.querySelectorAll('.lp-group-select-all').forEach(cb => {
        cb.addEventListener('change', () => {
            const rowCheckboxes = [...cb.closest('.lp-group').querySelectorAll('.lp-row-checkbox')];
            rowCheckboxes.forEach(rcb => {
                rcb.checked = cb.checked;
                if (cb.checked) state.selected.add(rcb.dataset.rowId);
                else state.selected.delete(rcb.dataset.rowId);
            });
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

    // sync_enabled lives on platform_listings, only meaningful for
    // 'active' rows (queued rows have no platform_listings row at all)
    // — a mixed selection just silently skips the queued ones rather
    // than erroring, same as clicking Push already tolerates a mixed
    // roster.
    const bulkSetSyncEnabled = async (enabled) => {
        const plIds = state.resolvedRows
            .filter(r => state.selected.has(r.row_id) && r.status === 'active' && r.platform_listing_id)
            .map(r => r.platform_listing_id);
        if (!plIds.length) {
            window.alert('None of the selected rows are active — sync only applies to active (live) rows.');
            return;
        }
        const { error } = await supabase.from('platform_listings')
            .update({ sync_enabled: enabled })
            .in('id', plIds);
        if (error) {
            window.alert(`Failed to ${enabled ? 'enable' : 'disable'} sync: ${error.message}`);
            return;
        }
        state.selected = new Set();
        await loadListing(container);
    };

    body.querySelector('#lp-bulk-sync-on-btn').addEventListener('click', () => bulkSetSyncEnabled(true));
    body.querySelector('#lp-bulk-sync-off-btn').addEventListener('click', () => bulkSetSyncEnabled(false));

    body.querySelector('#lp-new-group-btn').addEventListener('click', () => openNewGroupModal(container, body));

    body.querySelectorAll('.lp-edit-tiers-btn').forEach(btn => {
        btn.addEventListener('click', () => openEditTiersModal(container, body, btn.dataset.profileId));
    });

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
            if (sel.value === '__new__') {
                openNewProfileModal(container, body, sel.dataset.groupId);
                return;
            }
            const { error } = await supabase.from('listing_card_groups')
                .update({ profile_id: sel.value || null }).eq('id', sel.dataset.groupId);
            if (error) { window.alert(`Failed to assign profile: ${error.message}`); return; }
            await loadListing(container);
        });
    });

    // Custom eBay variation name (migration 012) — only ever editable for
    // queued rows (see rowHTML). When set, push_single_card_live() /
    // _do_promotions()'s promotion path use it verbatim instead of
    // computing one via _render_variation_name(). Clearing it reverts to
    // auto-generation at push time.
    body.querySelectorAll('.lp-custom-name-input').forEach(input => {
        input.addEventListener('change', async () => {
            const rowId = input.dataset.rowId;
            const raw = input.value.trim();
            const { error } = await supabase.from('listing_card_assignments')
                .update({ custom_name: raw === '' ? null : raw }).eq('id', rowId);
            if (error) { window.alert(`Failed to save custom name: ${error.message}`); return; }
            await refreshRowDerivedCells(container, rowId);
        });
    });

    // Market price edit — writes the REAL market price (migration 011),
    // not a scoped-to-this-page override. market_prices is keyed by
    // (variant_id, condition); every existing row in the table uses
    // condition='Near Mint' (confirmed live, no exceptions), so that's
    // the row this updates — the exact same one v_inventory (Inventory
    // tab) and every other market_prices consumer already reads. Editing
    // it here changes what shows up there too. Clearing the input
    // deletes the row entirely (no price data at all, same as any other
    // never-priced card) rather than reverting to some separate
    // "automatic" value — there isn't a separate one anymore.
    body.querySelectorAll('.lp-market-price-input').forEach(input => {
        input.addEventListener('change', async () => {
            const variantId = input.dataset.variantId;
            const rowId = input.dataset.rowId;
            const raw = input.value.trim();
            if (raw === '') {
                const { error } = await supabase.from('market_prices').delete()
                    .eq('variant_id', variantId).eq('condition', 'Near Mint');
                if (error) { window.alert(`Failed to clear market price: ${error.message}`); return; }
            } else {
                const { error } = await supabase.from('market_prices').upsert({
                    variant_id: variantId, condition: 'Near Mint', market_price: parseFloat(raw),
                    source: 'manual', updated_at: new Date().toISOString(),
                }, { onConflict: 'variant_id,condition' });
                if (error) { window.alert(`Failed to save market price: ${error.message}`); return; }
            }
            await refreshRowDerivedCells(container, rowId);
        });
    });

    // Pins (manual_price/low_stock_qty/quantity_limit) live on
    // listing_card_assignments (docs/plans/listing-pricing-system.md
    // migration 010) — the roster row, which exists for a card regardless
    // of status, unlike platform_listings which only exists once live.
    // Editable for queued rows too, so a pin set before going live carries
    // straight through once it does (same row id, no copying needed).
    body.querySelectorAll('.lp-pin-input').forEach(input => {
        input.addEventListener('change', async () => {
            const rowId = input.dataset.rowId;
            const raw = input.value.trim();
            const manualPrice = raw === '' ? null : parseFloat(raw);
            const { error } = await supabase.from('listing_card_assignments').update({ manual_price: manualPrice }).eq('id', rowId);
            if (error) { window.alert(`Failed to save pin: ${error.message}`); return; }
            await refreshRowDerivedCells(container, rowId);
        });
    });

    body.querySelectorAll('.lp-low-stock-input').forEach(input => {
        input.addEventListener('change', async () => {
            const rowId = input.dataset.rowId;
            const raw = input.value.trim();
            const lowStockQty = raw === '' ? null : parseInt(raw, 10);
            const { error } = await supabase.from('listing_card_assignments').update({ low_stock_qty: lowStockQty }).eq('id', rowId);
            if (error) { window.alert(`Failed to save low-stock qty: ${error.message}`); return; }
            await refreshRowDerivedCells(container, rowId);
        });
    });

    body.querySelectorAll('.lp-qty-limit-input').forEach(input => {
        input.addEventListener('change', async () => {
            const rowId = input.dataset.rowId;
            const raw = input.value.trim();
            const quantityLimit = raw === '' ? null : parseInt(raw, 10);
            const { error } = await supabase.from('listing_card_assignments').update({ quantity_limit: quantityLimit }).eq('id', rowId);
            if (error) { window.alert(`Failed to save qty limit pin: ${error.message}`); return; }
            await refreshRowDerivedCells(container, rowId);
        });
    });

    const importBtn = body.querySelector('#lp-import-existing-btn');
    if (importBtn) importBtn.addEventListener('click', () => importExisting(container));

    body.querySelector('#lp-add-card-btn').addEventListener('click', () => openAddCardModal(container, body));

    // Not rendered at all for a draft template (no listing_id yet) — see
    // wireDraftControls() for the "Create listing" equivalent.
    const pushBtn = body.querySelector('#lp-push-btn');
    const pushDryBtn = body.querySelector('#lp-push-dryrun-btn');
    if (pushBtn) pushBtn.addEventListener('click', () => doPush(container, false));
    if (pushDryBtn) pushDryBtn.addEventListener('click', () => doPush(container, true));

    body.querySelectorAll('.lp-push-card-btn').forEach(btn => {
        btn.addEventListener('click', () => pushCardLive(container, btn));
    });

    body.querySelectorAll('.lp-remove-card-btn').forEach(btn => {
        btn.addEventListener('click', () => removeCardLive(container, btn));
    });

    body.querySelectorAll('.lp-delete-roster-btn').forEach(btn => {
        btn.addEventListener('click', () => deleteRosterRow(container, btn));
    });

    body.querySelectorAll('.lp-fix-card-btn').forEach(btn => {
        btn.addEventListener('click', () => openAddCardModal(container, body, {
            rowId: btn.dataset.rowId,
            currentLabel: btn.dataset.currentLabel,
        }));
    });

    body.querySelectorAll('.lp-thumb-upload').forEach(el => {
        el.addEventListener('click', () => openStagePictureModal(container, body, el.dataset.rowId));
    });

    body.querySelectorAll('.lp-balance-qty-link').forEach(el => {
        el.addEventListener('click', (e) => {
            e.preventDefault();
            openBalanceQtyModal(container, body, el.dataset.variantId, el.dataset.cardLabel, el.dataset.rowId);
        });
    });
}

// ----------------------------------------------------------------
// Import existing platform_listings rows into the roster
// ----------------------------------------------------------------

async function importExisting(container) {
    const { data: existing, error: fetchErr } = await supabase
        .from('platform_listings')
        .select('id, variant_id')
        .eq('platform', state.platform).eq('listing_id', state.listingId).neq('status', 'delisted');
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
// New profile — quick inline creation so you don't have to leave the
// page to set up pricing for a new group. Includes at least one tier
// (a profile with none would silently fall through to the platform
// default formula, which is technically safe but a confusing result
// right after creating and assigning it).
// ----------------------------------------------------------------

function openNewProfileModal(container, body, groupId) {
    const root = body.querySelector('#lp-modal-root');
    let tierCount = 1;

    const tierRowHTML = (i) => `
        <div class="lp-new-profile-tier-row" data-i="${i}" style="border:1px solid var(--border); border-radius:6px; padding:8px; margin-bottom:6px;">
            <div style="display:flex; gap:8px; align-items:flex-end;">
                <label style="font-size:11px; color:var(--text-secondary); flex:1;">Min market ($)
                    <input type="number" step="0.01" class="lp-tier-min" value="0.00" style="width:100%; margin-top:2px;" />
                </label>
                <label style="font-size:11px; color:var(--text-secondary); flex:1;">Max market ($, blank=open-ended)
                    <input type="number" step="0.01" class="lp-tier-max" style="width:100%; margin-top:2px;" />
                </label>
                <label style="font-size:11px; color:var(--text-secondary); flex:1;">Pricing
                    <select class="lp-tier-mode" style="width:100%; margin-top:2px;">
                        <option value="flat">Flat price</option>
                        <option value="formula">Formula</option>
                    </select>
                </label>
            </div>
            <div class="lp-tier-flat-fields" style="display:flex; gap:8px; align-items:flex-end; margin-top:6px;">
                <label style="font-size:11px; color:var(--text-secondary); flex:1;">List price ($)
                    <input type="number" step="0.01" class="lp-tier-price" style="width:100%; margin-top:2px;" />
                </label>
            </div>
            <div class="lp-tier-formula-fields" style="display:none; gap:8px; align-items:flex-end; margin-top:6px;">
                <label style="font-size:11px; color:var(--text-secondary); flex:1;">Multiplier (× market)
                    <input type="number" step="0.01" class="lp-tier-multiplier" style="width:100%; margin-top:2px;" />
                </label>
                <label style="font-size:11px; color:var(--text-secondary); flex:1;">Plus ($)
                    <input type="number" step="0.01" class="lp-tier-plus" style="width:100%; margin-top:2px;" />
                </label>
            </div>
        </div>
    `;

    root.innerHTML = `
        <div style="position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:100;">
            <div style="background:var(--bg-secondary); border:1px solid var(--border); border-radius:8px; padding:20px; width:460px; max-width:90vw; max-height:85vh; overflow-y:auto;">
                <h3 style="margin:0 0 12px;">New pricing profile</h3>
                <label style="font-size:12px; color:var(--text-secondary); display:block; margin-bottom:10px;">Name
                    <input type="text" id="lp-new-profile-name" placeholder="e.g. double_rare_common" style="width:100%; margin-top:4px;" />
                </label>
                <label style="font-size:12px; color:var(--text-secondary); display:block; margin-bottom:10px;">Default low-stock qty (optional)
                    <input type="number" id="lp-new-profile-lowstock" style="width:100%; margin-top:4px;" />
                </label>
                <div style="font-size:11px; text-transform:uppercase; letter-spacing:0.03em; color:var(--text-secondary); margin:12px 0 6px;">
                    Tiers (min inclusive, max exclusive)
                </div>
                <div id="lp-new-profile-tiers">${tierRowHTML(0)}</div>
                <button type="button" class="btn" id="lp-add-tier-row-btn" style="font-size:12px; margin-top:6px;">+ Add tier</button>
                <div id="lp-new-profile-error" style="color:var(--danger); font-size:12px; margin-top:10px;"></div>
                <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:16px;">
                    <button type="button" class="btn" id="lp-new-profile-cancel">Cancel</button>
                    <button type="button" class="btn btn-primary" id="lp-new-profile-create">Create & assign</button>
                </div>
            </div>
        </div>
    `;

    root.querySelector('#lp-add-tier-row-btn').addEventListener('click', () => {
        root.querySelector('#lp-new-profile-tiers').insertAdjacentHTML('beforeend', tierRowHTML(tierCount++));
    });

    // Delegated listener so it keeps working for rows added later via + Add tier.
    root.querySelector('#lp-new-profile-tiers').addEventListener('change', (e) => {
        if (!e.target.classList.contains('lp-tier-mode')) return;
        const rowEl = e.target.closest('.lp-new-profile-tier-row');
        const isFormula = e.target.value === 'formula';
        rowEl.querySelector('.lp-tier-flat-fields').style.display = isFormula ? 'none' : 'flex';
        rowEl.querySelector('.lp-tier-formula-fields').style.display = isFormula ? 'flex' : 'none';
    });

    root.querySelector('#lp-new-profile-cancel').addEventListener('click', async () => {
        root.innerHTML = '';
        // The <select> was left on "__new__" — reload to reset it to whatever's actually assigned.
        await loadListing(container);
    });

    root.querySelector('#lp-new-profile-create').addEventListener('click', async () => {
        const errBox = root.querySelector('#lp-new-profile-error');
        errBox.textContent = '';
        const name = root.querySelector('#lp-new-profile-name').value.trim();
        if (!name) { errBox.textContent = 'Enter a name.'; return; }

        const tierRows = [...root.querySelectorAll('.lp-new-profile-tier-row')].map(rowEl => {
            const isFormula = rowEl.querySelector('.lp-tier-mode').value === 'formula';
            const multiplierRaw = rowEl.querySelector('.lp-tier-multiplier').value;
            const plusRaw = rowEl.querySelector('.lp-tier-plus').value;
            return {
                min_market: parseFloat(rowEl.querySelector('.lp-tier-min').value),
                max_market: rowEl.querySelector('.lp-tier-max').value ? parseFloat(rowEl.querySelector('.lp-tier-max').value) : null,
                list_price: isFormula ? null : parseFloat(rowEl.querySelector('.lp-tier-price').value),
                multiplier: isFormula && multiplierRaw ? parseFloat(multiplierRaw) : null,
                plus: isFormula && plusRaw ? parseFloat(plusRaw) : null,
            };
        }).filter(t => !isNaN(t.min_market) && (t.list_price != null ? !isNaN(t.list_price) : t.multiplier != null));

        if (!tierRows.length) { errBox.textContent = 'Add at least one complete tier (min market + a list price or multiplier).'; return; }

        // Generate the id client-side (standard crypto.randomUUID()) rather
        // than relying on reading it back after insert — keeps this to the
        // plain insert-with-no-return-value pattern used everywhere else in
        // this codebase instead of an unproven .select().single() chain.
        const profileId = crypto.randomUUID();
        const lowStockRaw = root.querySelector('#lp-new-profile-lowstock').value;
        const { error: profileErr } = await supabase.from('pricing_profiles').insert({
            id: profileId,
            name,
            default_low_stock_qty: lowStockRaw ? parseInt(lowStockRaw, 10) : null,
        });
        if (profileErr) {
            errBox.textContent = profileErr.code === '23505' ? `A profile named "${name}" already exists.` : profileErr.message;
            return;
        }

        const { error: tiersErr } = await supabase.from('pricing_profile_tiers')
            .insert(tierRows.map(t => ({ ...t, profile_id: profileId })));
        if (tiersErr) {
            errBox.textContent = tiersErr.message;
            return;
        }

        const { error: assignErr } = await supabase.from('listing_card_groups')
            .update({ profile_id: profileId }).eq('id', groupId);
        if (assignErr) {
            errBox.textContent = `Profile created, but failed to assign it: ${assignErr.message}`;
            return;
        }

        root.innerHTML = '';
        await loadListing(container);
    });
}

// ----------------------------------------------------------------
// Edit tiers — inline tier editing for a group's assigned profile, so you
// don't have to leave the Listing pricing page to fix a price. Mirrors
// configuration.js's per-profile Tiers modal (including the flat/formula
// toggle from migration 007), but stands alone here rather than importing
// it — same duplication convention already used for openNewProfileModal
// vs. Configuration's "New pricing profile" modal in this codebase.
// ----------------------------------------------------------------

function tierPriceLabel(t) {
    if (t.list_price != null) return formatPrice(t.list_price);
    const plusPart = t.plus ? ` + ${formatPrice(t.plus)}` : '';
    return `market × ${t.multiplier}${plusPart}`;
}

async function openEditTiersModal(container, body, profileId, editingTierId = null) {
    const root = body.querySelector('#lp-modal-root');
    const [{ data: profile }, { data: tiers }] = await Promise.all([
        supabase.from('pricing_profiles').select('*').eq('id', profileId).single(),
        supabase.from('pricing_profile_tiers').select('*').eq('profile_id', profileId).order('min_market'),
    ]);
    if (!profile) { root.innerHTML = ''; return; }

    const editingTier = editingTierId ? (tiers || []).find(t => t.id === editingTierId) : (editingTierId === 'new' ? {} : null);
    const isFormOpen = editingTierId !== null;
    const tierMode = editingTier && editingTier.list_price == null && editingTier.multiplier != null ? 'formula' : 'flat';

    root.innerHTML = `
        <div style="position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:100;">
            <div style="background:var(--bg-secondary); border:1px solid var(--border); border-radius:8px; padding:20px; width:460px; max-width:90vw; max-height:85vh; overflow-y:auto;">
                <h3 style="margin:0 0 4px;">Tiers — ${escapeHtml(profile.name)}</h3>
                <p style="color:var(--text-secondary); font-size:12px; margin:0 0 14px;">
                    Market price brackets: min is inclusive, max is exclusive (blank max = open-ended top tier).
                </p>
                ${(tiers || []).length ? `
                    <table style="margin-bottom:12px;">
                        <thead><tr><th>Min market</th><th>Max market</th><th>Price</th><th style="width:110px;"></th></tr></thead>
                        <tbody>
                            ${tiers.map(t => `
                                <tr>
                                    <td>${formatPrice(t.min_market)}</td>
                                    <td>${t.max_market == null ? '(open-ended)' : formatPrice(t.max_market)}</td>
                                    <td>${tierPriceLabel(t)}</td>
                                    <td>
                                        <button type="button" class="btn lp-edit-tier-row-btn" data-id="${t.id}" style="padding:2px 8px; font-size:12px;">Edit</button>
                                        <button type="button" class="btn lp-delete-tier-row-btn" data-id="${t.id}" style="padding:2px 8px; font-size:12px; color:var(--danger);">×</button>
                                    </td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                ` : `<p style="color:var(--text-secondary); font-size:13px;">No tiers yet.</p>`}

                ${isFormOpen ? `
                    <form id="lp-tier-form" style="border-top:1px solid var(--border); padding-top:12px; display:flex; flex-direction:column; gap:10px;">
                        <div style="display:flex; gap:10px;">
                            <label style="font-size:12px; color:var(--text-secondary); flex:1;">Min market ($, inclusive)
                                <input type="number" step="0.01" name="min_market" value="${editingTier?.min_market ?? '0.00'}" style="width:100%; margin-top:4px;" />
                            </label>
                            <label style="font-size:12px; color:var(--text-secondary); flex:1;">Max market ($, blank=open-ended)
                                <input type="number" step="0.01" name="max_market" value="${editingTier?.max_market ?? ''}" style="width:100%; margin-top:4px;" />
                            </label>
                        </div>
                        <label style="font-size:12px; color:var(--text-secondary);">Pricing
                            <select id="lp-tier-pricing-mode" name="pricing_mode" style="width:100%; margin-top:4px;">
                                <option value="flat" ${tierMode === 'flat' ? 'selected' : ''}>Flat price</option>
                                <option value="formula" ${tierMode === 'formula' ? 'selected' : ''}>Formula (market × multiplier + plus)</option>
                            </select>
                        </label>
                        <div id="lp-tier-flat-fields" style="${tierMode === 'flat' ? '' : 'display:none;'}">
                            <label style="font-size:12px; color:var(--text-secondary); display:block;">List price ($)
                                <input type="number" step="0.01" name="list_price" value="${editingTier?.list_price ?? ''}" style="width:100%; margin-top:4px;" />
                            </label>
                        </div>
                        <div id="lp-tier-formula-fields" style="display:flex; gap:10px; ${tierMode === 'formula' ? '' : 'display:none;'}">
                            <label style="font-size:12px; color:var(--text-secondary); flex:1;">Multiplier
                                <input type="number" step="0.01" name="multiplier" value="${editingTier?.multiplier ?? ''}" style="width:100%; margin-top:4px;" />
                            </label>
                            <label style="font-size:12px; color:var(--text-secondary); flex:1;">Plus ($)
                                <input type="number" step="0.01" name="plus" value="${editingTier?.plus ?? ''}" style="width:100%; margin-top:4px;" />
                            </label>
                        </div>
                        <div id="lp-tier-form-error" style="color:var(--danger); font-size:12px;"></div>
                        <div style="display:flex; gap:8px;">
                            <button type="submit" class="btn btn-primary">${editingTierId === 'new' ? 'Add tier' : 'Save tier'}</button>
                            <button type="button" class="btn" id="lp-tier-form-cancel">Cancel</button>
                        </div>
                    </form>
                ` : `<button type="button" class="btn btn-primary" id="lp-add-tier-btn">+ Add tier</button>`}

                <div style="display:flex; justify-content:flex-end; margin-top:16px;">
                    <button type="button" class="btn" id="lp-tiers-modal-close">Close</button>
                </div>
            </div>
        </div>
    `;

    root.querySelector('#lp-tiers-modal-close').addEventListener('click', async () => {
        root.innerHTML = '';
        await loadListing(container);
    });

    if (!isFormOpen) {
        root.querySelector('#lp-add-tier-btn').addEventListener('click', () => openEditTiersModal(container, body, profileId, 'new'));
        root.querySelectorAll('.lp-edit-tier-row-btn').forEach(btn => {
            btn.addEventListener('click', () => openEditTiersModal(container, body, profileId, btn.dataset.id));
        });
        root.querySelectorAll('.lp-delete-tier-row-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!window.confirm('Delete this tier?')) return;
                const { error } = await supabase.from('pricing_profile_tiers').delete().eq('id', btn.dataset.id);
                if (error) { window.alert(`Failed to delete: ${error.message}`); return; }
                await openEditTiersModal(container, body, profileId);
            });
        });
        return;
    }

    root.querySelector('#lp-tier-pricing-mode').addEventListener('change', (e) => {
        const isFormula = e.target.value === 'formula';
        root.querySelector('#lp-tier-flat-fields').style.display = isFormula ? 'none' : '';
        root.querySelector('#lp-tier-formula-fields').style.display = isFormula ? 'flex' : 'none';
    });

    root.querySelector('#lp-tier-form-cancel').addEventListener('click', () => openEditTiersModal(container, body, profileId));
    root.querySelector('#lp-tier-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errBox = root.querySelector('#lp-tier-form-error');
        errBox.textContent = '';
        const fd = new FormData(e.target);
        const mode = fd.get('pricing_mode');
        if (mode === 'flat' && !fd.get('list_price')) {
            errBox.textContent = 'List price is required for a flat tier.';
            return;
        }
        if (mode === 'formula' && !fd.get('multiplier')) {
            errBox.textContent = 'Multiplier is required for a formula tier.';
            return;
        }
        const payload = {
            profile_id: profileId,
            min_market: parseFloat(fd.get('min_market')),
            max_market: fd.get('max_market') ? parseFloat(fd.get('max_market')) : null,
            list_price: mode === 'flat' ? parseFloat(fd.get('list_price')) : null,
            multiplier: mode === 'formula' ? parseFloat(fd.get('multiplier')) : null,
            plus: mode === 'formula' && fd.get('plus') ? parseFloat(fd.get('plus')) : null,
        };
        const { error } = editingTierId === 'new'
            ? await supabase.from('pricing_profile_tiers').insert(payload)
            : await supabase.from('pricing_profile_tiers').update(payload).eq('id', editingTierId);
        if (error) {
            // The non-overlap trigger raises a plain RAISE EXCEPTION message — surface it directly.
            errBox.textContent = error.message || 'Failed to save tier.';
            return;
        }
        await openEditTiersModal(container, body, profileId);
    });
}

// ----------------------------------------------------------------
// Add card to listing (queued — not live yet)
// ----------------------------------------------------------------

// `editRow` is null for the normal "add a new card" flow, or
// {rowId, currentLabel} to instead re-point an EXISTING roster row's
// variant_id — used by the "Fix card" action for correcting a wrong
// search-result click (search requires an explicit click, there's no
// auto-pick, so a wrong card here is a manual misclick, not a matching
// bug — see docs/plans/listing-pricing-system.md). Deliberately only
// ever offered for queued/sold_out_retained rows, never active: an
// active row's live eBay variation text won't change just because we
// repoint variant_id here, and reconciling that mismatch is a separate,
// bigger problem (same class as the existing "needs manual reconcile in
// Seller Hub" cases elsewhere in this codebase).
function openAddCardModal(container, body, editRow = null) {
    const root = body.querySelector('#lp-modal-root');
    root.innerHTML = `
        <div style="position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:100;">
            <div style="background:var(--bg-secondary); border:1px solid var(--border); border-radius:8px; padding:20px; width:480px; max-width:90vw; max-height:80vh; overflow-y:auto;">
                <h3 style="margin:0 0 12px;">${editRow ? 'Fix card' : 'Add card to listing'}</h3>
                <p style="color:var(--text-secondary); font-size:12px; margin:0 0 10px;">
                    ${editRow
                        ? `Currently mapped to <strong>${escapeHtml(editRow.currentLabel)}</strong> — search and pick the correct card below.`
                        : `Adds as <strong>queued</strong> (planned, not live on eBay yet). Search by card name.`}
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
        debounceTimer = setTimeout(() => runCardSearch(container, root, q, editRow), 300);
    });
}

async function runCardSearch(container, root, query, editRow = null) {
    const resultsEl = root.querySelector('#lp-card-search-results');
    if (!query) { resultsEl.innerHTML = ''; return; }

    const { data: cards, error } = await supabase
        .from('card_master').select('id, name, card_number, card_number_numeric, set_id')
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

    // Sort by set then card number — an unsorted list is exactly what
    // made it easy to misclick an adjacent card in the same promo set.
    const sorted = [...cards].sort((a, b) => {
        const setA = setNameById[a.set_id] || '';
        const setB = setNameById[b.set_id] || '';
        if (setA !== setB) return setA.localeCompare(setB);
        return (a.card_number_numeric ?? 0) - (b.card_number_numeric ?? 0);
    });

    resultsEl.innerHTML = sorted.map(c => `
        <div class="lp-card-result" data-card-id="${c.id}" style="padding:8px; border-bottom:1px solid var(--border); cursor:pointer; font-size:13px;">
            <span style="color:var(--accent); font-weight:600;">#${escapeHtml(c.card_number || '?')}</span>
            ${escapeHtml(c.name)}
            <div style="font-size:11px; color:var(--text-secondary);">${escapeHtml(setNameById[c.set_id] || '')}</div>
        </div>
    `).join('');

    resultsEl.querySelectorAll('.lp-card-result').forEach(el => {
        el.addEventListener('click', () => showVariantPicker(container, root, el.dataset.cardId, editRow));
    });
}

async function showVariantPicker(container, root, cardId, editRow = null) {
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
            if (editRow) {
                const { error: updErr } = await supabase.from('listing_card_assignments')
                    .update({ variant_id: el.dataset.variantId }).eq('id', editRow.rowId);
                if (updErr) {
                    window.alert(`Failed to update card: ${updErr.message}`);
                    return;
                }
            } else {
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
            }
            root.innerHTML = '';
            await loadListing(container);
        });
    });
}

// ----------------------------------------------------------------
// Push
// ----------------------------------------------------------------

async function callPushPrices(dryRun) {
    const resp = await fetch(`${PICKING_API_URL}/api/push-prices`, {
        method: 'POST',
        headers: { 'x-picking-token': PICKING_API_TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({ listing_id: state.listingId, account_num: state.accountNum, dry_run: dryRun }),
    });
    if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        throw new Error(`${resp.status} ${detail}`);
    }
    return resp.json();
}

async function doPush(container, dryRun) {
    const body = container.querySelector('#lp-body');
    const msg = body.querySelector('#lp-push-msg');
    const pushBtn = body.querySelector('#lp-push-btn');
    const dryBtn = body.querySelector('#lp-push-dryrun-btn');

    pushBtn.disabled = true;
    dryBtn.disabled = true;

    try {
        if (!dryRun) {
            // Silent dry-run first so the confirm dialog can call out
            // exactly how many cards are going live for the first time —
            // a normal price sync can now also add brand-new variations
            // via 250-cap promotion, and that shouldn't be buried in a
            // routine-looking confirm.
            msg.innerHTML = `<span style="color:var(--text-secondary);">Checking...</span>`;
            const preview = await callPushPrices(true);
            if (!preview.pushed) {
                msg.innerHTML = `<span style="color:var(--text-secondary);">Nothing to push.</span>`;
                return;
            }
            const promoted = preview.promoted || 0;
            const priceQtyChanges = preview.pushed - promoted;
            const parts = [];
            if (priceQtyChanges > 0) parts.push(`${priceQtyChanges} price/qty change(s)`);
            if (promoted > 0) parts.push(`${promoted} card(s) going live for the first time`);
            const confirmed = window.confirm(
                `This will send live changes to eBay listing ${state.listingId}: `
                + `${parts.join(' + ')}. Continue?`
            );
            if (!confirmed) { msg.innerHTML = ''; return; }
        }

        msg.innerHTML = `<span style="color:var(--text-secondary);">${dryRun ? 'Checking' : 'Pushing'}...</span>`;
        const result = await callPushPrices(dryRun);
        const warningsNote = result.warnings && result.warnings.length
            ? ` — ${result.warnings.length} warning(s): ${escapeHtml(result.warnings.join('; '))}` : '';
        const promotedNote = result.promoted ? ` (${result.promoted} newly live)` : '';
        msg.innerHTML = `<span style="color:var(--success);">
            ${dryRun ? 'Would push' : 'Pushed'} ${result.pushed} of ${result.resolved} row(s)${promotedNote}${warningsNote}
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

async function callPushCard(rowId, dryRun) {
    const resp = await fetch(`${PICKING_API_URL}/api/push-card`, {
        method: 'POST',
        headers: { 'x-picking-token': PICKING_API_TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({ row_id: rowId, account_num: state.accountNum, dry_run: dryRun }),
    });
    if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        throw new Error(`${resp.status} ${detail}`);
    }
    return resp.json();
}

async function pushCardLive(container, btn) {
    const rowId = btn.dataset.rowId;
    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Checking...';

    try {
        const preview = await callPushCard(rowId, true);
        if (preview.error) {
            window.alert(`Can't push this card live: ${preview.error}`);
            return;
        }
        const confirmed = window.confirm(
            `Push "${preview.external_id}" live on eBay listing ${state.listingId} at `
            + `${formatPrice(preview.resolved_price)}, qty ${preview.qty_to_push}? `
            + `This adds ONLY this one card as a new variation — no other variation's `
            + `price or quantity is touched. Continue?`
        );
        if (!confirmed) return;

        btn.textContent = 'Pushing...';
        const result = await callPushCard(rowId, false);
        if (result.error) {
            window.alert(`Push failed: ${result.error}`);
            return;
        }
        await loadListing(container);
    } catch (err) {
        console.error(err);
        window.alert(`Push failed: ${err.message} — is picking_api.py running and reachable at ${PICKING_API_URL}?`);
    } finally {
        btn.disabled = false;
        btn.textContent = originalLabel;
    }
}

async function callRemoveCard(rowId, dryRun) {
    const resp = await fetch(`${PICKING_API_URL}/api/remove-card`, {
        method: 'POST',
        headers: { 'x-picking-token': PICKING_API_TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({ row_id: rowId, account_num: state.accountNum, dry_run: dryRun }),
    });
    if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        throw new Error(`${resp.status} ${detail}`);
    }
    return resp.json();
}

// Pulls a live card's variation off eBay — the reverse of pushCardLive().
// Roster row goes back to 'queued' (handled server-side), NOT deleted —
// permanently removing it from the roster is a separate action
// (deleteRosterRow), only offered once a row is no longer live.
async function removeCardLive(container, btn) {
    const rowId = btn.dataset.rowId;
    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Checking...';

    try {
        const preview = await callRemoveCard(rowId, true);
        if (preview.error) {
            window.alert(`Can't remove this card: ${preview.error}`);
            return;
        }
        const confirmed = window.confirm(
            `Remove "${preview.external_id}" from live eBay listing ${state.listingId}? `
            + `It goes back to queued and can be pushed live again later — no other `
            + `variation's price or quantity is touched. Continue?`
        );
        if (!confirmed) return;

        btn.textContent = 'Removing...';
        const result = await callRemoveCard(rowId, false);
        if (result.error) {
            window.alert(`Remove failed: ${result.error}`);
            return;
        }
        await loadListing(container);
    } catch (err) {
        console.error(err);
        window.alert(`Remove failed: ${err.message} — is picking_api.py running and reachable at ${PICKING_API_URL}?`);
    } finally {
        btn.disabled = false;
        btn.textContent = originalLabel;
    }
}

// Permanently deletes a listing_card_assignments row — only ever shown
// for 'queued'/'sold_out_retained' rows (never 'active'), so this never
// needs to touch eBay: nothing live is pointing at this row by the time
// the button exists.
async function deleteRosterRow(container, btn) {
    const rowId = btn.dataset.rowId;
    if (!window.confirm('Permanently remove this card from the roster? This cannot be undone — '
        + 'you would need to re-add it via "Add card to listing." Continue?')) return;

    btn.disabled = true;
    try {
        const { error } = await supabase.from('listing_card_assignments').delete().eq('id', rowId);
        if (error) { window.alert(`Failed to remove from roster: ${error.message}`); return; }
        await loadListing(container);
    } catch (err) {
        console.error(err);
        window.alert(`Failed to remove from roster: ${err.message}`);
    } finally {
        btn.disabled = false;
    }
}

// ----------------------------------------------------------------
// Stage a picture for eBay (EPS) — queued rows only. Uploads to eBay's
// own image hosting right now and stores the resulting URL on the
// roster row; nothing changes on the live listing yet (there's nothing
// live to attach a picture to for a queued card). The staged picture
// rides along automatically the next time this specific row gets pushed
// live. No R2/card_master catalog upload involved — separate, later plan.
// ----------------------------------------------------------------

function openStagePictureModal(container, body, rowId) {
    const root = body.querySelector('#lp-modal-root');
    root.innerHTML = `
        <div style="position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:100;">
            <div style="background:var(--bg-secondary); border:1px solid var(--border); border-radius:8px; padding:20px; width:420px; max-width:90vw;">
                <h3 style="margin:0 0 8px;">Stage picture for eBay</h3>
                <p style="color:var(--text-secondary); font-size:12px; margin:0 0 12px;">
                    Uploads to eBay's own image hosting (EPS) right now. The listing
                    itself isn't touched until this card is actually pushed live —
                    at that point the picture is attached automatically.
                </p>
                <label style="font-size:12px; color:var(--text-secondary); display:block; margin-bottom:10px;">Image URL
                    <input type="url" id="lp-stage-pic-url" placeholder="https://..." style="width:100%; margin-top:4px;" />
                </label>
                <div style="text-align:center; font-size:11px; color:var(--text-secondary); margin:6px 0;">— or —</div>
                <label style="font-size:12px; color:var(--text-secondary); display:block; margin-bottom:10px;">Upload a file
                    <input type="file" id="lp-stage-pic-file" accept="image/*" style="width:100%; margin-top:4px;" />
                </label>
                <div id="lp-stage-pic-error" style="color:var(--danger); font-size:12px; margin-bottom:10px;"></div>
                <div style="display:flex; justify-content:flex-end; gap:8px;">
                    <button type="button" class="btn" id="lp-stage-pic-cancel">Cancel</button>
                    <button type="button" class="btn btn-primary" id="lp-stage-pic-upload">Upload</button>
                </div>
            </div>
        </div>
    `;

    root.querySelector('#lp-stage-pic-cancel').addEventListener('click', () => { root.innerHTML = ''; });

    // URL and file are mutually exclusive — picking one clears the other,
    // so it's always unambiguous which the user meant.
    const urlInput = root.querySelector('#lp-stage-pic-url');
    const fileInput = root.querySelector('#lp-stage-pic-file');
    urlInput.addEventListener('input', () => { if (urlInput.value.trim()) fileInput.value = ''; });
    fileInput.addEventListener('change', () => { if (fileInput.files.length) urlInput.value = ''; });

    root.querySelector('#lp-stage-pic-upload').addEventListener('click', async () => {
        const errBox = root.querySelector('#lp-stage-pic-error');
        errBox.textContent = '';
        const url = urlInput.value.trim();
        const file = fileInput.files[0];
        if (!url && !file) { errBox.textContent = 'Enter an image URL or choose a file.'; return; }

        const uploadBtn = root.querySelector('#lp-stage-pic-upload');
        uploadBtn.disabled = true;
        uploadBtn.textContent = 'Uploading...';

        try {
            let resp;
            if (file) {
                const form = new FormData();
                form.append('row_id', rowId);
                form.append('account_num', String(state.accountNum));
                form.append('file', file);
                resp = await fetch(`${PICKING_API_URL}/api/stage-card-picture-file`, {
                    method: 'POST',
                    headers: { 'x-picking-token': PICKING_API_TOKEN },
                    body: form,
                });
            } else {
                resp = await fetch(`${PICKING_API_URL}/api/stage-card-picture`, {
                    method: 'POST',
                    headers: { 'x-picking-token': PICKING_API_TOKEN, 'content-type': 'application/json' },
                    body: JSON.stringify({ row_id: rowId, image_url: url, account_num: state.accountNum }),
                });
            }
            if (!resp.ok) {
                const detail = await resp.text().catch(() => '');
                throw new Error(`${resp.status} ${detail}`);
            }
            const result = await resp.json();
            if (result.error) {
                errBox.textContent = result.error;
                return;
            }
            root.innerHTML = '';
            await refreshRowDerivedCells(container, rowId);
        } catch (err) {
            console.error(err);
            errBox.textContent = `Upload failed: ${err.message} — is picking_api.py running and reachable at ${PICKING_API_URL}?`;
        } finally {
            uploadBtn.disabled = false;
            uploadBtn.textContent = 'Upload';
        }
    });
}

// ----------------------------------------------------------------
// Balance Qty — redistribute a card's shared inventory across every
// listing that currently offers it, including ones with no
// listing_templates row at all. Reads/writes platform_listings directly
// (LEFT-JOIN-style lookup against listing_templates just for a display
// name) rather than going through resolve_listing_prices()/the roster —
// same reasoning as revise_single_variation_qty() on the backend: this
// needs to work for listings that were never onboarded into a template.
// ----------------------------------------------------------------

async function openBalanceQtyModal(container, body, variantId, cardLabelText, rowId) {
    const root = body.querySelector('#lp-modal-root');
    root.innerHTML = `
        <div style="position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:100;">
            <div style="background:var(--bg-secondary); border:1px solid var(--border); border-radius:8px; padding:20px; width:520px; max-width:90vw; max-height:85vh; overflow-y:auto;">
                <h3 style="margin:0 0 4px;">Balance Qty — ${escapeHtml(cardLabelText)}</h3>
                <p id="lp-balance-loading" style="color:var(--text-secondary); font-size:12px;">Loading listings...</p>
                <div id="lp-balance-body"></div>
            </div>
        </div>
    `;

    const [{ data: invRows, error: invErr }, { data: plRows, error: plErr }] = await Promise.all([
        supabase.from('inventory').select('quantity, quantity_sold').eq('variant_id', variantId).eq('is_graded', false),
        // 'active' AND 'out_of_stock' — an OOS listing is still live on eBay
        // (revise_single_variation_qty can still find and update its
        // variation), it just currently shows 0. Excluding it here meant a
        // listing that sold out silently dropped out of the balance pool
        // and could never receive a fair share back on a later "Evenly
        // split" — 'delisted' is the only status genuinely excluded, since
        // that variation isn't live on eBay at all anymore to revise.
        supabase.from('platform_listings').select('id, platform, listing_id, account, quantity_listed, external_id, status')
            .eq('variant_id', variantId).in('status', ['active', 'out_of_stock']).order('listing_id'),
    ]);
    if (invErr || plErr) {
        root.querySelector('#lp-balance-loading').textContent = `Failed to load: ${(invErr || plErr).message}`;
        return;
    }

    const totalInventory = (invRows || []).reduce((sum, r) => sum + (r.quantity - (r.quantity_sold || 0)), 0);
    const rows = plRows || [];

    if (!rows.length) {
        root.querySelector('#lp-balance-loading').textContent = 'No live listings currently offer this card — nothing to balance yet.';
        return;
    }

    const listingIds = [...new Set(rows.map(r => r.listing_id))];
    const { data: templates } = await supabase.from('listing_templates').select('listing_id, name').in('listing_id', listingIds);
    const templateNameByListingId = Object.fromEntries((templates || []).map(t => [t.listing_id, t.name]));

    root.querySelector('#lp-balance-loading').remove();
    renderBalanceQtyBody(root, container, rows, totalInventory, templateNameByListingId, rowId);
}

function renderBalanceQtyBody(root, container, rows, totalInventory, templateNameByListingId, rowId) {
    const bodyEl = root.querySelector('#lp-balance-body');
    bodyEl.innerHTML = `
        <p style="font-size:12px; color:var(--text-secondary); margin:8px 0;">
            Total inventory: <strong>${totalInventory}</strong> — currently split across ${rows.length} live listing(s).
        </p>
        <table style="margin-bottom:10px;">
            <thead><tr><th>Listing</th><th style="width:90px;">Qty</th></tr></thead>
            <tbody>
                ${rows.map(r => `
                    <tr>
                        <td>
                            <div>${escapeHtml(templateNameByListingId[r.listing_id] || '(no template)')}${r.status === 'out_of_stock' ? ' <span style="color:var(--warning, var(--text-secondary)); font-size:11px;">(out of stock)</span>' : ''}</div>
                            <div style="font-size:11px; color:var(--text-secondary);">${escapeHtml(r.listing_id)}${r.account ? ` · ${escapeHtml(r.account)}` : ''}</div>
                        </td>
                        <td><input type="number" min="0" class="lp-balance-qty-input" data-pl-id="${r.id}" value="${r.quantity_listed ?? 0}" style="width:70px;" /></td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
        <div id="lp-balance-total-note" style="font-size:12px; margin-bottom:10px;"></div>
        <div id="lp-balance-error" style="color:var(--danger); font-size:12px; margin-bottom:10px;"></div>
        <div id="lp-balance-results" style="font-size:12px; margin-bottom:10px;"></div>
        <div style="display:flex; justify-content:space-between; gap:8px;">
            <button type="button" class="btn" id="lp-balance-even-btn">Evenly split</button>
            <div style="display:flex; gap:8px;">
                <button type="button" class="btn" id="lp-balance-cancel">Close</button>
                <button type="button" class="btn btn-primary" id="lp-balance-apply">Apply</button>
            </div>
        </div>
    `;

    const updateTotalNote = () => {
        const inputs = [...bodyEl.querySelectorAll('.lp-balance-qty-input')];
        const sum = inputs.reduce((s, el) => s + (parseInt(el.value, 10) || 0), 0);
        const note = bodyEl.querySelector('#lp-balance-total-note');
        note.textContent = `Entered total: ${sum} / ${totalInventory} in stock`;
        note.style.color = sum > totalInventory ? 'var(--danger)' : 'var(--text-secondary)';
    };
    bodyEl.querySelectorAll('.lp-balance-qty-input').forEach(el => el.addEventListener('input', updateTotalNote));
    updateTotalNote();

    bodyEl.querySelector('#lp-balance-even-btn').addEventListener('click', () => {
        const n = rows.length;
        const base = Math.floor(totalInventory / n);
        const remainder = totalInventory - base * n;
        rows.forEach((r, i) => {
            const share = base + (i < remainder ? 1 : 0);
            const input = bodyEl.querySelector(`.lp-balance-qty-input[data-pl-id="${r.id}"]`);
            if (input) input.value = share;
        });
        updateTotalNote();
    });

    root.querySelector('#lp-balance-cancel').addEventListener('click', () => {
        root.innerHTML = '';
    });

    bodyEl.querySelector('#lp-balance-apply').addEventListener('click', async () => {
        const errBox = bodyEl.querySelector('#lp-balance-error');
        const resultsBox = bodyEl.querySelector('#lp-balance-results');
        errBox.textContent = '';
        resultsBox.innerHTML = '';

        const sum = [...bodyEl.querySelectorAll('.lp-balance-qty-input')]
            .reduce((s, el) => s + (parseInt(el.value, 10) || 0), 0);
        if (sum > totalInventory) {
            errBox.textContent = `Entered total (${sum}) exceeds actual stock (${totalInventory}) — reduce before applying.`;
            return;
        }

        const changes = rows
            .map(r => {
                const input = bodyEl.querySelector(`.lp-balance-qty-input[data-pl-id="${r.id}"]`);
                return { row: r, newQty: parseInt(input.value, 10) || 0 };
            })
            .filter(({ row, newQty }) => newQty !== (row.quantity_listed ?? 0));

        if (!changes.length) {
            errBox.textContent = 'Nothing changed.';
            return;
        }

        const summary = changes.map(({ row, newQty }) =>
            `${templateNameByListingId[row.listing_id] || row.listing_id}: ${row.quantity_listed ?? 0} → ${newQty}`).join('\n');
        if (!window.confirm(`This will send live quantity changes to ${changes.length} eBay listing(s):\n\n${summary}\n\nContinue?`)) return;

        const applyBtn = bodyEl.querySelector('#lp-balance-apply');
        applyBtn.disabled = true;
        applyBtn.textContent = 'Applying...';

        const results = [];
        for (const { row, newQty } of changes) {
            try {
                const resp = await fetch(`${PICKING_API_URL}/api/revise-variation-qty`, {
                    method: 'POST',
                    headers: { 'x-picking-token': PICKING_API_TOKEN, 'content-type': 'application/json' },
                    body: JSON.stringify({ platform_listing_id: row.id, new_qty: newQty, account_num: state.accountNum, dry_run: false }),
                });
                if (!resp.ok) {
                    const detail = await resp.text().catch(() => '');
                    throw new Error(`${resp.status} ${detail}`);
                }
                const result = await resp.json();
                results.push({ listingId: row.listing_id, ok: !result.error, detail: result.error || `${row.quantity_listed ?? 0} → ${newQty}` });
            } catch (err) {
                results.push({ listingId: row.listing_id, ok: false, detail: err.message });
            }
        }

        resultsBox.innerHTML = results.map(r => `
            <div style="color:${r.ok ? 'var(--success)' : 'var(--danger)'};">
                ${r.ok ? '✓' : '✗'} ${escapeHtml(templateNameByListingId[r.listingId] || r.listingId)}: ${escapeHtml(r.detail)}
            </div>
        `).join('');

        applyBtn.disabled = false;
        applyBtn.textContent = 'Apply';

        if (results.every(r => r.ok)) {
            setTimeout(async () => {
                root.innerHTML = '';
                await refreshRowDerivedCells(container, rowId);
            }, 1200);
        }
    });
}

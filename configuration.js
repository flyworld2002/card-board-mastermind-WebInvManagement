// configuration.js
// Configuration section — Sets, Card games, Pricing rules, Listing templates.
// Follows the same renderX(container) pattern used by inventory.js / staging-review.js.

import { supabase, debounce } from './shared.js';

let state = {
    sets: [],
    games: [],
    setCounts: {},   // set_id -> count of card_master rows
    search: '',
    loading: true,
    error: null,
};

let gameState = {
    games: [],
    gameSetCounts: {},  // game_id -> count of card_sets rows
    search: '',
};

let pricingState = {
    tab: 'tiers',          // 'tiers' | 'set-config' | 'overrides' | 'card-type-mapping'
    tiers: [],
    setConfigs: [],
    overrides: [],
    cardTypeMappings: [],
    sets: [],
    cardSearch: '',
    cardResults: [],
};

// tier_card_type domain used by both price_tiers and card_type_mapping
const TIER_CARD_TYPES = ['common', 'holo', 'reverse_holo', 'ultra_rare_rule'];

let syncControlsState = {
    statuses: [],
};

let profilesState = {
    profiles: [],
};

let groupsState = {
    groups: [],
    templates: [],
};

let descTemplatesState = {
    tab: 'templates',    // 'templates' | 'theme'
    sections: [],
    templates: [],       // live listing_templates, for the Preview-against picker
    previewTemplateId: null,
    theme: [],           // description_theme_settings rows, ALL theme_keys (filtered client-side by activeThemeKey)
    activeThemeKey: 'default',
};

// Only used for the Preview call (real token rendering lives in
// importer/ebay_descriptions.py, reached via picking_api.py) — every
// other description_sections operation here is a plain Supabase CRUD,
// same as every other Configuration table, deliberately NOT routed
// through picking_api's /api/description-sections endpoints (those still
// exist for other callers, e.g. the CLI, but going direct is simpler and
// doesn't depend on the Tailscale-only desktop service being up for
// what's otherwise a plain settings edit).
const PICKING_API_URL = 'https://desktop-tu1m2fc.tail2c58d7.ts.net:8765';
const PICKING_API_TOKEN = 'I1knbOJAve_UZJQHAFZANds9-HalgCxcRJw1GXDg404';

// The 7 variant lookup tables card_variants references by `code` — all
// share the identical (code, display_name, sort_order) shape, so one
// generic CRUD component handles all of them instead of 7 near-copies.
const ATTR_TABLES = [
    { table: 'foil_types',    label: 'Foil Types',    variantColumn: 'foil_type' },
    { table: 'foil_patterns', label: 'Foil Patterns', variantColumn: 'foil_pattern' },
    { table: 'textures',      label: 'Textures',      variantColumn: 'texture' },
    { table: 'materials',     label: 'Materials',     variantColumn: 'material' },
    { table: 'sizes',         label: 'Sizes',          variantColumn: 'size' },
    { table: 'stamp_types',   label: 'Stamp Types',    variantColumn: 'stamp_type' },
    { table: 'source_types',  label: 'Source Types',   variantColumn: 'source_type' },
];

let attrState = {
    activeTable: 'foil_types',
    rows: [],
    usageCounts: {},   // code -> count of card_variants rows using it
    search: '',
};

export async function renderConfiguration(container, initialKey = 'sets') {
    if (initialKey === 'sets') {
        state = { sets: [], games: [], setCounts: {}, search: '', loading: true, error: null };
        container.innerHTML = configShell(setsSectionHTML());
        wireConfigNav(container, 'sets');
        await loadSets(container);
    } else if (initialKey === 'card-games') {
        gameState = { games: [], gameSetCounts: {}, search: '' };
        container.innerHTML = configShell(gamesSectionHTML());
        wireConfigNav(container, 'card-games');
        await loadGames(container);
    } else if (initialKey === 'pricing-rules') {
        pricingState = { tab: 'tiers', tiers: [], setConfigs: [], overrides: [], cardTypeMappings: [], sets: [], cardSearch: '', cardResults: [] };
        container.innerHTML = configShell(pricingSectionHTML());
        wireConfigNav(container, 'pricing-rules');
        await loadPricing(container);
    } else if (initialKey === 'variant-attributes') {
        attrState = { activeTable: 'foil_types', rows: [], usageCounts: {}, search: '' };
        container.innerHTML = configShell(attrSectionHTML());
        wireConfigNav(container, 'variant-attributes');
        wireAttrTabs(container);
        await loadAttrTable(container);
    } else if (initialKey === 'sync-controls') {
        syncControlsState = { statuses: [] };
        container.innerHTML = configShell(syncControlsSectionHTML());
        wireConfigNav(container, 'sync-controls');
        await loadSyncControls(container);
    } else if (initialKey === 'pricing-profiles') {
        profilesState = { profiles: [] };
        container.innerHTML = configShell(profilesSectionHTML());
        wireConfigNav(container, 'pricing-profiles');
        await loadProfiles(container);
    } else if (initialKey === 'groups') {
        groupsState = { groups: [], templates: [] };
        container.innerHTML = configShell(groupsSectionHTML());
        wireConfigNav(container, 'groups');
        await loadGroups(container);
    } else if (initialKey === 'description-templates') {
        descTemplatesState = { tab: 'templates', sections: [], templates: [], previewTemplateId: null, theme: [], activeThemeKey: 'default' };
        container.innerHTML = configShell(descTemplatesSectionHTML());
        wireConfigNav(container, 'description-templates');
        wireDescTabs(container);
        await loadDescTemplates(container);
    } else {
        container.innerHTML = configShell(`<p style="color:var(--text-secondary)">${labelFor(initialKey)} coming soon.</p>`);
        wireConfigNav(container, initialKey);
    }
}

// ── Shared configuration shell ──────────────────────────────────────────────
// Renders the left sub-nav (Sets / Card games / Pricing rules / Listing
// templates) plus a content slot. Other configuration pages can reuse this.

function configShell(bodyHTML) {
    return `
        <div style="display:flex; gap:24px;">
            <div style="width:180px; flex-shrink:0;">
                <div style="font-size:12px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.03em; padding:0 4px 8px;">Configuration</div>
                <a href="#sets" data-config-nav="sets" class="config-nav-item">Sets</a>
                <a href="#card-games" data-config-nav="card-games" class="config-nav-item">Card games</a>
                <a href="#pricing-rules" data-config-nav="pricing-rules" class="config-nav-item">Pricing rules</a>
                <a href="#pricing-profiles" data-config-nav="pricing-profiles" class="config-nav-item">Pricing profiles</a>
                <a href="#groups" data-config-nav="groups" class="config-nav-item">Groups</a>
                <a href="#description-templates" data-config-nav="description-templates" class="config-nav-item">Description templates</a>
                <a href="#variant-attributes" data-config-nav="variant-attributes" class="config-nav-item">Variant attributes</a>
                <a href="#sync-controls" data-config-nav="sync-controls" class="config-nav-item">Sync controls</a>
            </div>
            <div style="flex:1; min-width:0;" id="config-body">
                ${bodyHTML}
            </div>
        </div>
        <style>
            .config-nav-item {
                display:block;
                padding:8px 10px;
                margin-bottom:2px;
                border-radius:6px;
                color:var(--text-secondary);
                text-decoration:none;
                font-size:13px;
            }
            .config-nav-item:hover { background:var(--bg-tertiary); color:var(--text); }
            .config-nav-item.active { background:var(--bg-tertiary); color:var(--accent); }
        </style>
    `;
}

function wireConfigNav(container, activeKey) {
    container.querySelectorAll('.config-nav-item').forEach(a => {
        a.classList.toggle('active', a.dataset.configNav === activeKey);
        a.addEventListener('click', async (e) => {
            e.preventDefault();
            const key = a.dataset.configNav;
            if (key === activeKey) return;
            if (key === 'sets') {
                await renderConfiguration(container);
            } else if (key === 'card-games') {
                await renderConfiguration(container, 'card-games');
            } else if (key === 'pricing-rules') {
                await renderConfiguration(container, 'pricing-rules');
            } else if (key === 'variant-attributes') {
                await renderConfiguration(container, 'variant-attributes');
            } else if (key === 'sync-controls') {
                await renderConfiguration(container, 'sync-controls');
            } else if (key === 'pricing-profiles') {
                await renderConfiguration(container, 'pricing-profiles');
            } else if (key === 'groups') {
                await renderConfiguration(container, 'groups');
            } else if (key === 'description-templates') {
                await renderConfiguration(container, 'description-templates');
            } else {
                // Other configuration sub-pages land here later.
                container.innerHTML = configShell(`<p style="color:var(--text-secondary)">${labelFor(key)} coming soon.</p>`);
                wireConfigNav(container, key);
            }
        });
    });
}

function labelFor(key) {
    return {
        'card-games': 'Card games',
        'pricing-rules': 'Pricing rules',
        'sync-controls': 'Sync controls',
        'pricing-profiles': 'Pricing profiles',
        'groups': 'Groups',
        'description-templates': 'Description templates',
    }[key] || key;
}

// ── Sets section ─────────────────────────────────────────────────────────────

function setsSectionHTML() {
    return `
        <div class="filters-bar" style="justify-content:space-between;">
            <input type="search" id="sets-search" placeholder="Search sets..." style="min-width:240px;" />
            <button class="btn btn-primary" id="new-set-btn">+ New set</button>
        </div>
        <div id="sets-table-wrap"><p>Loading...</p></div>
        <div id="set-modal-root"></div>
    `;
}

async function loadSets(container) {
    const wrap = container.querySelector('#sets-table-wrap');
    try {
        const [{ data: sets, error: setsErr }, { data: games, error: gamesErr }, { data: masterRows, error: masterErr }] =
            await Promise.all([
                supabase.from('card_sets').select('*').order('name'),
                supabase.from('card_games').select('id, name'),
                supabase.from('card_master').select('set_id'),
            ]);

        if (setsErr) throw setsErr;
        if (gamesErr) throw gamesErr;
        if (masterErr) throw masterErr;

        const counts = {};
        for (const row of masterRows || []) {
            counts[row.set_id] = (counts[row.set_id] || 0) + 1;
        }

        state.sets = sets || [];
        state.games = games || [];
        state.setCounts = counts;
        state.loading = false;

        renderTable(container);
        wireSetsControls(container);
    } catch (err) {
        console.error(err);
        wrap.innerHTML = `<p style="color:var(--danger)">Failed to load sets: ${err.message}</p>`;
    }
}

function renderTable(container) {
    const wrap = container.querySelector('#sets-table-wrap');
    const gameNameById = Object.fromEntries(state.games.map(g => [g.id, g.name]));

    const q = state.search.trim().toLowerCase();
    const rows = state.sets.filter(s =>
        !q || s.name.toLowerCase().includes(q) || (s.set_code || '').toLowerCase().includes(q)
    );

    if (!rows.length) {
        wrap.innerHTML = `<p style="color:var(--text-secondary)">No sets found.</p>`;
        return;
    }

    wrap.innerHTML = `
        <table>
            <thead>
                <tr>
                    <th>Set name</th>
                    <th>Game</th>
                    <th>Code</th>
                    <th>Series</th>
                    <th>Year</th>
                    <th>Cards</th>
                    <th style="width:60px;"></th>
                </tr>
            </thead>
            <tbody>
                ${rows.map(s => `
                    <tr data-set-id="${s.id}">
                        <td>${escapeHTML(s.name)}</td>
                        <td>${escapeHTML(gameNameById[s.game_id] || '-')}</td>
                        <td>${escapeHTML(s.set_code || '-')}</td>
                        <td>${escapeHTML(s.series || '-')}</td>
                        <td>${s.release_year || '-'}</td>
                        <td>${state.setCounts[s.id] || 0}${s.total_cards ? ' / ' + s.total_cards : ''}</td>
                        <td><button class="btn edit-set-btn" data-id="${s.id}">Edit</button></td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;

    wrap.querySelectorAll('.edit-set-btn').forEach(btn => {
        btn.addEventListener('click', () => openSetModal(container, btn.dataset.id));
    });
}

async function confirmDeleteSet(container, setId) {
    const set = state.sets.find(s => s.id === setId);
    if (!set) return;

    const cardCount = state.setCounts[setId] || 0;
    const warning = cardCount > 0
        ? `"${set.name}" has ${cardCount} card${cardCount === 1 ? '' : 's'} linked to it in card_master. Deleting the set will fail unless those cards are removed or reassigned first.\n\nTry to delete anyway?`
        : `Delete "${set.name}"? This can't be undone.`;

    if (!window.confirm(warning)) return;

    try {
        const { error } = await supabase.from('card_sets').delete().eq('id', setId);
        if (error) throw error;
        await loadSets(container);
    } catch (err) {
        console.error(err);
        const isFkViolation = (err.code === '23503') || /foreign key/i.test(err.message || '');
        const msg = isFkViolation
            ? `Can't delete "${set.name}" — it still has cards referencing it in card_master. Remove or reassign those cards first.`
            : `Failed to delete set: ${err.message}`;
        window.alert(msg);
    }
}

function wireSetsControls(container) {
    const searchInput = container.querySelector('#sets-search');
    searchInput.value = state.search;
    searchInput.addEventListener('input', debounce((e) => {
        state.search = e.target.value;
        renderTable(container);
    }, 200));

    container.querySelector('#new-set-btn').addEventListener('click', () => openSetModal(container, null));
}

// ── Create / edit modal ──────────────────────────────────────────────────────

// Hint only, never auto-written — real Pokémon TCG sets pad card numbers
// inconsistently (2-digit, 3-digit, or not at all), so a numeric guess
// can't tell "this set genuinely has no padding" from "not configured
// yet." base_set_number is stored zero-padded already (e.g. '084'), so
// parseInt() first to get the real digit count (84 -> 2), not the
// stored string's literal length (which would always read 3).
function suggestedPadWidth(existing) {
    if (!existing) return null;
    const source = existing.base_set_number || existing.total_cards;
    if (!source) return null;
    const n = parseInt(source, 10);
    return Number.isFinite(n) && n > 0 ? String(n).length : null;
}

function openSetModal(container, setId) {
    const isEdit = !!setId;
    const existing = isEdit ? state.sets.find(s => s.id === setId) : null;
    const root = container.querySelector('#set-modal-root');

    root.innerHTML = `
        <div style="position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:100;">
            <div style="background:var(--bg-secondary); border:1px solid var(--border); border-radius:8px; padding:20px; width:420px; max-width:90vw;">
                <h3 style="margin:0 0 16px;">${isEdit ? 'Edit set' : 'New set'}</h3>
                <form id="set-form">
                    <div style="display:flex; flex-direction:column; gap:10px;">
                        <label style="font-size:12px; color:var(--text-secondary);">
                            Game
                            <select name="game_id" required style="width:100%; margin-top:4px;">
                                ${state.games.map(g => `<option value="${g.id}" ${existing && existing.game_id === g.id ? 'selected' : ''}>${escapeHTML(g.name)}</option>`).join('')}
                            </select>
                        </label>
                        <label style="font-size:12px; color:var(--text-secondary);">
                            Set name
                            <input type="text" name="name" required value="${existing ? escapeAttr(existing.name) : ''}" style="width:100%; margin-top:4px;" />
                        </label>
                        <label style="font-size:12px; color:var(--text-secondary);">
                            Set code
                            <input type="text" name="set_code" required value="${existing ? escapeAttr(existing.set_code || '') : ''}" style="width:100%; margin-top:4px;" placeholder="e.g. sv8pt5" />
                        </label>
                        <label style="font-size:12px; color:var(--text-secondary);">
                            Series
                            <input type="text" name="series" value="${existing ? escapeAttr(existing.series || '') : ''}" style="width:100%; margin-top:4px;" />
                        </label>
                        <div style="display:flex; gap:10px;">
                            <label style="font-size:12px; color:var(--text-secondary); flex:1;">
                                Release year
                                <input type="number" name="release_year" value="${existing ? (existing.release_year || '') : ''}" style="width:100%; margin-top:4px;" />
                            </label>
                            <label style="font-size:12px; color:var(--text-secondary); flex:1;">
                                Total cards
                                <input type="number" name="total_cards" value="${existing ? (existing.total_cards || '') : ''}" style="width:100%; margin-top:4px;" />
                            </label>
                        </div>
                        <label style="font-size:12px; color:var(--text-secondary);">
                            Language
                            <input type="text" name="language" value="${existing ? escapeAttr(existing.language || 'English') : 'English'}" style="width:100%; margin-top:4px;" />
                        </label>
                        <div style="border-top:1px solid var(--border); margin-top:4px; padding-top:10px;">
                            <div style="font-size:11px; text-transform:uppercase; letter-spacing:0.03em; color:var(--text-secondary); margin-bottom:8px;">Card numbering</div>
                            <div style="display:flex; flex-direction:column; gap:10px;">
                                <label style="font-size:12px; color:var(--text-secondary);">
                                    Base set number
                                    <input type="text" name="base_set_number" value="${existing ? escapeAttr(existing.base_set_number || '') : ''}" style="width:100%; margin-top:4px;" />
                                </label>
                                <label style="font-size:12px; color:var(--text-secondary);">
                                    On-card code
                                    <input type="text" name="on_card_code" value="${existing ? escapeAttr(existing.on_card_code || '') : ''}" style="width:100%; margin-top:4px;" />
                                </label>
                                <label style="font-size:12px; color:var(--text-secondary);">
                                    Set prefix
                                    <input type="text" name="set_prefix" value="${existing ? escapeAttr(existing.set_prefix || '') : ''}" style="width:100%; margin-top:4px;" />
                                </label>
                                <label style="font-size:12px; color:var(--text-secondary);">
                                    Number padding (blank = no padding)
                                    <input type="number" name="number_pad_width" min="0"
                                           value="${existing?.number_pad_width ?? ''}"
                                           placeholder="${suggestedPadWidth(existing) ?? 'e.g. 2 or 3'}"
                                           style="width:100%; margin-top:4px;" />
                                    ${suggestedPadWidth(existing) ? `<span style="font-size:11px; color:var(--text-secondary); display:block; margin-top:2px;">
                                        suggested: ${suggestedPadWidth(existing)} (from ${existing.base_set_number ? 'base set number' : 'total cards'})
                                    </span>` : ''}
                                </label>
                            </div>
                        </div>
                    </div>
                    <div id="set-form-error" style="color:var(--danger); font-size:12px; margin-top:10px;"></div>
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:18px;">
                        ${isEdit ? `<button type="button" class="btn" id="set-modal-delete" style="color:var(--danger); border-color:var(--danger);">Delete set</button>` : '<span></span>'}
                        <div style="display:flex; gap:8px;">
                            <button type="button" class="btn" id="set-modal-cancel">Cancel</button>
                            <button type="submit" class="btn btn-primary">${isEdit ? 'Save changes' : 'Create set'}</button>
                        </div>
                    </div>
                </form>
            </div>
        </div>
    `;

    root.querySelector('#set-modal-cancel').addEventListener('click', () => { root.innerHTML = ''; });

    if (isEdit) {
        root.querySelector('#set-modal-delete').addEventListener('click', async () => {
            root.innerHTML = '';
            await confirmDeleteSet(container, setId);
        });
    }

    root.querySelector('#set-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errBox = root.querySelector('#set-form-error');
        errBox.textContent = '';

        const fd = new FormData(e.target);
        const payload = {
            game_id: fd.get('game_id'),
            name: fd.get('name').trim(),
            set_code: fd.get('set_code').trim(),
            series: fd.get('series').trim() || null,
            release_year: fd.get('release_year') ? parseInt(fd.get('release_year'), 10) : null,
            total_cards: fd.get('total_cards') ? parseInt(fd.get('total_cards'), 10) : null,
            language: fd.get('language').trim() || 'English',
            base_set_number: fd.get('base_set_number').trim() || null,
            on_card_code: fd.get('on_card_code').trim() || null,
            set_prefix: fd.get('set_prefix').trim() || null,
            number_pad_width: fd.get('number_pad_width') ? parseInt(fd.get('number_pad_width'), 10) : null,
        };

        try {
            if (isEdit) {
                const { error } = await supabase.from('card_sets').update(payload).eq('id', setId);
                if (error) throw error;
            } else {
                const { error } = await supabase.from('card_sets').insert(payload);
                if (error) throw error;
            }
            root.innerHTML = '';
            await loadSets(container);
        } catch (err) {
            console.error(err);
            errBox.textContent = err.message || 'Failed to save set.';
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

// ── Pricing rules section (3 sub-tabs: tiers / set-config / overrides) ──────

function pricingSectionHTML() {
    return `
        <div style="display:flex; gap:4px; margin-bottom:16px; border-bottom:1px solid var(--border);">
            <button class="pricing-tab-btn" data-tab="tiers">Price tiers</button>
            <button class="pricing-tab-btn" data-tab="set-config">Set pricing</button>
            <button class="pricing-tab-btn" data-tab="overrides">Card overrides</button>
            <button class="pricing-tab-btn" data-tab="card-type-mapping">Card type mapping</button>
        </div>
        <div id="pricing-tab-content"><p>Loading...</p></div>
        <div id="pricing-modal-root"></div>
        <style>
            .pricing-tab-btn {
                background:none; border:none; color:var(--text-secondary);
                padding:8px 14px; font-size:13px; cursor:pointer;
                border-bottom:2px solid transparent; margin-bottom:-1px;
            }
            .pricing-tab-btn:hover { color:var(--text); }
            .pricing-tab-btn.active { color:var(--accent); border-bottom-color:var(--accent); }
        </style>
    `;
}

async function loadPricing(container) {
    const wrap = container.querySelector('#pricing-tab-content');
    try {
        const [{ data: tiers, error: tiersErr }, { data: setConfigs, error: scErr },
               { data: overrides, error: ovErr }, { data: mappings, error: mapErr },
               { data: sets, error: setsErr }] = await Promise.all([
            supabase.from('price_tiers').select('*').order('platform').order('card_type').order('sort_order'),
            supabase.from('set_pricing_config').select('*').order('created_at', { ascending: false }),
            supabase.from('card_pricing_overrides').select('*').order('updated_at', { ascending: false }),
            supabase.from('card_type_mapping').select('*').order('platform').order('rarity', { nullsFirst: true }),
            supabase.from('card_sets').select('id, name'),
        ]);
        if (tiersErr) throw tiersErr;
        if (scErr) throw scErr;
        if (ovErr) throw ovErr;
        if (mapErr) throw mapErr;
        if (setsErr) throw setsErr;

        pricingState.tiers = tiers || [];
        pricingState.setConfigs = setConfigs || [];
        pricingState.overrides = overrides || [];
        pricingState.cardTypeMappings = mappings || [];
        pricingState.sets = sets || [];

        wirePricingTabs(container);
        renderPricingTab(container);
    } catch (err) {
        console.error(err);
        wrap.innerHTML = `<p style="color:var(--danger)">Failed to load pricing data: ${err.message}</p>`;
    }
}

function wirePricingTabs(container) {
    container.querySelectorAll('.pricing-tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === pricingState.tab);
        btn.addEventListener('click', () => {
            pricingState.tab = btn.dataset.tab;
            container.querySelectorAll('.pricing-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === pricingState.tab));
            renderPricingTab(container);
        });
    });
}

function renderPricingTab(container) {
    if (pricingState.tab === 'tiers') renderTiersTab(container);
    else if (pricingState.tab === 'set-config') renderSetConfigTab(container);
    else if (pricingState.tab === 'card-type-mapping') renderCardTypeMappingTab(container);
    else renderOverridesTab(container);
}

// -- Price tiers --

function renderTiersTab(container) {
    const wrap = container.querySelector('#pricing-tab-content');
    const rows = pricingState.tiers;

    wrap.innerHTML = `
        <div style="display:flex; justify-content:flex-end; margin-bottom:12px;">
            <button class="btn btn-primary" id="new-tier-btn">+ New tier</button>
        </div>
        ${rows.length ? `
        <table>
            <thead><tr>
                <th>Platform</th><th>Account</th><th>Card type</th><th>Market price ≤</th><th>List price</th><th>Sort</th><th style="width:60px;"></th>
            </tr></thead>
            <tbody>
                ${rows.map(t => `
                    <tr>
                        <td>${escapeHTML(t.platform)}</td>
                        <td>${t.account ? escapeHTML(t.account) : '<span style="color:var(--text-secondary);">All accounts</span>'}</td>
                        <td>${escapeHTML(t.card_type)}</td>
                        <td>${formatPrice(t.market_price_max)}</td>
                        <td>${formatPrice(t.list_price)}</td>
                        <td>${t.sort_order}</td>
                        <td><button class="btn edit-tier-btn" data-id="${t.id}">Edit</button></td>
                    </tr>
                `).join('')}
            </tbody>
        </table>` : `<p style="color:var(--text-secondary)">No price tiers yet.</p>`}
    `;

    wrap.querySelector('#new-tier-btn').addEventListener('click', () => openTierModal(container, null));
    wrap.querySelectorAll('.edit-tier-btn').forEach(btn => {
        btn.addEventListener('click', () => openTierModal(container, btn.dataset.id));
    });
}

function openTierModal(container, tierId) {
    const isEdit = !!tierId;
    const existing = isEdit ? pricingState.tiers.find(t => t.id === tierId) : null;
    const root = container.querySelector('#pricing-modal-root');

    root.innerHTML = modalShell(isEdit ? 'Edit price tier' : 'New price tier', `
        <div style="display:flex; flex-direction:column; gap:10px;">
            ${field('Platform', 'text', 'platform', existing?.platform || 'ebay')}
            ${field('Account (blank = applies to all accounts)', 'text', 'account', existing?.account || '', 'e.g. BIGGYFISH', '', true)}
            ${field('Card type', 'text', 'card_type', existing?.card_type || '', 'e.g. common, holo, reverse_holo')}
            ${field('Market price max ($)', 'number', 'market_price_max', existing?.market_price_max ?? '', '', '0.01')}
            ${field('List price ($)', 'number', 'list_price', existing?.list_price ?? '', '', '0.01')}
            ${field('Sort order', 'number', 'sort_order', existing?.sort_order ?? '')}
        </div>
    `, isEdit, 'tier');

    root.querySelector('#modal-cancel').addEventListener('click', () => { root.innerHTML = ''; });
    if (isEdit) {
        root.querySelector('#modal-delete').addEventListener('click', async () => {
            root.innerHTML = '';
            await confirmDelete(container, 'price_tiers', tierId, `this price tier`, () => loadPricing(container));
        });
    }
    root.querySelector('#modal-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errBox = root.querySelector('#modal-error');
        errBox.textContent = '';
        const fd = new FormData(e.target);
        const payload = {
            platform: fd.get('platform').trim(),
            account: fd.get('account').trim() || null,
            card_type: fd.get('card_type').trim(),
            market_price_max: parseFloat(fd.get('market_price_max')),
            list_price: parseFloat(fd.get('list_price')),
            sort_order: parseInt(fd.get('sort_order'), 10),
        };
        try {
            const { error } = isEdit
                ? await supabase.from('price_tiers').update(payload).eq('id', tierId)
                : await supabase.from('price_tiers').insert(payload);
            if (error) throw error;
            root.innerHTML = '';
            await loadPricing(container);
        } catch (err) {
            console.error(err);
            errBox.textContent = err.message || 'Failed to save price tier.';
        }
    });
}

// -- Set pricing config --

function renderSetConfigTab(container) {
    const wrap = container.querySelector('#pricing-tab-content');
    const setNameById = Object.fromEntries(pricingState.sets.map(s => [s.id, s.name]));
    const rows = pricingState.setConfigs;

    wrap.innerHTML = `
        <div style="display:flex; justify-content:flex-end; margin-bottom:12px;">
            <button class="btn btn-primary" id="new-setconfig-btn">+ New set pricing rule</button>
        </div>
        ${rows.length ? `
        <table>
            <thead><tr>
                <th>Set</th><th>Platform</th><th>Account</th><th>Multiplier</th><th>Ultra rare rule</th><th>Era</th><th style="width:60px;"></th>
            </tr></thead>
            <tbody>
                ${rows.map(sc => `
                    <tr>
                        <td>${escapeHTML(setNameById[sc.set_id] || sc.set_id)}</td>
                        <td>${escapeHTML(sc.platform)}</td>
                        <td>${sc.account ? escapeHTML(sc.account) : '<span style="color:var(--text-secondary);">All accounts</span>'}</td>
                        <td>${sc.price_multiplier}x</td>
                        <td>${escapeHTML(sc.ultra_rare_rule)}</td>
                        <td>${escapeHTML(sc.era_tag || '-')}</td>
                        <td><button class="btn edit-setconfig-btn" data-id="${sc.id}">Edit</button></td>
                    </tr>
                `).join('')}
            </tbody>
        </table>` : `<p style="color:var(--text-secondary)">No set pricing rules yet.</p>`}
    `;

    wrap.querySelector('#new-setconfig-btn').addEventListener('click', () => openSetConfigModal(container, null));
    wrap.querySelectorAll('.edit-setconfig-btn').forEach(btn => {
        btn.addEventListener('click', () => openSetConfigModal(container, btn.dataset.id));
    });
}

function openSetConfigModal(container, configId) {
    const isEdit = !!configId;
    const existing = isEdit ? pricingState.setConfigs.find(sc => sc.id === configId) : null;
    const root = container.querySelector('#pricing-modal-root');

    root.innerHTML = modalShell(isEdit ? 'Edit set pricing rule' : 'New set pricing rule', `
        <div style="display:flex; flex-direction:column; gap:10px;">
            <label style="font-size:12px; color:var(--text-secondary);">
                Set
                <select name="set_id" required style="width:100%; margin-top:4px;">
                    ${pricingState.sets.map(s => `<option value="${s.id}" ${existing?.set_id === s.id ? 'selected' : ''}>${escapeHTML(s.name)}</option>`).join('')}
                </select>
            </label>
            ${field('Platform', 'text', 'platform', existing?.platform || 'ebay')}
            ${field('Account (blank = applies to all accounts)', 'text', 'account', existing?.account || '', 'e.g. BIGGYFISH', '', true)}
            ${field('Price multiplier', 'number', 'price_multiplier', existing?.price_multiplier ?? '1.00', '', '0.01')}
            <div style="display:flex; gap:10px;">
                ${field('Common floor ($)', 'number', 'common_floor', existing?.common_floor ?? '', '', '0.01', true)}
                ${field('Reverse holo floor ($)', 'number', 'reverse_holo_floor', existing?.reverse_holo_floor ?? '', '', '0.01', true)}
                ${field('Holo floor ($)', 'number', 'holo_floor', existing?.holo_floor ?? '', '', '0.01', true)}
            </div>
            <label style="font-size:12px; color:var(--text-secondary);">
                Ultra rare rule
                <select name="ultra_rare_rule" style="width:100%; margin-top:4px;">
                    ${['tier', 'manual', 'multiplier'].map(v => `<option value="${v}" ${existing?.ultra_rare_rule === v ? 'selected' : ''}>${v}</option>`).join('')}
                </select>
            </label>
            <div style="display:flex; gap:10px;">
                ${field('Ultra rare multiplier', 'number', 'ultra_rare_multiplier', existing?.ultra_rare_multiplier ?? '2.00', '', '0.01', true)}
                ${field('Ultra rare plus ($)', 'number', 'ultra_rare_plus', existing?.ultra_rare_plus ?? '1.00', '', '0.01', true)}
            </div>
            <div style="display:flex; gap:10px;">
                ${field('Common max card #', 'number', 'common_max_card_num', existing?.common_max_card_num ?? '', '', '', true)}
                ${field('Set total cards', 'number', 'set_total_cards', existing?.set_total_cards ?? '', '', '', true)}
            </div>
            ${field('Era tag', 'text', 'era_tag', existing?.era_tag || '', 'popular, vintage, standard, rotation', '', true)}
            ${field('Notes', 'text', 'notes', existing?.notes || '', '', '', true)}
        </div>
    `, isEdit, 'setconfig');

    root.querySelector('#modal-cancel').addEventListener('click', () => { root.innerHTML = ''; });
    if (isEdit) {
        root.querySelector('#modal-delete').addEventListener('click', async () => {
            root.innerHTML = '';
            await confirmDelete(container, 'set_pricing_config', configId, `this set pricing rule`, () => loadPricing(container));
        });
    }
    root.querySelector('#modal-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errBox = root.querySelector('#modal-error');
        errBox.textContent = '';
        const fd = new FormData(e.target);
        const num = (name) => fd.get(name) ? parseFloat(fd.get(name)) : null;
        const int = (name) => fd.get(name) ? parseInt(fd.get(name), 10) : null;
        const payload = {
            set_id: fd.get('set_id'),
            platform: fd.get('platform').trim(),
            account: fd.get('account').trim() || null,
            price_multiplier: parseFloat(fd.get('price_multiplier')) || 1.00,
            common_floor: num('common_floor'),
            reverse_holo_floor: num('reverse_holo_floor'),
            holo_floor: num('holo_floor'),
            ultra_rare_rule: fd.get('ultra_rare_rule'),
            ultra_rare_multiplier: num('ultra_rare_multiplier'),
            ultra_rare_plus: num('ultra_rare_plus'),
            common_max_card_num: int('common_max_card_num'),
            set_total_cards: int('set_total_cards'),
            era_tag: fd.get('era_tag').trim() || null,
            notes: fd.get('notes').trim() || null,
            updated_at: new Date().toISOString(),
        };
        try {
            const { error } = isEdit
                ? await supabase.from('set_pricing_config').update(payload).eq('id', configId)
                : await supabase.from('set_pricing_config').insert(payload);
            if (error) throw error;
            root.innerHTML = '';
            await loadPricing(container);
        } catch (err) {
            console.error(err);
            errBox.textContent = err.message || 'Failed to save set pricing rule.';
        }
    });
}

// -- Card pricing overrides --

function renderOverridesTab(container) {
    const wrap = container.querySelector('#pricing-tab-content');
    const rows = pricingState.overrides;

    wrap.innerHTML = `
        <div style="display:flex; justify-content:flex-end; margin-bottom:12px;">
            <button class="btn btn-primary" id="new-override-btn">+ New card override</button>
        </div>
        ${rows.length ? `
        <table>
            <thead><tr>
                <th>Card ID</th><th>Platform</th><th>Account</th><th>List price</th><th>Notes</th><th style="width:60px;"></th>
            </tr></thead>
            <tbody>
                ${rows.map(o => `
                    <tr>
                        <td style="font-family:monospace; font-size:12px;">${o.card_id}</td>
                        <td>${escapeHTML(o.platform)}</td>
                        <td>${o.account ? escapeHTML(o.account) : '<span style="color:var(--text-secondary);">All accounts</span>'}</td>
                        <td>${formatPrice(o.list_price)}</td>
                        <td style="color:var(--text-secondary);">${escapeHTML(o.notes || '-')}</td>
                        <td><button class="btn edit-override-btn" data-id="${o.id}">Edit</button></td>
                    </tr>
                `).join('')}
            </tbody>
        </table>` : `<p style="color:var(--text-secondary)">No card price overrides yet.</p>`}
        <p style="color:var(--text-secondary); font-size:12px; margin-top:8px;">Note: card overrides currently reference card_master by UUID directly — a proper card search/picker can be added once the Catalog page exists.</p>
    `;

    wrap.querySelector('#new-override-btn').addEventListener('click', () => openOverrideModal(container, null));
    wrap.querySelectorAll('.edit-override-btn').forEach(btn => {
        btn.addEventListener('click', () => openOverrideModal(container, btn.dataset.id));
    });
}

function openOverrideModal(container, overrideId) {
    const isEdit = !!overrideId;
    const existing = isEdit ? pricingState.overrides.find(o => o.id === overrideId) : null;
    const root = container.querySelector('#pricing-modal-root');

    root.innerHTML = modalShell(isEdit ? 'Edit card override' : 'New card override', `
        <div style="display:flex; flex-direction:column; gap:10px;">
            ${field('Card ID (UUID)', 'text', 'card_id', existing?.card_id || '', 'paste card_master.id')}
            ${field('Platform', 'text', 'platform', existing?.platform || 'ebay')}
            ${field('Account (blank = applies to all accounts)', 'text', 'account', existing?.account || '', 'e.g. BIGGYFISH', '', true)}
            ${field('List price ($)', 'number', 'list_price', existing?.list_price ?? '', '', '0.01')}
            ${field('Notes', 'text', 'notes', existing?.notes || '', '', '', true)}
        </div>
    `, isEdit, 'override');

    root.querySelector('#modal-cancel').addEventListener('click', () => { root.innerHTML = ''; });
    if (isEdit) {
        root.querySelector('#modal-delete').addEventListener('click', async () => {
            root.innerHTML = '';
            await confirmDelete(container, 'card_pricing_overrides', overrideId, `this card override`, () => loadPricing(container));
        });
    }
    root.querySelector('#modal-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errBox = root.querySelector('#modal-error');
        errBox.textContent = '';
        const fd = new FormData(e.target);
        const payload = {
            card_id: fd.get('card_id').trim(),
            platform: fd.get('platform').trim(),
            account: fd.get('account').trim() || null,
            list_price: parseFloat(fd.get('list_price')),
            notes: fd.get('notes').trim() || null,
            updated_at: new Date().toISOString(),
        };
        try {
            const { error } = isEdit
                ? await supabase.from('card_pricing_overrides').update(payload).eq('id', overrideId)
                : await supabase.from('card_pricing_overrides').insert(payload);
            if (error) throw error;
            root.innerHTML = '';
            await loadPricing(container);
        } catch (err) {
            console.error(err);
            errBox.textContent = err.message || 'Failed to save card override. Check that the Card ID is a valid card_master UUID.';
        }
    });
}

// -- Card type mapping (rarity + variant_key -> tier_card_type) --------------
// Resolved most-specific-first by importer/ebay_listing_sync.py's
// resolve_tier_card_type(): a row with BOTH rarity and variant_key set
// beats a row with only one set, which beats the all-NULL wildcard.
// `--ebay-recalc-prices --dry-run` flags any card that only matched the
// wildcard row, so new/unmapped rarities don't silently price as common.

function renderCardTypeMappingTab(container) {
    const wrap = container.querySelector('#pricing-tab-content');
    const rows = pricingState.cardTypeMappings;

    wrap.innerHTML = `
        <p style="color:var(--text-secondary); font-size:12px; margin:0 0 12px;">
            Maps a card's rarity (and optionally a variant_key pattern, for
            overrides like reverse-holo) to a pricing tier. Most-specific
            match wins: rarity + variant_key beats rarity-only beats the
            wildcard (blank rarity, blank variant_key) row. Cards that only
            match the wildcard are flagged in <code>--ebay-recalc-prices
            --dry-run</code> output — add a row here for any rarity that
            keeps showing up flagged.
        </p>
        <div style="display:flex; justify-content:flex-end; margin-bottom:12px;">
            <button class="btn btn-primary" id="new-mapping-btn">+ New mapping</button>
        </div>
        ${rows.length ? `
        <table>
            <thead><tr>
                <th>Platform</th><th>Account</th><th>Rarity</th><th>Variant key pattern</th><th>Tier</th><th>Priority</th><th style="width:60px;"></th>
            </tr></thead>
            <tbody>
                ${rows.map(m => `
                    <tr>
                        <td>${escapeHTML(m.platform)}</td>
                        <td>${m.account ? escapeHTML(m.account) : '<span style="color:var(--text-secondary);">All accounts</span>'}</td>
                        <td>${m.rarity ? escapeHTML(m.rarity) : '<span style="color:var(--text-secondary);">Any (wildcard)</span>'}</td>
                        <td><code>${m.variant_key ? escapeHTML(m.variant_key) : '(any)'}</code></td>
                        <td>${escapeHTML(m.tier_card_type)}</td>
                        <td>${m.priority}</td>
                        <td><button class="btn edit-mapping-btn" data-id="${m.id}">Edit</button></td>
                    </tr>
                `).join('')}
            </tbody>
        </table>` : `<p style="color:var(--text-secondary)">No card type mappings yet.</p>`}
    `;

    wrap.querySelector('#new-mapping-btn').addEventListener('click', () => openCardTypeMappingModal(container, null));
    wrap.querySelectorAll('.edit-mapping-btn').forEach(btn => {
        btn.addEventListener('click', () => openCardTypeMappingModal(container, btn.dataset.id));
    });
}

function openCardTypeMappingModal(container, mappingId) {
    const isEdit = !!mappingId;
    const existing = isEdit ? pricingState.cardTypeMappings.find(m => m.id === mappingId) : null;
    const root = container.querySelector('#pricing-modal-root');

    root.innerHTML = modalShell(isEdit ? 'Edit card type mapping' : 'New card type mapping', `
        <div style="display:flex; flex-direction:column; gap:10px;">
            ${field('Platform', 'text', 'platform', existing?.platform || 'ebay')}
            ${field('Account (blank = applies to all accounts)', 'text', 'account', existing?.account || '', 'e.g. BIGGYFISH', '', true)}
            ${field('Rarity (blank = wildcard, matches any)', 'text', 'rarity', existing?.rarity || '', 'e.g. Illustration Rare', '', true)}
            ${field('Variant key pattern (blank = any; % wildcards allowed)', 'text', 'variant_key', existing?.variant_key || '', 'e.g. %reverse_holo%', '', true)}
            <label style="font-size:12px; color:var(--text-secondary);">
                Tier
                <select name="tier_card_type" required style="width:100%; margin-top:4px;">
                    ${TIER_CARD_TYPES.map(v => `<option value="${v}" ${existing?.tier_card_type === v ? 'selected' : ''}>${v}</option>`).join('')}
                </select>
            </label>
            ${field('Priority (tie-break within equal specificity — higher wins)', 'number', 'priority', existing?.priority ?? '10')}
        </div>
    `, isEdit, 'mapping');

    root.querySelector('#modal-cancel').addEventListener('click', () => { root.innerHTML = ''; });
    if (isEdit) {
        root.querySelector('#modal-delete').addEventListener('click', async () => {
            root.innerHTML = '';
            await confirmDelete(container, 'card_type_mapping', mappingId, `this card type mapping`, () => loadPricing(container));
        });
    }
    root.querySelector('#modal-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errBox = root.querySelector('#modal-error');
        errBox.textContent = '';
        const fd = new FormData(e.target);
        const payload = {
            platform: fd.get('platform').trim(),
            account: fd.get('account').trim() || null,
            rarity: fd.get('rarity').trim() || null,
            variant_key: fd.get('variant_key').trim() || null,
            tier_card_type: fd.get('tier_card_type'),
            priority: parseInt(fd.get('priority'), 10) || 10,
        };
        try {
            const { error } = isEdit
                ? await supabase.from('card_type_mapping').update(payload).eq('id', mappingId)
                : await supabase.from('card_type_mapping').insert(payload);
            if (error) throw error;
            root.innerHTML = '';
            await loadPricing(container);
        } catch (err) {
            console.error(err);
            errBox.textContent = err.message || 'Failed to save card type mapping.';
        }
    });
}

// ── Pricing profiles section (docs/plans/listing-pricing-system.md) ────────
// A profile is a named, reusable tier table (e.g. 'double_rare_rh_ur':
// market < $1 -> 3.99, >= $1 -> 4.99). Listing pricing rules (assigned on
// the Listing pricing page, not here) map a card's rarity/foil_type/set/
// card to one of these profiles. Tier management is a nested view within
// the profile's own modal to keep this screen focused, mirroring how the
// rest of this file uses one modal per concern.

function profilesSectionHTML() {
    return `
        <p style="color:var(--text-secondary); font-size:12px; margin:0 0 12px;">
            Profiles are pure tier tables — they don't know about listings
            or platforms. Assign a profile to a listing via a pricing rule
            on that listing's Listing pricing page.
        </p>
        <div class="filters-bar" style="justify-content:flex-end;">
            <button class="btn btn-primary" id="new-profile-btn">+ New profile</button>
        </div>
        <div id="profiles-table-wrap"><p>Loading...</p></div>
        <div id="profiles-modal-root"></div>
    `;
}

async function loadProfiles(container) {
    const wrap = container.querySelector('#profiles-table-wrap');
    try {
        const { data: profiles, error: pErr } = await supabase.from('pricing_profiles').select('*').order('name');
        if (pErr) throw pErr;
        const { data: tiers, error: tErr } = await supabase.from('pricing_profile_tiers').select('*').order('min_market');
        if (tErr) throw tErr;

        const tiersByProfile = {};
        for (const t of tiers || []) {
            (tiersByProfile[t.profile_id] ??= []).push(t);
        }
        profilesState.profiles = (profiles || []).map(p => ({ ...p, tiers: tiersByProfile[p.id] || [] }));

        renderProfilesTable(container);
    } catch (err) {
        console.error(err);
        wrap.innerHTML = `<p style="color:var(--danger)">Failed to load pricing profiles: ${err.message}</p>`;
    }
}

function tiersSummary(tiers) {
    if (!tiers.length) return '<span style="color:var(--text-secondary);">no tiers</span>';
    return tiers.map(t => {
        const range = t.max_market == null ? `≥ ${formatPrice(t.min_market)}` : `${formatPrice(t.min_market)}–${formatPrice(t.max_market)}`;
        return `${range} → ${tierPriceLabel(t)}`;
    }).join(', ');
}

// A tier is either a flat list_price or a market*multiplier+plus formula
// (migration 007) — never both, enforced by chk_tier_price_or_formula.
function tierPriceLabel(t) {
    if (t.list_price != null) return formatPrice(t.list_price);
    const plusPart = t.plus ? ` + ${formatPrice(t.plus)}` : '';
    return `market × ${t.multiplier}${plusPart}`;
}

function renderProfilesTable(container) {
    const wrap = container.querySelector('#profiles-table-wrap');
    const rows = profilesState.profiles;

    if (!rows.length) {
        wrap.innerHTML = `<p style="color:var(--text-secondary)">No pricing profiles yet.</p>`;
    } else {
        wrap.innerHTML = `
            <table>
                <thead><tr>
                    <th>Name</th><th>Tiers</th><th>Default low-stock qty</th><th>Notes</th><th style="width:140px;"></th>
                </tr></thead>
                <tbody>
                    ${rows.map(p => `
                        <tr>
                            <td>${escapeHTML(p.name)}</td>
                            <td style="font-size:12px; color:var(--text-secondary);">${tiersSummary(p.tiers)}</td>
                            <td>${p.default_low_stock_qty ?? '-'}</td>
                            <td style="color:var(--text-secondary);">${escapeHTML(p.notes || '-')}</td>
                            <td>
                                <button class="btn edit-profile-btn" data-id="${p.id}">Edit</button>
                                <button class="btn manage-tiers-btn" data-id="${p.id}">Tiers</button>
                                <button class="btn duplicate-profile-btn" data-id="${p.id}">Duplicate</button>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    }

    container.querySelector('#new-profile-btn').addEventListener('click', () => openProfileModal(container, null));
    wrap.querySelectorAll('.edit-profile-btn').forEach(btn => {
        btn.addEventListener('click', () => openProfileModal(container, btn.dataset.id));
    });
    wrap.querySelectorAll('.manage-tiers-btn').forEach(btn => {
        btn.addEventListener('click', () => openProfileTiersModal(container, btn.dataset.id));
    });
    wrap.querySelectorAll('.duplicate-profile-btn').forEach(btn => {
        btn.addEventListener('click', () => duplicateProfile(container, btn.dataset.id));
    });
}

// Copies name/notes/default_low_stock_qty AND every tier — unlike
// duplicating a listing template (config only, roster stays empty),
// tiers ARE the profile's actual pricing rules: a duplicate with none
// would just fall back to the market*2+1 default and be useless as a
// starting point for a similar-but-tweaked rule set.
async function duplicateProfile(container, profileId) {
    const source = profilesState.profiles.find(p => p.id === profileId);
    if (!source) return;

    let copyName = `${source.name} (copy)`;
    for (let n = 2; profilesState.profiles.some(p => p.name === copyName); n++) {
        copyName = `${source.name} (copy ${n})`;
    }

    try {
        const { data: inserted, error: insErr } = await supabase.from('pricing_profiles').insert({
            name: copyName,
            notes: source.notes,
            default_low_stock_qty: source.default_low_stock_qty,
        }).select().single();
        if (insErr) throw insErr;

        if (source.tiers.length) {
            const tierPayload = source.tiers.map(t => ({
                profile_id: inserted.id,
                min_market: t.min_market,
                max_market: t.max_market,
                list_price: t.list_price,
                multiplier: t.multiplier,
                plus: t.plus,
            }));
            const { error: tierErr } = await supabase.from('pricing_profile_tiers').insert(tierPayload);
            if (tierErr) throw tierErr;
        }

        await loadProfiles(container);
    } catch (err) {
        console.error(err);
        window.alert(`Failed to duplicate profile: ${err.message}`);
    }
}

function openProfileModal(container, profileId) {
    const isEdit = !!profileId;
    const existing = isEdit ? profilesState.profiles.find(p => p.id === profileId) : null;
    const root = container.querySelector('#profiles-modal-root');

    root.innerHTML = modalShell(isEdit ? 'Edit pricing profile' : 'New pricing profile', `
        <div style="display:flex; flex-direction:column; gap:10px;">
            ${field('Name', 'text', 'name', existing?.name || '', 'e.g. double_rare_rh_ur')}
            ${field('Notes', 'text', 'notes', existing?.notes || '', '', '', true)}
            ${field('Default low-stock qty', 'number', 'default_low_stock_qty', existing?.default_low_stock_qty ?? '', 'holds back this many units from being pushed', '', true)}
        </div>
        ${!isEdit ? '<p style="color:var(--text-secondary); font-size:12px; margin-top:10px;">Add tiers after creating the profile, via the "Tiers" button.</p>' : ''}
    `, isEdit, 'profile');

    root.querySelector('#modal-cancel').addEventListener('click', () => { root.innerHTML = ''; });
    if (isEdit) {
        root.querySelector('#modal-delete').addEventListener('click', async () => {
            root.innerHTML = '';
            await confirmDelete(container, 'pricing_profiles', profileId, `this pricing profile`, () => loadProfiles(container));
        });
    }
    root.querySelector('#modal-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errBox = root.querySelector('#modal-error');
        errBox.textContent = '';
        const fd = new FormData(e.target);
        const payload = {
            name: fd.get('name').trim(),
            notes: fd.get('notes').trim() || null,
            default_low_stock_qty: fd.get('default_low_stock_qty') ? parseInt(fd.get('default_low_stock_qty'), 10) : null,
        };
        try {
            const { error } = isEdit
                ? await supabase.from('pricing_profiles').update(payload).eq('id', profileId)
                : await supabase.from('pricing_profiles').insert(payload);
            if (error) throw error;
            root.innerHTML = '';
            await loadProfiles(container);
        } catch (err) {
            console.error(err);
            const isDupe = err.code === '23505';
            errBox.textContent = isDupe ? `"${payload.name}" already exists.` : (err.message || 'Failed to save pricing profile.');
        }
    });
}

// -- Tier management (nested within one profile) --

function openProfileTiersModal(container, profileId) {
    const profile = profilesState.profiles.find(p => p.id === profileId);
    if (!profile) return;
    const root = container.querySelector('#profiles-modal-root');
    renderTiersModalBody(root, container, profileId);
}

function renderTiersModalBody(root, container, profileId, editingTierId = null) {
    const profile = profilesState.profiles.find(p => p.id === profileId);
    const tiers = profile.tiers;
    const editingTier = editingTierId ? tiers.find(t => t.id === editingTierId) : (editingTierId === 'new' ? {} : null);
    const isFormOpen = editingTierId !== null;
    const tierMode = editingTier && editingTier.list_price == null && editingTier.multiplier != null ? 'formula' : 'flat';

    root.innerHTML = `
        <div style="position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:100;">
            <div style="background:var(--bg-secondary); border:1px solid var(--border); border-radius:8px; padding:20px; width:460px; max-width:90vw; max-height:85vh; overflow-y:auto;">
                <h3 style="margin:0 0 4px;">Tiers — ${escapeHTML(profile.name)}</h3>
                <p style="color:var(--text-secondary); font-size:12px; margin:0 0 14px;">
                    Market price brackets: min is inclusive, max is exclusive (blank max = open-ended top tier).
                    Blank quantity limit falls back to the listing's default, then 24.
                </p>
                ${tiers.length ? `
                    <table style="margin-bottom:12px;">
                        <thead><tr><th>Min market</th><th>Max market</th><th>List price</th><th>Qty limit</th><th style="width:110px;"></th></tr></thead>
                        <tbody>
                            ${tiers.map(t => `
                                <tr>
                                    <td>${formatPrice(t.min_market)}</td>
                                    <td>${t.max_market == null ? '(open-ended)' : formatPrice(t.max_market)}</td>
                                    <td>${tierPriceLabel(t)}</td>
                                    <td>${t.quantity_limit ?? '—'}</td>
                                    <td>
                                        <button type="button" class="btn edit-tier-row-btn" data-id="${t.id}" style="padding:2px 8px; font-size:12px;">Edit</button>
                                        <button type="button" class="btn delete-tier-row-btn" data-id="${t.id}" style="padding:2px 8px; font-size:12px; color:var(--danger);">×</button>
                                    </td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                ` : `<p style="color:var(--text-secondary); font-size:13px;">No tiers yet.</p>`}

                ${isFormOpen ? `
                    <form id="tier-form" style="border-top:1px solid var(--border); padding-top:12px; display:flex; flex-direction:column; gap:10px;">
                        <div style="display:flex; gap:10px;">
                            ${field('Min market ($, inclusive)', 'number', 'min_market', editingTier?.min_market ?? '0.00', '', '0.01')}
                            ${field('Max market ($, exclusive; blank = open-ended)', 'number', 'max_market', editingTier?.max_market ?? '', '', '0.01', true)}
                        </div>
                        ${field('Quantity limit (blank = listing default)', 'number', 'quantity_limit', editingTier?.quantity_limit ?? '', 'default', '', true)}
                        <label style="font-size:12px; color:var(--text-secondary);">Pricing
                            <select id="tier-pricing-mode" name="pricing_mode" style="width:100%; margin-top:4px;">
                                <option value="flat" ${tierMode === 'flat' ? 'selected' : ''}>Flat price</option>
                                <option value="formula" ${tierMode === 'formula' ? 'selected' : ''}>Formula (market × multiplier + plus)</option>
                            </select>
                        </label>
                        <div id="tier-flat-fields" style="${tierMode === 'flat' ? '' : 'display:none;'}">
                            ${field('List price ($)', 'number', 'list_price', editingTier?.list_price ?? '', '', '0.01', true)}
                        </div>
                        <div id="tier-formula-fields" style="display:flex; gap:10px; ${tierMode === 'formula' ? '' : 'display:none;'}">
                            ${field('Multiplier', 'number', 'multiplier', editingTier?.multiplier ?? '', 'e.g. 2', '0.01', true)}
                            ${field('Plus ($)', 'number', 'plus', editingTier?.plus ?? '', 'e.g. 1.00', '0.01', true)}
                        </div>
                        <div id="tier-form-error" style="color:var(--danger); font-size:12px;"></div>
                        <div style="display:flex; gap:8px;">
                            <button type="submit" class="btn btn-primary">${editingTierId === 'new' ? 'Add tier' : 'Save tier'}</button>
                            <button type="button" class="btn" id="tier-form-cancel">Cancel</button>
                        </div>
                    </form>
                ` : `<button type="button" class="btn btn-primary" id="add-tier-btn">+ Add tier</button>`}

                <div style="display:flex; justify-content:flex-end; margin-top:16px;">
                    <button type="button" class="btn" id="tiers-modal-close">Close</button>
                </div>
            </div>
        </div>
    `;

    root.querySelector('#tiers-modal-close').addEventListener('click', () => { root.innerHTML = ''; });

    if (!isFormOpen) {
        root.querySelector('#add-tier-btn').addEventListener('click', () => renderTiersModalBody(root, container, profileId, 'new'));
        root.querySelectorAll('.edit-tier-row-btn').forEach(btn => {
            btn.addEventListener('click', () => renderTiersModalBody(root, container, profileId, btn.dataset.id));
        });
        root.querySelectorAll('.delete-tier-row-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!window.confirm('Delete this tier?')) return;
                const { error } = await supabase.from('pricing_profile_tiers').delete().eq('id', btn.dataset.id);
                if (error) { window.alert(`Failed to delete: ${error.message}`); return; }
                await loadProfiles(container);
                renderTiersModalBody(root, container, profileId);
            });
        });
        return;
    }

    root.querySelector('#tier-pricing-mode').addEventListener('change', (e) => {
        const isFormula = e.target.value === 'formula';
        root.querySelector('#tier-flat-fields').style.display = isFormula ? 'none' : '';
        root.querySelector('#tier-formula-fields').style.display = isFormula ? 'flex' : 'none';
    });

    root.querySelector('#tier-form-cancel').addEventListener('click', () => renderTiersModalBody(root, container, profileId));
    root.querySelector('#tier-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errBox = root.querySelector('#tier-form-error');
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
            quantity_limit: fd.get('quantity_limit') ? parseInt(fd.get('quantity_limit'), 10) : null,
        };
        try {
            const { error } = editingTierId === 'new'
                ? await supabase.from('pricing_profile_tiers').insert(payload)
                : await supabase.from('pricing_profile_tiers').update(payload).eq('id', editingTierId);
            if (error) throw error;
            await loadProfiles(container);
            renderTiersModalBody(root, container, profileId);
        } catch (err) {
            console.error(err);
            // The DB trigger raises a plain RAISE EXCEPTION message for overlaps —
            // surface it directly, it's already human-readable.
            errBox.textContent = err.message || 'Failed to save tier.';
        }
    });
}

// ── Groups section (listing_card_groups — read/manage from Configuration
// too, per Fei's request; day-to-day group creation still happens inline
// on the Listing pricing page). Groups stay listing-scoped by design —
// see docs/plans/listing-pricing-system.md — this table shows which
// template/listing each group belongs to and lets you rename/reassign a
// profile/delete without opening that listing.
// ────────────────────────────────────────────────────────────────────────

function groupsSectionHTML() {
    return `
        <p style="color:var(--text-secondary); font-size:12px; margin:0 0 12px;">
            Groups are listing-scoped — the same name can be reused across
            listings (suggested when creating one), but each is a separate
            group with its own profile assignment. Day-to-day group
            creation happens on the Listing pricing page; this is for
            renaming/reassigning/deleting without opening that listing.
        </p>
        <div id="groups-table-wrap"><p>Loading...</p></div>
        <div id="groups-modal-root"></div>
    `;
}

async function loadGroups(container) {
    const wrap = container.querySelector('#groups-table-wrap');
    try {
        // Load profiles here too (not just relying on profilesState from a
        // prior visit to the Pricing profiles tab — that may never have
        // happened this session).
        const [{ data: groups, error: gErr }, { data: templates, error: tErr },
               { data: profiles, error: pErr }] = await Promise.all([
            supabase.from('listing_card_groups').select('*').order('name'),
            supabase.from('listing_templates').select('id, name, listing_id'),
            supabase.from('pricing_profiles').select('*').order('name'),
        ]);
        if (gErr) throw gErr;
        if (tErr) throw tErr;
        if (pErr) throw pErr;
        groupsState.groups = groups || [];
        groupsState.templates = templates || [];
        profilesState.profiles = profiles || [];
        renderGroupsTable(container);
    } catch (err) {
        console.error(err);
        wrap.innerHTML = `<p style="color:var(--danger)">Failed to load groups: ${err.message}</p>`;
    }
}

function renderGroupsTable(container) {
    const wrap = container.querySelector('#groups-table-wrap');
    const rows = groupsState.groups;
    const templateById = Object.fromEntries(groupsState.templates.map(t => [t.id, t]));

    if (!rows.length) {
        wrap.innerHTML = `<p style="color:var(--text-secondary)">No groups yet — create one on the Listing pricing page.</p>`;
    } else {
        wrap.innerHTML = `
            <table>
                <thead><tr>
                    <th>Group name</th><th>Listing (template)</th><th>eBay Item #</th><th>Profile</th><th style="width:60px;"></th>
                </tr></thead>
                <tbody>
                    ${rows.map(g => {
                        const t = templateById[g.template_id];
                        const profile = g.profile_id ? profilesState.profiles.find(p => p.id === g.profile_id) : null;
                        return `
                        <tr>
                            <td>${escapeHTML(g.name)}</td>
                            <td>${t ? escapeHTML(t.name) : '<span style="color:var(--text-secondary);">(unknown template)</span>'}</td>
                            <td>${t?.listing_id ? escapeHTML(t.listing_id) : '<span style="color:var(--text-secondary);">-</span>'}</td>
                            <td>${profile ? escapeHTML(profile.name) : '<span style="color:var(--text-secondary);">none</span>'}</td>
                            <td><button class="btn edit-group-btn" data-id="${g.id}">Edit</button></td>
                        </tr>
                    `;
                    }).join('')}
                </tbody>
            </table>
        `;
    }

    wrap.querySelectorAll('.edit-group-btn').forEach(btn => {
        btn.addEventListener('click', () => openGroupModal(container, btn.dataset.id));
    });
}

function openGroupModal(container, groupId) {
    const existing = groupsState.groups.find(g => g.id === groupId);
    if (!existing) return;
    const root = container.querySelector('#groups-modal-root');

    root.innerHTML = modalShell('Edit group', `
        <div style="display:flex; flex-direction:column; gap:10px;">
            <p style="font-size:12px; color:var(--text-secondary); margin:0;">
                Listing: ${escapeHTML(groupsState.templates.find(t => t.id === existing.template_id)?.name || 'unknown')}
                (can't be moved to a different listing here — delete and recreate on that listing's page if needed)
            </p>
            ${field('Name', 'text', 'name', existing.name)}
            <label style="font-size:12px; color:var(--text-secondary);">
                Profile
                <select name="profile_id" style="width:100%; margin-top:4px;">
                    <option value="">(none — falls to platform default)</option>
                    ${profilesState.profiles.map(p => `<option value="${p.id}" ${existing.profile_id === p.id ? 'selected' : ''}>${escapeHTML(p.name)}</option>`).join('')}
                </select>
            </label>
        </div>
    `, true, 'group');

    root.querySelector('#modal-cancel').addEventListener('click', () => { root.innerHTML = ''; });
    root.querySelector('#modal-delete').addEventListener('click', async () => {
        root.innerHTML = '';
        await confirmDelete(container, 'listing_card_groups', groupId,
            `this group (cards in it become ungrouped, not deleted)`, () => loadGroups(container));
    });
    root.querySelector('#modal-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errBox = root.querySelector('#modal-error');
        errBox.textContent = '';
        const fd = new FormData(e.target);
        const payload = {
            name: fd.get('name').trim(),
            profile_id: fd.get('profile_id') || null,
        };
        try {
            const { error } = await supabase.from('listing_card_groups').update(payload).eq('id', groupId);
            if (error) throw error;
            root.innerHTML = '';
            await loadGroups(container);
        } catch (err) {
            console.error(err);
            errBox.textContent = err.code === '23505' ? `A group named "${payload.name}" already exists on this listing.`
                : (err.message || 'Failed to save group.');
        }
    });
}

// ── Description templates section (description_sections module library) ───
// Named, reusable blocks for eBay listing descriptions, referenced from a
// description as {{key}} — kind='static' is plain HTML, 'repeater' loops
// over related listings by rule, 'single' renders exactly one block (see
// importer/ebay_descriptions.py's module-dispatch section, migration 029).
// The Listing pricing page's visual builder picks from this library; this
// page is where modules get created/edited. Moved here from a modal inside
// the Listing pricing page's Edit-fields panel — that space was too
// cramped for a real editor + preview workflow.

function descTemplatesSectionHTML() {
    return `
        <div style="display:flex; gap:4px; margin-bottom:16px; border-bottom:1px solid var(--border);">
            <button class="desc-tab-btn" data-tab="templates">Modules</button>
            <button class="desc-tab-btn" data-tab="theme">Theme</button>
        </div>
        <div id="desc-tab-content"><p>Loading...</p></div>
        <div id="desc-templates-modal-root"></div>
        <style>
            .desc-tab-btn {
                background:none; border:none; color:var(--text-secondary);
                padding:8px 14px; font-size:13px; cursor:pointer;
                border-bottom:2px solid transparent; margin-bottom:-1px;
            }
            .desc-tab-btn:hover { color:var(--text); }
            .desc-tab-btn.active { color:var(--accent); border-bottom-color:var(--accent); }
        </style>
    `;
}

function wireDescTabs(container) {
    container.querySelectorAll('.desc-tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === descTemplatesState.tab);
        btn.addEventListener('click', () => {
            if (btn.dataset.tab === descTemplatesState.tab) return;
            descTemplatesState.tab = btn.dataset.tab;
            container.querySelectorAll('.desc-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === descTemplatesState.tab));
            renderDescTabContent(container);
        });
    });
}

function renderDescTabContent(container) {
    const wrap = container.querySelector('#desc-tab-content');
    if (descTemplatesState.tab === 'theme') {
        renderThemeSettings(wrap);
    } else {
        wrap.innerHTML = `
            <p style="color:var(--text-secondary); font-size:12px; margin:0 0 12px;">
                A module is any named, reusable block, referenced from a description as <code>{{its_key}}</code>.
                Every module declares its own shape via <b>Kind</b>: <b>Layout</b> is the complete thing you
                pick on a listing's Edit-fields page &mdash; usually just a wrapper referencing other modules,
                e.g. <code>{{header}}{{family_nav}}{{footer}}</code>; <b>Static</b> is a small reusable piece
                (header, footer, ...) meant to be used INSIDE a Layout, not picked directly; <b>Repeater</b>
                loops over related listings automatically, by a <b>Repeat rule</b> (<code>family</code> =
                finish variants of this set, <code>era_siblings</code> = every other set in this era,
                <code>era_index</code> = every era's hub set); <b>Single</b> renders exactly one block,
                either <code>self</code> (this listing, standalone) or <code>era_hub</code> (a banner link
                to the era hub, non-hub listings only). The 4 built-in modules (<code>family_nav</code>,
                <code>era_nav</code>, <code>era_hub_link</code>, <code>era_index</code>) are just
                Repeater/Single rows seeded under those names &mdash; edit them here like any other module,
                and reference them from your own Layouts.
            </p>
            <p style="color:var(--text-secondary); font-size:12px; margin:0 0 16px; padding:10px 12px; background:var(--bg-tertiary); border-radius:6px;">
                Repeater/Single modules also take an optional <b>Item template HTML</b> &mdash; what ONE
                tile/row/chip looks like, using <code>{{item_label}}</code>/<code>{{item_url}}</code>/
                <code>{{item_image_url}}</code>/<code>{{item_description}}</code>/<code>{{item_title}}</code>
                (the real eBay listing title, not the short tile label) as placeholders. Leave it
                blank to use the built-in look (Static/Repeater/Single structure and DB lookups always stay
                Python's job either way &mdash; a module only ever controls markup, never the query behind
                it). Preview renders against whichever listing you pick below.
            </p>
            <div class="filters-bar" style="justify-content:space-between; margin-bottom:12px;">
                <label style="font-size:12px; color:var(--text-secondary);">
                    Preview against
                    <select id="desc-preview-target" style="margin-left:6px;"></select>
                </label>
                <button class="btn btn-primary" id="new-desc-template-btn">+ Add new</button>
            </div>
            <div id="desc-templates-table-wrap"><p>Loading...</p></div>
        `;
        renderDescTemplatesTable(container);
    }
}

async function loadDescTemplates(container) {
    const wrap = container.querySelector('#desc-tab-content');
    try {
        const [{ data: sections, error: sErr }, { data: templates, error: tErr },
               { data: theme, error: thErr }] = await Promise.all([
            supabase.from('description_sections').select('*').order('sort_order').order('label'),
            supabase.from('listing_templates').select('id, name, listing_id').not('listing_id', 'is', null).order('name'),
            supabase.from('description_theme_settings').select('*').order('category').order('label'),
        ]);
        if (sErr) throw sErr;
        if (tErr) throw tErr;
        if (thErr) throw thErr;
        descTemplatesState.sections = sections || [];
        descTemplatesState.templates = templates || [];
        descTemplatesState.theme = theme || [];
        if (!descTemplatesState.previewTemplateId && descTemplatesState.templates.length) {
            descTemplatesState.previewTemplateId = descTemplatesState.templates[0].id;
        }
        renderDescTabContent(container);
    } catch (err) {
        console.error(err);
        wrap.innerHTML = `<p style="color:var(--danger)">Failed to load description templates: ${err.message}</p>`;
    }
}

// Quick, inline-editable knobs (colors/sizing/button+label text) for the
// family_nav/era_nav/era_index renderer in importer/ebay_descriptions.py
// — a fixed, code-referenced key set (not a freeform library), so this
// is a plain list + per-row Save, not a full CRUD-with-Add UI.
//
// Migration 028 (8/09) added theme_key scoping so different shops/listing
// groups can each run their own theme instead of one theme applying
// everywhere — descTemplatesState.theme holds rows for EVERY theme_key at
// once (cheap, it's a small fixed-size table); this function filters to
// activeThemeKey client-side and re-renders itself in place on picker
// change, same pattern as every other in-place redraw in this file.
function renderThemeSettings(wrap) {
    const CATEGORY_LABELS = { color: 'Colors', size: 'Sizing', text: 'Text' };
    const themeKeys = [...new Set(descTemplatesState.theme.map(r => r.theme_key))]
        .sort((a, b) => (a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b)));
    if (!themeKeys.includes(descTemplatesState.activeThemeKey)) {
        descTemplatesState.activeThemeKey = themeKeys[0] || 'default';
    }
    const activeKey = descTemplatesState.activeThemeKey;
    const rows = descTemplatesState.theme.filter(r => r.theme_key === activeKey);

    const byCategory = {};
    rows.forEach(row => {
        (byCategory[row.category] ||= []).push(row);
    });

    const rowHTML = (row) => {
        const inputId = `theme-input-${row.key}`;
        const valueInput = row.category === 'color'
            ? `<input type="color" id="${inputId}" value="${escapeAttr(row.value)}" style="width:44px; height:30px; padding:2px; vertical-align:middle;" />
               <input type="text" id="${inputId}-hex" value="${escapeAttr(row.value)}" style="width:90px; margin-left:6px;" />`
            : row.category === 'size'
                ? `<input type="number" id="${inputId}" value="${escapeAttr(row.value)}" style="width:90px;" />`
                : `<input type="text" id="${inputId}" value="${escapeAttr(row.value)}" style="width:280px;" />`;
        return `
            <tr data-key="${escapeAttr(row.key)}">
                <td style="white-space:nowrap;">${escapeHTML(row.label)}</td>
                <td>${valueInput}</td>
                <td style="width:70px;"><button class="btn theme-save-btn" data-key="${escapeAttr(row.key)}">Save</button></td>
                <td class="theme-save-status" style="font-size:11px; color:var(--success);"></td>
            </tr>
        `;
    };

    wrap.innerHTML = `
        <p style="color:var(--text-secondary); font-size:12px; margin:0 0 12px;">
            Small tweaks to how {{family_nav}}/{{era_nav}}/{{era_index}} render — no code change or
            deploy needed. Changes apply the next time a description is previewed or pushed.
        </p>
        <div class="filters-bar" style="justify-content:space-between; margin-bottom:16px;">
            <label style="font-size:12px; color:var(--text-secondary);">
                Theme
                <select id="theme-key-picker" style="margin-left:6px;">
                    ${themeKeys.map(k => `<option value="${escapeAttr(k)}" ${k === activeKey ? 'selected' : ''}>${escapeHTML(k)}</option>`).join('')}
                </select>
            </label>
            <button class="btn" id="new-theme-btn">+ New theme</button>
        </div>
        ${Object.entries(CATEGORY_LABELS).map(([cat, label]) => `
            <h4 style="margin:16px 0 8px;">${label}</h4>
            <table style="margin-bottom:8px;">
                <tbody>${(byCategory[cat] || []).map(rowHTML).join('')}</tbody>
            </table>
        `).join('')}
    `;

    wrap.querySelector('#theme-key-picker').addEventListener('change', (e) => {
        descTemplatesState.activeThemeKey = e.target.value;
        renderThemeSettings(wrap);
    });

    wrap.querySelector('#new-theme-btn').addEventListener('click', async () => {
        const raw = (prompt(`New theme name — copies all current "${activeKey}" values as a starting point.\nAssign it to listings via the Theme dropdown on the Edit-fields modal.`) || '').trim();
        if (!raw) return;
        const name = raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
        if (!name) { alert('Invalid theme name.'); return; }
        if (themeKeys.includes(name)) { alert(`A theme named "${name}" already exists.`); return; }
        const insertRows = rows.map(r => ({ theme_key: name, key: r.key, value: r.value, label: r.label, category: r.category }));
        try {
            const { data, error } = await supabase.from('description_theme_settings').insert(insertRows).select();
            if (error) throw error;
            descTemplatesState.theme.push(...(data || insertRows));
            descTemplatesState.activeThemeKey = name;
            renderThemeSettings(wrap);
        } catch (err) {
            console.error(err);
            alert(err.message || 'Failed to create theme.');
        }
    });

    // Keep the color swatch and its hex text input in sync with each other.
    (byCategory.color || []).forEach(row => {
        const swatch = wrap.querySelector(`#theme-input-${row.key}`);
        const hex = wrap.querySelector(`#theme-input-${row.key}-hex`);
        swatch.addEventListener('input', () => { hex.value = swatch.value; });
        hex.addEventListener('input', () => {
            if (/^#[0-9a-fA-F]{6}$/.test(hex.value)) swatch.value = hex.value;
        });
    });

    wrap.querySelectorAll('.theme-save-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const key = btn.dataset.key;
            const row = rows.find(r => r.key === key);
            const tr = wrap.querySelector(`tr[data-key="${key}"]`);
            const status = tr.querySelector('.theme-save-status');
            const value = row.category === 'color'
                ? wrap.querySelector(`#theme-input-${key}-hex`).value
                : wrap.querySelector(`#theme-input-${key}`).value;
            btn.disabled = true;
            status.textContent = '';
            status.style.color = 'var(--success)';
            try {
                const { error } = await supabase.from('description_theme_settings')
                    .update({ value }).eq('key', key).eq('theme_key', activeKey);
                if (error) throw error;
                row.value = value;
                status.textContent = 'Saved';
            } catch (err) {
                console.error(err);
                status.style.color = 'var(--danger)';
                status.textContent = err.message || 'Failed to save.';
            } finally {
                btn.disabled = false;
            }
        });
    });
}

function renderDescTemplatesTable(container) {
    const wrap = container.querySelector('#desc-templates-table-wrap');
    const layouts = descTemplatesState.sections.filter(s => s.kind === 'layout');
    const staticRows = descTemplatesState.sections.filter(s => s.kind === 'static');
    const repeaters = descTemplatesState.sections.filter(s => s.kind === 'repeater');
    const singles = descTemplatesState.sections.filter(s => s.kind === 'single');
    // Legacy — migration 029's backfill converts these away; this group
    // only ever shows something if that conversion hasn't run yet.
    const legacyItemTemplates = descTemplatesState.sections.filter(s => s.kind === 'item_template');

    const picker = container.querySelector('#desc-preview-target');
    picker.innerHTML = descTemplatesState.templates.length
        ? descTemplatesState.templates.map(t => `<option value="${t.id}" ${t.id === descTemplatesState.previewTemplateId ? 'selected' : ''}>${escapeHTML(t.name)}</option>`).join('')
        : `<option value="">(no live listings to preview against)</option>`;
    if (!picker.dataset.wired) {
        picker.dataset.wired = '1';
        picker.addEventListener('change', () => { descTemplatesState.previewTemplateId = picker.value || null; });
    }

    const groupTable = (label, hint, rows, showRule = false) => `
        <h4 style="margin:0 0 4px;">${label}</h4>
        <p style="color:var(--text-secondary); font-size:11px; margin:0 0 8px;">${hint}</p>
        ${!rows.length ? `<p style="color:var(--text-secondary); font-size:12px; margin:0 0 20px;">None yet.</p>` : `
            <table style="margin-bottom:20px;">
                <thead><tr><th>Label</th><th>Key</th>${showRule ? '<th>Rule</th>' : ''}<th>Order</th><th style="width:60px;"></th></tr></thead>
                <tbody>
                    ${rows.map(s => `
                        <tr>
                            <td>${escapeHTML(s.label)}</td>
                            <td><code>${escapeHTML(s.key)}</code></td>
                            ${showRule ? `<td>${escapeHTML(s.repeat_rule || '')}</td>` : ''}
                            <td>${s.sort_order}</td>
                            <td><button class="btn edit-desc-template-btn" data-id="${s.id}">Edit</button></td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `}
    `;

    wrap.innerHTML =
        groupTable('Layouts', 'A complete, ready-to-use description — this is what shows up in the Layout dropdown on a listing\'s Edit-fields page. Usually just a wrapper referencing other modules by {{key}}, e.g. {{header}}{{family_nav}}{{footer}}.', layouts)
        + groupTable('Static content', 'Small reusable HTML pieces (header, footer, ...) — building blocks for a Layout, referenced by {{key}}. Not shown on the listing page directly.', staticRows)
        + groupTable('Repeaters', 'Loop over related listings automatically (family/era rules) — one design per module, referenced as {{key}} inside a Layout.', repeaters, true)
        + groupTable('Single blocks', 'Exactly one block per render (this listing itself, or a link to the era hub) — referenced as {{key}} inside a Layout.', singles, true)
        + (legacyItemTemplates.length ? groupTable('Legacy item templates', 'Pre-module-builder rows not yet converted — run backfill_description_modules() again if you see any here.', legacyItemTemplates) : '');

    const addBtn = container.querySelector('#new-desc-template-btn');
    if (!addBtn.dataset.wired) {
        addBtn.dataset.wired = '1';
        addBtn.addEventListener('click', () => openDescTemplateModal(container, null));
    }
    wrap.querySelectorAll('.edit-desc-template-btn').forEach(btn => {
        btn.addEventListener('click', () => openDescTemplateModal(container, btn.dataset.id));
    });
}

// repeat_rule options per kind (migration 029's module builder) — a
// 'repeater' loops over related listings, a 'single' renders exactly one
// block. item_template_current_html only makes sense for the two loops
// that can include "myself" — family (this listing among its siblings)
// and era_index (this series' hub chip); era_siblings excludes self from
// its query entirely and never has a "current" cell.
const _REPEAT_RULE_OPTIONS = {
    repeater: [
        ['family', 'family — finish variants of this set'],
        ['era_siblings', 'era_siblings — other sets in this era'],
        ['era_index', 'era_index — every era’s hub set'],
    ],
    single: [
        ['self', 'self — this listing, standalone'],
        ['era_hub', 'era_hub — banner link to the era hub (non-hub listings only)'],
    ],
};
const _CURRENT_HTML_RULES = new Set(['family', 'era_index']);

function openDescTemplateModal(container, sectionId) {
    const isEdit = sectionId !== null;
    const existing = isEdit ? descTemplatesState.sections.find(s => s.id === sectionId) : null;
    if (isEdit && !existing) return;
    const root = container.querySelector('#desc-templates-modal-root');
    const initialKind = existing?.kind || 'static';

    root.innerHTML = `
        <div style="position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:100; overflow-y:auto;">
            <div style="background:var(--bg-secondary); border:1px solid var(--border); border-radius:8px; padding:20px; width:760px; max-width:95vw; max-height:88vh; overflow-y:auto;">
                <h3 style="margin:0 0 16px;">${isEdit ? 'Edit' : 'Add'} module</h3>
                <form id="desc-template-form">
                    <div style="display:flex; gap:12px; margin-bottom:10px;">
                        ${field('Key (unique)', 'text', 'key', existing?.key || '')}
                        ${field('Label', 'text', 'label', existing?.label || '')}
                    </div>
                    <div style="display:flex; gap:12px; margin-bottom:10px; align-items:flex-end;">
                        <label style="font-size:12px; color:var(--text-secondary); flex:1;">
                            Kind
                            <select name="kind" style="width:100%; margin-top:4px;">
                                <option value="layout" ${initialKind === 'layout' ? 'selected' : ''}>Layout (complete, pick-one-and-done description)</option>
                                <option value="static" ${initialKind === 'static' ? 'selected' : ''}>Static (small reusable piece)</option>
                                <option value="repeater" ${initialKind === 'repeater' ? 'selected' : ''}>Repeater (loops over related listings)</option>
                                <option value="single" ${initialKind === 'single' ? 'selected' : ''}>Single (exactly one block)</option>
                                ${initialKind === 'item_template' ? `<option value="item_template" selected>Item template (legacy, not converted yet)</option>` : ''}
                            </select>
                        </label>
                        ${field('Sort order', 'number', 'sort_order', existing?.sort_order ?? 0)}
                    </div>
                    <div data-for="repeater single" style="display:flex; gap:12px; margin-bottom:10px; align-items:flex-end;">
                        <label style="font-size:12px; color:var(--text-secondary); flex:1;">
                            Repeat rule
                            <select name="repeat_rule" style="width:100%; margin-top:4px;"></select>
                        </label>
                        <label data-for="repeater" style="font-size:12px; color:var(--text-secondary); flex:1;">
                            Layout
                            <select name="layout" style="width:100%; margin-top:4px;">
                                <option value="">(default for the rule)</option>
                                <option value="grid" ${existing?.layout === 'grid' ? 'selected' : ''}>Grid (2-column tiles)</option>
                                <option value="chips" ${existing?.layout === 'chips' ? 'selected' : ''}>Chips (inline wrap)</option>
                            </select>
                        </label>
                    </div>
                    <div data-for="repeater" style="display:flex; gap:12px; margin-bottom:10px;">
                        ${field('Title override (optional — {{finish_label}}/{{set_name}}/{{series_name}} allowed)', 'text', 'title', existing?.title || '', '', '', true)}
                        ${field('Subtitle override (optional)', 'text', 'subtitle', existing?.subtitle || '', '', '', true)}
                    </div>
                    <div data-for="static layout">
                        <label style="font-size:12px; color:var(--text-secondary); display:block; margin-bottom:4px;">HTML</label>
                        <textarea name="html" rows="14" style="width:100%; font-family:monospace; font-size:12px; margin-bottom:10px;">${escapeHTML(existing?.html || '')}</textarea>
                    </div>
                    <div data-for="repeater single">
                        <label style="font-size:12px; color:var(--text-secondary); display:block; margin-bottom:4px;">
                            Item template HTML — placeholders: <code>{{item_label}}</code> <code>{{item_url}}</code>
                            <code>{{item_image_url}}</code> <code>{{item_description}}</code> <code>{{item_title}}</code>
                            (real eBay listing title). Leave blank to use the built-in look.
                        </label>
                        <textarea name="item_template_html" rows="8" style="width:100%; font-family:monospace; font-size:12px; margin-bottom:10px;">${escapeHTML(existing?.item_template_html || '')}</textarea>
                    </div>
                    <div data-for="current-html">
                        <label style="font-size:12px; color:var(--text-secondary); display:block; margin-bottom:4px;">
                            Item template HTML — "current" variant (this listing itself, e.g. "Viewing this"). Leave blank to reuse the one above.
                        </label>
                        <textarea name="item_template_current_html" rows="8" style="width:100%; font-family:monospace; font-size:12px; margin-bottom:10px;">${escapeHTML(existing?.item_template_current_html || '')}</textarea>
                    </div>
                    <div id="desc-template-error" style="color:var(--danger); font-size:12px; margin-bottom:10px;"></div>
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        ${isEdit ? `<button type="button" class="btn" id="desc-template-delete" style="color:var(--danger); border-color:var(--danger);">Delete</button>` : '<span></span>'}
                        <div style="display:flex; gap:8px;">
                            <button type="button" class="btn" id="desc-template-preview">Preview</button>
                            <button type="button" class="btn" id="desc-template-cancel">Cancel</button>
                            <button type="submit" class="btn btn-primary">${isEdit ? 'Save changes' : 'Create'}</button>
                        </div>
                    </div>
                </form>
            </div>
        </div>
    `;

    const kindSelect = root.querySelector('select[name="kind"]');
    const ruleSelect = root.querySelector('select[name="repeat_rule"]');

    const populateRuleOptions = () => {
        const kind = kindSelect.value;
        const options = _REPEAT_RULE_OPTIONS[kind] || [];
        const current = existing?.repeat_rule;
        ruleSelect.innerHTML = options.map(([v, l]) =>
            `<option value="${escapeAttr(v)}" ${v === current ? 'selected' : ''}>${escapeHTML(l)}</option>`).join('');
    };

    const updateVisibility = () => {
        const kind = kindSelect.value;
        root.querySelectorAll('[data-for]').forEach(el => {
            const forKinds = el.dataset.for.split(' ');
            let visible = forKinds.includes(kind);
            if (forKinds[0] === 'current-html') {
                visible = kind === 'repeater' && _CURRENT_HTML_RULES.has(ruleSelect.value);
            }
            el.style.display = visible ? '' : 'none';
        });
        root.querySelector('textarea[name="html"]').required = kind === 'static' || kind === 'layout';
    };

    populateRuleOptions();
    updateVisibility();
    kindSelect.addEventListener('change', () => { populateRuleOptions(); updateVisibility(); });
    ruleSelect.addEventListener('change', updateVisibility);

    root.querySelector('#desc-template-cancel').addEventListener('click', () => { root.innerHTML = ''; });

    if (isEdit) {
        root.querySelector('#desc-template-delete').addEventListener('click', async () => {
            root.innerHTML = '';
            await confirmDelete(container, 'description_sections', sectionId, `"${existing.label}"`, () => loadDescTemplates(container));
        });
    }

    root.querySelector('#desc-template-preview').addEventListener('click', async () => {
        const kind = kindSelect.value;
        const templateId = descTemplatesState.previewTemplateId;
        if (!templateId) { window.alert('No live listing available to preview against.'); return; }
        const key = root.querySelector('input[name="key"]').value.trim();
        let sourceHtml;
        if (kind === 'static' || kind === 'layout') {
            sourceHtml = root.querySelector('textarea[name="html"]').value;
        } else if (isEdit && key) {
            // Repeater/single modules only render inside their own rule
            // (looped or self) — previewed by reference, which means this
            // shows the last SAVED item_template_html, not unsaved edits.
            sourceHtml = `{{${key}}}`;
        } else {
            window.alert('Save this module first, then Preview shows it live via {{its key}}.');
            return;
        }
        try {
            const resp = await fetch(`${PICKING_API_URL}/api/description-preview/${templateId}`, {
                method: 'POST',
                headers: { 'x-picking-token': PICKING_API_TOKEN, 'content-type': 'application/json' },
                body: JSON.stringify({ description_html: sourceHtml }),
            });
            if (!resp.ok) throw new Error(`${resp.status} ${await resp.text().catch(() => '')}`);
            const result = await resp.json();
            openDescTemplatePreviewWindow(result.html);
        } catch (err) {
            window.alert(`Preview failed: ${err.message}`);
        }
    });

    root.querySelector('#desc-template-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errBox = root.querySelector('#desc-template-error');
        errBox.textContent = '';
        const fd = new FormData(e.target);
        const kind = fd.get('kind');
        const payload = {
            key: fd.get('key').trim(),
            label: fd.get('label').trim(),
            kind,
            sort_order: parseInt(fd.get('sort_order'), 10) || 0,
            html: (kind === 'static' || kind === 'layout') ? fd.get('html') : null,
            repeat_rule: (kind === 'repeater' || kind === 'single') ? (fd.get('repeat_rule') || null) : null,
            layout: kind === 'repeater' ? (fd.get('layout') || null) : null,
            item_template_html: (kind === 'repeater' || kind === 'single') ? (fd.get('item_template_html').trim() || null) : null,
            item_template_current_html: (kind === 'repeater' && _CURRENT_HTML_RULES.has(fd.get('repeat_rule')))
                ? (fd.get('item_template_current_html').trim() || null) : null,
            title: kind === 'repeater' ? (fd.get('title').trim() || null) : null,
            subtitle: kind === 'repeater' ? (fd.get('subtitle').trim() || null) : null,
        };
        try {
            const { error } = isEdit
                ? await supabase.from('description_sections').update(payload).eq('id', sectionId)
                : await supabase.from('description_sections').insert(payload);
            if (error) throw error;
            root.innerHTML = '';
            await loadDescTemplates(container);
        } catch (err) {
            console.error(err);
            errBox.textContent = err.code === '23505' ? `Key "${payload.key}" is already in use.` : (err.message || 'Failed to save.');
        }
    });
}

function openDescTemplatePreviewWindow(html) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); display:flex; align-items:center; justify-content:center; z-index:200;';
    overlay.innerHTML = `
        <div style="background:var(--bg-secondary); border:1px solid var(--border); border-radius:8px; padding:16px; width:820px; max-width:95vw; max-height:90vh; display:flex; flex-direction:column;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                <h3 style="margin:0;">Preview</h3>
                <div style="display:flex; gap:6px;">
                    <button type="button" class="btn" id="desc-preview-desktop">Desktop</button>
                    <button type="button" class="btn" id="desc-preview-mobile">Mobile</button>
                    <button type="button" class="btn" id="desc-preview-close">Close</button>
                </div>
            </div>
            <iframe id="desc-preview-frame" style="border:1px solid var(--border); width:100%; height:70vh; background:#fff; align-self:center;"></iframe>
        </div>
    `;
    document.body.appendChild(overlay);
    const frame = overlay.querySelector('#desc-preview-frame');
    frame.srcdoc = html;
    overlay.querySelector('#desc-preview-desktop').addEventListener('click', () => { frame.style.width = '100%'; });
    overlay.querySelector('#desc-preview-mobile').addEventListener('click', () => { frame.style.width = '375px'; });
    overlay.querySelector('#desc-preview-close').addEventListener('click', () => overlay.remove());
}

// ── Sync controls section (platform_sync_status kill switches) ─────────────
// Emergency freeze for a whole platform or one account. Rows are opt-in —
// a platform/account with NO row here is fully enabled by default; a row
// only exists to turn something OFF (or to explicitly re-confirm it's on).
// This is separate from (and layered UNDER) the per-listing sync_enabled
// toggle on each platform_listings row — both must pass for a listing to
// be touched by --ebay-recalc-prices / --ebay-push-listings.

function syncControlsSectionHTML() {
    return `
        <p style="color:var(--text-secondary); font-size:12px; margin:0 0 12px;">
            Emergency kill switch for the eBay listing sync engine. A
            platform-wide row (blank account) freezes sync for every
            account at once; an account-specific row freezes just that
            account. No row for a platform/account = sync fully enabled —
            rows only exist to turn something OFF.
        </p>
        <div class="filters-bar" style="justify-content:flex-end;">
            <button class="btn btn-primary" id="new-syncstatus-btn">+ New kill switch</button>
        </div>
        <div id="syncstatus-table-wrap"><p>Loading...</p></div>
        <div id="syncstatus-modal-root"></div>
    `;
}

async function loadSyncControls(container) {
    const wrap = container.querySelector('#syncstatus-table-wrap');
    try {
        const { data, error } = await supabase.from('platform_sync_status').select('*').order('platform').order('account', { nullsFirst: true });
        if (error) throw error;
        syncControlsState.statuses = data || [];
        renderSyncControlsTable(container);
    } catch (err) {
        console.error(err);
        wrap.innerHTML = `<p style="color:var(--danger)">Failed to load sync controls: ${err.message}</p>`;
    }
}

function renderSyncControlsTable(container) {
    const wrap = container.querySelector('#syncstatus-table-wrap');
    const rows = syncControlsState.statuses;

    if (!rows.length) {
        wrap.innerHTML = `<p style="color:var(--text-secondary)">No kill switches configured — sync is fully enabled everywhere.</p>`;
    } else {
        wrap.innerHTML = `
            <table>
                <thead><tr>
                    <th>Platform</th><th>Account</th><th>Sync enabled</th><th>Disabled at</th><th>Notes</th><th style="width:60px;"></th>
                </tr></thead>
                <tbody>
                    ${rows.map(s => `
                        <tr>
                            <td>${escapeHTML(s.platform)}</td>
                            <td>${s.account ? escapeHTML(s.account) : '<span style="color:var(--text-secondary);">Whole platform</span>'}</td>
                            <td>${s.sync_enabled
                                ? '<span style="color:var(--success);">Enabled</span>'
                                : '<span style="color:var(--danger); font-weight:600;">DISABLED</span>'}</td>
                            <td style="color:var(--text-secondary); font-size:12px;">${s.disabled_at ? new Date(s.disabled_at).toLocaleString() : '-'}</td>
                            <td style="color:var(--text-secondary);">${escapeHTML(s.notes || '-')}</td>
                            <td><button class="btn edit-syncstatus-btn" data-id="${s.id}">Edit</button></td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    }

    container.querySelector('#new-syncstatus-btn').addEventListener('click', () => openSyncStatusModal(container, null));
    wrap.querySelectorAll('.edit-syncstatus-btn').forEach(btn => {
        btn.addEventListener('click', () => openSyncStatusModal(container, btn.dataset.id));
    });
}

function openSyncStatusModal(container, statusId) {
    const isEdit = !!statusId;
    const existing = isEdit ? syncControlsState.statuses.find(s => s.id === statusId) : null;
    const root = container.querySelector('#syncstatus-modal-root');

    root.innerHTML = modalShell(isEdit ? 'Edit kill switch' : 'New kill switch', `
        <div style="display:flex; flex-direction:column; gap:10px;">
            ${field('Platform', 'text', 'platform', existing?.platform || 'ebay')}
            ${field('Account (blank = whole platform, all accounts)', 'text', 'account', existing?.account || '', 'e.g. BIGGYFISH', '', true)}
            <label style="font-size:12px; color:var(--text-secondary); display:flex; align-items:center; gap:8px;">
                <input type="checkbox" name="sync_enabled" ${existing ? (existing.sync_enabled ? 'checked' : '') : 'checked'} />
                Sync enabled (uncheck to freeze sync for this platform/account)
            </label>
            ${field('Notes', 'text', 'notes', existing?.notes || '', 'why this was turned off', '', true)}
        </div>
    `, isEdit, 'syncstatus');

    root.querySelector('#modal-cancel').addEventListener('click', () => { root.innerHTML = ''; });
    if (isEdit) {
        root.querySelector('#modal-delete').addEventListener('click', async () => {
            root.innerHTML = '';
            await confirmDelete(container, 'platform_sync_status', statusId, `this kill switch`, () => loadSyncControls(container));
        });
    }
    root.querySelector('#modal-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errBox = root.querySelector('#modal-error');
        errBox.textContent = '';
        const fd = new FormData(e.target);
        const syncEnabled = fd.get('sync_enabled') === 'on';
        const payload = {
            platform: fd.get('platform').trim(),
            account: fd.get('account').trim() || null,
            sync_enabled: syncEnabled,
            disabled_at: syncEnabled ? null : new Date().toISOString(),
            notes: fd.get('notes').trim() || null,
        };
        try {
            const { error } = isEdit
                ? await supabase.from('platform_sync_status').update(payload).eq('id', statusId)
                : await supabase.from('platform_sync_status').insert(payload);
            if (error) throw error;
            root.innerHTML = '';
            await loadSyncControls(container);
        } catch (err) {
            console.error(err);
            errBox.textContent = err.message || 'Failed to save kill switch.';
        }
    });
}

// ── Small shared modal helpers (used by pricing + templates) ────────────────

function modalShell(title, bodyHTML, isEdit, formName) {
    return `
        <div style="position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:100;">
            <div style="background:var(--bg-secondary); border:1px solid var(--border); border-radius:8px; padding:20px; width:460px; max-width:90vw; max-height:85vh; overflow-y:auto;">
                <h3 style="margin:0 0 16px;">${title}</h3>
                <form id="modal-form">
                    ${bodyHTML}
                    <div id="modal-error" style="color:var(--danger); font-size:12px; margin-top:10px;"></div>
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:18px;">
                        ${isEdit ? `<button type="button" class="btn" id="modal-delete" style="color:var(--danger); border-color:var(--danger);">Delete</button>` : '<span></span>'}
                        <div style="display:flex; gap:8px;">
                            <button type="button" class="btn" id="modal-cancel">Cancel</button>
                            <button type="submit" class="btn btn-primary">${isEdit ? 'Save changes' : 'Create'}</button>
                        </div>
                    </div>
                </form>
            </div>
        </div>
    `;
}

function field(label, type, name, value, placeholder = '', step = '', optional = false) {
    return `
        <label style="font-size:12px; color:var(--text-secondary); flex:${optional ? '1' : 'initial'};">
            ${label}
            <input type="${type}" name="${name}" ${step ? `step="${step}"` : ''} ${optional ? '' : (type === 'number' ? '' : 'required')}
                   value="${escapeAttr(value)}" placeholder="${escapeAttr(placeholder)}" style="width:100%; margin-top:4px;" />
        </label>
    `;
}

async function confirmDelete(container, table, id, label, onDone) {
    if (!window.confirm(`Delete ${label}? This can't be undone.`)) return;
    try {
        const { error } = await supabase.from(table).delete().eq('id', id);
        if (error) throw error;
        await onDone();
    } catch (err) {
        console.error(err);
        const isFkViolation = (err.code === '23503') || /foreign key/i.test(err.message || '');
        window.alert(isFkViolation
            ? `Can't delete ${label} — other records still reference it.`
            : `Failed to delete: ${err.message}`);
    }
}

function formatPrice(value) {
    if (value === null || value === undefined || value === '') return '-';
    return '$' + Number(value).toFixed(2);
}

// ── Card games section ───────────────────────────────────────────────────────

function gamesSectionHTML() {
    return `
        <div class="filters-bar" style="justify-content:space-between;">
            <input type="search" id="games-search" placeholder="Search card games..." style="min-width:240px;" />
            <button class="btn btn-primary" id="new-game-btn">+ New card game</button>
        </div>
        <div id="games-table-wrap"><p>Loading...</p></div>
        <div id="game-modal-root"></div>
    `;
}

async function loadGames(container) {
    const wrap = container.querySelector('#games-table-wrap');
    try {
        const [{ data: games, error: gamesErr }, { data: setRows, error: setsErr }] = await Promise.all([
            supabase.from('card_games').select('*').order('name'),
            supabase.from('card_sets').select('game_id'),
        ]);

        if (gamesErr) throw gamesErr;
        if (setsErr) throw setsErr;

        const counts = {};
        for (const row of setRows || []) {
            counts[row.game_id] = (counts[row.game_id] || 0) + 1;
        }

        gameState.games = games || [];
        gameState.gameSetCounts = counts;

        renderGamesTable(container);
        wireGamesControls(container);
    } catch (err) {
        console.error(err);
        wrap.innerHTML = `<p style="color:var(--danger)">Failed to load card games: ${err.message}</p>`;
    }
}

function renderGamesTable(container) {
    const wrap = container.querySelector('#games-table-wrap');
    const q = gameState.search.trim().toLowerCase();
    const rows = gameState.games.filter(g => !q || g.name.toLowerCase().includes(q));

    if (!rows.length) {
        wrap.innerHTML = `<p style="color:var(--text-secondary)">No card games found.</p>`;
        return;
    }

    wrap.innerHTML = `
        <table>
            <thead>
                <tr>
                    <th>Name</th>
                    <th>Publisher</th>
                    <th>Notes</th>
                    <th>Sets</th>
                    <th style="width:60px;"></th>
                </tr>
            </thead>
            <tbody>
                ${rows.map(g => `
                    <tr data-game-id="${g.id}">
                        <td>${escapeHTML(g.name)}</td>
                        <td>${escapeHTML(g.publisher || '-')}</td>
                        <td style="color:var(--text-secondary);">${escapeHTML(g.notes || '-')}</td>
                        <td>${gameState.gameSetCounts[g.id] || 0}</td>
                        <td><button class="btn edit-game-btn" data-id="${g.id}">Edit</button></td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;

    wrap.querySelectorAll('.edit-game-btn').forEach(btn => {
        btn.addEventListener('click', () => openGameModal(container, btn.dataset.id));
    });
}

function wireGamesControls(container) {
    const searchInput = container.querySelector('#games-search');
    searchInput.value = gameState.search;
    searchInput.addEventListener('input', debounce((e) => {
        gameState.search = e.target.value;
        renderGamesTable(container);
    }, 200));

    container.querySelector('#new-game-btn').addEventListener('click', () => openGameModal(container, null));
}

function openGameModal(container, gameId) {
    const isEdit = !!gameId;
    const existing = isEdit ? gameState.games.find(g => g.id === gameId) : null;
    const root = container.querySelector('#game-modal-root');

    root.innerHTML = `
        <div style="position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:100;">
            <div style="background:var(--bg-secondary); border:1px solid var(--border); border-radius:8px; padding:20px; width:420px; max-width:90vw;">
                <h3 style="margin:0 0 16px;">${isEdit ? 'Edit card game' : 'New card game'}</h3>
                <form id="game-form">
                    <div style="display:flex; flex-direction:column; gap:10px;">
                        <label style="font-size:12px; color:var(--text-secondary);">
                            Name
                            <input type="text" name="name" required value="${existing ? escapeAttr(existing.name) : ''}" style="width:100%; margin-top:4px;" placeholder="e.g. Pokemon" />
                        </label>
                        <label style="font-size:12px; color:var(--text-secondary);">
                            Publisher
                            <input type="text" name="publisher" value="${existing ? escapeAttr(existing.publisher || '') : ''}" style="width:100%; margin-top:4px;" />
                        </label>
                        <label style="font-size:12px; color:var(--text-secondary);">
                            Notes
                            <input type="text" name="notes" value="${existing ? escapeAttr(existing.notes || '') : ''}" style="width:100%; margin-top:4px;" />
                        </label>
                    </div>
                    <div id="game-form-error" style="color:var(--danger); font-size:12px; margin-top:10px;"></div>
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:18px;">
                        ${isEdit ? `<button type="button" class="btn" id="game-modal-delete" style="color:var(--danger); border-color:var(--danger);">Delete game</button>` : '<span></span>'}
                        <div style="display:flex; gap:8px;">
                            <button type="button" class="btn" id="game-modal-cancel">Cancel</button>
                            <button type="submit" class="btn btn-primary">${isEdit ? 'Save changes' : 'Create game'}</button>
                        </div>
                    </div>
                </form>
            </div>
        </div>
    `;

    root.querySelector('#game-modal-cancel').addEventListener('click', () => { root.innerHTML = ''; });

    if (isEdit) {
        root.querySelector('#game-modal-delete').addEventListener('click', async () => {
            root.innerHTML = '';
            await confirmDeleteGame(container, gameId);
        });
    }

    root.querySelector('#game-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errBox = root.querySelector('#game-form-error');
        errBox.textContent = '';

        const fd = new FormData(e.target);
        const payload = {
            name: fd.get('name').trim(),
            publisher: fd.get('publisher').trim() || null,
            notes: fd.get('notes').trim() || null,
        };

        try {
            if (isEdit) {
                const { error } = await supabase.from('card_games').update(payload).eq('id', gameId);
                if (error) throw error;
            } else {
                const { error } = await supabase.from('card_games').insert(payload);
                if (error) throw error;
            }
            root.innerHTML = '';
            await loadGames(container);
        } catch (err) {
            console.error(err);
            errBox.textContent = err.message || 'Failed to save card game.';
        }
    });
}

async function confirmDeleteGame(container, gameId) {
    const game = gameState.games.find(g => g.id === gameId);
    if (!game) return;

    const setCount = gameState.gameSetCounts[gameId] || 0;
    const warning = setCount > 0
        ? `"${game.name}" has ${setCount} set${setCount === 1 ? '' : 's'} linked to it. Deleting the game will fail unless those sets are removed or reassigned first.\n\nTry to delete anyway?`
        : `Delete "${game.name}"? This can't be undone.`;

    if (!window.confirm(warning)) return;

    try {
        const { error } = await supabase.from('card_games').delete().eq('id', gameId);
        if (error) throw error;
        await loadGames(container);
    } catch (err) {
        console.error(err);
        const isFkViolation = (err.code === '23503') || /foreign key/i.test(err.message || '');
        const msg = isFkViolation
            ? `Can't delete "${game.name}" — it still has sets referencing it. Remove or reassign those sets first.`
            : `Failed to delete card game: ${err.message}`;
        window.alert(msg);
    }
}

// ── Variant attributes ───────────────────────────────────────────────────
// One generic CRUD component for all 7 lookup tables card_variants
// references by `code` (foil_types, foil_patterns, textures, materials,
// sizes, stamp_types, source_types). All 7 share the identical
// (code, display_name, sort_order) shape.

function attrSectionHTML() {
    return `
        <div style="display:flex; gap:6px; margin-bottom:12px; flex-wrap:wrap;">
            ${ATTR_TABLES.map(t => `
                <button class="btn attr-tab-btn" data-table="${t.table}"
                        style="${t.table === attrState.activeTable ? 'background:var(--accent); color:white;' : ''}">
                    ${t.label}
                </button>
            `).join('')}
        </div>
        <div class="filters-bar" style="justify-content:space-between;">
            <input type="search" id="attr-search" placeholder="Search..." style="min-width:240px;" />
            <button class="btn btn-primary" id="new-attr-btn">+ New value</button>
        </div>
        <div id="attr-table-wrap"><p>Loading...</p></div>
        <div id="attr-modal-root"></div>
    `;
}

function wireAttrTabs(container) {
    container.querySelectorAll('.attr-tab-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            attrState.activeTable = btn.dataset.table;
            attrState.search = '';
            // Re-render the tab bar itself so the active highlight moves.
            container.querySelector('#config-body').innerHTML = attrSectionHTML();
            wireAttrTabs(container);
            await loadAttrTable(container);
        });
    });
}

function currentAttrDef() {
    return ATTR_TABLES.find(t => t.table === attrState.activeTable);
}

async function loadAttrTable(container) {
    const wrap = container.querySelector('#attr-table-wrap');
    const def = currentAttrDef();

    try {
        const [{ data: rows, error: rowsErr }, { data: usageRows, error: usageErr }] = await Promise.all([
            supabase.from(def.table).select('*').order('sort_order').order('display_name'),
            supabase.from('card_variants').select(def.variantColumn),
        ]);

        if (rowsErr) throw rowsErr;
        if (usageErr) throw usageErr;

        const counts = {};
        for (const row of usageRows || []) {
            const val = row[def.variantColumn];
            if (!val) continue;
            counts[val] = (counts[val] || 0) + 1;
        }

        attrState.rows = rows || [];
        attrState.usageCounts = counts;

        renderAttrTable(container);
        wireAttrControls(container);
    } catch (err) {
        console.error(err);
        wrap.innerHTML = `<p style="color:var(--danger)">Failed to load ${def.label}: ${err.message}</p>`;
    }
}

function renderAttrTable(container) {
    const wrap = container.querySelector('#attr-table-wrap');
    const def = currentAttrDef();
    const q = attrState.search.trim().toLowerCase();
    const rows = attrState.rows.filter(r =>
        !q || r.code.toLowerCase().includes(q) || r.display_name.toLowerCase().includes(q));

    if (!rows.length) {
        wrap.innerHTML = `<p style="color:var(--text-secondary)">No ${def.label.toLowerCase()} found.</p>`;
        return;
    }

    wrap.innerHTML = `
        <table>
            <thead>
                <tr>
                    <th>Code</th>
                    <th>Display name</th>
                    <th style="width:80px;">Sort order</th>
                    <th style="width:100px;">In use</th>
                    <th style="width:60px;"></th>
                </tr>
            </thead>
            <tbody>
                ${rows.map(r => `
                    <tr data-code="${escapeAttr(r.code)}">
                        <td><code>${escapeHTML(r.code)}</code></td>
                        <td>${escapeHTML(r.display_name)}</td>
                        <td>${r.sort_order ?? 0}</td>
                        <td>${attrState.usageCounts[r.code] || 0}</td>
                        <td><button class="btn edit-attr-btn" data-code="${escapeAttr(r.code)}">Edit</button></td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;

    wrap.querySelectorAll('.edit-attr-btn').forEach(btn => {
        btn.addEventListener('click', () => openAttrModal(container, btn.dataset.code));
    });
}

function wireAttrControls(container) {
    const searchInput = container.querySelector('#attr-search');
    searchInput.value = attrState.search;
    searchInput.addEventListener('input', debounce((e) => {
        attrState.search = e.target.value;
        renderAttrTable(container);
    }, 200));

    container.querySelector('#new-attr-btn').addEventListener('click', () => openAttrModal(container, null));
}

function openAttrModal(container, code) {
    const def = currentAttrDef();
    const isEdit = !!code;
    const existing = isEdit ? attrState.rows.find(r => r.code === code) : null;
    const root = container.querySelector('#attr-modal-root');

    root.innerHTML = `
        <div style="position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:100;">
            <div style="background:var(--bg-secondary); border:1px solid var(--border); border-radius:8px; padding:20px; width:420px; max-width:90vw;">
                <h3 style="margin:0 0 16px;">${isEdit ? `Edit ${def.label.slice(0, -1)}` : `New ${def.label.slice(0, -1)}`}</h3>
                <form id="attr-form">
                    <div style="display:flex; flex-direction:column; gap:10px;">
                        <label style="font-size:12px; color:var(--text-secondary);">
                            Code ${isEdit ? '<span style="color:var(--text-secondary);">(locked — referenced by existing variants)</span>' : ''}
                            <input type="text" name="code" required value="${existing ? escapeAttr(existing.code) : ''}"
                                   ${isEdit ? 'readonly style="width:100%; margin-top:4px; opacity:0.6;"' : 'style="width:100%; margin-top:4px;"'}
                                   placeholder="e.g. Confetti" />
                        </label>
                        <label style="font-size:12px; color:var(--text-secondary);">
                            Display name
                            <input type="text" name="display_name" required value="${existing ? escapeAttr(existing.display_name) : ''}" style="width:100%; margin-top:4px;" placeholder="e.g. Confetti" />
                        </label>
                        <label style="font-size:12px; color:var(--text-secondary);">
                            Sort order
                            <input type="number" name="sort_order" value="${existing ? existing.sort_order ?? 0 : 0}" style="width:100%; margin-top:4px;" />
                        </label>
                    </div>
                    <div id="attr-form-error" style="color:var(--danger); font-size:12px; margin-top:10px;"></div>
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:18px;">
                        ${isEdit ? `<button type="button" class="btn" id="attr-modal-delete" style="color:var(--danger); border-color:var(--danger);">Delete</button>` : '<span></span>'}
                        <div style="display:flex; gap:8px;">
                            <button type="button" class="btn" id="attr-modal-cancel">Cancel</button>
                            <button type="submit" class="btn btn-primary">${isEdit ? 'Save changes' : 'Create'}</button>
                        </div>
                    </div>
                </form>
            </div>
        </div>
    `;

    root.querySelector('#attr-modal-cancel').addEventListener('click', () => { root.innerHTML = ''; });

    if (isEdit) {
        root.querySelector('#attr-modal-delete').addEventListener('click', async () => {
            root.innerHTML = '';
            await confirmDeleteAttr(container, code);
        });
    }

    root.querySelector('#attr-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errBox = root.querySelector('#attr-form-error');
        errBox.textContent = '';

        const fd = new FormData(e.target);
        const payload = {
            code: fd.get('code').trim(),
            display_name: fd.get('display_name').trim(),
            sort_order: parseInt(fd.get('sort_order'), 10) || 0,
        };

        try {
            if (isEdit) {
                // code is locked/readonly in the form, so only display_name
                // and sort_order can actually change here.
                const { error } = await supabase.from(def.table)
                    .update({ display_name: payload.display_name, sort_order: payload.sort_order })
                    .eq('code', code);
                if (error) throw error;
            } else {
                const { error } = await supabase.from(def.table).insert(payload);
                if (error) throw error;
            }
            root.innerHTML = '';
            await loadAttrTable(container);
        } catch (err) {
            console.error(err);
            const isDupe = err.code === '23505';
            errBox.textContent = isDupe
                ? `"${payload.code}" already exists in ${def.label}.`
                : (err.message || `Failed to save ${def.label.toLowerCase()} value.`);
        }
    });
}

async function confirmDeleteAttr(container, code) {
    const def = currentAttrDef();
    const row = attrState.rows.find(r => r.code === code);
    if (!row) return;

    const usageCount = attrState.usageCounts[code] || 0;
    const warning = usageCount > 0
        ? `"${row.display_name}" is used by ${usageCount} existing card variant${usageCount === 1 ? '' : 's'}. Deleting it will fail unless those variants are updated first.\n\nTry to delete anyway?`
        : `Delete "${row.display_name}"? This can't be undone.`;

    if (!window.confirm(warning)) return;

    try {
        const { error } = await supabase.from(def.table).delete().eq('code', code);
        if (error) throw error;
        await loadAttrTable(container);
    } catch (err) {
        console.error(err);
        const isFkViolation = (err.code === '23503') || /foreign key/i.test(err.message || '');
        const msg = isFkViolation
            ? `Can't delete "${row.display_name}" — it's still referenced by existing card variants. Update those variants first.`
            : `Failed to delete: ${err.message}`;
        window.alert(msg);
    }
}

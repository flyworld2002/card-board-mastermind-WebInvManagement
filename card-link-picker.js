// card-link-picker.js
// The card picker used to tie a TCGplayer card to one exact card version of ours. Shared by
//   - Catalog > TCGplayer catalogue (tcg-catalogue.js): links a TCGplayer product + printing (tcg_link_product)
//   - Incoming > Fix card matches (incoming-match.js): links an order line, and every line of that product (tcg_link_line)
// What it offers (same as Staging Review's card search):
//   - type-ahead search by name; Set and # only narrow it; if nothing matches it drops the set, then the number, and says so
//   - Link            an existing card version
//   - New version...  another version of a card we have (the 7 finish fields of Catalog > Our cards), then link it
//   - New card...     the card itself when it is not in our catalog (like Staging Review's Create new card) + its version
// The caller decides what "link" means through opts.onLink(variantId) -> true, or an error message.

import { supabase, loadAxisOptions, AXIS_OPTIONS } from './shared.js';

const esc = (s) => (s ?? '').toString()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const likeName = (t) => t.replace(/[%_]/g, '').replace(/pok[eé]mon/gi, 'Pok_mon').replace(/[‘’']/g, '_');
const label = (r) => [r.foil_label, r.pattern_label, r.texture_label, r.material_label, r.size_label, r.stamp_label, r.source_label].filter(Boolean).join(' · ') || 'Non-Holo';
const COLS = 'card_id, variant_id, card_name, set_name, display_number, card_number, rarity, foil_type, foil_pattern, texture, foil_label, pattern_label, texture_label, material_label, size_label, stamp_label, source_label';
const AX = [['foil_type', 'Foil type'], ['foil_pattern', 'Foil pattern'], ['texture', 'Texture'], ['material', 'Material'],
            ['size', 'Size'], ['stamp_type', 'Stamp'], ['source_type', 'Source']];
export const FINISH = { 'Normal': 'non_holo', 'Holofoil': 'holo', 'Reverse Holofoil': 'reverse_holo' };
const noZeros = (n) => String(n || '').split('/')[0].trim().replace(/^0+(?=\d)/, '');

/**
 * opts: { what            text shown as "Link <what> to one of our card versions"
 *         name, number    search prefill (number may be "054/193")
 *         ourSetName      set prefill (our set's name), ourSetId (pre-selected in New card)
 *         tcgSetName      TCGplayer set name (Promo detection in New card), rarity, imageUrl
 *         want            { foil_type, foil_pattern, texture } the finish to rank first and pre-fill
 *         onLink(variantId) -> Promise<true | string error>
 *         onClose() }
 */
export function mountCardPicker(host, opts) {
    const want = { foil_type: opts.want?.foil_type || 'non_holo', foil_pattern: opts.want?.foil_pattern || null, texture: opts.want?.texture || null };
    const num = noZeros(opts.number);
    host.innerHTML = `
        <div style="border:1px solid var(--border); border-radius:6px; padding:8px 10px;">
            <div style="font-size:12px; margin-bottom:6px;">Link <strong>${esc(opts.what)}</strong> to one of our card versions:</div>
            <div style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:6px; align-items:center;">
                <input class="tp-name" placeholder="Type a card name..." value="${esc(opts.name || '')}" style="width:220px;" />
                <input class="tp-set" placeholder="Set (optional)" value="${esc(opts.ourSetName || '')}" style="width:190px;" />
                <input class="tp-num" placeholder="# (optional)" value="${esc(num)}" style="width:80px;" />
                <button class="btn tp-newcard" style="font-size:12px;" title="The card is not in our catalog at all: create it, its version, and link it">New card…</button>
                <button class="btn tp-close" style="font-size:12px;">Cancel</button>
            </div>
            <div class="tp-note" style="font-size:11px; color:var(--text-secondary); margin-bottom:4px;"></div>
            <div class="tp-results" style="font-size:12px; max-height:320px; overflow-y:auto;"></div>
        </div>`;
    const results = host.querySelector('.tp-results'), note = host.querySelector('.tp-note');
    const doLink = async (variantId) => {
        const r = await opts.onLink(variantId);
        if (r === true) return true;
        results.insertAdjacentHTML('afterbegin', `<div style="color:var(--danger);">${esc(r || 'Could not link')}</div>`);
        return false;
    };
    const axisSelects = () => AX.map(([ax, lab]) => `<label>${lab}<br><select data-axis="${ax}"><option value="">—</option>${(AXIS_OPTIONS[ax] || []).map(([code, name]) =>
        `<option value="${esc(code)}" ${want[ax] && code === want[ax] ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select></label>`).join('');
    const readAxes = (f, payload) => { f.querySelectorAll('select[data-axis]').forEach(sel => { payload[sel.dataset.axis] = sel.value || null; }); return payload; };
    const variants = (name, set, n) => {
        let q = supabase.from('v_card_variants').select(COLS).order('card_name').order('set_name').order('foil_type').limit(40);
        if (name) q = q.ilike('card_name', `%${likeName(name)}%`);
        if (set) q = q.ilike('set_name', `%${likeName(set)}%`);
        if (n) q = q.eq('card_number', n);
        return q;
    };
    const same = (r) => (r.foil_type || 'non_holo') === want.foil_type && (r.foil_pattern || null) === want.foil_pattern && (r.texture || null) === want.texture;

    let seq = 0;
    const run = async () => {
        const my = ++seq;
        const name = host.querySelector('.tp-name').value.trim(), set = host.querySelector('.tp-set').value.trim(), n = noZeros(host.querySelector('.tp-num').value);
        if (!name && !(set && n)) { results.innerHTML = ''; note.textContent = 'Type a card name (or fill both Set and #).'; return; }
        results.textContent = 'Searching...';
        // tiers: everything filled, then drop the set, then drop the number
        const tiers = [[name, set, n, '']];
        if (set) tiers.push([name, '', n, `Nothing in "${set}" with that name/number; showing matches from every set.`]);
        if (n && name) tiers.push([name, '', '', `Nothing with #${n}; showing every number.`]);
        let data = [], used = '';
        for (const [a, b, c, msg] of tiers) {
            const { data: d, error } = await variants(a, b, c);
            if (my !== seq) return;
            if (error) { results.innerHTML = `<span style="color:var(--danger)">${esc(error.message)}</span>`; return; }
            if (d.length) { data = d; used = msg; break; }
        }
        // cards we have with no version yet
        let bare = [];
        if (name) {
            let cq = supabase.from('card_master').select('id, name, card_number, rarity, card_sets(name)').ilike('name', `%${likeName(name)}%`).limit(15);
            if (n) cq = cq.eq('card_number', n);
            const { data: cm } = await cq;
            if (my !== seq) return;
            const seen = new Set(data.map(r => r.card_id));
            bare = (cm || []).filter(c => !seen.has(c.id));
        }
        note.textContent = used;
        if (!data.length && !bare.length) { results.textContent = 'No cards found. Try a shorter name, clear Set and #, or use New card.'; return; }
        data.sort((a, b) => Number(same(b)) - Number(same(a)));
        results.innerHTML = data.map(r => `
            <div style="display:flex; gap:10px; align-items:center; padding:4px 6px; border:1px solid var(--border); border-radius:4px; margin-bottom:3px; flex-wrap:wrap; ${same(r) ? '' : 'opacity:0.7;'}">
                <span style="min-width:200px;"><strong>${esc(r.card_name)}</strong> <span style="color:var(--text-secondary);">#${esc(r.display_number || r.card_number)}</span></span>
                <span style="min-width:170px; color:var(--text-secondary);">${esc(r.set_name)}</span>
                <span style="min-width:110px;">${esc(r.rarity || '')}</span>
                <span style="min-width:150px;">${esc(label(r))}${same(r) ? ' <span style="color:var(--success);">✓ same finish</span>' : ''}</span>
                <button class="btn tp-new" data-card="${esc(r.card_id)}" data-label="${esc(`${r.card_name} #${r.display_number || r.card_number} · ${r.set_name}`)}" style="font-size:11px; margin-left:auto;" title="Create another version of this card (different finish, stamp, pattern...) and link it">New version…</button>
                <button class="btn tp-link" data-v="${esc(r.variant_id)}" style="font-size:12px;">Link</button>
            </div>`).join('') + bare.map(c => `
            <div style="display:flex; gap:10px; align-items:center; padding:4px 6px; border:1px dashed var(--border); border-radius:4px; margin-bottom:3px; flex-wrap:wrap; opacity:0.7;">
                <span style="min-width:200px;"><strong>${esc(c.name)}</strong> <span style="color:var(--text-secondary);">#${esc(c.card_number)}</span></span>
                <span style="min-width:170px; color:var(--text-secondary);">${esc(c.card_sets?.name || '')}</span>
                <span style="min-width:110px;">${esc(c.rarity || '')}</span>
                <span style="color:var(--text-secondary);">no version of this card yet</span>
                <button class="btn tp-new" data-card="${esc(c.id)}" data-label="${esc(`${c.name} #${c.card_number} · ${c.card_sets?.name || ''}`)}" style="font-size:11px; margin-left:auto;">New version…</button>
            </div>`).join('');
        results.querySelectorAll('.tp-link').forEach(b => b.addEventListener('click', async () => {
            b.disabled = true;
            if (!(await doLink(b.dataset.v))) b.disabled = false;
        }));
        results.querySelectorAll('.tp-new').forEach(b => b.addEventListener('click', async () => {
            if (!Object.keys(AXIS_OPTIONS).length) await loadAxisOptions();
            host.querySelector('.tp-newform')?.remove();
            note.insertAdjacentHTML('afterend', `
                <div class="tp-newform" style="border:1px solid var(--accent); border-radius:6px; padding:8px 10px; margin:4px 0 8px; font-size:12px;">
                    New version of <strong>${esc(b.dataset.label)}</strong>, linked to <strong>${esc(opts.what)}</strong>. Leave a field on — for standard / none.
                    <div style="display:flex; flex-wrap:wrap; gap:10px; margin:6px 0;">${axisSelects()}</div>
                    <button class="btn btn-primary tp-create" style="font-size:12px;">Create &amp; link</button>
                    <button class="btn tp-newcancel" style="font-size:12px;">Cancel</button>
                    <span class="tp-newerr" style="color:var(--danger); margin-left:8px;"></span>
                </div>`);
            const f = host.querySelector('.tp-newform');
            f.querySelector('.tp-newcancel').addEventListener('click', () => f.remove());
            f.querySelector('.tp-create').addEventListener('click', async (ev) => {
                ev.target.disabled = true;
                const { data: nv, error } = await supabase.from('card_variants').insert(readAxes(f, { card_id: b.dataset.card })).select('id').single();
                if (error) {
                    ev.target.disabled = false;
                    f.querySelector('.tp-newerr').textContent = (error.code === '23505' || /duplicate|unique/i.test(error.message || ''))
                        ? 'This card already has a version with exactly these fields: pick it in the list below and click Link.'
                        : error.message;
                    return;
                }
                if (!(await doLink(nv.id))) ev.target.disabled = false;
            });
        }));
    };

    let t = null;
    host.querySelectorAll('.tp-name, .tp-set, .tp-num').forEach(i => i.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 300); }));
    host.querySelector('.tp-close').addEventListener('click', () => opts.onClose?.());
    host.querySelector('.tp-newcard').addEventListener('click', async () => {
        if (!Object.keys(AXIS_OPTIONS).length) await loadAxisOptions();
        if (!window.__cbmOurSets) {
            const { data } = await supabase.from('card_sets').select('id, name, release_year').order('name');
            window.__cbmOurSets = data || [];
        }
        host.querySelector('.tp-newform')?.remove();
        const preSet = opts.ourSetId || (window.__cbmOurSets.find(o => o.name.toLowerCase() === String(opts.ourSetName || '').toLowerCase()) || {}).id;
        note.insertAdjacentHTML('afterend', `
            <div class="tp-newform" style="border:1px solid var(--accent); border-radius:6px; padding:8px 10px; margin:4px 0 8px; font-size:12px;">
                New card for <strong>${esc(opts.what)}</strong>${opts.tcgSetName ? ` (${esc(opts.tcgSetName)})` : ''}. Check the cards listed below first, so you do not create a duplicate.
                <div style="display:flex; flex-wrap:wrap; gap:10px; margin:6px 0;">
                    <label>Card name<br><input class="nc-name" value="${esc(opts.name || '')}" style="width:200px;" /></label>
                    <label>Our set<br><select class="nc-set" style="max-width:240px;"><option value="">pick a set...</option>${window.__cbmOurSets.map(o =>
                        `<option value="${o.id}" ${o.id === preSet ? 'selected' : ''}>${esc(o.name)}${o.release_year ? ` (${o.release_year})` : ''}</option>`).join('')}</select></label>
                    <label>Number<br><input class="nc-num" value="${esc(num)}" style="width:80px;" /></label>
                    <label>Rarity<br><input class="nc-rarity" value="${esc(opts.rarity || '')}" style="width:170px;" /></label>
                    <label style="align-self:end;"><input type="checkbox" class="nc-promo" ${/promo/i.test(opts.tcgSetName || '') ? 'checked' : ''} /> Promo</label>
                    <label style="align-self:end;"><input type="checkbox" class="nc-first" /> 1st Edition</label>
                    <label style="align-self:end;"><input type="checkbox" class="nc-shiny" /> Shiny</label>
                </div>
                <div style="margin:2px 0;">Its version (leave a field on — for standard / none):</div>
                <div style="display:flex; flex-wrap:wrap; gap:10px; margin:4px 0 6px;">${axisSelects()}</div>
                <label style="display:block; margin-bottom:6px;"><input type="checkbox" class="nc-img" ${opts.imageUrl ? 'checked' : 'disabled'} /> Use TCGplayer's picture for the card</label>
                <button class="btn btn-primary nc-create" style="font-size:12px;">Create card &amp; link</button>
                <button class="btn nc-cancel" style="font-size:12px;">Cancel</button>
                <span class="nc-err" style="color:var(--danger); margin-left:8px;"></span>
            </div>`);
        const f = host.querySelector('.tp-newform');
        const err = (m) => { f.querySelector('.nc-err').textContent = m; };
        f.querySelector('.nc-cancel').addEventListener('click', () => f.remove());
        f.querySelector('.nc-create').addEventListener('click', async (ev) => {
            const name = f.querySelector('.nc-name').value.trim(), setId = f.querySelector('.nc-set').value, number = noZeros(f.querySelector('.nc-num').value);
            if (!name || !setId || !number) { err('Card name, set and number are needed.'); return; }
            ev.target.disabled = true;
            // same set + number + name already there? do not create a duplicate
            const { data: dup } = await supabase.from('card_master').select('id, name').eq('set_id', setId).eq('card_number', number);
            if ((dup || []).some(d => d.name.toLowerCase() === name.toLowerCase())) {
                ev.target.disabled = false;
                err('That card already exists in this set with this number: use "New version..." on it in the list below.');
                return;
            }
            const { data: card, error: e1 } = await supabase.from('card_master').insert({
                set_id: setId, name, card_number: number, rarity: f.querySelector('.nc-rarity').value.trim() || null,
                is_promo: f.querySelector('.nc-promo').checked, is_first_edition: f.querySelector('.nc-first').checked,
                is_shiny: f.querySelector('.nc-shiny').checked,
                image_url: f.querySelector('.nc-img').checked ? opts.imageUrl : null,
            }).select('id').single();
            if (e1) { ev.target.disabled = false; err(`Could not create the card: ${e1.message}`); return; }
            const { data: nv, error: e2 } = await supabase.from('card_variants').insert(readAxes(f, { card_id: card.id })).select('id').single();
            if (e2) { err(`The card was created, but not its version: ${e2.message}. Search for it and use "New version...".`); return; }
            if (!(await doLink(nv.id))) ev.target.disabled = false;
        });
    });
    host.querySelector('.tp-name').focus();
    run();
}

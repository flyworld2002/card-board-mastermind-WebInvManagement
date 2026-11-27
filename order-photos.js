// order-photos.js
// Photos of the ORDER itself (packing slip, opened contents, damaged package), shown on the Incoming
// order detail and on the Held page. Different from card photos (held.js), which are shared with the
// seller by default.
//
// These are PRIVATE: they are stored in the non-public bucket "tcg-order-photos" (a slip or label
// shows your name and address) and only you, signed in, can open them. "Show to seller" copies one
// into the public bucket "tcg-held-photos" so the seller's gallery link can display it; switching it
// off deletes that copy. SQL: sql/tcg_order_photos.sql.

import { supabase } from './shared.js';

const PRIVATE_BUCKET = 'tcg-order-photos';
const PUBLIC_BUCKET = 'tcg-held-photos';
const KINDS = [['slip', 'Packing slip'], ['contents', 'Opened contents'], ['package', 'Package / outside'], ['other', 'Other']];
const KIND_LABEL = Object.fromEntries(KINDS);

const esc = (s) => (s ?? '').toString()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Phone photos are 3-5 MB; shrink to a 1600 px JPEG before uploading.
async function shrink(file) {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return await new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('Could not read that image')), 'image/jpeg', 0.82));
}

// Draws the photo section for one order into `el` and keeps it up to date.
export async function renderOrderPhotos(el, orderNumber, opts = {}) {
    let msg = '';
    const load = async () => {
        const { data, error } = await supabase.from('tcg_order_photos').select('*').eq('order_number', orderNumber).order('created_at');
        if (error) throw new Error(error.message);
        const rows = data || [];
        const urls = new Map();
        if (rows.length) {
            const { data: signed } = await supabase.storage.from(PRIVATE_BUCKET).createSignedUrls(rows.map(r => r.path), 3600);
            for (const s of signed || []) if (s.path && s.signedUrl) urls.set(s.path, s.signedUrl);
        }
        return { rows, urls };
    };
    const draw = async () => {
        let ctx;
        try { ctx = await load(); } catch (e) { el.innerHTML = `<div style="color:var(--danger); font-size:12px;">Could not load order photos: ${esc(e.message)}</div>`; return; }
        const { rows, urls } = ctx;
        el.innerHTML = `
        <div style="border:1px solid var(--border); border-radius:6px; padding:6px 10px; margin-bottom:10px;">
            <div style="font-size:12px;"><strong>Order photos</strong>
                <span style="color:var(--text-secondary);"> · private: only you can see them. A slip or label shows your address, so keep "Show to seller" off for those unless the address is not visible.</span></div>
            <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:6px;">
                ${rows.map(r => `
                <div class="op-item" data-id="${esc(r.id)}" style="width:128px; font-size:11px;">
                    ${urls.get(r.path) ? `<a href="${esc(urls.get(r.path))}" target="_blank" rel="noopener"><img src="${esc(urls.get(r.path))}" loading="lazy" style="width:128px; height:96px; object-fit:cover; border-radius:4px; border:1px solid ${r.show_to_seller ? 'var(--warning)' : 'var(--border)'};" /></a>`
                        : '<div style="width:128px; height:96px; background:var(--bg-tertiary); border-radius:4px;"></div>'}
                    <div>${esc(KIND_LABEL[r.kind] || r.kind)}${r.caption ? ' · ' + esc(r.caption) : ''}</div>
                    <label style="display:flex; gap:3px; align-items:center;"><input type="checkbox" class="op-show" ${r.show_to_seller && r.public_path ? 'checked' : ''} /> Show to seller</label>
                    <button class="btn op-del" style="font-size:10px; padding:0 6px;">Delete</button>
                </div>`).join('')}
            </div>
            <div style="margin-top:6px; display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
                <select class="op-kind" style="font-size:12px;">${KINDS.map(k => `<option value="${k[0]}">${esc(k[1])}</option>`).join('')}</select>
                <input type="text" class="op-caption" placeholder="Caption (optional)" style="width:180px; font-size:12px;" />
                <label class="btn" style="font-size:12px; cursor:pointer;">Add photos
                    <input type="file" class="op-file" accept="image/*" multiple style="display:none;" /></label>
                <span class="op-msg" style="font-size:12px; color:var(--text-secondary);">${esc(msg)}</span>
            </div>
        </div>`;
        wire(rows);
    };
    const setMsg = (m) => { msg = m; const s = el.querySelector('.op-msg'); if (s) s.textContent = m; };

    const wire = (rows) => {
        el.querySelector('.op-file').addEventListener('change', async (e) => {
            const files = [...e.target.files];
            if (!files.length) return;
            const kind = el.querySelector('.op-kind').value;
            const caption = el.querySelector('.op-caption').value.trim() || null;
            let ok = 0;
            for (const f of files) {
                try {
                    setMsg(`Uploading ${ok + 1} of ${files.length}...`);
                    const blob = await shrink(f);
                    const path = `${orderNumber}/${crypto.randomUUID()}.jpg`;
                    const up = await supabase.storage.from(PRIVATE_BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: false });
                    if (up.error) throw up.error;
                    const ins = await supabase.from('tcg_order_photos').insert({ order_number: orderNumber, kind, caption, path });
                    if (ins.error) throw ins.error;
                    ok++;
                } catch (err) {
                    alert(`Could not add ${f.name}: ${err.message}`);
                }
            }
            msg = ok ? `${ok} photo${ok === 1 ? '' : 's'} added (private).` : '';
            await draw();
            opts.onChange?.();
        });
        el.querySelectorAll('.op-item').forEach(item => {
            const row = rows.find(r => r.id === item.dataset.id);
            item.querySelector('.op-show').addEventListener('change', async (e) => {
                e.target.disabled = true;
                try { await setShown(row, e.target.checked); msg = e.target.checked ? 'Now visible on the seller gallery link.' : 'Hidden from the seller again.'; }
                catch (err) { alert(`Could not change that: ${err.message}`); }
                await draw();
                opts.onChange?.();
            });
            item.querySelector('.op-del').addEventListener('click', async () => {
                if (!confirm('Delete this photo?')) return;
                try { await deletePhoto(row); msg = 'Photo deleted.'; } catch (err) { alert(`Could not delete: ${err.message}`); }
                await draw();
                opts.onChange?.();
            });
        });
    };
    await draw();
}

// On: copy the private original into the public bucket. Off: remove the public copy.
async function setShown(row, on) {
    if (on) {
        const dl = await supabase.storage.from(PRIVATE_BUCKET).download(row.path);
        if (dl.error) throw dl.error;
        const publicPath = `order-photos/${row.order_number}/${row.id}.jpg`;
        const up = await supabase.storage.from(PUBLIC_BUCKET).upload(publicPath, dl.data, { contentType: 'image/jpeg', upsert: true });
        if (up.error) throw up.error;
        const u = await supabase.from('tcg_order_photos').update({ show_to_seller: true, public_path: publicPath }).eq('id', row.id);
        if (u.error) throw u.error;
    } else {
        if (row.public_path) {
            const rm = await supabase.storage.from(PUBLIC_BUCKET).remove([row.public_path]);
            if (rm.error) throw rm.error;
        }
        const u = await supabase.from('tcg_order_photos').update({ show_to_seller: false, public_path: null }).eq('id', row.id);
        if (u.error) throw u.error;
    }
}

async function deletePhoto(row) {
    const paths = [row.public_path].filter(Boolean);
    if (paths.length) { const r = await supabase.storage.from(PUBLIC_BUCKET).remove(paths); if (r.error) throw r.error; }
    const r2 = await supabase.storage.from(PRIVATE_BUCKET).remove([row.path]);
    if (r2.error) throw r2.error;
    const d = await supabase.from('tcg_order_photos').delete().eq('id', row.id);
    if (d.error) throw d.error;
}

// 90 days after an order stops needing follow-up, its order photos are deleted (both copies).
// Called from the Held page, like the card-photo purge. Returns how many photos were removed.
export async function purgeOldOrderPhotos() {
    const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
    const { data: old } = await supabase.from('tcg_order_photos').select('*').lt('created_at', cutoff).limit(200);
    if (!old?.length) return 0;
    const { data: fu } = await supabase.from('v_tcg_followups').select('order_number').in('order_number', [...new Set(old.map(r => r.order_number))]);
    const still = new Set((fu || []).map(r => r.order_number));
    let n = 0;
    for (const row of old.filter(r => !still.has(r.order_number))) {
        try { await deletePhoto(row); n++; } catch { /* try again next time */ }
    }
    return n;
}

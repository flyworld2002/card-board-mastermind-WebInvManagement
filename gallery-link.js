// gallery-link.js
// The address of the seller photo page. It is a separate, neutral site (the gallery-site folder,
// deployed on its own Cloudflare Pages project) so the link a seller sees does not show the name of
// this system. To move it (a new name, or your own domain) change GALLERY_BASE here only.

export const GALLERY_BASE = 'https://mypcphoto.pages.dev';

export function galleryUrl(token) {
    return `${GALLERY_BASE}/?t=${encodeURIComponent(token)}`;
}

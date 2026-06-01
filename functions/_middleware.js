// Edge HTML rewrite — injects the user's zip into the books page
// before the response leaves Cloudflare's edge, so the page arrives
// with the real value already in place (no client-side flash from
// the hardcoded fallback to the detected zip).
//
// Runs for every request. Cheap if it doesn't match (just a path
// check + content-type check). Only rewrites HTML, only touches
// the books page, only acts when request.cf has a US-shaped zip.

const ZIP_RE = /^\d{5}$/;

export async function onRequest(context) {
    const { request, next } = context;
    const url = new URL(request.url);

    // Scope: just the books page (with or without .html).
    if (url.pathname !== '/books' && url.pathname !== '/books.html') {
        return next();
    }

    const response = await next();
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return response;

    // ?zip= overrides geo (shared-link case). Otherwise use request.cf.
    const urlZip = url.searchParams.get('zip');
    const geoZip = request.cf?.postalCode;
    const zip = ZIP_RE.test(urlZip || '') ? urlZip : geoZip;
    if (!zip || !ZIP_RE.test(zip)) return response;

    const transformed = new HTMLRewriter()
        .on('.order-summary__zip-code', {
            element(el) { el.setInnerContent(zip); },
        })
        .transform(response);

    // Mark the response as user-specific so no shared cache layer
    // hands one user's zip to another. HTMLRewriter returns a new
    // Response — we rebuild headers to keep them mutable.
    const headers = new Headers(transformed.headers);
    headers.set('Cache-Control', 'private, no-cache');
    return new Response(transformed.body, {
        status: transformed.status,
        statusText: transformed.statusText,
        headers,
    });
}

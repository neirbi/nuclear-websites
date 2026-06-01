// Cloudflare Pages Function — returns the user's location from
// request.cf, which the edge attaches to every request for free.
// No external API, no key, no rate limit, no CORS (same origin).
// Lives at /api/geo once deployed.

export function onRequest({ request }) {
    const cf = request.cf || {};
    return new Response(
        JSON.stringify({
            postal: cf.postalCode || null,
            city: cf.city || null,
            region: cf.regionCode || null,
            country: cf.country || null,
            timezone: cf.timezone || null,
            lat: cf.latitude || null,
            lon: cf.longitude || null,
        }),
        {
            headers: {
                'Content-Type': 'application/json',
                // 5 min per-user cache so we don't re-run the function on
                // every page load while the user clicks around.
                'Cache-Control': 'private, max-age=300',
            },
        }
    );
}

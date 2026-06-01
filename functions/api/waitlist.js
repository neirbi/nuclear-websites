// Server-side waitlist signup. Consolidates the old client-side flow
// (validator + Zapier) into one endpoint so the Turnstile secret can
// stay on the server.
//
// Env vars (set on the Pages project → Settings → Env Variables):
//   TURNSTILE_SECRET  — required for spam protection. If absent, the
//                       captcha step is skipped (graceful degradation
//                       while you finish dashboard setup).

const TURNSTILE_VERIFY  = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const VALIDATOR_URL     = 'https://nuclear-websites-email-validator.throbbing-sun-378c.workers.dev/';
const WAITLIST_WEBHOOK  = 'https://hooks.zapier.com/hooks/catch/27288191/4bmwix9/';
const ACCEPTED          = new Set(['valid', 'catch-all']);
const EMAIL_RE          = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const json = (status, body) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });

export async function onRequestPost({ request, env }) {
    let payload;
    try { payload = await request.json(); }
    catch { return json(400, { ok: false, error: 'bad_request' }); }

    const { email, cover, turnstile } = payload;
    if (!email || !EMAIL_RE.test(email)) {
        return json(400, { ok: false, error: 'bad_email' });
    }

    // 0. Cloudflare's threat score for this IP (0=clean, 100=malicious).
    // Silently drop high-threat traffic with a fake success response so
    // bots don't realize they were filtered and retry from a new IP.
    // Threshold 40 = Cloudflare's 'malicious' bucket; legit users score 0.
    if ((request.cf?.threatScore ?? 0) >= 40) {
        return json(200, { ok: true });
    }

    // 1. Turnstile verification — only enforced if a secret is configured.
    if (env.TURNSTILE_SECRET) {
        if (!turnstile) return json(403, { ok: false, error: 'no_captcha' });
        const verify = await fetch(TURNSTILE_VERIFY, {
            method: 'POST',
            body: new URLSearchParams({
                secret: env.TURNSTILE_SECRET,
                response: turnstile,
                remoteip: request.headers.get('CF-Connecting-IP') || '',
            }),
        });
        const result = await verify.json();
        if (!result.success) return json(403, { ok: false, error: 'captcha_failed' });
    }

    // 2. Email validation (network error → pass through, same as before).
    let emailOk = true;
    try {
        const v = await fetch(VALIDATOR_URL + '?email=' + encodeURIComponent(email), {
            // Worker checks Origin against an allow-list; server-to-server
            // fetches don't get an Origin header, so we set one explicitly.
            headers: { Origin: 'https://nuclear-websites.pages.dev' },
        });
        if (v.ok) {
            const { status } = await v.json();
            emailOk = ACCEPTED.has(status);
        }
    } catch {}
    if (!emailOk) return json(422, { ok: false, error: 'invalid_email' });

    // 3. Forward to Zapier (fire-and-forget — never blocks the success response).
    try {
        await fetch(WAITLIST_WEBHOOK, {
            method: 'POST',
            body: new URLSearchParams({ email, cover: cover || '' }),
        });
    } catch {}

    return json(200, { ok: true });
}

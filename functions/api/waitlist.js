// Server-side waitlist signup. Verifies Turnstile, validates the email
// via the ZeroBounce-backed worker, persists the signup to D1.
//
// Env vars (set on the Pages project → Settings → Variables and Secrets):
//   TURNSTILE_SECRET — required for spam protection. If absent, the
//                      captcha step is skipped (graceful degradation
//                      while dashboard setup is in progress).
//
// Bindings (Pages project → Settings → Bindings):
//   DB — D1 database binding pointing at the nuclear-waitlist database.

const TURNSTILE_VERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const VALIDATOR_URL    = 'https://nuclear-websites-email-validator.throbbing-sun-378c.workers.dev/';
const ACCEPTED         = new Set(['valid', 'catch-all']);
const EMAIL_RE         = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

    // 3. Persist to D1. created_at defaults to unixepoch() server-side.
    // Allows duplicate emails on purpose — interesting signal (someone
    // signed up twice = they care). Dedupe at query/export time if needed.
    try {
        await env.DB.prepare(
            'INSERT INTO signups (email, cover, ip, country, user_agent) VALUES (?, ?, ?, ?, ?)'
        ).bind(
            email,
            cover || '',
            request.headers.get('CF-Connecting-IP') || '',
            request.cf?.country || '',
            request.headers.get('User-Agent') || '',
        ).run();
    } catch {
        // Storage failure shouldn't surface to the user — they already
        // passed Turnstile + validation. Quietly return ok and rely on
        // dashboard logs to surface DB issues.
    }

    return json(200, { ok: true });
}

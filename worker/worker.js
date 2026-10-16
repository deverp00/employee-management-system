/**
 * Employee Management & Payroll System
 * Designed and Developed by Yadav Web Technologies
 * ----------------------------------------------------------------------------
 * worker/worker.js
 *
 * Cloudflare Worker — the secure backend/API layer.
 *
 * Trust boundary:
 *   Browser (GitHub Pages)
 *     -> this Worker (verifies ID tokens, enforces permissions)
 *       -> Firebase Realtime Database (rules: .read=false, .write=false)
 *
 * Security model:
 *   - Firebase ID tokens are verified locally using WebCrypto against
 *     Google's published JWK set for the project.
 *   - The authoritative role is read from /users/{uid} in the Realtime
 *     Database, using a service-account OAuth2 access token that is minted
 *     from a Cloudflare Secret and never leaves this Worker.
 *   - Every protected endpoint performs a role check and an ownership
 *     check independently. Hiding a navigation item in the frontend is not
 *     a security control.
 *   - All responses use a standardized envelope. Raw errors, stack traces,
 *     credentials, and internal identifiers are never returned.
 *   - CORS is enforced against an explicit origin allowlist.
 *
 * Environment variables (public Firebase web configuration):
 *   FIREBASE_WEB_API_KEY
 *   FIREBASE_AUTH_DOMAIN
 *   FIREBASE_PROJECT_ID
 *   FIREBASE_APP_ID
 *   FIREBASE_DATABASE_URL
 *   FIREBASE_STORAGE_BUCKET
 *   FIREBASE_MESSAGING_SENDER_ID
 *   FIREBASE_MEASUREMENT_ID
 *
 * Secrets:
 *   FIREBASE_SERVICE_ACCOUNT_EMAIL
 *   FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY   (PEM, PKCS#8)
 */

/* ============================================================================
 * 1. Constants
 * ========================================================================= */

/**
 * Origins permitted to call this Worker. The Worker is not a public API; it
 * exists solely for the Employee Management System frontend. Any origin not
 * in this list receives no CORS headers, so a browser will block the
 * response regardless of what the request contained.
 */
const ALLOWED_ORIGINS = [
    'https://deverp00.github.io',
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
];

/** Firebase JWK set endpoint for ID token verification. */
const FIREBASE_JWK_URL =
    'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

/** Google OAuth2 token endpoint for service-account exchange. */
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Scopes required by this Worker. Least privilege. */
const SERVICE_ACCOUNT_SCOPES = [
    'https://www.googleapis.com/auth/firebase.database',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/identitytoolkit',
].join(' ');

/** Recognized application roles. The display name for each is decided in the frontend. */
const VALID_ROLES = ['super_admin', 'hr_admin', 'employee'];

/** Maximum accepted JSON body size, in bytes. */
const MAX_BODY_BYTES = 64 * 1024;

/** Rate limit defaults. Best-effort per isolate. */
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 120;

/* ============================================================================
 * 2. Response helpers
 * ========================================================================= */

function jsonResponse(body, status, corsHeaders, requestId) {
    const headers = new Headers(corsHeaders || {});
    headers.set('Content-Type', 'application/json; charset=utf-8');
    headers.set('X-Request-Id', requestId || '');
    headers.set('Cache-Control', 'no-store');
    return new Response(JSON.stringify(body), { status, headers });
}

function errorResponse(code, status, corsHeaders, requestId, extra) {
    const body = {
        error: {
            code: code,
            message: safeMessageFor(code),
            requestId: requestId || '',
        },
    };
    if (extra && typeof extra === 'object') {
        for (const [k, v] of Object.entries(extra)) {
            body.error[k] = v;
        }
    }
    return jsonResponse(body, status, corsHeaders, requestId);
}

function safeMessageFor(code) {
    switch (code) {
        case 'bad_request':       return 'The request was not valid.';
        case 'unauthorized':      return 'Your session has expired. Please sign in again.';
        case 'forbidden':         return 'You do not have permission to perform this action.';
        case 'not_found':         return 'The requested record could not be found.';
        case 'conflict':          return 'This action conflicts with existing data.';
        case 'validation_failed': return 'Please check the information you entered.';
        case 'rate_limited':      return 'Too many requests. Please wait a moment and try again.';
        case 'server_error':      return 'The server is temporarily unavailable. Please try again.';
        default:                  return 'Something went wrong. Please try again.';
    }
}

/* ============================================================================
 * 3. CORS
 * ========================================================================= */

function getCorsHeaders(origin) {
    if (typeof origin !== 'string' || !ALLOWED_ORIGINS.includes(origin)) {
        return {};
    }
    return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin',
    };
}

function handlePreflight(request) {
    const origin = request.headers.get('Origin') || '';
    const headers = getCorsHeaders(origin);
    if (Object.keys(headers).length === 0) {
        return new Response(null, { status: 403 });
    }
    return new Response(null, { status: 204, headers });
}

/* ============================================================================
 * 4. Base64url and encoding helpers
 * ========================================================================= */

function base64urlEncodeBytes(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

function base64urlDecodeToBytes(str) {
    const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + pad;
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function base64urlDecodeToString(str) {
    return new TextDecoder().decode(base64urlDecodeToBytes(str));
}

function base64urlEncodeString(str) {
    return base64urlEncodeBytes(new TextEncoder().encode(str));
}

/* ============================================================================
 * 5. Firebase ID token verification
 * ========================================================================= */

let cachedJwks = null;
let cachedJwksExpiry = 0;

async function getFirebaseJwks() {
    const now = Date.now();
    if (cachedJwks && now < cachedJwksExpiry) {
        return cachedJwks;
    }

    const res = await fetch(FIREBASE_JWK_URL, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
    });

    if (!res.ok) {
        throw new Error('jwks_fetch_failed');
    }

    const data = await res.json();
    const keys = Array.isArray(data && data.keys) ? data.keys : [];
    if (keys.length === 0) {
        throw new Error('jwks_empty');
    }

    const cc = res.headers.get('Cache-Control') || '';
    const match = cc.match(/max-age=(\d+)/);
    const maxAgeSec = match ? parseInt(match[1], 10) : 3600;
    const safeMaxAgeMs = Math.max(60 * 1000, (maxAgeSec * 1000) - 60 * 1000);

    cachedJwks = keys;
    cachedJwksExpiry = now + safeMaxAgeMs;

    return keys;
}

/**
 * Verifies a Firebase ID token. Returns the decoded payload on success.
 * Throws a plain Error with a short machine-readable message on any failure.
 *
 * Checks performed:
 *   - Structure (three segments)
 *   - Algorithm (must be RS256)
 *   - Signature (against the matching JWK)
 *   - exp and iat within clock skew
 *   - Issuer matches the project
 *   - Audience matches the project
 *   - Subject is a non-empty string
 */
async function verifyFirebaseIdToken(idToken, projectId) {
    if (typeof idToken !== 'string' || idToken.length === 0) {
        throw new Error('empty_token');
    }
    if (typeof projectId !== 'string' || projectId.length === 0) {
        throw new Error('project_id_missing');
    }

    const parts = idToken.split('.');
    if (parts.length !== 3) {
        throw new Error('malformed_token');
    }

    const [headerB64, payloadB64, signatureB64] = parts;

    let header;
    try {
        header = JSON.parse(base64urlDecodeToString(headerB64));
    } catch (_e) {
        throw new Error('invalid_header');
    }

    if (!header || header.alg !== 'RS256') {
        throw new Error('unsupported_algorithm');
    }

    const jwks = await getFirebaseJwks();
    const jwk = jwks.find((k) => k && k.kid === header.kid);
    if (!jwk) {
        throw new Error('unknown_kid');
    }

    const cryptoKey = await crypto.subtle.importKey(
        'jwk',
        {
            kty: jwk.kty,
            n: jwk.n,
            e: jwk.e,
            alg: 'RS256',
            use: 'sig',
            ext: true,
        },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify']
    );

    const signatureBytes = base64urlDecodeToBytes(signatureB64);
    const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

    const signatureValid = await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        cryptoKey,
        signatureBytes,
        signedData
    );

    if (!signatureValid) {
        throw new Error('invalid_signature');
    }

    let payload;
    try {
        payload = JSON.parse(base64urlDecodeToString(payloadB64));
    } catch (_e) {
        throw new Error('invalid_payload');
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const clockSkewSec = 60;

    if (typeof payload.exp !== 'number' || payload.exp < nowSec - clockSkewSec) {
        throw new Error('token_expired');
    }
    if (typeof payload.iat !== 'number' || payload.iat > nowSec + clockSkewSec) {
        throw new Error('invalid_issued_at');
    }
    if (payload.iss !== `https://securetoken.google.com/${projectId}`) {
        throw new Error('invalid_issuer');
    }
    if (payload.aud !== projectId) {
        throw new Error('invalid_audience');
    }
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
        throw new Error('invalid_subject');
    }

    return payload;
}

/* ============================================================================
 * 6. Service account — OAuth2 access token
 * ========================================================================= */

let cachedAccessToken = null;
let cachedAccessTokenExpiry = 0;
let cachedPrivateKey = null;
let cachedPrivateKeyPem = '';

async function getServiceAccountAccessToken(env) {
    const now = Date.now();
    if (cachedAccessToken && now < cachedAccessTokenExpiry) {
        return cachedAccessToken;
    }

    // The service account is stored as a single Cloudflare Secret named
    // FIREBASE_SERVICE_ACCOUNT_JSON, containing the full JSON that Firebase
    // issues when a new private key is generated. We parse it here to
    // extract the client email and private key. This avoids duplicating the
    // same credential across two secrets and keeps the deployment simple.
    const rawJson = env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (typeof rawJson !== 'string' || rawJson.length === 0) {
        throw new Error('service_account_json_missing');
    }

    let serviceAccount;
    try {
        serviceAccount = JSON.parse(rawJson);
    } catch (_e) {
        throw new Error('service_account_json_invalid');
    }

    const email = serviceAccount && typeof serviceAccount.client_email === 'string'
        ? serviceAccount.client_email
        : '';
    const privateKeyPem = serviceAccount && typeof serviceAccount.private_key === 'string'
        ? serviceAccount.private_key
        : '';

    if (!email) {
        throw new Error('service_account_email_missing');
    }
    if (!privateKeyPem) {
        throw new Error('service_account_key_missing');
    }

    const privateKey = await getServiceAccountPrivateKey(privateKeyPem);

    const iat = Math.floor(now / 1000);
    const exp = iat + 3600;

    const jwtHeader = { alg: 'RS256', typ: 'JWT' };
    const jwtPayload = {
        iss: email,
        scope: SERVICE_ACCOUNT_SCOPES,
        aud: GOOGLE_TOKEN_URL,
        iat: iat,
        exp: exp,
    };

    const assertion = await signJwt(jwtHeader, jwtPayload, privateKey);

    const body = new URLSearchParams();
    body.set('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    body.set('assertion', assertion);

    const res = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    });

    if (!res.ok) {
        throw new Error('service_account_exchange_failed');
    }

    const data = await res.json();
    if (!data || typeof data.access_token !== 'string' || data.access_token.length === 0) {
        throw new Error('service_account_no_token');
    }

    cachedAccessToken = data.access_token;
    const expiresInSec = typeof data.expires_in === 'number' ? data.expires_in : 3600;
    // Refresh 5 minutes before expiry to avoid edge-of-expiry failures.
    cachedAccessTokenExpiry = now + Math.max(60000, (expiresInSec - 300) * 1000);

    return cachedAccessToken;
}

async function getServiceAccountPrivateKey(privateKeyPem) {
    if (cachedPrivateKey && cachedPrivateKeyPem === privateKeyPem) {
        return cachedPrivateKey;
    }

    // Normalize escaped newlines that may have been preserved when the secret
    // was entered through the Cloudflare dashboard or via `wrangler secret put`.
    const normalizedPem = privateKeyPem.replace(/\\n/g, '\n');

    const base64 = normalizedPem
        .replace(/-----BEGIN [^-]*-----/g, '')
        .replace(/-----END [^-]*-----/g, '')
        .replace(/\s+/g, '');

    if (base64.length === 0) {
        throw new Error('service_account_key_invalid');
    }

    let bytes;
    try {
        const binary = atob(base64);
        bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
    } catch (_e) {
        throw new Error('service_account_key_invalid');
    }

    let key;
    try {
        key = await crypto.subtle.importKey(
            'pkcs8',
            bytes.buffer,
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            false,
            ['sign']
        );
    } catch (_e) {
        throw new Error('service_account_key_import_failed');
    }

    cachedPrivateKey = key;
    cachedPrivateKeyPem = privateKeyPem;
    return key;
}

async function signJwt(header, payload, privateKey) {
    const headerB64 = base64urlEncodeString(JSON.stringify(header));
    const payloadB64 = base64urlEncodeString(JSON.stringify(payload));
    const signingInput = `${headerB64}.${payloadB64}`;

    const signatureBuffer = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        privateKey,
        new TextEncoder().encode(signingInput)
    );

    const signatureB64 = base64urlEncodeBytes(new Uint8Array(signatureBuffer));
    return `${signingInput}.${signatureB64}`;
}

/* ----------------------------------------------------------------------------
 * Firebase Authentication Admin API
 *
 * Create users without a password. The user sets their own password via a
 * Firebase password reset link sent to their email. The admin never knows
 * or stores any password.
 *
 * All endpoints use the service account OAuth2 token. The service account
 * must have the Firebase Authentication Admin role.
 * ------------------------------------------------------------------------- */

const IDENTITY_TOOLKIT_BASE = 'https://identitytoolkit.googleapis.com/v1';

async function createFirebaseAuthUser(env, email, displayName) {
    const projectId = env.FIREBASE_PROJECT_ID;
    if (!projectId) throw new Error('project_id_missing');

    const accessToken = await getServiceAccountAccessToken(env);

    const url = `${IDENTITY_TOOLKIT_BASE}/projects/${encodeURIComponent(projectId)}/accounts`;
    const body = {
        email: email,
        displayName: displayName || '',
        emailVerified: false,
        disabled: false,
    };

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const text = await res.text();
        let errCode = 'unknown';
        try {
            const parsed = JSON.parse(text);
            errCode = (parsed && parsed.error && parsed.error.message) || 'unknown';
        } catch (_e) { /* noop */ }

        if (errCode === 'EMAIL_EXISTS') throw new Error('email_already_exists');
        throw new Error('firebase_user_create_failed');
    }

    const data = await res.json();
    if (!data || typeof data.localId !== 'string' || data.localId.length === 0) {
        throw new Error('firebase_user_create_no_uid');
    }

    return {
        uid: data.localId,
        email: data.email || email,
    };
}

async function sendPasswordResetEmail(env, email) {
    const apiKey = env.FIREBASE_WEB_API_KEY;
    if (!apiKey) throw new Error('web_api_key_missing');

    const url = `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${encodeURIComponent(apiKey)}`;
    const body = {
        requestType: 'PASSWORD_RESET',
        email: email,
    };

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        let errCode = 'unknown';
        try {
            const parsed = await res.json();
            errCode = (parsed && parsed.error && parsed.error.message) || 'unknown';
        } catch (_e) { /* noop */ }

        if (errCode === 'EMAIL_NOT_FOUND') throw new Error('user_not_found');
        throw new Error('password_reset_email_failed');
    }

    const data = await res.json();
    return { email: data.email || email };
}

async function disableFirebaseAuthUser(env, uid) {
    return updateFirebaseAuthUser(env, uid, { disabled: true });
}

async function enableFirebaseAuthUser(env, uid) {
    return updateFirebaseAuthUser(env, uid, { disabled: false });
}

async function updateFirebaseAuthUser(env, uid, props) {
    const projectId = env.FIREBASE_PROJECT_ID;
    if (!projectId) throw new Error('project_id_missing');

    const accessToken = await getServiceAccountAccessToken(env);
    const url = `${IDENTITY_TOOLKIT_BASE}/projects/${encodeURIComponent(projectId)}/accounts:update`;
    const body = Object.assign({ localId: uid }, props);

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error('firebase_user_update_failed');
    return res.json();
}

async function deleteFirebaseAuthUser(env, uid) {
    const projectId = env.FIREBASE_PROJECT_ID;
    if (!projectId) throw new Error('project_id_missing');

    const accessToken = await getServiceAccountAccessToken(env);
    const url = `${IDENTITY_TOOLKIT_BASE}/projects/${encodeURIComponent(projectId)}/accounts:delete`;

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ localId: uid }),
    });

    if (!res.ok) throw new Error('firebase_user_delete_failed');
    return true;
}

/* ============================================================================
 * 7. Realtime Database access helpers
 * ========================================================================= */

async function rtdbFetch(env, accessToken, path, init) {
    const dbUrl = env.FIREBASE_DATABASE_URL;
    if (typeof dbUrl !== 'string' || dbUrl.length === 0) {
        throw new Error('database_url_missing');
    }

    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const base = dbUrl.replace(/\/+$/, '');
    const url = `${base}${normalizedPath}.json`;

    const headers = new Headers(init && init.headers ? init.headers : {});
    headers.set('Authorization', `Bearer ${accessToken}`);

    const res = await fetch(url, { ...(init || {}), headers });

    if (!res.ok) {
        throw new Error(`rtdb_request_failed:${res.status}`);
    }

    if (res.status === 204) {
        return null;
    }

    const text = await res.text();
    if (!text) {
        return null;
    }

    try {
        return JSON.parse(text);
    } catch (_e) {
        return null;
    }
}

async function rtdbGet(env, token, path) {
    return rtdbFetch(env, token, path, { method: 'GET' });
}

async function rtdbQuery(env, token, path, params) {
    const dbUrl = env.FIREBASE_DATABASE_URL;
    if (typeof dbUrl !== 'string' || dbUrl.length === 0) {
        throw new Error('database_url_missing');
    }
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const base = dbUrl.replace(/\/+$/, '');
    const url = new URL(`${base}${normalizedPath}.json`);

    if (params && typeof params === 'object') {
        for (const [key, value] of Object.entries(params)) {
            url.searchParams.append(key, JSON.stringify(value));
        }
    }

    const res = await fetch(url.toString(), {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!res.ok) {
        throw new Error(`rtdb_query_failed:${res.status}`);
    }

    const text = await res.text();
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch (_e) {
        return null;
    }
}

async function rtdbSet(env, token, path, value) {
    return rtdbFetch(env, token, path, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
    });
}

/* ============================================================================
 * 8. Authorization context
 * ========================================================================= */

/**
 * Loads the authenticated user's authorization context from the database.
 *
 * Returns either:
 *   { ok: true, context: { uid, email, role, orgId, employeeId, displayName } }
 * or
 *   { ok: false, code: 'forbidden' | 'server_error', reason: string }
 */
async function resolveAuthContext(env, decodedToken) {
    const uid = decodedToken.sub;
    if (typeof uid !== 'string' || uid.length === 0) {
        return { ok: false, code: 'unauthorized', reason: 'invalid_subject' };
    }

    let accessToken;
    try {
        accessToken = await getServiceAccountAccessToken(env);
    } catch (_err) {
        return { ok: false, code: 'server_error', reason: 'service_account_unavailable' };
    }

    let userRecord;
    try {
        userRecord = await rtdbGet(env, accessToken, `/users/${encodeURIComponent(uid)}`);
    } catch (_err) {
        return { ok: false, code: 'server_error', reason: 'database_unavailable' };
    }

    if (!userRecord || typeof userRecord !== 'object' || Array.isArray(userRecord)) {
        return { ok: false, code: 'forbidden', reason: 'not_provisioned' };
    }

    if (userRecord.enabled === false) {
        return { ok: false, code: 'forbidden', reason: 'account_disabled' };
    }

    const role = typeof userRecord.role === 'string' ? userRecord.role : '';
    if (!VALID_ROLES.includes(role)) {
        return { ok: false, code: 'forbidden', reason: 'invalid_role' };
    }

    // Activation status check. Accounts created through the invitation flow
    // start with activationStatus = "pending". They become active only after
    // the user has proven email ownership by completing the Firebase
    // password reset flow, at which point Firebase sets emailVerified = true
    // on the account. The Firebase maintainers confirm this behavior:
    // resetting the password via an email action sets emailVerified to true.
    //
    // The Worker trusts its own activationStatus field as the authoritative
    // gate. Firebase's emailVerified flag is consulted only as the trigger
    // that flips the status from pending to active. This keeps the business
    // rule under our control even if Firebase's behavior changes.
    let activationStatus = typeof userRecord.activationStatus === 'string'
        ? userRecord.activationStatus
        : 'active';

    if (activationStatus === 'pending') {
        // If Firebase reports the email as verified, the user has completed
        // the password reset. Promote the account to active on the fly, so
        // the very next request succeeds.
        if (decodedToken.email_verified === true) {
            activationStatus = 'active';
            try {
                const now = new Date().toISOString();
                await rtdbSet(env, accessToken, `/users/${encodeURIComponent(uid)}/activationStatus`, 'active');
                await rtdbSet(env, accessToken, `/users/${encodeURIComponent(uid)}/activatedAt`, now);
                if (userRecord.employeeId) {
                    await rtdbSet(env, accessToken, `/employees/${encodeURIComponent(userRecord.employeeId)}/activationStatus`, 'active');
                    await rtdbSet(env, accessToken, `/employees/${encodeURIComponent(userRecord.employeeId)}/activatedAt`, now);
                }
            } catch (_e) {
                // Promotion write failed. The account remains pending for
                // this request; the next request will retry. We do not
                // block the request on this write, because the user has
                // already proven email ownership.
            }
        } else {
            return { ok: false, code: 'forbidden', reason: 'activation_pending' };
        }
    }

    return {
        ok: true,
        context: {
            uid: uid,
            email: typeof userRecord.email === 'string' ? userRecord.email : (decodedToken.email || ''),
            role: role,
            orgId: typeof userRecord.orgId === 'string' ? userRecord.orgId : null,
            employeeId: typeof userRecord.employeeId === 'string' ? userRecord.employeeId : null,
            displayName: typeof userRecord.displayName === 'string' ? userRecord.displayName : '',
            activationStatus: activationStatus,
        },
    };
}

/**
 * Extracts and verifies the Bearer token from the Authorization header.
 * Returns the decoded payload, or null if verification failed.
 */
async function authenticateRequest(request, env) {
    const header = request.headers.get('Authorization') || '';
    if (!header.startsWith('Bearer ')) {
        return { ok: false, reason: 'missing_token' };
    }
    const idToken = header.slice('Bearer '.length).trim();
    if (!idToken) {
        return { ok: false, reason: 'empty_token' };
    }
    try {
        const decoded = await verifyFirebaseIdToken(idToken, env.FIREBASE_PROJECT_ID);
        return { ok: true, decoded: decoded };
    } catch (err) {
        return { ok: false, reason: (err && err.message) || 'verification_failed' };
    }
}

/* ============================================================================
 * 9. Rate limiting (best-effort, per isolate)
 * ========================================================================= */

const rateLimitStore = new Map();

function checkRateLimit(key) {
    const now = Date.now();
    const entry = rateLimitStore.get(key);

    if (!entry || now >= entry.resetAt) {
        rateLimitStore.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
        return true;
    }

    entry.count += 1;
    if (entry.count > RATE_LIMIT_MAX_REQUESTS) {
        return false;
    }
    return true;
}

/* ============================================================================
 * 10. Request body reading
 * ========================================================================= */

async function readJsonBody(request) {
    const contentLength = request.headers.get('Content-Length');
    if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
        return { ok: false, reason: 'body_too_large' };
    }
    let text;
    try {
        text = await request.text();
    } catch (_e) {
        return { ok: false, reason: 'body_read_failed' };
    }
    if (text.length > MAX_BODY_BYTES) {
        return { ok: false, reason: 'body_too_large' };
    }
    if (text.length === 0) {
        return { ok: true, data: null };
    }
    try {
        const data = JSON.parse(text);
        return { ok: true, data: data };
    } catch (_e) {
        return { ok: false, reason: 'invalid_json' };
    }
}

/* ============================================================================
 * 11. Public configuration
 * ========================================================================= */

function readPublicConfig(env) {
    const raw = {
        apiKey:             env.FIREBASE_WEB_API_KEY,
        authDomain:         env.FIREBASE_AUTH_DOMAIN,
        projectId:          env.FIREBASE_PROJECT_ID,
        appId:              env.FIREBASE_APP_ID,
        databaseURL:        env.FIREBASE_DATABASE_URL,
        storageBucket:      env.FIREBASE_STORAGE_BUCKET,
        messagingSenderId:  env.FIREBASE_MESSAGING_SENDER_ID,
        measurementId:      env.FIREBASE_MEASUREMENT_ID,
    };

    const config = {};
    for (const [key, value] of Object.entries(raw)) {
        if (typeof value === 'string' && value.length > 0) {
            config[key] = value;
        }
    }
    return config;
}

/* ============================================================================
 * 12. Route handlers
 * ========================================================================= */

function handleHealth(requestId, corsHeaders) {
    return jsonResponse(
        { status: 'ok', time: new Date().toISOString() },
        200,
        corsHeaders,
        requestId
    );
}

function handlePublicConfig(env, requestId, corsHeaders) {
    const config = readPublicConfig(env);

    // Minimal sanity check: without these, the frontend cannot initialize
    // Firebase Authentication. We prefer to fail loudly here rather than
    // serve a config that will crash the login page.
    const required = ['apiKey', 'authDomain', 'projectId', 'appId', 'databaseURL'];
    const missing = required.filter((k) => !(k in config));
    if (missing.length > 0) {
        return errorResponse('server_error', 500, corsHeaders, requestId);
    }

    return jsonResponse(config, 200, corsHeaders, requestId);
}

async function handleAuthContext(request, env, requestId, corsHeaders) {
    const auth = await authenticateRequest(request, env);
    if (!auth.ok) {
        return errorResponse('unauthorized', 401, corsHeaders, requestId);
    }

    const resolved = await resolveAuthContext(env, auth.decoded);
    if (!resolved.ok) {
        if (resolved.code === 'server_error') {
            return errorResponse('server_error', 500, corsHeaders, requestId);
        }
        // Not provisioned or account disabled are authorization failures from
        // the caller's perspective; the response code is the same either way,
        // and the frontend treats a 403 on /auth/context as "you cannot enter
        // the application" without needing to know the specific reason.
        return errorResponse('forbidden', 403, corsHeaders, requestId);
    }

    return jsonResponse(resolved.context, 200, corsHeaders, requestId);
}

/**
 * One-time bootstrap endpoint.
 *
 * Creates users/{uid} with role=super_admin for the CALLER, but ONLY if no
 * super_admin exists anywhere in the database. Once a super_admin exists,
 * this endpoint returns 409 forever.
 *
 * This satisfies the "controlled administrative setup" requirement without
 * opening public self-registration: the caller must already possess a valid
 * Firebase Authentication session (which itself requires you to have created
 * the account in the Firebase console), and the endpoint self-disables the
 * moment the first super_admin is created.
 */
async function handleAdminBootstrap(request, env, requestId, corsHeaders) {
    const auth = await authenticateRequest(request, env);
    if (!auth.ok) {
        return errorResponse('unauthorized', 401, corsHeaders, requestId);
    }

    const uid = auth.decoded.sub;
    const email = typeof auth.decoded.email === 'string' ? auth.decoded.email : '';

    let accessToken;
    try {
        accessToken = await getServiceAccountAccessToken(env);
    } catch (_err) {
        return errorResponse('server_error', 500, corsHeaders, requestId);
    }

    // Check whether any super_admin already exists.
    let existing;
    try {
        existing = await rtdbQuery(env, accessToken, '/users', {
            orderBy: 'role',
            equalTo: 'super_admin',
        });
    } catch (_err) {
        return errorResponse('server_error', 500, corsHeaders, requestId);
    }

    if (existing && typeof existing === 'object' && Object.keys(existing).length > 0) {
        return errorResponse('conflict', 409, corsHeaders, requestId);
    }

    // Check whether the caller already has a user record; if so, refuse to
    // overwrite it silently.
    let callerRecord;
    try {
        callerRecord = await rtdbGet(env, accessToken, `/users/${encodeURIComponent(uid)}`);
    } catch (_err) {
        return errorResponse('server_error', 500, corsHeaders, requestId);
    }

    if (callerRecord && typeof callerRecord === 'object') {
        return errorResponse('conflict', 409, corsHeaders, requestId);
    }

    const now = new Date().toISOString();
    const record = {
        uid: uid,
        email: email,
        role: 'super_admin',
        orgId: null,
        employeeId: null,
        displayName: '',
        enabled: true,
        createdAt: now,
        updatedAt: now,
        createdBy: uid,
    };

    try {
        await rtdbSet(env, accessToken, `/users/${encodeURIComponent(uid)}`, record);
    } catch (_err) {
        return errorResponse('server_error', 500, corsHeaders, requestId);
    }

    return jsonResponse(record, 201, corsHeaders, requestId);
}

/* ----------------------------------------------------------------------------
 * Dashboard summary
 *
 * Role-specific summary data for the dashboard module. Admins receive
 * organization-wide counts. Employees receive their own summary only.
 *
 * The endpoint returns zeros and empty arrays when the database has no data.
 * It never fabricates counts, totals, or activity entries.
 * ------------------------------------------------------------------------- */

async function handleDashboardSummary(request, env, requestId, corsHeaders) {
    const auth = await authenticateRequest(request, env);
    if (!auth.ok) {
        return errorResponse('unauthorized', 401, corsHeaders, requestId);
    }

    const resolved = await resolveAuthContext(env, auth.decoded);
    if (!resolved.ok) {
        if (resolved.code === 'server_error') {
            return errorResponse('server_error', 500, corsHeaders, requestId);
        }
        return errorResponse('forbidden', 403, corsHeaders, requestId);
    }

    const ctx = resolved.context;

    let accessToken;
    try {
        accessToken = await getServiceAccountAccessToken(env);
    } catch (_err) {
        return errorResponse('server_error', 500, corsHeaders, requestId);
    }

    try {
        const summary = (ctx.role === 'employee')
            ? await buildEmployeeSummary(env, accessToken, ctx)
            : await buildAdminSummary(env, accessToken, ctx);
        return jsonResponse(summary, 200, corsHeaders, requestId);
    } catch (_err) {
        return errorResponse('server_error', 500, corsHeaders, requestId);
    }
}

async function buildAdminSummary(env, accessToken, ctx) {
    const generatedAt = new Date().toISOString();
    const today = isoDateUTC();
    const currentPeriod = today.slice(0, 7);
    const currentYear = today.slice(0, 4);

    // --- Employees --------------------------------------------------------
    let employees = {};
    try {
        const raw = await rtdbGet(env, accessToken, '/employees');
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            employees = raw;
        }
    } catch (_e) { /* leave empty */ }

    const employeeIds = Object.keys(employees);
    let activeEmployees = 0;
    let inactiveEmployees = 0;
    for (const id of employeeIds) {
        const rec = employees[id];
        if (!rec || typeof rec !== 'object') continue;
        const status = String(rec.status || '').toLowerCase();
        if (status === 'active') activeEmployees += 1;
        else if (status === 'inactive') inactiveEmployees += 1;
    }

    // --- Attendance today -------------------------------------------------
    // Small organisations: fetch per-employee for the current date.
    // Larger deployments should add a date-indexed node. See note in the
    // project README under "Known limitations".
    const attendanceToday = await countAttendanceForDate(env, accessToken, employeeIds, today);

    // --- Pending leave ----------------------------------------------------
    let leavePendingCount = 0;
    try {
        const raw = await rtdbGet(env, accessToken, '/leaveRequests');
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            for (const id of Object.keys(raw)) {
                const rec = raw[id];
                if (rec && typeof rec === 'object' && String(rec.status || '').toLowerCase() === 'pending') {
                    leavePendingCount += 1;
                }
            }
        }
    } catch (_e) { /* leave zero */ }

    // --- Current period payroll run --------------------------------------
    let payrollCurrent = null;
    try {
        const raw = await rtdbGet(env, accessToken, '/payrollRuns');
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            for (const id of Object.keys(raw)) {
                const run = raw[id];
                if (!run || typeof run !== 'object') continue;
                if (String(run.period || '') !== currentPeriod) continue;
                payrollCurrent = {
                    runId: String(run.runId || id),
                    period: currentPeriod,
                    status: String(run.status || 'draft'),
                    employeeCount: Number(run.employeeCount) || 0,
                    totalNetMinor: (run.totals && Number(run.totals.net)) || 0,
                    totalGrossMinor: (run.totals && Number(run.totals.gross)) || 0,
                };
                break;
            }
        }
    } catch (_e) { /* leave null */ }

    // --- Recent activity --------------------------------------------------
    // Fetches the auditLogs node and sorts client-side. For a first release
    // this is acceptable; if the audit log grows, an indexed query with
    // limitToLast will replace this. See "Known limitations" in the README.
    let recentActivity = [];
    try {
        const raw = await rtdbGet(env, accessToken, '/auditLogs');
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            const entries = Object.values(raw)
                .filter((l) => l && typeof l === 'object' && typeof l.timestamp === 'string')
                .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
                .slice(0, 10);
            recentActivity = entries.map((l) => ({
                action: String(l.action || ''),
                target: String(l.target || ''),
                targetId: String(l.targetId || ''),
                actorRole: String(l.actorRole || ''),
                timestamp: String(l.timestamp || ''),
            }));
        }
    } catch (_e) { /* leave empty */ }

    return {
        role: ctx.role,
        generatedAt,
        period: currentPeriod,
        year: currentYear,
        employees: {
            total: employeeIds.length,
            active: activeEmployees,
            inactive: inactiveEmployees,
        },
        attendanceToday: {
            date: today,
            present: attendanceToday.present,
            absent: attendanceToday.absent,
            leave: attendanceToday.leave,
            notMarked: attendanceToday.notMarked,
        },
        leavePending: { count: leavePendingCount },
        payrollCurrent,
        recentActivity,
    };
}

async function countAttendanceForDate(env, accessToken, employeeIds, date) {
    // Bounded concurrency so a large employee roster does not open
    // hundreds of simultaneous RTDB requests from a single isolate.
    const CONCURRENCY = 20;
    let present = 0;
    let absent = 0;
    let leave = 0;
    let notMarked = 0;

    for (let i = 0; i < employeeIds.length; i += CONCURRENCY) {
        const batch = employeeIds.slice(i, i + CONCURRENCY);
        const results = await Promise.all(batch.map(async (id) => {
            try {
                return await rtdbGet(env, accessToken, `/attendance/${encodeURIComponent(id)}/${date}`);
            } catch (_e) {
                return null;
            }
        }));

        for (const rec of results) {
            if (!rec || typeof rec !== 'object') {
                notMarked += 1;
                continue;
            }
            const status = String(rec.status || '').toLowerCase();
            if (status === 'present') present += 1;
            else if (status === 'absent') absent += 1;
            else if (status === 'leave') leave += 1;
            else notMarked += 1;
        }
    }

    return { present, absent, leave, notMarked };
}

async function buildEmployeeSummary(env, accessToken, ctx) {
    const generatedAt = new Date().toISOString();
    const today = isoDateUTC();
    const currentPeriod = today.slice(0, 7);
    const currentYear = today.slice(0, 4);

    if (!ctx.employeeId) {
        return {
            role: 'employee',
            generatedAt,
            period: currentPeriod,
            year: currentYear,
            myEmployee: null,
            myAttendance: { month: currentPeriod, present: 0, absent: 0, leave: 0 },
            myLeaveBalance: {},
            myLatestPayslip: null,
        };
    }

    const employeeId = ctx.employeeId;

    let myEmployee = null;
    try {
        const rec = await rtdbGet(env, accessToken, `/employees/${encodeURIComponent(employeeId)}`);
        if (rec && typeof rec === 'object') {
            myEmployee = {
                employeeId,
                employeeCode: String(rec.employeeCode || ''),
                firstName: String(rec.firstName || ''),
                lastName: String(rec.lastName || ''),
                departmentId: rec.departmentId ? String(rec.departmentId) : null,
                designationId: rec.designationId ? String(rec.designationId) : null,
                status: String(rec.status || ''),
            };
        }
    } catch (_e) { /* leave null */ }

    let attendance = { present: 0, absent: 0, leave: 0 };
    try {
        const raw = await rtdbGet(env, accessToken, `/attendance/${encodeURIComponent(employeeId)}`);
        if (raw && typeof raw === 'object') {
            for (const dateKey of Object.keys(raw)) {
                if (!dateKey.startsWith(currentPeriod + '-')) continue;
                const rec = raw[dateKey];
                if (!rec || typeof rec !== 'object') continue;
                const status = String(rec.status || '').toLowerCase();
                if (status === 'present') attendance.present += 1;
                else if (status === 'absent') attendance.absent += 1;
                else if (status === 'leave') attendance.leave += 1;
            }
        }
    } catch (_e) { /* leave zeros */ }

    let myLeaveBalance = {};
    try {
        const raw = await rtdbGet(env, accessToken, `/leaveBalances/${encodeURIComponent(employeeId)}/${currentYear}`);
        if (raw && typeof raw === 'object') {
            for (const type of Object.keys(raw)) {
                const b = raw[type];
                if (!b || typeof b !== 'object') continue;
                myLeaveBalance[type] = {
                    allocated: Number(b.allocated) || 0,
                    used: Number(b.used) || 0,
                    remaining: Number(b.remaining) || 0,
                };
            }
        }
    } catch (_e) { /* leave empty */ }

    let myLatestPayslip = null;
    try {
        const raw = await rtdbGet(env, accessToken, '/payslips');
        if (raw && typeof raw === 'object') {
            const mine = Object.values(raw)
                .filter((s) => s && typeof s === 'object' && s.employeeId === employeeId)
                .sort((a, b) => String(b.period || '').localeCompare(String(a.period || '')));
            const latest = mine[0];
            if (latest) {
                myLatestPayslip = {
                    payslipId: String(latest.payslipId || ''),
                    period: String(latest.period || ''),
                    netMinor: Number(latest.net) || 0,
                    issuedAt: String(latest.issuedAt || ''),
                };
            }
        }
    } catch (_e) { /* leave null */ }

    return {
        role: 'employee',
        generatedAt,
        period: currentPeriod,
        year: currentYear,
        myEmployee,
        myAttendance: {
            month: currentPeriod,
            present: attendance.present,
            absent: attendance.absent,
            leave: attendance.leave,
        },
        myLeaveBalance,
        myLatestPayslip,
    };
}

function isoDateUTC() {
    const d = new Date();
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/* ----------------------------------------------------------------------------
 * Common authorization helper
 *
 * Every protected endpoint runs the same sequence: extract the Bearer token,
 * verify it, resolve the authoritative context. This helper centralizes that
 * sequence so a missing check is impossible.
 * ------------------------------------------------------------------------- */

async function requireAuth(request, env, corsHeaders, requestId) {
    const auth = await authenticateRequest(request, env);
    if (!auth.ok) {
        return { ok: false, response: errorResponse('unauthorized', 401, corsHeaders, requestId) };
    }
    const resolved = await resolveAuthContext(env, auth.decoded);
    if (!resolved.ok) {
        if (resolved.code === 'server_error') {
            return { ok: false, response: errorResponse('server_error', 500, corsHeaders, requestId) };
        }
        return { ok: false, response: errorResponse('forbidden', 403, corsHeaders, requestId) };
    }
    return { ok: true, context: resolved.context };
}

function isAdmin(role) {
    return role === 'super_admin' || role === 'hr_admin';
}

/* ----------------------------------------------------------------------------
 * Employees — validation and shaping
 * ------------------------------------------------------------------------- */

const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'intern'];
const EMPLOYEE_STATUSES = ['active', 'inactive', 'terminated'];
const GENDERS = ['male', 'female', 'other'];

const MAX_NAME_LEN = 80;
const MAX_CODE_LEN = 40;
const MAX_TEXT_LEN = 250;

function isString(v) { return typeof v === 'string'; }

function normalizeOptionalString(v, maxLen) {
    if (v === null || v === undefined) return '';
    if (typeof v !== 'string') return '';
    const s = v.trim();
    if (s.length === 0) return '';
    return s.slice(0, maxLen);
}

function isValidEmailFormat(v) {
    return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

function isValidISODate(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    const d = new Date(v + 'T00:00:00Z');
    return !isNaN(d.getTime());
}

/**
 * Validates an employee payload. Returns:
 *   { ok: true, cleaned: <record-shaped object> }
 *   { ok: false, errors: { fieldName: 'message', ... } }
 *
 * When { partial: true } is set, missing fields are allowed. When false,
 * required fields must be present.
 */
function validateEmployeePayload(body, options) {
    const partial = !!(options && options.partial);
    const errors = {};
    const cleaned = {};

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { ok: false, errors: { _root: 'Request body must be a JSON object.' } };
    }

    function requireField(name) {
        if (!partial && (body[name] === undefined || body[name] === null || body[name] === '')) {
            errors[name] = 'This field is required.';
            return false;
        }
        return true;
    }

    // First name
    if (requireField('firstName') || body.firstName !== undefined) {
        const v = normalizeOptionalString(body.firstName, MAX_NAME_LEN);
        if (!v) errors.firstName = 'First name is required.';
        else cleaned.firstName = v;
    }

    // Last name
    if (body.lastName !== undefined) {
        cleaned.lastName = normalizeOptionalString(body.lastName, MAX_NAME_LEN);
    } else if (!partial) {
        cleaned.lastName = '';
    }

    // Email
    if (requireField('email') || body.email !== undefined) {
        const v = normalizeOptionalString(body.email, MAX_TEXT_LEN);
        if (!v) errors.email = 'Email is required.';
        else if (!isValidEmailFormat(v)) errors.email = 'Enter a valid email address.';
        else cleaned.email = v.toLowerCase();
    }

    // Phone
    if (body.phone !== undefined) {
        cleaned.phone = normalizeOptionalString(body.phone, 30);
    } else if (!partial) {
        cleaned.phone = '';
    }

    // Date of birth
    if (body.dateOfBirth !== undefined) {
        const v = normalizeOptionalString(body.dateOfBirth, 10);
        if (v && !isValidISODate(v)) errors.dateOfBirth = 'Date of birth must be YYYY-MM-DD.';
        else cleaned.dateOfBirth = v;
    } else if (!partial) {
        cleaned.dateOfBirth = '';
    }

    // Gender
    if (body.gender !== undefined) {
        const v = normalizeOptionalString(body.gender, 20).toLowerCase();
        if (v && !GENDERS.includes(v)) errors.gender = 'Select a valid gender.';
        else cleaned.gender = v;
    } else if (!partial) {
        cleaned.gender = '';
    }

    // Address
    if (body.address !== undefined) {
        cleaned.address = normalizeOptionalString(body.address, MAX_TEXT_LEN);
    } else if (!partial) {
        cleaned.address = '';
    }

    // Emergency contact
    if (body.emergencyContact !== undefined) {
        cleaned.emergencyContact = normalizeOptionalString(body.emergencyContact, MAX_TEXT_LEN);
    } else if (!partial) {
        cleaned.emergencyContact = '';
    }

    // Department and designation — treated as opaque IDs. The Administration
    // module is responsible for maintaining the reference data. The Worker
    // does not validate that a referenced department or designation exists,
    // because that would add a database read per write and the reference
    // data is small. A dangling reference is a data quality issue that the
    // Administration module can surface; it is not a security issue.
    if (body.departmentId !== undefined) {
        cleaned.departmentId = normalizeOptionalString(body.departmentId, MAX_CODE_LEN) || null;
    } else if (!partial) {
        cleaned.departmentId = null;
    }
    if (body.designationId !== undefined) {
        cleaned.designationId = normalizeOptionalString(body.designationId, MAX_CODE_LEN) || null;
    } else if (!partial) {
        cleaned.designationId = null;
    }

    // Join date
    if (requireField('joinDate') || body.joinDate !== undefined) {
        const v = normalizeOptionalString(body.joinDate, 10);
        if (!v) errors.joinDate = 'Join date is required.';
        else if (!isValidISODate(v)) errors.joinDate = 'Join date must be YYYY-MM-DD.';
        else cleaned.joinDate = v;
    }

    // Employment type
    if (requireField('employmentType') || body.employmentType !== undefined) {
        const v = normalizeOptionalString(body.employmentType, 20).toLowerCase();
        if (!v) errors.employmentType = 'Employment type is required.';
        else if (!EMPLOYMENT_TYPES.includes(v)) errors.employmentType = 'Select a valid employment type.';
        else cleaned.employmentType = v;
    }

    // Status — defaults to active on create; updatable via dedicated endpoint
    if (body.status !== undefined) {
        const v = normalizeOptionalString(body.status, 20).toLowerCase();
        if (!EMPLOYEE_STATUSES.includes(v)) errors.status = 'Select a valid status.';
        else cleaned.status = v;
    } else if (!partial) {
        cleaned.status = 'active';
    }

    // Employee code — optional. If not provided on create, it is auto-generated.
    if (body.employeeCode !== undefined) {
        const v = normalizeOptionalString(body.employeeCode, MAX_CODE_LEN).toUpperCase();
        if (v && !/^[A-Z0-9-]+$/.test(v)) {
            errors.employeeCode = 'Employee code may contain letters, numbers, and hyphens only.';
        } else {
            cleaned.employeeCode = v;
        }
    }

    // uid — optional link to a Firebase Auth account
    if (body.uid !== undefined) {
        const v = normalizeOptionalString(body.uid, 128);
        cleaned.uid = v || null;
    } else if (!partial) {
        cleaned.uid = null;
    }

    // Bank details — nested object
    if (body.bank !== undefined) {
        const b = body.bank;
        if (b === null) {
            cleaned.bank = { bankName: '', accountNumber: '', ifsc: '' };
        } else if (typeof b !== 'object' || Array.isArray(b)) {
            errors.bank = 'Bank details must be an object.';
        } else {
            cleaned.bank = {
                bankName:      normalizeOptionalString(b.bankName, 100),
                accountNumber: normalizeOptionalString(b.accountNumber, 40),
                ifsc:          normalizeOptionalString(b.ifsc, 20).toUpperCase(),
            };
        }
    } else if (!partial) {
        cleaned.bank = { bankName: '', accountNumber: '', ifsc: '' };
    }

    if (Object.keys(errors).length > 0) {
        return { ok: false, errors };
    }
    return { ok: true, cleaned };
}

function shapeEmployeeListItem(rec) {
    return {
        employeeId:       String(rec.employeeId || ''),
        employeeCode:     String(rec.employeeCode || ''),
        firstName:        String(rec.firstName || ''),
        lastName:         String(rec.lastName || ''),
        email:            String(rec.email || ''),
        departmentId:     rec.departmentId ? String(rec.departmentId) : null,
        designationId:    rec.designationId ? String(rec.designationId) : null,
        status:           String(rec.status || ''),
        joinDate:         String(rec.joinDate || ''),
        employmentType:   String(rec.employmentType || ''),
        uid:              rec.uid ? String(rec.uid) : null,
        activationStatus: String(rec.activationStatus || 'active'),
    };
}

/**
 * Full employee shape. Bank details are included only when the caller is
 * authorized to see them: admins, or the employee viewing their own record.
 */
function shapeEmployeeFull(rec, options) {
    const includeBank = !!(options && options.includeBank);
    const out = Object.assign(shapeEmployeeListItem(rec), {
        phone:            String(rec.phone || ''),
        dateOfBirth:      String(rec.dateOfBirth || ''),
        gender:           String(rec.gender || ''),
        address:          String(rec.address || ''),
        emergencyContact: String(rec.emergencyContact || ''),
        invitedAt:        String(rec.invitedAt || ''),
        activatedAt:      String(rec.activatedAt || ''),
        lastInviteAt:     String(rec.lastInviteAt || ''),
        createdAt:        String(rec.createdAt || ''),
        updatedAt:        String(rec.updatedAt || ''),
        createdBy:        String(rec.createdBy || ''),
        updatedBy:        String(rec.updatedBy || ''),
    });
    if (includeBank) {
        const b = rec.bank && typeof rec.bank === 'object' ? rec.bank : {};
        out.bank = {
            bankName:      String(b.bankName || ''),
            accountNumber: String(b.accountNumber || ''),
            ifsc:          String(b.ifsc || ''),
        };
    }
    return out;
}

function generateEmployeeCode(existingCodes) {
    // Employee codes are generated in the form EMP-YYYY-NNN, where YYYY is
    // the current calendar year (UTC) and NNN is a sequential number that
    // restarts at 001 each year. Example: EMP-2026-001.
    //
    // The sequence is derived from the existing codes for the same year.
    // HR administration operations are rare enough that a concurrent create
    // racing within the same millisecond is acceptable; a future version
    // can move this into a transactional counter.
    const year = String(new Date().getUTCFullYear());
    const prefix = `EMP-${year}-`;
    let maxNum = 0;
    for (const code of existingCodes) {
        const s = String(code || '');
        if (!s.startsWith(prefix)) continue;
        const tail = s.slice(prefix.length);
        if (!/^\d+$/.test(tail)) continue;
        const n = parseInt(tail, 10);
        if (Number.isFinite(n) && n > maxNum) maxNum = n;
    }
    return prefix + String(maxNum + 1).padStart(3, '0');
}

/* ----------------------------------------------------------------------------
 * Employees — handlers
 * ------------------------------------------------------------------------- */

async function handleEmployeesList(request, env, requestId, corsHeaders) {
    const authRes = await requireAuth(request, env, corsHeaders, requestId);
    if (!authRes.ok) return authRes.response;
    const ctx = authRes.context;

    if (!isAdmin(ctx.role)) {
        return errorResponse('forbidden', 403, corsHeaders, requestId);
    }

    let accessToken;
    try {
        accessToken = await getServiceAccountAccessToken(env);
    } catch (_e) {
        return errorResponse('server_error', 500, corsHeaders, requestId);
    }

    let all;
    try {
        all = await rtdbGet(env, accessToken, '/employees');
    } catch (_e) {
        return errorResponse('server_error', 500, corsHeaders, requestId);
    }

    const raw = (all && typeof all === 'object' && !Array.isArray(all)) ? all : {};

    const url = new URL(request.url);
    const search        = (url.searchParams.get('search') || '').trim().toLowerCase();
    const departmentId  = (url.searchParams.get('departmentId') || '').trim();
    const designationId = (url.searchParams.get('designationId') || '').trim();
    const status        = (url.searchParams.get('status') || '').trim().toLowerCase();

    let items = Object.values(raw).filter((r) => r && typeof r === 'object');

    if (search) {
        items = items.filter((r) => {
            const hay = [
                r.firstName, r.lastName, r.email, r.employeeCode,
            ].filter(Boolean).join(' ').toLowerCase();
            return hay.indexOf(search) !== -1;
        });
    }
    if (departmentId)  items = items.filter((r) => String(r.departmentId || '') === departmentId);
    if (designationId) items = items.filter((r) => String(r.designationId || '') === designationId);
    if (status)        items = items.filter((r) => String(r.status || '').toLowerCase() === status);

    items.sort((a, b) => {
        const ac = String(a.employeeCode || '').toUpperCase();
        const bc = String(b.employeeCode || '').toUpperCase();
        if (ac && bc) return ac.localeCompare(bc);
        const an = `${a.firstName || ''} ${a.lastName || ''}`.trim().toLowerCase();
        const bn = `${b.firstName || ''} ${b.lastName || ''}`.trim().toLowerCase();
        return an.localeCompare(bn);
    });

    const page     = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('pageSize') || '25', 10) || 25));
    const total    = items.length;
    const start    = (page - 1) * pageSize;
    const slice    = items.slice(start, start + pageSize);

    return jsonResponse({
        items:    slice.map(shapeEmployeeListItem),
        total:    total,
        page:     page,
        pageSize: pageSize,
    }, 200, corsHeaders, requestId);
}

async function handleEmployeeGet(request, env, requestId, corsHeaders, params) {
    const authRes = await requireAuth(request, env, corsHeaders, requestId);
    if (!authRes.ok) return authRes.response;
    const ctx = authRes.context;

    let targetId = params && params.employeeId ? params.employeeId : '';
    if (targetId === 'me') {
        targetId = ctx.employeeId || '';
    }

    if (!targetId) {
        return errorResponse('not_found', 404, corsHeaders, requestId);
    }

    // Ownership check: an employee may only read their own record.
    const isOwn = ctx.role === 'employee' && ctx.employeeId === targetId;
    if (ctx.role === 'employee' && !isOwn) {
        return errorResponse('forbidden', 403, corsHeaders, requestId);
    }

    let accessToken;
    try {
        accessToken = await getServiceAccountAccessToken(env);
    } catch (_e) {
        return errorResponse('server_error', 500, corsHeaders, requestId);
    }

    let record;
    try {
        record = await rtdbGet(env, accessToken, `/employees/${encodeURIComponent(targetId)}`);
    } catch (_e) {
        return errorResponse('server_error', 500, corsHeaders, requestId);
    }

    if (!record || typeof record !== 'object') {
        return errorResponse('not_found', 404, corsHeaders, requestId);
    }

    const includeBank = isAdmin(ctx.role) || isOwn;
    return jsonResponse(shapeEmployeeFull(record, { includeBank }), 200, corsHeaders, requestId);
}

async function handleEmployeeCreate(request, env, requestId, corsHeaders) {
    const authRes = await requireAuth(request, env, corsHeaders, requestId);
    if (!authRes.ok) return authRes.response;
    const ctx = authRes.context;

    if (!isAdmin(ctx.role)) {
        return errorResponse('forbidden', 403, corsHeaders, requestId);
    }

    const body = await readJsonBody(request);
    if (!body.ok) {
        return errorResponse('bad_request', 400, corsHeaders, requestId);
    }

    const validated = validateEmployeePayload(body.data, { partial: false });
    if (!validated.ok) {
        return errorResponse('validation_failed', 422, corsHeaders, requestId, {
            fields: validated.errors,
        });
    }
    const clean = validated.cleaned;

    // Optional flag. Default true: onboarding is the standard flow. Admin
    // may pass sendInvite: false when migrating existing data, in which case
    // no Firebase Auth account is created and no email is sent.
    const sendInvite = !(body.data && body.data.sendInvite === false);

    let accessToken;
    try {
        accessToken = await getServiceAccountAccessToken(env);
    } catch (_e) {
        return errorResponse('server_error', 500, corsHeaders, requestId);
    }

    // Duplicate checks against employees.
    let all;
    try {
        all = await rtdbGet(env, accessToken, '/employees');
    } catch (_e) {
        return errorResponse('server_error', 500, corsHeaders, requestId);
    }
    const raw = (all && typeof all === 'object' && !Array.isArray(all)) ? all : {};

    const existingCodes = new Set();
    const existingEmails = new Set();
    const existingUids = new Set();
    for (const r of Object.values(raw)) {
        if (!r || typeof r !== 'object') continue;
        if (r.employeeCode) existingCodes.add(String(r.employeeCode).toUpperCase());
        if (r.email) existingEmails.add(String(r.email).toLowerCase());
        if (r.uid) existingUids.add(String(r.uid));
    }

    if (clean.employeeCode && existingCodes.has(clean.employeeCode)) {
        return errorResponse('conflict', 409, corsHeaders, requestId, {
            fields: { employeeCode: 'This employee code is already in use.' },
        });
    }
    if (existingEmails.has(clean.email)) {
        return errorResponse('conflict', 409, corsHeaders, requestId, {
            fields: { email: 'An employee with this email already exists.' },
        });
    }
    if (clean.uid && existingUids.has(clean.uid)) {
        return errorResponse('conflict', 409, corsHeaders, requestId, {
            fields: { uid: 'This Firebase account is already linked to another employee.' },
        });
    }

    const employeeCode = clean.employeeCode || generateEmployeeCode(existingCodes);

    const employeeId = (crypto && typeof crypto.randomUUID === 'function')
        ? crypto.randomUUID()
        : `emp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    const now = new Date().toISOString();
    const displayName = `${clean.firstName} ${clean.lastName || ''}`.trim();

    // --- Firebase Auth user creation (only when inviting) ----------------
    let firebaseUid = clean.uid || null;
    let inviteState = 'not_requested';
    let inviteError = '';

    if (sendInvite) {
        try {
            const created = await createFirebaseAuthUser(env, clean.email, displayName);
            firebaseUid = created.uid;
            inviteState = 'user_created';
        } catch (err) {
            const msg = (err && err.message) || '';
            if (msg === 'email_already_exists') {
                return errorResponse('conflict', 409, corsHeaders, requestId, {
                    fields: { email: 'A sign-in account already exists for this email. Use a different email or recover the existing account.' },
                });
            }
            return errorResponse('server_error', 500, corsHeaders, requestId);
        }
    }

    // --- Employee record ------------------------------------------------
    const record = {
        employeeId,
        employeeCode,
        orgId:          ctx.orgId || null,
        uid:            firebaseUid,
        firstName:      clean.firstName,
        lastName:       clean.lastName,
        email:          clean.email,
        phone:          clean.phone || '',
        dateOfBirth:    clean.dateOfBirth || '',
        gender:         clean.gender || '',
        address:        clean.address || '',
        emergencyContact: clean.emergencyContact || '',
        departmentId:   clean.departmentId || null,
        designationId:  clean.designationId || null,
        joinDate:       clean.joinDate,
        employmentType: clean.employmentType,
        status:         clean.status || 'active',
        bank:           clean.bank || { bankName: '', accountNumber: '', ifsc: '' },
        activationStatus: sendInvite ? 'pending' : 'active',
        invitedAt:      sendInvite ? now : '',
        activatedAt:    sendInvite ? '' : now,
        lastInviteAt:   sendInvite ? now : '',
        createdAt:      now,
        updatedAt:      now,
        createdBy:      ctx.uid,
        updatedBy:      ctx.uid,
    };

    // Write the employee record. If this fails after Firebase Auth user was
    // created, roll back the Firebase user so the email is not orphaned.
    try {
        await rtdbSet(env, accessToken, `/employees/${encodeURIComponent(employeeId)}`, record);
    } catch (_e) {
        if (sendInvite && firebaseUid) {
            try { await deleteFirebaseAuthUser(env, firebaseUid); } catch (_e2) { /* best effort */ }
        }
        return errorResponse('server_error', 500, corsHeaders, requestId);
    }

    // --- users/{uid} record (when inviting) -----------------------------
    if (sendInvite && firebaseUid) {
        const userRecord = {
            uid: firebaseUid,
            email: clean.email,
            role: 'employee',
            orgId: ctx.orgId || null,
            employeeId: employeeId,
            displayName: displayName,
            enabled: true,
            activationStatus: 'pending',
            activatedAt: '',
            createdAt: now,
            updatedAt: now,
            createdBy: ctx.uid,
        };
        try {
            await rtdbSet(env, accessToken, `/users/${encodeURIComponent(firebaseUid)}`, userRecord);
        } catch (_e) {
            // Roll back: employee record + Firebase user.
            try { await rtdbSet(env, accessToken, `/employees/${encodeURIComponent(employeeId)}`, null); } catch (_e2) { /* best effort */ }
            try { await deleteFirebaseAuthUser(env, firebaseUid); } catch (_e2) { /* best effort */ }
            return errorResponse('server_error', 500, corsHeaders, requestId);
        }
    }

    // --- Send invitation email ------------------------------------------
    if (sendInvite) {
        try {
            await sendPasswordResetEmail(env, clean.email);
            inviteState = 'invited';
        } catch (err) {
            const msg = (err && err.message) || '';
            // Account exists but the email could not be sent. The admin can
            // resend. We still return success with a warning so the admin
            // knows the record was created.
            inviteState = 'invite_failed';
            inviteError = msg || 'invite_email_failed';
        }
    }

    const response = shapeEmployeeFull(record, { includeBank: true });
    response.inviteState = inviteState;
    if (inviteError) response.inviteError = inviteError;

    return jsonResponse(response, 201, corsHeaders, requestId);
}

async function handleEmployeeUpdate(request, env, requestId, corsHeaders, params) {
    const authRes = await requireAuth(request, env, corsHeaders, requestId);
    if (!authRes.ok) return authRes.response;
    const ctx = authRes.context;

    if (!isAdmin(ctx.role)) {
        return errorResponse('forbidden', 403, corsHeaders, requestId);
    }

    const targetId = params && params.employeeId ? params.employeeId : '';
    if (!targetId) {
        return errorResponse('bad_request', 400, corsHeaders, requestId);
    }

    const body = await readJsonBody(request);
    if (!body.ok) {
        return errorResponse('bad_request', 400, corsHeaders, requestId);
    }

    const validated = validateEmployeePayload(body.data, { partial: true });
    if (!validated.ok) {
        return errorResponse('validation_failed', 422, corsHeaders, requestId, {
            fields: validated.errors,
        });
    }
    const clean = validated.cleaned;

    let accessToken;
    try {
        accessToken = await getServiceAccountAccessToken(env);
    } catch (_e) {
        return errorResponse('server_error', 500, corsHeaders, requestId);
    }

    let current;
    try {
        current = await rtdbGet(env, accessToken, `/employees/${encodeURIComponent(targetId)}`);
    } catch (_e) {
        return errorResponse('server_error', 500, corsHeaders, requestId);
    }

    if (!current || typeof current !== 'object') {
        return errorResponse('not_found', 404, corsHeaders, requestId);
    }

    // Duplicate checks against OTHER records
    let all;
    try {
        all = await rtdbGet(env, accessToken, '/employees');
    } catch (_e) {
        return errorResponse('server_error', 500, corsHeaders, requestId);
    }
    const raw = (all && typeof all === 'object' && !Array.isArray(all)) ? all : {};

    if (clean.employeeCode) {
        const codeUpper = clean.employeeCode.toUpperCase();
        for (const [id, r] of Object.entries(raw)) {
            if (id === targetId) continue;
            if (r && String(r.employeeCode || '').toUpperCase() === codeUpper) {
                return errorResponse('conflict', 409, corsHeaders, requestId, {
                    fields: { employeeCode: 'This employee code is already in use.' },
                });
            }
        }
    }
    if (clean.email) {
        for (const [id, r] of Object.entries(raw)) {
            if (id === targetId) continue;
            if (r && String(r.email || '').toLowerCase() === clean.email.toLowerCase()) {
                return errorResponse('conflict', 409, corsHeaders, requestId, {
                    fields: { email: 'Another employee already uses this email.' },
                });
            }
        }
    }
    if (clean.uid) {
        for (const [id, r] of Object.entries(raw)) {
            if (id === targetId) continue;
            if (r && String(r.uid || '') === clean.uid) {
                return errorResponse('conflict', 409, corsHeaders, requestId, {
                    fields: { uid: 'This Firebase account is already linked to another employee.' },
                });
            }
        }
    }

    // Merge — fields not present in the request are unchanged.
    const updated = Object.assign({}, current, clean, {
        employeeId: targetId,
        updatedAt:  new Date().toISOString(),
        updatedBy:  ctx.uid,
    });

    try {
        await rtdbSet(env, accessToken, `/employees/${encodeURIComponent(targetId)}`, updated);
    } catch (_e) {
        return errorResponse('server_error', 500, corsHeaders, requestId);
    }

    return jsonResponse(shapeEmployeeFull(updated, { includeBank: true }), 200, corsHeaders, requestId);
}

async function handleEmployeeStatusUpdate(request, env, requestId, corsHeaders, params) {
    const authRes = await requireAuth(request, env, corsHeaders, requestId);
    if (!authRes.ok) return authRes.response;
    const ctx = authRes.context;

    if (!isAdmin(ctx.role)) {
        return errorResponse('forbidden', 403, corsHeaders, requestId);
    }

    const targetId = params && params.employeeId ? params.employeeId : '';
    if (!targetId) {
        return errorResponse('bad_request', 400, corsHeaders, requestId);
    }

    const body = await readJsonBody(request);
    if (!body.ok || !body.data || typeof body.data !== 'object') {
        return errorResponse('bad_request', 400, corsHeaders, requestId);
    }

    const status = String(body.data.status || '').trim().toLowerCase();
    if (!EMPLOYEE_STATUSES.includes(status)) {
        return errorResponse('validation_failed', 422, corsHeaders, requestId, {
            fields: { status: 'Select a valid status: active, inactive, or terminated.' },
        });
    }

    let accessToken;
    try {
        accessToken = await getServiceAccountAccessToken(env);
    } catch (_e) {
        return errorResponse('server_error', 500, corsHeaders, requestId);
    }

    let current;
    try {
        current = await rtdbGet(env, accessToken, `/employees/${encodeURIComponent(targetId)}`);
    } catch (_e) {
        return errorResponse('server_error', 500, corsHeaders, requestId);
    }

    if (!current || typeof current !== 'object') {
        return errorResponse('not_found', 404, corsHeaders, requestId);
    }

    const updated = Object.assign({}, current, {
        status,
        updatedAt: new Date().toISOString(),
        updatedBy: ctx.uid,
    });

    try {
        await rtdbSet(env, accessToken, `/employees/${encodeURIComponent(targetId)}`, updated);
    } catch (_e) {
        return errorResponse('server_error', 500, corsHeaders, requestId);
    }

    return jsonResponse(shapeEmployeeFull(updated, { includeBank: true }), 200, corsHeaders, requestId);
}

/* ----------------------------------------------------------------------------
 * Resend invitation
 *
 * Re-sends the Firebase password reset email for an employee whose account
 * is still pending activation. Refuses for already-activated accounts and
 * for employees that have no linked Firebase account.
 * ------------------------------------------------------------------------- */

async function handleEmployeeResendInvite(request, env, requestId, corsHeaders, params) {
    const authRes = await requireAuth(request, env, corsHeaders, requestId);
    if (!authRes.ok) return authRes.response;
    const ctx = authRes.context;

    if (!isAdmin(ctx.role)) {
        return errorResponse('forbidden', 403, corsHeaders, requestId);
    }

    const employeeId = params && params.employeeId ? String(params.employeeId) : '';
    if (!employeeId) {
        return errorResponse('bad_request', 400, corsHeaders, requestId);
    }

    let accessToken;
    try {
        accessToken = await getServiceAccountAccessToken(env);
    } catch (_e) {
        return errorResponse('server_error', 500, corsHeaders, requestId);
    }

    let employee;
    try {
        employee = await rtdbGet(env, accessToken, `/employees/${encodeURIComponent(employeeId)}`);
    } catch (_e) {
        return errorResponse('server_error', 500, corsHeaders, requestId);
    }
    if (!employee || typeof employee !== 'object') {
        return errorResponse('not_found', 404, corsHeaders, requestId);
    }

    if (!employee.uid) {
        return errorResponse('conflict', 409, corsHeaders, requestId, {
            fields: { invite: 'This employee has no linked sign-in account.' },
        });
    }

    if (employee.activationStatus === 'active') {
        return errorResponse('conflict', 409, corsHeaders, requestId, {
            fields: { invite: 'This account has already been activated.' },
        });
    }

    if (!employee.email) {
        return errorResponse('conflict', 409, corsHeaders, requestId, {
            fields: { invite: 'This employee has no email address.' },
        });
    }

    try {
        await sendPasswordResetEmail(env, employee.email);
    } catch (err) {
        const msg = (err && err.message) || '';
        if (msg === 'user_not_found') {
            return errorResponse('conflict', 409, corsHeaders, requestId, {
                fields: { invite: 'The sign-in account no longer exists.' },
            });
        }
        return errorResponse('server_error', 500, corsHeaders, requestId);
    }

    const now = new Date().toISOString();
    try {
        await rtdbSet(env, accessToken, `/employees/${encodeURIComponent(employeeId)}/lastInviteAt`, now);
        await rtdbSet(env, accessToken, `/employees/${encodeURIComponent(employeeId)}/updatedAt`, now);
        await rtdbSet(env, accessToken, `/employees/${encodeURIComponent(employeeId)}/updatedBy`, ctx.uid);
    } catch (_e) { /* non-critical */ }

    return jsonResponse({
        employeeId,
        email: employee.email,
        lastInviteAt: now,
    }, 200, corsHeaders, requestId);
}

/* ----------------------------------------------------------------------------
 * Attendance — validation and shaping
 * ---------------------------------------------------------------------------- */

const ATTENDANCE_STATUSES = ['present', 'absent', 'leave', 'half_day', 'holiday'];

function isValidAttendanceStatus(v) {
    return typeof v === 'string' && ATTENDANCE_STATUSES.includes(v);
}

function isValidTimeHHMM(v) {
    if (typeof v !== 'string') return false;
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}

function normalizeDate(v) {
    if (typeof v !== 'string') return '';
    const s = v.trim();
    if (!isValidISODate(s)) return '';
    return s;
}

function shapeAttendanceRecord(rec) {
    if (!rec || typeof rec !== 'object') return null;
    return {
        status:      String(rec.status || ''),
        checkIn:     String(rec.checkIn || ''),
        checkOut:    String(rec.checkOut || ''),
        hoursWorked: Number(rec.hoursWorked) || 0,
        note:        String(rec.note || ''),
        markedBy:    String(rec.markedBy || ''),
        markedAt:    String(rec.markedAt || ''),
        updatedAt:   String(rec.updatedAt || ''),
        updatedBy:   String(rec.updatedBy || ''),
    };
}

function validateAttendancePayload(body) {
    const errors = {};
    const cleaned = {};

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { ok: false, errors: { _root: 'Request body must be a JSON object.' } };
    }

    const status = String(body.status || '').trim().toLowerCase();
    if (!status) errors.status = 'Status is required.';
    else if (!isValidAttendanceStatus(status)) errors.status = 'Select a valid status.';
    else cleaned.status = status;

    if (body.checkIn !== undefined && body.checkIn !== null && body.checkIn !== '') {
        const v = String(body.checkIn).trim();
        if (!isValidTimeHHMM(v)) errors.checkIn = 'Check-in must be HH:MM (24-hour).';
        else cleaned.checkIn = v;
    } else {
        cleaned.checkIn = '';
    }

    if (body.checkOut !== undefined && body.checkOut !== null && body.checkOut !== '') {
        const v = String(body.checkOut).trim();
        if (!isValidTimeHHMM(v)) errors.checkOut = 'Check-out must be HH:MM (24-hour).';
        else cleaned.checkOut = v;
    } else {
        cleaned.checkOut = '';
    }

    if (body.note !== undefined) {
        cleaned.note = normalizeOptionalString(body.note, 250);
    } else {
        cleaned.note = '';
    }

    // If both check-in and check-out are provided, compute hours worked.
    // This is a convenience for reporting; the client may not always provide
    // them. Values are stored as decimal hours rounded to two places.
    if (cleaned.checkIn && cleaned.checkOut) {
        const [ih, im] = cleaned.checkIn.split(':').map(Number);
        const [oh, om] = cleaned.checkOut.split(':').map(Number);
        let minutes = (oh * 60 + om) - (ih * 60 + im);
        if (minutes < 0) minutes += 24 * 60; // overnight shift
        cleaned.hoursWorked = Math.round((minutes / 60) * 100) / 100;
    } else {
        cleaned.hoursWorked = 0;
    }

    if (Object.keys(errors).length > 0) return { ok: false, errors };
    return { ok: true, cleaned };
}

/* ----------------------------------------------------------------------------
 * Attendance — handlers
 * ------------------------------------------------------------------------- */

async function handleAttendanceList(request, env, requestId, corsHeaders) {
    const authRes = await requireAuth(request, env, corsHeaders, requestId);
    if (!authRes.ok) return authRes.response;
    const ctx = authRes.context;

    const url = new URL(request.url);
    const from = normalizeDate(url.searchParams.get('from') || '');
    const to   = normalizeDate(url.searchParams.get('to') || '');
    const filterEmployee = String(url.searchParams.get('employeeId') || '').trim();
    const statusFilter = String(url.searchParams.get('status') || '').trim().toLowerCase();
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(url.searchParams.get('pageSize') || '50', 10) || 50));

    // Employee scope: an employee can only see their own attendance.
    let employeeScope = null;
    if (ctx.role === 'employee') {
        if (!ctx.employeeId) {
            return errorResponse('forbidden', 403, corsHeaders, requestId);
        }
        employeeScope = ctx.employeeId;
    } else if (!isAdmin(ctx.role)) {
        return errorResponse('forbidden', 403, corsHeaders, requestId);
    }

    if (!from || !to) {
        return errorResponse('bad_request', 400, corsHeaders, requestId, {
            fields: { from: 'from and to dates are required.' },
        });
    }
    if (from > to) {
        return errorResponse('bad_request', 400, corsHeaders, requestId, {
            fields: { to: 'to must be on or after from.' },
        });
    }

    // Determine which employees to include.
    let targetEmployeeIds = [];
    if (employeeScope) {
        targetEmployeeIds = [employeeScope];
    } else if (filterEmployee && filterEmployee !== 'all') {
        targetEmployeeIds = [filterEmployee];
    } else {
        // Fetch the employee directory to enumerate.
        let all;
        let accessToken;
        try {
            accessToken = await getServiceAccountAccessToken(env);
            all = await rtdbGet(env, accessToken, '/employees');
        } catch (_e) {
            return errorResponse('server_error', 500, corsHeaders, requestId);
        }
        const raw = (all && typeof all === 'object' && !Array.isArray(all)) ? all : {};
        targetEmployeeIds = Object.keys(raw);
    }

    let accessToken;
    try {
        accessToken = await getServiceAccountAccessToken(env);
    } catch (_e) {
        return errorResponse('server_error', 500, corsHeaders, requestId);
    }

    // Fetch attendance per employee within the date range.
    // Bounded concurrency. For small-to-medium organizations this is
    // acceptable; see the Known Limitations section of the README.
    const CONCURRENCY = 20;
    const rows = [];

    for (let i = 0; i < targetEmployeeIds.length; i += CONCURRENCY) {
        const batch = targetEmployeeIds.slice(i, i + CONCURRENCY);
        const perEmployee = await Promise.all(batch.map(async (id) => {
            try {
                const raw = await rtdbGet(env, accessToken, `/attendance/${encodeURIComponent(id)}`);
                return { id, raw };
            } catch (_e) {
                return { id, raw: null };
            }
        }));

        for (const entry of perEmployee) {
            const rec = entry.raw;
            if (!rec || typeof rec !== 'object') continue;

            for (const dateKey of Object.keys(rec)) {
                if (!isValidISODate(dateKey)) continue;
                if (from && dateKey < from) continue;
                if (to && dateKey > to) continue;

                const shaped = shapeAttendanceRecord(rec[dateKey]);
                if (!shaped) continue;
                if (statusFilter && shaped.status !== statusFilter) continue;

                rows.push({ employeeId: entry.id, date: dateKey, ...shaped });
            }
        }
    }

    rows.sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? 1 : -1;
        return a.employeeId.localeCompare(b.employeeId);
    });

    const total = rows.length;
    const start = (page - 1) * pageSize;
    const slice = rows.slice(start, start + pageSize);

    return jsonResponse({
        items: slice,
        total,
        page,
        pageSize,
    }, 200, corsHeaders, requestId);
}

async function handleAttendanceSummary(request, env, requestId, corsHeaders) {
    const authRes = await requireAuth(request, env, corsHeaders, requestId);
    if (!authRes.ok) return authRes.response;
    const ctx = authRes.context;

    const url = new URL(request.url);
    const from = normalizeDate(url.searchParams.get('from') || '');
    const to   = normalizeDate(url.searchParams.get('to') || '');

    if (!from || !to) {
        return errorResponse('bad_request', 400, corsHeaders, requestId, {
            fields: { from: 'from and to dates are required.' },
        });
    }
    if (from > to) {
        return errorResponse('bad_request', 400, corsHeaders, requestId, {
            fields: { to: 'to must be on or after from.' },
        });
    }

    // Employee scope enforcement.
    let employeeScope = null;
    if (ctx.role === 'employee') {
        if (!ctx.employeeId) return errorResponse('forbidden', 403, corsHeaders, requestId);
        employeeScope = ctx.employeeId;
    } else if (!isAdmin(ctx.role)) {
        return errorResponse('forbidden', 403, corsHeaders, requestId);
    }

    const filterEmployee = String(url.searchParams.get('employeeId') || '').trim();

    let targetEmployeeIds = [];
    let accessToken;
    try {
        accessToken = await getServiceAccountAccessToken(env);
    } catch (_e) {
        return errorResponse('server_error', 500, corsHeaders, requestId);
    }

    if (employeeScope) {
        targetEmployeeIds = [employeeScope];
    } else if (filterEmployee && filterEmployee !== 'all') {
        targetEmployeeIds = [filterEmployee];
    } else {
        let all;
        try {
            all = await rtdbGet(env, accessToken, '/employees');
        } catch (_e) {
            return errorResponse('server_error', 500, corsHeaders, requestId);
        }
        const raw = (all && typeof all === 'object' && !Array.isArray(all)) ? all : {};
        targetEmployeeIds = Object.keys(raw);
    }

    const counts = { present: 0, absent: 0, leave: 0, half_day: 0, holiday: 0, notMarked: 0 };

    const CONCURRENCY = 20;
    for (let i = 0; i < targetEmployeeIds.length; i += CONCURRENCY) {
        const batch = targetEmployeeIds.slice(i, i + CONCURRENCY);
        const results = await Promise.all(batch.map(async (id) => {
            try {
                return await rtdbGet(env, accessToken, `/attendance/${encodeURIComponent(id)}`);
            } catch (_e) {
                return null;
            }
        }));

        for (const rec of results) {
            if (!rec || typeof rec !== 'object') {
                counts.notMarked += countWorkingDays(from, to);
                continue;
            }
            const workingDays = countWorkingDays(from, to);
            let marked = 0;
            for (const dateKey of Object.keys(rec)) {
                if (!isValidISODate(dateKey)) continue;
                if (dateKey < from || dateKey > to) continue;
                const s = String(rec[dateKey] && rec[dateKey].status || '').toLowerCase();
                if (counts[s] !== undefined) counts[s] += 1;
                marked += 1;
            }
            counts.notMarked += Math.max(0, workingDays - marked);
        }
    }

    return jsonResponse({
        from, to,
        employees: targetEmployeeIds.length,
        counts,
    }, 200, corsHeaders, requestId);
}

/**
 * Marks a single attendance record. Admins only; employees cannot mark
 * attendance through this API. The endpoint is idempotent: marking the same
 * employee and date twice overwrites the record, and the audit entry records
 * the change.
 */
async function handleAttendanceMark(request, env, requestId, corsHeaders) {
    const authRes = await requireAuth(request, env, corsHeaders, requestId);
    if (!authRes.ok) return authRes.response;
    const ctx = authRes.context;

    if (!isAdmin(ctx.role)) {
        return errorResponse('forbidden', 403, corsHeaders, requestId);
    }

    const body = await readJsonBody(request);
    if (!body.ok) return errorResponse('bad_request', 400, corsHeaders, requestId);

    const data = body.data || {};
    const employeeId = String(data.employeeId || '').trim();
    const date = normalizeDate(data.date);

    if (!employeeId) {
        return errorResponse('validation_failed', 422, corsHeaders, requestId, {
            fields: { employeeId: 'Employee is required.' },
        });
    }
    if (!date) {
        return errorResponse('validation_failed', 422, corsHeaders, requestId, {
            fields: { date: 'A valid date (YYYY-MM-DD) is required.' },
        });
    }

    const validated = validateAttendancePayload(data);
    if (!validated.ok) {
        return errorResponse('validation_failed', 422, corsHeaders, requestId, {
            fields: validated.errors,
        });
    }

    let accessToken;
    try {
        accessToken = await getServiceAccountAccessToken(env);
    } catch (_e) {
        return errorResponse('server_error', 500, corsHeaders, requestId);
    }

    // Confirm the employee exists.
    let employee;
    try {
        employee = await rtdbGet(env, accessToken, `/employees/${encodeURIComponent(employeeId)}`);
    } catch (_e) {
        return errorResponse('server_error', 500, corsHeaders, requestId);
    }
    if (!employee || typeof employee !== 'object') {
        return errorResponse('not_found', 404, corsHeaders, requestId);
    }

    const now = new Date().toISOString();
    const record = {
        status:      validated.cleaned.status,
        checkIn:     validated.cleaned.checkIn,
        checkOut:    validated.cleaned.checkOut,
        hoursWorked: validated.cleaned.hoursWorked,
        note:        validated.cleaned.note,
        markedBy:    ctx.uid,
        markedAt:    now,
        updatedAt:   now,
        updatedBy:   ctx.uid,
    };

    try {
        await rtdbSet(env, accessToken, `/attendance/${encodeURIComponent(employeeId)}/${date}`, record);
    } catch (_e) {
        return errorResponse('server_error', 500, corsHeaders, requestId);
    }

    return jsonResponse({ employeeId, date, ...record }, 200, corsHeaders, requestId);
}

/**
 * Bulk marking. Accepts { date, records: [{ employeeId, status, ... }] }.
 * Each record is validated and written. Partial failures are reported
 * individually — successful writes are kept, failures are returned in
 * the response so the UI can retry only the failed subset.
 */
async function handleAttendanceBulk(request, env, requestId, corsHeaders) {
    const authRes = await requireAuth(request, env, corsHeaders, requestId);
    if (!authRes.ok) return authRes.response;
    const ctx = authRes.context;

    if (!isAdmin(ctx.role)) {
        return errorResponse('forbidden', 403, corsHeaders, requestId);
    }

    const body = await readJsonBody(request);
    if (!body.ok || !body.data || typeof body.data !== 'object') {
        return errorResponse('bad_request', 400, corsHeaders, requestId);
    }

    const date = normalizeDate(body.data.date);
    if (!date) {
        return errorResponse('validation_failed', 422, corsHeaders, requestId, {
            fields: { date: 'A valid date (YYYY-MM-DD) is required.' },
        });
    }

    const records = Array.isArray(body.data.records) ? body.data.records : [];
    if (records.length === 0) {
        return errorResponse('validation_failed', 422, corsHeaders, requestId, {
            fields: { records: 'At least one record is required.' },
        });
    }
    if (records.length > 500) {
        return errorResponse('bad_request', 400, corsHeaders, requestId);
    }

    let accessToken;
    try {
        accessToken = await getServiceAccountAccessToken(env);
    } catch (_e) {
        return errorResponse('server_error', 500, corsHeaders, requestId);
    }

    const now = new Date().toISOString();
    const written = [];
    const failed = [];

    for (const rec of records) {
        const employeeId = String(rec && rec.employeeId || '').trim();
        if (!employeeId) {
            failed.push({ employeeId: '', error: 'employeeId is required.' });
            continue;
        }

        const validated = validateAttendancePayload(rec);
        if (!validated.ok) {
            failed.push({ employeeId, error: 'Invalid attendance payload.', fields: validated.errors });
            continue;
        }

        const record = {
            status:      validated.cleaned.status,
            checkIn:     validated.cleaned.checkIn,
            checkOut:    validated.cleaned.checkOut,
            hoursWorked: validated.cleaned.hoursWorked,
            note:        validated.cleaned.note,
            markedBy:    ctx.uid,
            markedAt:    now,
            updatedAt:   now,
            updatedBy:   ctx.uid,
        };

        try {
            await rtdbSet(env, accessToken, `/attendance/${encodeURIComponent(employeeId)}/${date}`, record);
            written.push(employeeId);
        } catch (_e) {
            failed.push({ employeeId, error: 'Write failed.' });
        }
    }

    return jsonResponse({
        date,
        written,
        failed,
        writtenCount: written.length,
        failedCount: failed.length,
    }, 200, corsHeaders, requestId);
}

/**
 * Corrects an existing attendance record. Admins only. The correction
 * requires the record to already exist — this endpoint is not used for
 * initial marking.
 */
async function handleAttendanceCorrect(request, env, requestId, corsHeaders, params) {
    const authRes = await requireAuth(request, env, corsHeaders, requestId);
    if (!authRes.ok) return authRes.response;
    const ctx = authRes.context;

    if (!isAdmin(ctx.role)) {
        return errorResponse('forbidden', 403, corsHeaders, requestId);
    }

    const employeeId = params && params.employeeId ? String(params.employeeId) : '';
    const date = params && params.date ? normalizeDate(params.date) : '';
    if (!employeeId || !date) {
        return errorResponse('bad_request', 400, corsHeaders, requestId);
    }

    const body = await readJsonBody(request);
    if (!body.ok) return errorResponse('bad_request', 400, corsHeaders, requestId);

    const validated = validateAttendancePayload(body.data);
    if (!validated.ok) {
        return errorResponse('validation_failed', 422, corsHeaders, requestId, {
            fields: validated.errors,
        });
    }

    let accessToken;
    try {
        accessToken = await getServiceAccountAccessToken(env);
    } catch (_e) {
        return errorResponse('server_error', 500, corsHeaders, requestId);
    }

    let existing;
    try {
        existing = await rtdbGet(env, accessToken, `/attendance/${encodeURIComponent(employeeId)}/${date}`);
    } catch (_e) {
        return errorResponse('server_error', 500, corsHeaders, requestId);
    }
    if (!existing || typeof existing !== 'object') {
        return errorResponse('not_found', 404, corsHeaders, requestId);
    }

    const now = new Date().toISOString();
    const record = {
        status:      validated.cleaned.status,
        checkIn:     validated.cleaned.checkIn,
        checkOut:    validated.cleaned.checkOut,
        hoursWorked: validated.cleaned.hoursWorked,
        note:        validated.cleaned.note,
        markedBy:    existing.markedBy || ctx.uid,
        markedAt:    existing.markedAt || now,
        updatedAt:   now,
        updatedBy:   ctx.uid,
    };

    try {
        await rtdbSet(env, accessToken, `/attendance/${encodeURIComponent(employeeId)}/${date}`, record);
    } catch (_e) {
        return errorResponse('server_error', 500, corsHeaders, requestId);
    }

    return jsonResponse({ employeeId, date, ...record }, 200, corsHeaders, requestId);
}

/**
 * Counts working days between two ISO dates (inclusive), Monday–Saturday.
 * Sunday is treated as a non-working day.
 *
 * Note: this is a placeholder for the working-week configuration. If the
 * organization works Monday–Friday, this must be changed. The setting will
 * become configurable in a later phase. See Known Limitations in README.
 */
/* ----------------------------------------------------------------------------
 * Leave — validation and shaping
 * ------------------------------------------------------------------------- */

const LEAVE_TYPES = ['casual', 'sick', 'earned', 'unpaid', 'other'];
const LEAVE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];

function shapeLeaveRequest(rec) {
    return {
        requestId:  String(rec.requestId || ''),
        employeeId: String(rec.employeeId || ''),
        leaveType:  String(rec.leaveType || ''),
        fromDate:   String(rec.fromDate || ''),
        toDate:     String(rec.toDate || ''),
        days:       Number(rec.days) || 0,
        reason:     String(rec.reason || ''),
        status:     String(rec.status || 'pending'),
        appliedAt:  String(rec.appliedAt || ''),
        reviewedBy: String(rec.reviewedBy || ''),
        reviewedAt: String(rec.reviewedAt || ''),
        reviewNote: String(rec.reviewNote || ''),
    };
}

function validateLeavePayload(body) {
    const errors = {};
    const cleaned = {};

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { ok: false, errors: { _root: 'Request body must be a JSON object.' } };
    }

    const leaveType = String(body.leaveType || '').trim().toLowerCase();
    if (!leaveType) errors.leaveType = 'Leave type is required.';
    else if (!LEAVE_TYPES.includes(leaveType)) errors.leaveType = 'Select a valid leave type.';
    else cleaned.leaveType = leaveType;

    const fromDate = String(body.fromDate || '').trim();
    if (!fromDate) errors.fromDate = 'From date is required.';
    else if (!isValidISODate(fromDate)) errors.fromDate = 'Enter a valid date.';
    else cleaned.fromDate = fromDate;

    const toDate = String(body.toDate || '').trim();
    if (!toDate) errors.toDate = 'To date is required.';
    else if (!isValidISODate(toDate)) errors.toDate = 'Enter a valid date.';
    else cleaned.toDate = toDate;

    if (cleaned.fromDate && cleaned.toDate && cleaned.fromDate > cleaned.toDate) {
        errors.toDate = 'To date must be on or after from date.';
    }

    const reason = normalizeOptionalString(body.reason, 500);
    if (!reason) errors.reason = 'Reason is required.';
    else cleaned.reason = reason;

    if (Object.keys(errors).length > 0) return { ok: false, errors };

    // Calculate days as the number of working days in the range, inclusive.
    cleaned.days = countWorkingDays(cleaned.fromDate, cleaned.toDate);

    return { ok: true, cleaned };
}

async function handleLeaveList(request, env, requestId, corsHeaders) {
    const authRes = await requireAuth(request, env, corsHeaders, requestId);
    if (!authRes.ok) return authRes.response;
    const ctx = authRes.context;

    const url = new URL(request.url);
    const status = String(url.searchParams.get('status') || '').trim().toLowerCase();
    const employeeId = String(url.searchParams.get('employeeId') || '').trim();
    const filterEmployee = String(url.searchParams.get('filterEmployee') || '').trim();

    let scope = null;
    if (ctx.role === 'employee') {
        if (!ctx.employeeId) return errorResponse('forbidden', 403, corsHeaders, requestId);
        scope = ctx.employeeId;
    } else if (!isAdmin(ctx.role)) {
        return errorResponse('forbidden', 403, corsHeaders, requestId);
    }

    let accessToken;
    try { accessToken = await getServiceAccountAccessToken(env); }
    catch (_e) { return errorResponse('server_error', 500, corsHeaders, requestId); }

    let all;
    try { all = await rtdbGet(env, accessToken, '/leaveRequests'); }
    catch (_e) { return errorResponse('server_error', 500, corsHeaders, requestId); }

    const raw = (all && typeof all === 'object' && !Array.isArray(all)) ? all : {};
    let items = Object.values(raw).filter((r) => r && typeof r === 'object').map(shapeLeaveRequest);

    if (scope) items = items.filter((r) => r.employeeId === scope);
    else if (filterEmployee) items = items.filter((r) => r.employeeId === filterEmployee);
    else if (employeeId) items = items.filter((r) => r.employeeId === employeeId);

    if (status) items = items.filter((r) => r.status === status);

    items.sort((a, b) => String(b.appliedAt).localeCompare(String(a.appliedAt)));

    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('pageSize') || '25', 10) || 25));
    const total = items.length;
    const start = (page - 1) * pageSize;

    return jsonResponse({
        items: items.slice(start, start + pageSize),
        total, page, pageSize,
    }, 200, corsHeaders, requestId);
}

async function handleLeaveApply(request, env, requestId, corsHeaders) {
    const authRes = await requireAuth(request, env, corsHeaders, requestId);
    if (!authRes.ok) return authRes.response;
    const ctx = authRes.context;

    const body = await readJsonBody(request);
    if (!body.ok) return errorResponse('bad_request', 400, corsHeaders, requestId);

    const validated = validateLeavePayload(body.data);
    if (!validated.ok) return errorResponse('validation_failed', 422, corsHeaders, requestId, { fields: validated.errors });
    const clean = validated.cleaned;

    // Employees may only apply for their own leave. Admins may apply on
    // behalf of an employee by passing employeeId.
    let targetEmployeeId;
    if (ctx.role === 'employee') {
        if (!ctx.employeeId) return errorResponse('forbidden', 403, corsHeaders, requestId);
        targetEmployeeId = ctx.employeeId;
    } else if (isAdmin(ctx.role)) {
        targetEmployeeId = String((body.data && body.data.employeeId) || '').trim();
        if (!targetEmployeeId) {
            return errorResponse('validation_failed', 422, corsHeaders, requestId, {
                fields: { employeeId: 'Employee is required.' },
            });
        }
    } else {
        return errorResponse('forbidden', 403, corsHeaders, requestId);
    }

    let accessToken;
    try { accessToken = await getServiceAccountAccessToken(env); }
    catch (_e) { return errorResponse('server_error', 500, corsHeaders, requestId); }

    // Confirm the employee exists.
    let employee;
    try { employee = await rtdbGet(env, accessToken, `/employees/${encodeURIComponent(targetEmployeeId)}`); }
    catch (_e) { return errorResponse('server_error', 500, corsHeaders, requestId); }
    if (!employee || typeof employee !== 'object') return errorResponse('not_found', 404, corsHeaders, requestId);

    const requestIdValue = (crypto && typeof crypto.randomUUID === 'function')
        ? crypto.randomUUID()
        : `lr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    const now = new Date().toISOString();
    const record = {
        requestId: requestIdValue,
        employeeId: targetEmployeeId,
        leaveType: clean.leaveType,
        fromDate: clean.fromDate,
        toDate: clean.toDate,
        days: clean.days,
        reason: clean.reason,
        status: 'pending',
        appliedAt: now,
        reviewedBy: '',
        reviewedAt: '',
        reviewNote: '',
    };

    try {
        await rtdbSet(env, accessToken, `/leaveRequests/${encodeURIComponent(requestIdValue)}`, record);
    } catch (_e) {
        return errorResponse('server_error', 500, corsHeaders, requestId);
    }

    return jsonResponse(shapeLeaveRequest(record), 201, corsHeaders, requestId);
}

async function handleLeaveGet(request, env, requestId, corsHeaders, params) {
    const authRes = await requireAuth(request, env, corsHeaders, requestId);
    if (!authRes.ok) return authRes.response;
    const ctx = authRes.context;

    const rid = params && params.requestId ? params.requestId : '';
    if (!rid) return errorResponse('bad_request', 400, corsHeaders, requestId);

    let accessToken;
    try { accessToken = await getServiceAccountAccessToken(env); }
    catch (_e) { return errorResponse('server_error', 500, corsHeaders, requestId); }

    let rec;
    try { rec = await rtdbGet(env, accessToken, `/leaveRequests/${encodeURIComponent(rid)}`); }
    catch (_e) { return errorResponse('server_error', 500, corsHeaders, requestId); }
    if (!rec || typeof rec !== 'object') return errorResponse('not_found', 404, corsHeaders, requestId);

    if (ctx.role === 'employee' && rec.employeeId !== ctx.employeeId) {
        return errorResponse('forbidden', 403, corsHeaders, requestId);
    }
    if (!isAdmin(ctx.role) && ctx.role !== 'employee') {
        return errorResponse('forbidden', 403, corsHeaders, requestId);
    }

    return jsonResponse(shapeLeaveRequest(rec), 200, corsHeaders, requestId);
}

async function handleLeaveReview(request, env, requestId, corsHeaders, params) {
    const authRes = await requireAuth(request, env, corsHeaders, requestId);
    if (!authRes.ok) return authRes.response;
    const ctx = authRes.context;

    if (!isAdmin(ctx.role)) return errorResponse('forbidden', 403, corsHeaders, requestId);

    const rid = params && params.requestId ? params.requestId : '';
    if (!rid) return errorResponse('bad_request', 400, corsHeaders, requestId);

    const body = await readJsonBody(request);
    if (!body.ok || !body.data) return errorResponse('bad_request', 400, corsHeaders, requestId);

    const decision = String(body.data.status || '').trim().toLowerCase();
    if (!['approved', 'rejected'].includes(decision)) {
        return errorResponse('validation_failed', 422, corsHeaders, requestId, {
            fields: { status: 'Decision must be approved or rejected.' },
        });
    }

    const note = normalizeOptionalString(body.data.reviewNote, 500);

    let accessToken;
    try { accessToken = await getServiceAccountAccessToken(env); }
    catch (_e) { return errorResponse('server_error', 500, corsHeaders, requestId); }

    let current;
    try { current = await rtdbGet(env, accessToken, `/leaveRequests/${encodeURIComponent(rid)}`); }
    catch (_e) { return errorResponse('server_error', 500, corsHeaders, requestId); }
    if (!current || typeof current !== 'object') return errorResponse('not_found', 404, corsHeaders, requestId);

    if (current.status !== 'pending') {
        return errorResponse('conflict', 409, corsHeaders, requestId, {
            fields: { status: 'This request has already been reviewed.' },
        });
    }

    const now = new Date().toISOString();
    const updated = Object.assign({}, current, {
        status: decision,
        reviewedBy: ctx.uid,
        reviewedAt: now,
        reviewNote: note,
    });

    try {
        await rtdbSet(env, accessToken, `/leaveRequests/${encodeURIComponent(rid)}`, updated);
    } catch (_e) {
        return errorResponse('server_error', 500, corsHeaders, requestId);
    }

    // Update the leave balance if approved. This is a simple adjustment of
    // the used / remaining counters. Statutory rules and accrual policies
    // are out of scope for this version — they are configurable in a later
    // phase.
    if (decision === 'approved' && updated.employeeId && updated.leaveType && updated.days > 0) {
        const year = String(updated.fromDate || '').slice(0, 4);
        if (year) {
            const balancePath = `/leaveBalances/${encodeURIComponent(updated.employeeId)}/${year}/${updated.leaveType}`;
            try {
                const balance = await rtdbGet(env, accessToken, balancePath);
                const b = (balance && typeof balance === 'object') ? balance : { allocated: 0, used: 0, remaining: 0 };
                const newUsed = (Number(b.used) || 0) + updated.days;
                const newRemaining = Math.max(0, (Number(b.allocated) || 0) - newUsed);
                await rtdbSet(env, accessToken, balancePath, {
                    allocated: Number(b.allocated) || 0,
                    used: newUsed,
                    remaining: newRemaining,
                });
            } catch (_e) { /* non-critical */ }
        }
    }

    return jsonResponse(shapeLeaveRequest(updated), 200, corsHeaders, requestId);
}

async function handleLeaveBalancesGet(request, env, requestId, corsHeaders, params) {
    const authRes = await requireAuth(request, env, corsHeaders, requestId);
    if (!authRes.ok) return authRes.response;
    const ctx = authRes.context;

    let empId = params && params.employeeId ? params.employeeId : '';
    const year = params && params.year ? params.year : '';

    if (!empId || !/^\d{4}$/.test(year)) return errorResponse('bad_request', 400, corsHeaders, requestId);

    if (empId === 'me') empId = ctx.employeeId || '';
    if (!empId) return errorResponse('not_found', 404, corsHeaders, requestId);

    if (ctx.role === 'employee' && empId !== ctx.employeeId) {
        return errorResponse('forbidden', 403, corsHeaders, requestId);
    }
    if (!isAdmin(ctx.role) && ctx.role !== 'employee') {
        return errorResponse('forbidden', 403, corsHeaders, requestId);
    }

    let accessToken;
    try { accessToken = await getServiceAccountAccessToken(env); }
    catch (_e) { return errorResponse('server_error', 500, corsHeaders, requestId); }

    let balances;
    try { balances = await rtdbGet(env, accessToken, `/leaveBalances/${encodeURIComponent(empId)}/${year}`); }
    catch (_e) { return errorResponse('server_error', 500, corsHeaders, requestId); }

    const out = {};
    if (balances && typeof balances === 'object' && !Array.isArray(balances)) {
        for (const [type, b] of Object.entries(balances)) {
            if (!b || typeof b !== 'object') continue;
            out[type] = {
                allocated: Number(b.allocated) || 0,
                used:      Number(b.used) || 0,
                remaining: Number(b.remaining) || 0,
            };
        }
    }

    return jsonResponse({ employeeId: empId, year, balances: out }, 200, corsHeaders, requestId);
}

async function handleLeaveBalancesSet(request, env, requestId, corsHeaders, params) {
    const authRes = await requireAuth(request, env, corsHeaders, requestId);
    if (!authRes.ok) return authRes.response;
    const ctx = authRes.context;

    if (!isAdmin(ctx.role)) return errorResponse('forbidden', 403, corsHeaders, requestId);

    const empId = params && params.employeeId ? params.employeeId : '';
    const year = params && params.year ? params.year : '';
    if (!empId || !/^\d{4}$/.test(year)) return errorResponse('bad_request', 400, corsHeaders, requestId);

    const body = await readJsonBody(request);
    if (!body.ok || !body.data) return errorResponse('bad_request', 400, corsHeaders, requestId);

    const leaveType = String(body.data.leaveType || '').trim().toLowerCase();
    if (!LEAVE_TYPES.includes(leaveType)) {
        return errorResponse('validation_failed', 422, corsHeaders, requestId, {
            fields: { leaveType: 'Select a valid leave type.' },
        });
    }

    const allocated = Number(body.data.allocated);
    if (!Number.isFinite(allocated) || allocated < 0) {
        return errorResponse('validation_failed', 422, corsHeaders, requestId, {
            fields: { allocated: 'Allocated days must be a non-negative number.' },
        });
    }

    let accessToken;
    try { accessToken = await getServiceAccountAccessToken(env); }
    catch (_e) { return errorResponse('server_error', 500, corsHeaders, requestId); }

    const path = `/leaveBalances/${encodeURIComponent(empId)}/${year}/${leaveType}`;
    let existing;
    try { existing = await rtdbGet(env, accessToken, path); }
    catch (_e) { return errorResponse('server_error', 500, corsHeaders, requestId); }

    const used = existing && typeof existing === 'object' ? (Number(existing.used) || 0) : 0;
    const remaining = Math.max(0, allocated - used);

    try {
        await rtdbSet(env, accessToken, path, { allocated, used, remaining });
    } catch (_e) {
        return errorResponse('server_error', 500, corsHeaders, requestId);
    }

    return jsonResponse({ employeeId: empId, year, leaveType, allocated, used, remaining }, 200, corsHeaders, requestId);
}

/* ----------------------------------------------------------------------------
 * Attendance — working day counter (used by leave day calculation too)
 * ------------------------------------------------------------------------- */

function countWorkingDays(fromISO, toISO) {
    if (!isValidISODate(fromISO) || !isValidISODate(toISO)) return 0;
    const from = new Date(fromISO + 'T00:00:00Z');
    const to = new Date(toISO + 'T00:00:00Z');
    if (from > to) return 0;
    let count = 0;
    const cursor = new Date(from.getTime());
    while (cursor <= to) {
        const dow = cursor.getUTCDay(); // 0 = Sunday
        if (dow !== 0) count += 1;
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return count;
}

/* ============================================================================
 * 13. Router
 * ========================================================================= */

function matchRoute(method, pathname) {
    // --- Exact routes ----------------------------------------------------
    if (method === 'GET'  && pathname === '/health')            return { name: 'health' };
    if (method === 'GET'  && pathname === '/public/config')     return { name: 'publicConfig' };
    if (method === 'GET'  && pathname === '/auth/context')      return { name: 'authContext', requiresAuth: true };
    if (method === 'POST' && pathname === '/admin/bootstrap')   return { name: 'adminBootstrap', requiresAuth: true };
    if (method === 'GET'  && pathname === '/dashboard/summary') return { name: 'dashboardSummary', requiresAuth: true };

    // --- Parameterized routes -------------------------------------------
    // Split the path into non-empty segments and match against simple
    // patterns. Each segment is decoded so IDs containing URL-escaped
    // characters match correctly. Firebase UIDs are URL-safe, but the
    // decoding is applied defensively.
    const parts = pathname.split('/').filter((p) => p.length > 0);

    // /employees
    if (parts.length === 1 && parts[0] === 'employees') {
        if (method === 'GET')  return { name: 'employeesList',   requiresAuth: true };
        if (method === 'POST') return { name: 'employeeCreate',  requiresAuth: true };
    }

    // /employees/:id
    if (parts.length === 2 && parts[0] === 'employees') {
        const employeeId = decodeURIComponent(parts[1]);
        if (method === 'GET')   return { name: 'employeeGet',    requiresAuth: true, params: { employeeId } };
        if (method === 'PATCH') return { name: 'employeeUpdate', requiresAuth: true, params: { employeeId } };
    }

    // /employees/:id/status
    if (parts.length === 3 && parts[0] === 'employees' && parts[2] === 'status') {
        const employeeId = decodeURIComponent(parts[1]);
        if (method === 'PATCH') return { name: 'employeeStatusUpdate', requiresAuth: true, params: { employeeId } };
    }

    // /employees/:id/resend-invite
    if (parts.length === 3 && parts[0] === 'employees' && parts[2] === 'resend-invite') {
        const employeeId = decodeURIComponent(parts[1]);
        if (method === 'POST') return { name: 'employeeResendInvite', requiresAuth: true, params: { employeeId } };
    }

    // /attendance                       -> list (GET)
    if (parts.length === 1 && parts[0] === 'attendance') {
        if (method === 'GET') return { name: 'attendanceList', requiresAuth: true };
    }

    // /attendance/summary               -> summary (GET)
    if (parts.length === 2 && parts[0] === 'attendance' && parts[1] === 'summary') {
        if (method === 'GET') return { name: 'attendanceSummary', requiresAuth: true };
    }

    // /attendance/mark                  -> mark single (POST)
    if (parts.length === 2 && parts[0] === 'attendance' && parts[1] === 'mark') {
        if (method === 'POST') return { name: 'attendanceMark', requiresAuth: true };
    }

    // /attendance/bulk                  -> mark multiple (POST)
    if (parts.length === 2 && parts[0] === 'attendance' && parts[1] === 'bulk') {
        if (method === 'POST') return { name: 'attendanceBulk', requiresAuth: true };
    }

    // /attendance/:employeeId/:date     -> correct (PATCH)
    if (parts.length === 3 && parts[0] === 'attendance') {
        const employeeId = decodeURIComponent(parts[1]);
        const date = decodeURIComponent(parts[2]);
        if (method === 'PATCH') return { name: 'attendanceCorrect', requiresAuth: true, params: { employeeId, date } };
    }

    // /leave/requests
    if (parts.length === 2 && parts[0] === 'leave' && parts[1] === 'requests') {
        if (method === 'GET')  return { name: 'leaveList',   requiresAuth: true };
        if (method === 'POST') return { name: 'leaveApply',  requiresAuth: true };
    }

    // /leave/requests/:id
    if (parts.length === 3 && parts[0] === 'leave' && parts[1] === 'requests') {
        const requestId = decodeURIComponent(parts[2]);
        if (method === 'GET')   return { name: 'leaveGet',    requiresAuth: true, params: { requestId } };
        if (method === 'PATCH') return { name: 'leaveReview', requiresAuth: true, params: { requestId } };
    }

    // /leave/balances/:employeeId/:year
    if (parts.length === 4 && parts[0] === 'leave' && parts[1] === 'balances') {
        const employeeId = decodeURIComponent(parts[2]);
        const year = decodeURIComponent(parts[3]);
        if (method === 'GET')   return { name: 'leaveBalancesGet', requiresAuth: true, params: { employeeId, year } };
        if (method === 'PATCH') return { name: 'leaveBalancesSet', requiresAuth: true, params: { employeeId, year } };
    }

    return null;
}

/* ============================================================================
 * 14. Main fetch handler
 * ========================================================================= */

export default {
    async fetch(request, env, _ctx) {
        const requestId = (crypto && typeof crypto.randomUUID === 'function')
            ? crypto.randomUUID()
            : String(Date.now());

        if (request.method === 'OPTIONS') {
            return handlePreflight(request);
        }

        const origin = request.headers.get('Origin') || '';
        const corsHeaders = getCorsHeaders(origin);

        // Rate limiting. Best-effort: per-isolate Map, not a distributed limit.
        // For production-grade limiting, Cloudflare's own rate limiting rules
        // can be layered on top of this Worker without any code change.
        const rateKey = origin || request.headers.get('CF-Connecting-IP') || 'unknown';
        if (!checkRateLimit(rateKey)) {
            return errorResponse('rate_limited', 429, corsHeaders, requestId);
        }

        let url;
        try {
            url = new URL(request.url);
        } catch (_e) {
            return errorResponse('bad_request', 400, corsHeaders, requestId);
        }

        // Normalize trailing slashes, but keep the root path as "/".
        let pathname = url.pathname;
        if (pathname.length > 1) {
            pathname = pathname.replace(/\/+$/, '');
        }
        if (pathname === '') {
            pathname = '/';
        }

        const route = matchRoute(request.method, pathname);
        if (!route) {
            return errorResponse('not_found', 404, corsHeaders, requestId);
        }

        try {
            switch (route.name) {
                case 'health':
                    return handleHealth(requestId, corsHeaders);
                case 'publicConfig':
                    return handlePublicConfig(env, requestId, corsHeaders);
                case 'authContext':
                    return await handleAuthContext(request, env, requestId, corsHeaders);
                case 'adminBootstrap':
                    return await handleAdminBootstrap(request, env, requestId, corsHeaders);
                case 'dashboardSummary':
                    return await handleDashboardSummary(request, env, requestId, corsHeaders);
                case 'employeesList':
                    return await handleEmployeesList(request, env, requestId, corsHeaders);
                case 'employeeGet':
                    return await handleEmployeeGet(request, env, requestId, corsHeaders, route.params);
                case 'employeeCreate':
                    return await handleEmployeeCreate(request, env, requestId, corsHeaders);
                case 'employeeUpdate':
                    return await handleEmployeeUpdate(request, env, requestId, corsHeaders, route.params);
                case 'employeeStatusUpdate':
                    return await handleEmployeeStatusUpdate(request, env, requestId, corsHeaders, route.params);
                case 'employeeResendInvite':
                    return await handleEmployeeResendInvite(request, env, requestId, corsHeaders, route.params);
                case 'attendanceList':
                    return await handleAttendanceList(request, env, requestId, corsHeaders);
                case 'attendanceSummary':
                    return await handleAttendanceSummary(request, env, requestId, corsHeaders);
                case 'attendanceMark':
                    return await handleAttendanceMark(request, env, requestId, corsHeaders);
                case 'attendanceBulk':
                    return await handleAttendanceBulk(request, env, requestId, corsHeaders);
                case 'attendanceCorrect':
                    return await handleAttendanceCorrect(request, env, requestId, corsHeaders, route.params);
                case 'leaveList':
                    return await handleLeaveList(request, env, requestId, corsHeaders);
                case 'leaveApply':
                    return await handleLeaveApply(request, env, requestId, corsHeaders);
                case 'leaveGet':
                    return await handleLeaveGet(request, env, requestId, corsHeaders, route.params);
                case 'leaveReview':
                    return await handleLeaveReview(request, env, requestId, corsHeaders, route.params);
                case 'leaveBalancesGet':
                    return await handleLeaveBalancesGet(request, env, requestId, corsHeaders, route.params);
                case 'leaveBalancesSet':
                    return await handleLeaveBalancesSet(request, env, requestId, corsHeaders, route.params);
                default:
                    return errorResponse('not_found', 404, corsHeaders, requestId);
            }
        } catch (_err) {
            // Any unhandled error is reported as server_error with no details.
            // The Worker never returns raw error strings, stack traces, or
            // upstream response bodies.
            return errorResponse('server_error', 500, corsHeaders, requestId);
        }
    },
};

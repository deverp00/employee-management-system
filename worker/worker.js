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

    return {
        ok: true,
        context: {
            uid: uid,
            email: typeof userRecord.email === 'string' ? userRecord.email : (decodedToken.email || ''),
            role: role,
            orgId: typeof userRecord.orgId === 'string' ? userRecord.orgId : null,
            employeeId: typeof userRecord.employeeId === 'string' ? userRecord.employeeId : null,
            displayName: typeof userRecord.displayName === 'string' ? userRecord.displayName : '',
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

/* ============================================================================
 * 13. Router
 * ========================================================================= */

function matchRoute(method, pathname) {
    if (method === 'GET'  && pathname === '/health')            return { name: 'health' };
    if (method === 'GET'  && pathname === '/public/config')     return { name: 'publicConfig' };
    if (method === 'GET'  && pathname === '/auth/context')      return { name: 'authContext', requiresAuth: true };
    if (method === 'POST' && pathname === '/admin/bootstrap')   return { name: 'adminBootstrap', requiresAuth: true };
    if (method === 'GET'  && pathname === '/dashboard/summary') return { name: 'dashboardSummary', requiresAuth: true };
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

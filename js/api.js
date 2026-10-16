/**
 * Employee Management & Payroll System
 * Designed and Developed by Yadav Web Technologies
 * ----------------------------------------------------------------------------
 * js/api.js
 *
 * Authenticated API client.
 *
 * Responsibilities:
 *   - The ONLY file in the project that issues authenticated fetch requests
 *     to the Cloudflare Worker. Every module and the shell go through this.
 *   - Attach the current Firebase ID token as a Bearer token on every call.
 *   - On 401, retry once with a freshly forced ID token. If the retry also
 *     returns 401, sign the user out. This is the single place in the
 *     application where an expired session is handled.
 *   - Send JSON bodies and parse JSON responses.
 *   - Convert every failure mode — network, timeout, HTTP error, malformed
 *     body, non-JSON response — into a typed ApiError with a message that
 *     is safe to display to the user.
 *
 * Rules this file enforces:
 *   - No configuration values, credentials, or secrets are stored or
 *     hardcoded here. The Worker base URL comes from js/config.js. The ID
 *     token comes from js/auth.js.
 *   - Raw backend error payloads are never shown to the user. The message
 *     the UI receives is always one of the safe strings defined below.
 *   - Tokens and request bodies are never logged to the console.
 *
 * Exports:
 *   ApiError
 *   apiGet(path, options?)
 *   apiPost(path, body?, options?)
 *   apiPatch(path, body?, options?)
 *   apiPut(path, body?, options?)
 *   apiDelete(path, options?)
 */

import { WORKER_BASE } from './config.js';
import { getIdToken, signOut } from './auth.js';

/* ----------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------- */

/** Default timeout applied to every request when the caller does not provide one. */
const DEFAULT_TIMEOUT_MS = 20000;

/**
 * Safe, user-facing messages for every error code the Worker can return.
 * The Worker's own message string is never surfaced directly, so a change
 * in backend wording can never leak internal details to the browser.
 */
const SAFE_MESSAGES = {
    bad_request:       'The request was not valid.',
    unauthorized:      'Your session has expired. Please sign in again.',
    forbidden:         'You do not have permission to perform this action.',
    not_found:         'The requested record could not be found.',
    conflict:          'This action conflicts with existing data.',
    validation_failed: 'Please check the information you entered.',
    rate_limited:      'Too many requests. Please wait a moment and try again.',
    server_error:      'The server is temporarily unavailable. Please try again.',
    network_error:     'Network unavailable. Check your connection and try again.',
    timeout:           'The request took too long. Please try again.',
    invalid_response:  'The server returned an unexpected response.',
    unknown:           'Something went wrong. Please try again.',
};

/**
 * Fallback mapping from HTTP status to error code when the Worker does not
 * send an explicit code in the response body.
 */
const STATUS_TO_CODE = {
    400: 'bad_request',
    401: 'unauthorized',
    403: 'forbidden',
    404: 'not_found',
    409: 'conflict',
    422: 'validation_failed',
    429: 'rate_limited',
    500: 'server_error',
    502: 'server_error',
    503: 'server_error',
    504: 'server_error',
};

/* ----------------------------------------------------------------------------
 * ApiError
 * ------------------------------------------------------------------------- */

/**
 * Error type raised for every failed API call.
 *
 * Properties:
 *   status    {number}  HTTP status, or 0 for network and timeout failures.
 *   code      {string}  Machine-readable code from the Worker, or a
 *                       client-side fallback such as "network_error".
 *   requestId {string}  Correlation ID returned by the Worker when present.
 *   message   {string}  Safe, user-facing message. Never a raw backend string.
 */
export class ApiError extends Error {
    constructor(message, { status = 0, code = 'unknown', requestId = '', cause = null } = {}) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
        this.requestId = requestId;
        this.cause = cause;
    }
}

/* ----------------------------------------------------------------------------
 * Public API
 * ------------------------------------------------------------------------- */

/**
 * Issues a GET request.
 * @param {string} path
 * @param {{ query?: object, signal?: AbortSignal, timeoutMs?: number }} [options]
 * @returns {Promise<any>}
 */
export function apiGet(path, options = {}) {
    return apiRequest('GET', path, undefined, options);
}

/**
 * Issues a POST request.
 * @param {string} path
 * @param {object} [body]
 * @param {{ query?: object, signal?: AbortSignal, timeoutMs?: number }} [options]
 * @returns {Promise<any>}
 */
export function apiPost(path, body, options = {}) {
    return apiRequest('POST', path, body, options);
}

/**
 * Issues a PATCH request.
 * @param {string} path
 * @param {object} [body]
 * @param {{ query?: object, signal?: AbortSignal, timeoutMs?: number }} [options]
 * @returns {Promise<any>}
 */
export function apiPatch(path, body, options = {}) {
    return apiRequest('PATCH', path, body, options);
}

/**
 * Issues a PUT request.
 * @param {string} path
 * @param {object} [body]
 * @param {{ query?: object, signal?: AbortSignal, timeoutMs?: number }} [options]
 * @returns {Promise<any>}
 */
export function apiPut(path, body, options = {}) {
    return apiRequest('PUT', path, body, options);
}

/**
 * Issues a DELETE request.
 * @param {string} path
 * @param {{ query?: object, signal?: AbortSignal, timeoutMs?: number }} [options]
 * @returns {Promise<any>}
 */
export function apiDelete(path, options = {}) {
    return apiRequest('DELETE', path, undefined, options);
}

/* ----------------------------------------------------------------------------
 * Core request
 * ------------------------------------------------------------------------- */

async function apiRequest(method, path, body, options) {
    const url = buildUrl(path, options.query);
    const timeoutMs = typeof options.timeoutMs === 'number'
        ? options.timeoutMs
        : DEFAULT_TIMEOUT_MS;

    const firstResponse = await attemptRequest({
        method,
        url,
        body,
        timeoutMs,
        signal: options.signal,
        forceRefresh: false,
    });

    // Silent token refresh: exactly one retry, exactly one forced token
    // refresh. If the retry also returns 401, the session is unrecoverable
    // and the user is signed out. This is the only place in the whole
    // application that reacts to an expired session.
    if (firstResponse.status === 401) {
        const retryResponse = await attemptRequest({
            method,
            url,
            body,
            timeoutMs,
            signal: options.signal,
            forceRefresh: true,
        });

        if (retryResponse.status === 401) {
            // Session is unrecoverable. Sign out. signOut() will redirect
            // the shell to the login page; the error we throw here is a
            // courtesy for any caller that happens to observe it before
            // the redirect completes.
            try { await signOut(); } catch (_err) { /* ignored */ }
            throw new ApiError(SAFE_MESSAGES.unauthorized, {
                status: 401,
                code: 'unauthorized',
            });
        }

        return finalizeResponse(retryResponse);
    }

    return finalizeResponse(firstResponse);
}

/**
 * Performs one network attempt and returns the raw Response object so that
 * the caller can decide whether a retry is needed.
 *
 * @returns {Promise<Response>}
 */
async function attemptRequest({ method, url, body, timeoutMs, signal, forceRefresh }) {
    let token;
    try {
        token = await getIdToken(forceRefresh);
    } catch (err) {
        // No session available. Convert to an ApiError instead of leaking
        // the internal Firebase error to the caller.
        throw new ApiError(SAFE_MESSAGES.unauthorized, {
            status: 401,
            code: 'unauthorized',
            cause: err,
        });
    }

    const headers = {
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
    };

    let payload;
    if (body !== undefined && body !== null) {
        headers['Content-Type'] = 'application/json';
        try {
            payload = JSON.stringify(body);
        } catch (err) {
            throw new ApiError('Unable to prepare the request.', {
                status: 0,
                code: 'bad_request',
                cause: err,
            });
        }
    }

    const init = {
        method,
        headers,
        body: payload,
        // Bearer tokens are used, so cookies are not needed. Omitting
        // credentials prevents a cross-origin request from reusing a
        // session and matches the Worker's CORS configuration.
        credentials: 'omit',
    };

    try {
        return await fetchWithTimeout(url, init, timeoutMs, signal);
    } catch (err) {
        if (err instanceof ApiError) throw err;
        if (isAbortError(err)) {
            // Caller-initiated abort. Rethrow as a distinguishable error so
            // modules can silently ignore it on unmount without showing a
            // toast to the user.
            throw new ApiError('Request was cancelled.', {
                status: 0,
                code: 'aborted',
                cause: err,
            });
        }
        if (isTimeoutError(err)) {
            throw new ApiError(SAFE_MESSAGES.timeout, {
                status: 0,
                code: 'timeout',
                cause: err,
            });
        }
        throw new ApiError(SAFE_MESSAGES.network_error, {
            status: 0,
            code: 'network_error',
            cause: err,
        });
    }
}

/**
 * Parses the response body and either returns the parsed data or throws an
 * ApiError built from the response status and payload.
 */
async function finalizeResponse(response) {
    const payload = await readJsonSafely(response);
    if (response.ok) {
        return payload;
    }
    throw apiErrorFromResponse(response, payload);
}

/* ----------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

function buildUrl(path, query) {
    if (typeof path !== 'string' || path.length === 0) {
        throw new TypeError('apiRequest requires a non-empty path.');
    }

    // Disallow absolute URLs so that callers cannot bypass the Worker base
    // and accidentally send their Bearer token to a different origin.
    if (/^https?:\/\//i.test(path) || path.startsWith('//')) {
        throw new TypeError('apiRequest path must be relative to the Worker base.');
    }

    const normalizedPath = path.startsWith('/') ? path : '/' + path;
    const base = WORKER_BASE.replace(/\/+$/, '');
    const url = new URL(base + normalizedPath);

    if (query && typeof query === 'object') {
        for (const [key, value] of Object.entries(query)) {
            if (value === undefined || value === null) continue;

            if (Array.isArray(value)) {
                for (const item of value) {
                    if (item === undefined || item === null) continue;
                    url.searchParams.append(key, String(item));
                }
            } else if (value === '') {
                // Skip empty-string filters rather than sending `?key=` to
                // the backend, where it would be treated as an active filter.
                continue;
            } else {
                url.searchParams.append(key, String(value));
            }
        }
    }

    return url.toString();
}

async function fetchWithTimeout(url, init, timeoutMs, externalSignal) {
    const controller = new AbortController();
    let abortReason = null; // 'timeout' | 'external' | null

    const timer = setTimeout(() => {
        if (!abortReason) abortReason = 'timeout';
        controller.abort();
    }, timeoutMs);

    let abortListener = null;
    if (externalSignal) {
        if (externalSignal.aborted) {
            abortReason = 'external';
            clearTimeout(timer);
            controller.abort();
        } else {
            abortListener = () => {
                if (!abortReason) abortReason = 'external';
                controller.abort();
            };
            externalSignal.addEventListener('abort', abortListener, { once: true });
        }
    }

    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
        if (abortReason === 'timeout') {
            const timeoutErr = new Error('Request timed out.');
            timeoutErr.name = 'TimeoutError';
            throw timeoutErr;
        }
        if (abortReason === 'external') {
            const abortErr = new Error('Request aborted by caller.');
            abortErr.name = 'AbortError';
            throw abortErr;
        }
        throw err;
    } finally {
        clearTimeout(timer);
        if (externalSignal && abortListener) {
            externalSignal.removeEventListener('abort', abortListener);
        }
    }
}

async function readJsonSafely(response) {
    // 204 No Content and empty bodies are legitimate for some endpoints.
    const text = await response.text();
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch (_err) {
        // Non-JSON body. Return null and let apiErrorFromResponse fall back
        // to the HTTP status mapping.
        return null;
    }
}

function apiErrorFromResponse(response, payload) {
    const status = response.status;

    const errorObject = payload
        && typeof payload === 'object'
        && payload.error
        && typeof payload.error === 'object'
        ? payload.error
        : null;

    const workerCode = errorObject && typeof errorObject.code === 'string'
        ? errorObject.code
        : '';

    const requestId = errorObject && typeof errorObject.requestId === 'string'
        ? errorObject.requestId
        : '';

    const fallbackCode = STATUS_TO_CODE[status] || 'unknown';
    const code = workerCode || fallbackCode;

    // The message is looked up from the safe table. The Worker's message
    // string is intentionally discarded so that no backend detail can leak
    // through the UI, even if the backend is later changed to include more
    // context in its error payloads.
    const message = SAFE_MESSAGES[code] || SAFE_MESSAGES.unknown;

    return new ApiError(message, { status, code, requestId });
}

function isAbortError(err) {
    return Boolean(err) && err.name === 'AbortError';
}

function isTimeoutError(err) {
    return Boolean(err) && err.name === 'TimeoutError';
}

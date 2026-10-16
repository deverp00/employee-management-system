/**
 * Employee Management & Payroll System
 * Designed and Developed by Yadav Web Technologies
 * ----------------------------------------------------------------------------
 * js/config.js
 *
 * Runtime configuration and Firebase initialization.
 *
 * Responsibilities:
 *   - Fetch the public Firebase web configuration from the Cloudflare Worker
 *     at GET /public/config. Values are never hardcoded into the source.
 *   - Initialize the Firebase app exactly once per page load.
 *   - Initialize Firebase Authentication exactly once per page load.
 *   - Expose a small, stable API used by every other module.
 *
 * This file is the ONLY place that calls initializeApp() or getAuth(), and
 * the ONLY place that knows the Cloudflare Worker base URL. All other files
 * import from here.
 */

/* ----------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------- */

/**
 * Cloudflare Worker base URL.
 *
 * This URL is public — it is the API endpoint the frontend talks to. It is
 * not a secret, and it does not carry credentials. All sensitive values live
 * behind it, inside the Worker's environment and Cloudflare Secrets.
 */
export const WORKER_BASE = 'https://employee-management-api.yadavsubba2003.workers.dev';

/** Path on the Worker that returns the public Firebase web configuration. */
const PUBLIC_CONFIG_PATH = '/public/config';

/** Firebase JS SDK version, pinned for stability. */
const FIREBASE_SDK_VERSION = '10.14.1';

/** Firebase SDK module URLs (modular, ES module builds). */
const FIREBASE_APP_URL  = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-app.js`;
const FIREBASE_AUTH_URL = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-auth.js`;

/** How long to wait for the runtime config before giving up (milliseconds). */
const CONFIG_FETCH_TIMEOUT_MS = 10000;

/**
 * Configuration keys the frontend requires in order to initialize Firebase
 * Authentication and to remain forward-compatible with other Firebase
 * services. If the Worker omits any of these, initialization stops and an
 * error is thrown — this is intentional, so a misconfigured backend cannot
 * silently degrade the application.
 */
const REQUIRED_CONFIG_KEYS = [
    'apiKey',
    'authDomain',
    'projectId',
    'appId',
    'databaseURL',
];

/* ----------------------------------------------------------------------------
 * Errors
 * ------------------------------------------------------------------------- */

/**
 * Error type raised for any configuration or initialization failure.
 * Callers can distinguish configuration problems from authentication or
 * network failures by checking `error instanceof ConfigError`.
 */
export class ConfigError extends Error {
    constructor(message, cause) {
        super(message);
        this.name = 'ConfigError';
        this.cause = cause;
    }
}

/* ----------------------------------------------------------------------------
 * Module-level singletons
 * ------------------------------------------------------------------------- */

let runtimeConfigPromise = null;
let firebaseAppPromise = null;
let firebaseAuthPromise = null;
let authSdkPromise = null;

/* ----------------------------------------------------------------------------
 * Public API — runtime configuration
 * ------------------------------------------------------------------------- */

/**
 * Returns the runtime configuration fetched from the Worker.
 * The result is cached for the lifetime of the page. A failed fetch is not
 * cached, so a subsequent call can retry.
 *
 * @returns {Promise<Readonly<object>>}
 */
export function getRuntimeConfig() {
    if (!runtimeConfigPromise) {
        runtimeConfigPromise = fetchRuntimeConfig().catch((err) => {
            runtimeConfigPromise = null;
            throw err;
        });
    }
    return runtimeConfigPromise;
}

/* ----------------------------------------------------------------------------
 * Public API — Firebase
 * ------------------------------------------------------------------------- */

/**
 * Returns the initialized Firebase app singleton.
 *
 * @returns {Promise<import('firebase/app').FirebaseApp>}
 */
export function getFirebaseApp() {
    if (!firebaseAppPromise) {
        firebaseAppPromise = initFirebaseApp().catch((err) => {
            firebaseAppPromise = null;
            throw err;
        });
    }
    return firebaseAppPromise;
}

/**
 * Returns the initialized Firebase Authentication instance singleton.
 *
 * @returns {Promise<import('firebase/auth').Auth>}
 */
export function getFirebaseAuth() {
    if (!firebaseAuthPromise) {
        firebaseAuthPromise = initFirebaseAuth().catch((err) => {
            firebaseAuthPromise = null;
            throw err;
        });
    }
    return firebaseAuthPromise;
}

/**
 * Returns the Firebase Authentication SDK module.
 *
 * The modular Firebase SDK exposes its functions (signInWithEmailAndPassword,
 * signOut, onAuthStateChanged, and so on) as named exports of a module rather
 * than as methods of the Auth instance. This helper gives every caller a
 * single, cached access point to that module, so the URL is defined in one
 * place only.
 *
 * @returns {Promise<typeof import('firebase/auth')>}
 */
export function getAuthSdk() {
    if (!authSdkPromise) {
        authSdkPromise = import(FIREBASE_AUTH_URL).catch((err) => {
            authSdkPromise = null;
            throw err;
        });
    }
    return authSdkPromise;
}

/* ----------------------------------------------------------------------------
 * Internal — runtime configuration
 * ------------------------------------------------------------------------- */

async function fetchRuntimeConfig() {
    const url = `${WORKER_BASE}${PUBLIC_CONFIG_PATH}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG_FETCH_TIMEOUT_MS);

    let response;
    try {
        response = await fetch(url, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            signal: controller.signal,
            cache: 'no-store',
            credentials: 'omit',
        });
    } catch (err) {
        clearTimeout(timer);
        if (err && err.name === 'AbortError') {
            throw new ConfigError('Loading the runtime configuration timed out.');
        }
        throw new ConfigError('Unable to reach the backend service.', err);
    }
    clearTimeout(timer);

    if (!response.ok) {
        throw new ConfigError(
            `Runtime configuration request failed with status ${response.status}.`
        );
    }

    let data;
    try {
        data = await response.json();
    } catch (err) {
        throw new ConfigError('The runtime configuration response was not valid JSON.', err);
    }

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new ConfigError('The runtime configuration response was empty or malformed.');
    }

    for (const key of REQUIRED_CONFIG_KEYS) {
        const value = data[key];
        if (typeof value !== 'string' || value.trim() === '') {
            throw new ConfigError(
                `The runtime configuration is missing a required value for "${key}".`
            );
        }
    }

    return Object.freeze({
        apiKey:             data.apiKey,
        authDomain:         data.authDomain,
        projectId:          data.projectId,
        appId:              data.appId,
        databaseURL:        data.databaseURL,
        storageBucket:      typeof data.storageBucket === 'string'      ? data.storageBucket      : undefined,
        messagingSenderId:  typeof data.messagingSenderId === 'string'  ? data.messagingSenderId  : undefined,
        measurementId:      typeof data.measurementId === 'string'      ? data.measurementId      : undefined,
    });
}

/* ----------------------------------------------------------------------------
 * Internal — Firebase initialization
 * ------------------------------------------------------------------------- */

async function initFirebaseApp() {
    const [firebaseAppModule, config] = await Promise.all([
        import(FIREBASE_APP_URL),
        getRuntimeConfig(),
    ]);

    const { initializeApp, getApps, getApp } = firebaseAppModule;

    // If any Firebase app has already been created on this page, reuse it.
    // This guards against double initialization even if config.js were ever
    // imported from multiple entry points.
    if (getApps().length > 0) {
        return getApp();
    }

    return initializeApp({
        apiKey:             config.apiKey,
        authDomain:         config.authDomain,
        projectId:          config.projectId,
        appId:              config.appId,
        databaseURL:        config.databaseURL,
        storageBucket:      config.storageBucket,
        messagingSenderId:  config.messagingSenderId,
        measurementId:      config.measurementId,
    });
}

async function initFirebaseAuth() {
    const [app, firebaseAuthModule] = await Promise.all([
        getFirebaseApp(),
        import(FIREBASE_AUTH_URL),
    ]);

    const { getAuth } = firebaseAuthModule;

    return getAuth(app);
}

/**
 * Employee Management & Payroll System
 * Designed and Developed by Yadav Web Technologies
 * ----------------------------------------------------------------------------
 * js/auth.js
 *
 * Single authentication controller.
 *
 * Responsibilities:
 *   - Provide the login page with a fully wired sign in form.
 *   - Expose the current session and current user to the rest of the app.
 *   - Provide ID tokens to the API client for authenticated requests.
 *   - Own the entire sign in / sign out lifecycle.
 *
 * Rules this file enforces:
 *   - It is the ONLY file in the project that imports the Firebase Auth SDK.
 *   - It contains no configuration values, no credentials, no secrets.
 *     All Firebase configuration arrives at runtime through js/config.js.
 *   - It never trusts a role, a user record, or a permission from the
 *     frontend. Roles and permissions are resolved exclusively by the
 *     Cloudflare Worker via /auth/context and enforced on every endpoint.
 *   - It registers exactly one onAuthStateChanged listener per page load.
 *
 * Exports:
 *   initLoginPage()      -> wires the login form on index.html
 *   observeSession(cb)   -> subscribe to session state; returns unsubscribe
 *   getCurrentUser()     -> returns the current Firebase user, or null
 *   getIdToken(refresh?) -> returns a valid ID token for API calls
 *   signIn(email, pass)  -> performs Firebase email/password sign in
 *   signOut()            -> signs out and redirects to the login page
 */

import {
    getFirebaseAuth,
    getAuthSdk,
    ConfigError,
} from './config.js';

/* ----------------------------------------------------------------------------
 * Module state
 * ------------------------------------------------------------------------- */

/**
 * Promise that resolves to { auth, sdk } once Firebase Auth is initialized
 * and the single onAuthStateChanged listener has been attached. Reset to
 * null on failure so a retry is possible.
 */
let authInitPromise = null;

/** The current Firebase user, or null when signed out. */
let currentUser = null;

/** True once the initial onAuthStateChanged callback has fired. */
let initialSessionResolved = false;

/** Promise that resolves the first time the session state is known. */
let initialSessionPromise = null;

/** Registered session observers. Each entry is a function (user) => void. */
const sessionCallbacks = new Set();

/** Idempotency guard for login page setup. */
let loginPageSetupPromise = null;

/* ----------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------- */

const LOGIN_PAGE = './index.html';
const APP_PAGE   = './app.html';

const BTN_IDLE_LABEL      = 'Sign in';
const BTN_SUBMIT_LABEL    = 'Signing in…';
const BTN_PREPARING_LABEL = 'Preparing sign in…';

/* ----------------------------------------------------------------------------
 * Public API — login page
 * ------------------------------------------------------------------------- */

/**
 * Wires up the login form. Safe to call multiple times; only runs once.
 *
 * @returns {Promise<void>}
 */
export function initLoginPage() {
    if (!loginPageSetupPromise) {
        loginPageSetupPromise = setupLoginPage().catch((err) => {
            loginPageSetupPromise = null;
            throw err;
        });
    }
    return loginPageSetupPromise;
}

/* ----------------------------------------------------------------------------
 * Public API — session observation
 * ------------------------------------------------------------------------- */

/**
 * Subscribes to session state changes. The callback receives the current
 * Firebase user object, or null when signed out.
 *
 * The callback is invoked:
 *   - once when the initial session state becomes known,
 *   - subsequently on every sign in and sign out.
 *
 * If the session state is already known at the time of subscription, the
 * callback is invoked on a microtask with the current value.
 *
 * @param {(user: object|null) => void} callback
 * @returns {() => void} unsubscribe function
 */
export function observeSession(callback) {
    if (typeof callback !== 'function') {
        throw new TypeError('observeSession requires a callback function.');
    }

    sessionCallbacks.add(callback);

    if (initialSessionResolved) {
        queueMicrotask(() => {
            if (!sessionCallbacks.has(callback)) return;
            safeInvoke(callback, currentUser);
        });
    }

    // Ensure the auth listener is attached. If initialization fails, drop
    // the callback silently — the caller can detect failure elsewhere.
    ensureAuth().catch(() => {
        sessionCallbacks.delete(callback);
    });

    return () => {
        sessionCallbacks.delete(callback);
    };
}

/* ----------------------------------------------------------------------------
 * Public API — current session
 * ------------------------------------------------------------------------- */

/**
 * Returns the current Firebase user, or null. Synchronous; reflects the
 * most recent session state. Does not wait for the initial session event.
 *
 * @returns {object|null}
 */
export function getCurrentUser() {
    return currentUser;
}

/**
 * Returns a valid Firebase ID token for the current user.
 *
 * @param {boolean} [forceRefresh=false]
 * @returns {Promise<string>}
 * @throws {Error} if no user is signed in.
 */
export async function getIdToken(forceRefresh = false) {
    await ensureAuth();
    await waitForInitialSession();

    if (!currentUser) {
        const err = new Error('No authenticated user.');
        err.code = 'auth/no-current-user';
        throw err;
    }

    return currentUser.getIdToken(forceRefresh === true);
}

/* ----------------------------------------------------------------------------
 * Public API — sign in / sign out
 * ------------------------------------------------------------------------- */

/**
 * Signs in with email and password.
 * Returns the Firebase user on success. Throws the underlying Firebase
 * error on failure — callers are expected to map it to a UI message via
 * mapAuthError() or handle it directly.
 *
 * This function does NOT redirect. Navigation on success is driven by the
 * observeSession subscription set up in initLoginPage(), so that there is
 * exactly one place that decides where an authenticated user goes.
 *
 * @param {string} email
 * @param {string} password
 * @returns {Promise<object>}
 */
export async function signIn(email, password) {
    const { auth, sdk } = await ensureAuth();
    const credential = await sdk.signInWithEmailAndPassword(auth, email, password);
    return credential.user;
}

/**
 * Signs out the current user and redirects to the login page.
 * Redirects even if the sign out call fails, so the user is never left
 * staring at a broken authenticated page.
 *
 * @returns {Promise<void>}
 */
export async function signOut() {
    try {
        const { auth, sdk } = await ensureAuth();
        try {
            await sdk.signOut(auth);
        } catch (_err) {
            // Ignore; we redirect regardless.
        }
    } catch (_err) {
        // Auth was never initialized; still redirect.
    }
    redirectToLogin();
}

/**
 * Maps a Firebase authentication error to a user facing message.
 * Exported so callers can render their own error UI if needed.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function mapAuthError(error) {
    const code = error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : '';

    switch (code) {
        case 'auth/invalid-email':
        case 'auth/missing-email':
            return 'Enter a valid email address.';

        case 'auth/missing-password':
            return 'Enter your password.';

        case 'auth/user-disabled':
            return 'This account has been disabled. Please contact your administrator.';

        // Firebase deliberately does not distinguish between a missing user
        // and a wrong password for these sign-in flows; we mirror that here
        // to avoid disclosing which addresses are registered.
        case 'auth/user-not-found':
        case 'auth/wrong-password':
        case 'auth/invalid-credential':
            return 'Email or password is incorrect.';

        case 'auth/too-many-requests':
            return 'Too many attempts. Please wait a moment and try again.';

        case 'auth/network-request-failed':
            return 'Network unavailable. Check your connection and try again.';

        case 'auth/operation-not-allowed':
            return 'Email and password sign in is not enabled for this project.';

        case 'auth/invalid-api-key':
            return 'Sign in is unavailable right now. Please try again later.';

        default:
            return 'Unable to sign in right now. Please try again.';
    }
}

/* ----------------------------------------------------------------------------
 * Internal — auth initialization
 * ------------------------------------------------------------------------- */

/**
 * Initializes Firebase Auth and attaches the single onAuthStateChanged
 * listener. Idempotent. Concurrent callers all receive the same promise.
 *
 * @returns {Promise<{ auth: object, sdk: object }>}
 */
function ensureAuth() {
    if (!authInitPromise) {
        authInitPromise = (async () => {
            const [auth, sdk] = await Promise.all([
                getFirebaseAuth(),
                getAuthSdk(),
            ]);
            sdk.onAuthStateChanged(auth, handleAuthStateChange);
            return { auth, sdk };
        })().catch((err) => {
            authInitPromise = null;
            throw err;
        });
    }
    return authInitPromise;
}

/**
 * The single onAuthStateChanged handler for the whole application.
 *
 * @param {object|null} user
 */
function handleAuthStateChange(user) {
    currentUser = user || null;
    initialSessionResolved = true;

    // Snapshot to protect against mutation during iteration.
    const snapshot = Array.from(sessionCallbacks);
    for (const cb of snapshot) {
        if (!sessionCallbacks.has(cb)) continue;
        safeInvoke(cb, currentUser);
    }
}

/**
 * Resolves the first time the session state is known.
 * @returns {Promise<void>}
 */
function waitForInitialSession() {
    if (initialSessionResolved) return Promise.resolve();

    if (!initialSessionPromise) {
        initialSessionPromise = new Promise((resolve) => {
            let done = false;
            observeSession(() => {
                if (done) return;
                done = true;
                resolve();
            });
        });
    }
    return initialSessionPromise;
}

/* ----------------------------------------------------------------------------
 * Internal — login page wiring
 * ------------------------------------------------------------------------- */

async function setupLoginPage() {
    const form          = document.getElementById('login-form');
    const emailInput    = document.getElementById('email');
    const passwordInput = document.getElementById('password');
    const submitBtn     = document.getElementById('login-submit');
    const alertEl       = document.getElementById('login-alert');
    const emailError    = document.getElementById('email-error');
    const passwordError = document.getElementById('password-error');

    // If the login markup is not present, this page is not the login page.
    // Do nothing and let the caller proceed. This keeps the module safe to
    // import from any context.
    if (!form || !emailInput || !passwordInput || !submitBtn) {
        return;
    }

    let submitting = false;

    // When a session exists, go straight to the app shell. This covers the
    // "user already signed in, opens index.html" case without any duplicate
    // redirect logic in the page itself.
    observeSession((user) => {
        if (user) {
            redirectToApp();
        }
    });

    // Enable the form once the initial session state is known. Until then,
    // the button stays disabled with the "Preparing sign in…" label that
    // index.html ships with. This prevents a sign in attempt against an
    // uninitialized Firebase project.
    observeSession(() => {
        setButtonState(submitBtn, {
            disabled: false,
            label: BTN_IDLE_LABEL,
        });
    });

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (submitting) return;

        clearFieldError(emailInput, emailError);
        clearFieldError(passwordInput, passwordError);
        hideAlert(alertEl);

        const email    = String(emailInput.value || '').trim();
        const password = String(passwordInput.value || '');

        const emailCheck = validateEmail(email);
        if (!emailCheck.ok) {
            showFieldError(emailInput, emailError, emailCheck.message);
            emailInput.focus();
            return;
        }
        if (!password) {
            showFieldError(passwordInput, passwordError, 'Enter your password.');
            passwordInput.focus();
            return;
        }

        submitting = true;
        setButtonState(submitBtn, { disabled: true, label: BTN_SUBMIT_LABEL });

        try {
            await signIn(email, password);
            // On success, the observeSession callback above will navigate
            // to the app. We deliberately do nothing else here so that
            // navigation is decided in exactly one place.
        } catch (err) {
            submitting = false;
            setButtonState(submitBtn, { disabled: false, label: BTN_IDLE_LABEL });

            if (err instanceof ConfigError) {
                showAlert(alertEl, err.message);
                return;
            }
            showAlert(alertEl, mapAuthError(err));
        }
    });

    // Live re-validation: clear field error once the user starts fixing it.
    emailInput.addEventListener('input', () => {
        if (emailInput.classList.contains('has-error')) {
            clearFieldError(emailInput, emailError);
        }
    });
    passwordInput.addEventListener('input', () => {
        if (passwordInput.classList.contains('has-error')) {
            clearFieldError(passwordInput, passwordError);
        }
    });
}

/* ----------------------------------------------------------------------------
 * Internal — navigation helpers
 * ------------------------------------------------------------------------- */

function redirectToApp() {
    if (!isCurrentPage('app.html')) {
        window.location.replace(APP_PAGE);
    }
}

function redirectToLogin() {
    // Only redirect if we are on the app page. If we are already on the
    // login page (or anything else), do nothing. This prevents redirect
    // loops even if signOut is called from an unexpected context.
    if (isCurrentPage('app.html')) {
        window.location.replace(LOGIN_PAGE);
    }
}

function isCurrentPage(filename) {
    const path = window.location.pathname;
    return path.endsWith('/' + filename) || path.endsWith(filename);
}

/* ----------------------------------------------------------------------------
 * Internal — DOM helpers
 * ------------------------------------------------------------------------- */

function setButtonState(button, { disabled, label }) {
    if (!button) return;
    button.disabled = Boolean(disabled);
    if (typeof label === 'string') {
        button.textContent = label;
    }
}

function showAlert(el, message) {
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
}

function hideAlert(el) {
    if (!el) return;
    el.textContent = '';
    el.hidden = true;
}

function showFieldError(input, errorEl, message) {
    if (input) {
        input.classList.add('has-error');
        input.setAttribute('aria-invalid', 'true');
    }
    if (errorEl) {
        errorEl.textContent = message;
        errorEl.hidden = false;
    }
}

function clearFieldError(input, errorEl) {
    if (input) {
        input.classList.remove('has-error');
        input.removeAttribute('aria-invalid');
    }
    if (errorEl) {
        errorEl.textContent = '';
        errorEl.hidden = true;
    }
}

/* ----------------------------------------------------------------------------
 * Internal — validation
 * ------------------------------------------------------------------------- */

function validateEmail(email) {
    if (!email) {
        return { ok: false, message: 'Enter your email address.' };
    }
    // Deliberately permissive: real validation happens at Firebase and in
    // the Worker. This only catches obvious typos before a network round
    // trip. It is not intended to be RFC 5322 compliant.
    const pattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!pattern.test(email)) {
        return { ok: false, message: 'Enter a valid email address.' };
    }
    return { ok: true };
}

/* ----------------------------------------------------------------------------
 * Internal — misc
 * ------------------------------------------------------------------------- */

function safeInvoke(fn, arg) {
    try {
        fn(arg);
    } catch (_err) {
        // Isolate listener failures so one bad subscriber cannot block the
        // rest of the application from receiving session updates.
    }
}

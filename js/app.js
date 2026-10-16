/**
 * Employee Management & Payroll System
 * Designed and Developed by Yadav Web Technologies
 * ----------------------------------------------------------------------------
 * js/app.js
 *
 * Application shell bootstrap.
 *
 * Responsibilities:
 *   - Subscribe to the session lifecycle via js/auth.js.
 *   - Fetch the authoritative authorization context from the Worker via
 *     js/api.js (GET /auth/context). The role that drives the entire portal
 *     comes from this response, never from any frontend value.
 *   - Populate the shell — portal title, sidebar navigation, user name,
 *     user role, sign out — from the verified context.
 *   - Start the hash router in js/ui.js on the role's default route.
 *   - Wire the mobile drawer, backdrop, close button, escape key, and
 *     resize handling.
 *   - Reveal the shell only after the context is verified. Until then, the
 *     bootstrap state is shown.
 *
 * Rules this file enforces:
 *   - The role is read from the /auth/context response. It is never read
 *     from the login page, the URL, localStorage, sessionStorage, or the
 *     Firebase token itself.
 *   - No role-specific string is written into the shell here. The portal
 *     title comes from js/ui.js, which is the single source of role labels.
 *   - No global page transitions, no animation controller. The shell is
 *     mounted once and stays mounted. Only the router's content outlet
 *     changes on navigation.
 *   - Session state changes are handled distinctly:
 *       signed out                    -> redirect to index.html
 *       unprovisioned or disabled     -> clear bootstrap error
 *       expired session               -> sign out, clear bootstrap error
 *       network or backend unavailable-> bootstrap error with retry
 *     None of these cause a redirect loop.
 */

import { observeSession, signOut } from './auth.js';
import { apiGet, ApiError } from './api.js';
import {
    getPortalConfig,
    getRoleLabel,
    getDefaultRoute,
    renderNavigation,
    createRouter,
    debounce,
} from './ui.js';

/* ============================================================================
 * Constants
 * ========================================================================= */

const LOGIN_PAGE = './index.html';

/**
 * If the shell has not resolved a context within this window, show a
 * retryable error. This is a safety net for cases like: config fetch hangs,
 * Firebase initialization silently fails, or the session never resolves.
 */
const BOOTSTRAP_TIMEOUT_MS = 15000;

/** Desktop breakpoint, matching css/style.css. */
const DESKTOP_MIN_WIDTH = 1024;

/* ============================================================================
 * Module state
 * ========================================================================= */

const dom = {
    bootstrap:          null,
    bootstrapTitle:     null,
    bootstrapMessage:   null,
    bootstrapSpinner:   null,
    bootstrapActions:   null,

    shell:              null,
    sidebar:            null,
    sidebarClose:       null,
    sidebarOrgName:     null,
    sidebarPortalTitle: null,
    sidebarNavList:     null,
    sidebarUserName:    null,
    sidebarUserRole:    null,

    backdrop:           null,
    menuBtn:            null,

    headerPortalTitle:  null,
    headerOrgName:      null,
    headerUserName:     null,
    signOutBtn:         null,

    content:            null,
    contentInner:       null,
    breadcrumbs:        null,
};

let contextResolved = false;
let controlsWired = false;
let router = null;
let unsubscribeSession = null;
let bootstrapTimer = null;
let redirecting = false;

/* ============================================================================
 * Bootstrap
 * ========================================================================= */

function init() {
    cacheDom();

    // If the shell markup is not present, this page is not the shell.
    // Do nothing — no errors, no redirects. This keeps the module safe to
    // import from any context.
    if (!dom.bootstrap || !dom.shell) {
        return;
    }

    // Start hidden shell / visible bootstrap.
    dom.bootstrap.hidden = false;
    dom.shell.hidden = true;
    showBootstrapLoading(
        'Preparing your workspace',
        'Verifying your session and loading your portal.'
    );

    // Safety net: if nothing resolves within the timeout, show a retry.
    bootstrapTimer = setTimeout(() => {
        if (!contextResolved) {
            showBootstrapError(
                'Taking too long',
                'The application could not reach the backend. Reload the page to try again.',
                { retry: true }
            );
        }
    }, BOOTSTRAP_TIMEOUT_MS);

    unsubscribeSession = observeSession(handleSession);
}

function cacheDom() {
    dom.bootstrap          = document.getElementById('app-bootstrap');
    dom.bootstrapTitle     = document.getElementById('app-bootstrap-title');
    dom.bootstrapMessage   = document.getElementById('app-bootstrap-message');
    dom.bootstrapSpinner   = document.getElementById('app-bootstrap-spinner');
    dom.bootstrapActions   = document.getElementById('app-bootstrap-actions');

    dom.shell              = document.getElementById('app-shell');
    dom.sidebar            = document.getElementById('app-sidebar');
    dom.sidebarClose       = document.getElementById('sidebar-close');
    dom.sidebarOrgName     = document.getElementById('sidebar-org-name');
    dom.sidebarPortalTitle = document.getElementById('sidebar-portal-title');
    dom.sidebarNavList     = document.getElementById('sidebar-nav-list');
    dom.sidebarUserName    = document.getElementById('sidebar-user-name');
    dom.sidebarUserRole    = document.getElementById('sidebar-user-role');

    dom.backdrop           = document.getElementById('app-backdrop');
    dom.menuBtn            = document.getElementById('header-menu-btn');

    dom.headerPortalTitle  = document.getElementById('header-portal-title');
    dom.headerOrgName      = document.getElementById('header-org-name');
    dom.headerUserName     = document.getElementById('header-user-name');
    dom.signOutBtn         = document.getElementById('header-signout');

    dom.content            = document.getElementById('app-content');
    dom.contentInner       = document.getElementById('app-content-inner');
    dom.breadcrumbs        = document.getElementById('app-breadcrumbs');
}

/* ============================================================================
 * Session handling
 * ========================================================================= */

function handleSession(user) {
    if (!user) {
        // No session on the shell page. Redirect to login.
        redirectToLogin();
        return;
    }

    // A user session exists. Resolve the context exactly once. Subsequent
    // session fires (token refresh, for example) must not re-fetch.
    if (contextResolved) return;
    contextResolved = true;

    if (bootstrapTimer) {
        clearTimeout(bootstrapTimer);
        bootstrapTimer = null;
    }

    loadContext();
}

async function loadContext() {
    showBootstrapLoading(
        'Preparing your workspace',
        'Verifying your session and loading your portal.'
    );

    let context;
    try {
        context = await apiGet('/auth/context');
    } catch (err) {
        handleContextError(err);
        return;
    }

    if (!context || typeof context !== 'object' || Array.isArray(context)) {
        showBootstrapError(
            'Unable to load your account',
            'The server returned an unexpected response. Please try again.',
            { retry: true }
        );
        return;
    }

    const role = typeof context.role === 'string' ? context.role : '';
    const portal = getPortalConfig(role);
    if (!portal) {
        showBootstrapError(
            'Account not recognized',
            'Your account is not configured for this application. Please contact your administrator.',
            { signInLink: true }
        );
        return;
    }

    mountShell(context, portal);
}

function handleContextError(err) {
    if (err instanceof ApiError) {
        // Session expired. The API client already triggered sign out and
        // a redirect from within js/auth.js. Do not redirect again — just
        // show a clear message in case the user is still looking at the
        // page during the transition.
        if (err.status === 401) {
            // Distinguish a real session expiry from a config/bootstrap
            // failure that the API client wrapped as 401. The wrapped
            // failure will have a ConfigError as its cause.
            const cause = err && err.cause;
            if (cause && cause.name === 'ConfigError') {
                showBootstrapError(
                    'Unable to reach the server',
                    'The application could not load its configuration. Please try again.',
                    { retry: true }
                );
                return;
            }
            showBootstrapError(
                'Session expired',
                'Your session has expired. Please sign in again.',
                { signInLink: true }
            );
            return;
        }

        // Not provisioned, disabled account, or no users/{uid} record.
        if (err.status === 403) {
            showBootstrapError(
                'Access denied',
                'Your account is not enabled, or it has not been provisioned by an administrator.',
                { signInLink: true }
            );
            return;
        }

        // Connectivity and transient server failures.
        if (err.code === 'network_error' || err.code === 'timeout') {
            showBootstrapError(
                'Unable to reach the server',
                'Check your connection and try again.',
                { retry: true }
            );
            return;
        }

        if (err.code === 'server_error' || err.status >= 500) {
            showBootstrapError(
                'The server is temporarily unavailable',
                'Please wait a moment and try again.',
                { retry: true }
            );
            return;
        }

        showBootstrapError(
            'Unable to load your account',
            err.message || 'Please try again.',
            { retry: true }
        );
        return;
    }

    // Unknown error type. Never surface raw error text.
    showBootstrapError(
        'Unable to start the application',
        'Reload the page to try again.',
        { retry: true }
    );
}

/* ============================================================================
 * Shell mounting
 * ========================================================================= */

function mountShell(context, portal) {
    const role = context.role;
    const displayName = typeof context.displayName === 'string' && context.displayName.trim() !== ''
        ? context.displayName.trim()
        : (typeof context.email === 'string' && context.email.trim() !== ''
            ? context.email.trim()
            : 'Signed in');
    const roleLabel = getRoleLabel(role);
    const orgName = typeof context.organizationName === 'string'
        ? context.organizationName
        : '';

    // Portal title. Populated from js/ui.js, the single source of role
    // labels. No hardcoded string here.
    if (dom.sidebarPortalTitle) dom.sidebarPortalTitle.textContent = portal.portalTitle;
    if (dom.headerPortalTitle) dom.headerPortalTitle.textContent = portal.portalTitle;

    // Org name (may be empty; the element stays blank if so).
    if (dom.sidebarOrgName) dom.sidebarOrgName.textContent = orgName;
    if (dom.headerOrgName)  dom.headerOrgName.textContent = orgName;

    // User display name and role label.
    if (dom.sidebarUserName) dom.sidebarUserName.textContent = displayName;
    if (dom.headerUserName)  dom.headerUserName.textContent = displayName;
    if (dom.sidebarUserRole) dom.sidebarUserRole.textContent = roleLabel;

    // Build the initial navigation.
    rebuildNavigation(role, getDefaultRoute(role));

    // Wire shell controls once.
    wireShellControls();

    // Create and start the router.
    router = createRouter({
        container: dom.contentInner,
        context: context,
        onRouteChange: ({ path, title }) => {
            // Re-render the sidebar so the active item tracks the route.
            // This replaces the nav DOM and re-attaches listeners on the
            // new items, which is why wireShellControls does NOT bind
            // anything to individual nav links.
            rebuildNavigation(role, path);
            document.title = `${title} — Employee Management & Payroll System`;
        },
    });
    router.start();

    // Reveal the shell.
    dom.bootstrap.hidden = true;
    dom.shell.hidden = false;

    // On mobile, ensure the drawer starts closed.
    closeMobileDrawer();
}

function rebuildNavigation(role, activeRoute) {
    if (!dom.sidebarNavList) return;
    renderNavigation(dom.sidebarNavList, role, activeRoute, (route) => {
        if (router) router.navigate(route);
        // On mobile, close the drawer after navigation.
        if (window.innerWidth < DESKTOP_MIN_WIDTH) {
            closeMobileDrawer();
        }
    });
}

/* ============================================================================
 * Shell controls
 * ========================================================================= */

function wireShellControls() {
    if (controlsWired) return;
    controlsWired = true;

    if (dom.menuBtn) {
        dom.menuBtn.addEventListener('click', openMobileDrawer);
    }
    if (dom.sidebarClose) {
        dom.sidebarClose.addEventListener('click', closeMobileDrawer);
    }
    if (dom.backdrop) {
        dom.backdrop.addEventListener('click', closeMobileDrawer);
    }
    if (dom.signOutBtn) {
        dom.signOutBtn.addEventListener('click', handleSignOutClick);
    }

    // Escape closes the mobile drawer.
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && isMobileDrawerOpen()) {
            closeMobileDrawer();
        }
    });

    // If the viewport crosses into desktop while the drawer is open, close
    // it. This prevents body overflow from remaining hidden on desktop.
    const onResize = debounce(() => {
        if (window.innerWidth >= DESKTOP_MIN_WIDTH && isMobileDrawerOpen()) {
            closeMobileDrawer();
        }
    }, 150);
    window.addEventListener('resize', onResize);

    // If the page is unloaded, unsubscribe to avoid a dangling listener
    // in the bfcache.
    window.addEventListener('pagehide', () => {
        if (typeof unsubscribeSession === 'function') {
            try { unsubscribeSession(); } catch (_e) { /* isolate */ }
        }
    });
}

function isMobileDrawerOpen() {
    return Boolean(dom.sidebar && dom.sidebar.classList.contains('is-open'));
}

function openMobileDrawer() {
    // Only meaningful on mobile; the CSS hides the trigger on desktop, but
    // guard anyway so a stray call cannot leave body overflow stuck.
    if (window.innerWidth >= DESKTOP_MIN_WIDTH) return;

    if (dom.sidebar)    dom.sidebar.classList.add('is-open');
    if (dom.backdrop)   dom.backdrop.classList.add('is-visible');
    if (dom.menuBtn)    dom.menuBtn.setAttribute('aria-expanded', 'true');

    // Lock body scroll while the drawer is open.
    document.body.style.overflow = 'hidden';

    // Focus the close button so keyboard users can dismiss easily.
    if (dom.sidebarClose && typeof dom.sidebarClose.focus === 'function') {
        try { dom.sidebarClose.focus(); } catch (_e) { /* isolate */ }
    }
}

function closeMobileDrawer() {
    if (dom.sidebar)    dom.sidebar.classList.remove('is-open');
    if (dom.backdrop)   dom.backdrop.classList.remove('is-visible');
    if (dom.menuBtn)    dom.menuBtn.setAttribute('aria-expanded', 'false');

    // Restore body scroll unless a modal is currently open. Modal open/
    // close manages body overflow independently via js/ui.js, and both
    // systems should not fight over the same property.
    const modalOpen = document.querySelector('.modal-backdrop.is-open');
    if (!modalOpen) {
        document.body.style.overflow = '';
    }
}

async function handleSignOutClick() {
    if (!dom.signOutBtn) return;

    dom.signOutBtn.disabled = true;
    const original = dom.signOutBtn.textContent;
    dom.signOutBtn.textContent = 'Signing out…';

    try {
        await signOut();
        // signOut() in js/auth.js redirects to index.html on its own.
        // The restore below only runs if, for some reason, the redirect
        // did not happen — for example, if we were not on app.html, which
        // cannot happen here, but keeping it defensive is harmless.
        dom.signOutBtn.disabled = false;
        dom.signOutBtn.textContent = original;
    } catch (_err) {
        // Restore the button so the user can try again.
        dom.signOutBtn.disabled = false;
        dom.signOutBtn.textContent = original;
    }
}

/* ============================================================================
 * Bootstrap state rendering
 * ========================================================================= */

function showBootstrapLoading(title, message) {
    if (dom.bootstrapSpinner) dom.bootstrapSpinner.hidden = false;
    if (dom.bootstrapTitle)   dom.bootstrapTitle.textContent = String(title || '');
    if (dom.bootstrapMessage) dom.bootstrapMessage.textContent = String(message || '');
    if (dom.bootstrapActions) {
        dom.bootstrapActions.replaceChildren();
        dom.bootstrapActions.hidden = true;
    }
}

function showBootstrapError(title, message, options) {
    const opts = options || {};

    if (dom.bootstrapSpinner) dom.bootstrapSpinner.hidden = true;
    if (dom.bootstrapTitle)   dom.bootstrapTitle.textContent = String(title || 'Something went wrong');
    if (dom.bootstrapMessage) dom.bootstrapMessage.textContent = String(message || '');

    if (!dom.bootstrapActions) return;

    dom.bootstrapActions.replaceChildren();

    if (opts.retry) {
        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'btn btn-primary';
        retryBtn.textContent = 'Try again';
        retryBtn.addEventListener('click', () => {
            // Reset state and re-run context resolution.
            contextResolved = false;

            if (bootstrapTimer) {
                clearTimeout(bootstrapTimer);
                bootstrapTimer = null;
            }

            if (dom.bootstrapActions) {
                dom.bootstrapActions.replaceChildren();
                dom.bootstrapActions.hidden = true;
            }

            // Restart the safety timeout.
            bootstrapTimer = setTimeout(() => {
                if (!contextResolved) {
                    showBootstrapError(
                        'Taking too long',
                        'The application could not reach the backend. Reload the page to try again.',
                        { retry: true }
                    );
                }
            }, BOOTSTRAP_TIMEOUT_MS);

            loadContext();
        });
        dom.bootstrapActions.appendChild(retryBtn);
    }

    if (opts.signInLink) {
        const link = document.createElement('a');
        link.href = LOGIN_PAGE;
        link.className = 'btn btn-secondary';
        link.textContent = 'Return to sign in';
        dom.bootstrapActions.appendChild(link);
    }

    if (opts.reloadOnly) {
        const reloadBtn = document.createElement('button');
        reloadBtn.type = 'button';
        reloadBtn.className = 'btn btn-primary';
        reloadBtn.textContent = 'Reload page';
        reloadBtn.addEventListener('click', () => window.location.reload());
        dom.bootstrapActions.appendChild(reloadBtn);
    }

    dom.bootstrapActions.hidden = false;
}

/* ============================================================================
 * Redirects
 * ========================================================================= */

function redirectToLogin() {
    if (redirecting) return;
    redirecting = true;
    window.location.replace(LOGIN_PAGE);
}

/* ============================================================================
 * Entry
 * ========================================================================= */

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}

/**
 * Employee Management & Payroll System
 * Designed and Developed by Yadav Web Technologies
 * ----------------------------------------------------------------------------
 * js/ui.js
 *
 * Role configuration, router, navigation renderer, reusable components,
 * utilities.
 *
 * Responsibilities:
 *   - The ONLY place that maps a backend role identifier to a display label.
 *     No HTML file and no other JavaScript file contains "Organization Admin",
 *     "HR Administration Portal", or "Employee Self-Service Portal".
 *   - The ONLY place that defines which navigation items and routes each
 *     role sees.
 *   - The hash router used inside app.html. It keeps the shell mounted and
 *     swaps only the content outlet when a module changes.
 *   - Reusable, monochrome components used by every feature module.
 *   - Utility helpers for dates, currency, formatting, and validation.
 *
 * Rules this file enforces:
 *   - No role-specific string is written into any HTML file. The shell loads
 *     blank, and this module populates it from the backend-verified context.
 *   - No page-transition animations. The router changes the content outlet's
 *     children synchronously and calls module.mount(). There is no fade, no
 *     overlay, no global animation controller.
 *   - No configuration values, credentials, or secrets.
 *   - No Firebase or Worker calls. This file is UI only.
 */

/* ============================================================================
 * 1. Role labels and portal configuration
 * ========================================================================= */

/**
 * Backend role identifier -> display label.
 *
 * The backend stores `super_admin` for the highest role. That string is
 * NEVER shown to the user. It is looked up here once and displayed as
 * "Organization Admin". If the backend identifier is later migrated, only
 * this map changes.
 */
export const ROLE_LABELS = Object.freeze({
    super_admin: 'Organization Admin',
    hr_admin:    'HR Admin',
    employee:    'Employee',
});

/**
 * Role -> portal configuration.
 *
 * portalTitle        : full title shown in the header and sidebar
 * shortTitle         : short label, if needed for tight spaces
 * defaultRoute       : route the user lands on after sign in
 * nav                : ordered list of navigation items this role sees
 * accessibleRoutes   : every route this role can enter (superset of nav
 *                      routes; some routes are reachable from within a
 *                      module without appearing in the sidebar)
 */
export const PORTAL_CONFIG = Object.freeze({
    super_admin: Object.freeze({
        portalTitle:  'Organization Admin Portal',
        shortTitle:   'Organization Admin',
        defaultRoute: '/dashboard',
        nav: Object.freeze([
            { label: 'Dashboard',      route: '/dashboard',      icon: 'dashboard' },
            { label: 'Employees',      route: '/employees',      icon: 'users' },
            { label: 'Attendance',     route: '/attendance',     icon: 'calendar' },
            { label: 'Leave',          route: '/leave',          icon: 'leave' },
            { label: 'Payroll',        route: '/payroll',        icon: 'money' },
            { label: 'Reports',        route: '/reports',        icon: 'chart' },
            { label: 'Administration', route: '/administration', icon: 'settings' },
            { label: 'Profile',        route: '/profile',        icon: 'user' },
        ]),
        accessibleRoutes: Object.freeze([
            '/dashboard',
            '/employees',
            '/attendance',
            '/leave',
            '/payroll',
            '/reports',
            '/administration',
            '/profile',
        ]),
    }),

    hr_admin: Object.freeze({
        portalTitle:  'HR Administration Portal',
        shortTitle:   'HR Admin',
        defaultRoute: '/dashboard',
        nav: Object.freeze([
            { label: 'Dashboard',  route: '/dashboard',  icon: 'dashboard' },
            { label: 'Employees',  route: '/employees',  icon: 'users' },
            { label: 'Attendance', route: '/attendance', icon: 'calendar' },
            { label: 'Leave',      route: '/leave',      icon: 'leave' },
            { label: 'Payroll',    route: '/payroll',    icon: 'money' },
            { label: 'Reports',    route: '/reports',    icon: 'chart' },
            { label: 'Profile',    route: '/profile',    icon: 'user' },
        ]),
        accessibleRoutes: Object.freeze([
            '/dashboard',
            '/employees',
            '/attendance',
            '/leave',
            '/payroll',
            '/reports',
            '/profile',
        ]),
    }),

    employee: Object.freeze({
        portalTitle:  'Employee Self-Service Portal',
        shortTitle:   'Employee',
        defaultRoute: '/dashboard',
        nav: Object.freeze([
            { label: 'My Dashboard',        route: '/dashboard',  icon: 'dashboard' },
            { label: 'My Profile',          route: '/profile',    icon: 'user' },
            { label: 'My Attendance',       route: '/attendance', icon: 'calendar' },
            { label: 'My Leave',            route: '/leave',      icon: 'leave' },
            { label: 'My Payroll & Payslips', route: '/payroll',  icon: 'money' },
        ]),
        accessibleRoutes: Object.freeze([
            '/dashboard',
            '/profile',
            '/attendance',
            '/leave',
            '/payroll',
        ]),
    }),
});

/**
 * Returns the portal configuration for a role, or null if the role is
 * unknown. Callers must handle null rather than assume a fallback.
 */
export function getPortalConfig(role) {
    if (typeof role !== 'string') return null;
    return PORTAL_CONFIG[role] || null;
}

/**
 * Returns the display label for a role. Falls back to a neutral string if
 * the role is unknown, so that no internal identifier ever leaks to the
 * interface.
 */
export function getRoleLabel(role) {
    if (typeof role === 'string' && ROLE_LABELS[role]) {
        return ROLE_LABELS[role];
    }
    return 'Signed in';
}

/**
 * Returns true if the given role may enter the given route.
 */
export function canAccess(role, routePath) {
    const config = getPortalConfig(role);
    if (!config) return false;
    return config.accessibleRoutes.includes(routePath);
}

/**
 * Returns the default route for the given role, or '/dashboard' as a
 * last-resort fallback.
 */
export function getDefaultRoute(role) {
    const config = getPortalConfig(role);
    return config ? config.defaultRoute : '/dashboard';
}

/* ============================================================================
 * 2. Utility helpers
 * ========================================================================= */

export function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function debounce(fn, waitMs) {
    let timer = null;
    return function debounced(...args) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            fn.apply(this, args);
        }, typeof waitMs === 'number' ? waitMs : 250);
    };
}

export function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

let idCounter = 0;
export function nextId(prefix) {
    idCounter += 1;
    return `${prefix || 'id'}-${idCounter}-${Date.now().toString(36)}`;
}

/* ----------------------------------------------------------------------------
 * Date and time
 * ------------------------------------------------------------------------- */

export function formatDate(value, options) {
    const d = toDate(value);
    if (!d) return '';
    return new Intl.DateTimeFormat('en-IN', options || {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
    }).format(d);
}

export function formatDateTime(value) {
    const d = toDate(value);
    if (!d) return '';
    return new Intl.DateTimeFormat('en-IN', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    }).format(d);
}

export function formatTime(value) {
    const d = toDate(value);
    if (!d) return '';
    return new Intl.DateTimeFormat('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
    }).format(d);
}

export function formatISODate(value) {
    const d = toDate(value);
    if (!d) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

export function toDate(value) {
    if (!value) return null;
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
    if (typeof value === 'number') {
        const d = new Date(value);
        return isNaN(d.getTime()) ? null : d;
    }
    if (typeof value === 'string') {
        const d = new Date(value);
        return isNaN(d.getTime()) ? null : d;
    }
    return null;
}

export function monthName(monthIndex) {
    const names = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December',
    ];
    return names[monthIndex] || '';
}

export function todayISO() {
    return formatISODate(new Date());
}

/* ----------------------------------------------------------------------------
 * Money
 *
 * Money is stored as integer minor units (paise). Display converts to the
 * major unit. Arithmetic is done in minor units to avoid floating point
 * drift.
 * ------------------------------------------------------------------------- */

const DEFAULT_CURRENCY = 'INR';
const DEFAULT_LOCALE = 'en-IN';

export function formatCurrency(minorUnits, currency) {
    const value = Number.isFinite(minorUnits) ? minorUnits : 0;
    const major = value / 100;
    return new Intl.NumberFormat(DEFAULT_LOCALE, {
        style: 'currency',
        currency: currency || DEFAULT_CURRENCY,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(major);
}

export function formatNumber(value) {
    if (!Number.isFinite(value)) return '0';
    return new Intl.NumberFormat(DEFAULT_LOCALE).format(value);
}

/**
 * Converts a user-entered major-unit string ("1234.56") to integer minor
 * units (123456). Returns null if the input is not a valid non-negative
 * number.
 */
export function parseMoneyToMinor(input) {
    if (input === null || input === undefined) return null;
    const str = String(input).trim().replace(/,/g, '');
    if (str === '') return null;
    if (!/^\d+(\.\d{1,2})?$/.test(str)) return null;
    const parts = str.split('.');
    const whole = parts[0];
    const frac = (parts[1] || '').padEnd(2, '0').slice(0, 2);
    const minor = Number(whole) * 100 + Number(frac);
    return Number.isFinite(minor) ? minor : null;
}

/* ----------------------------------------------------------------------------
 * Text and initials
 * ------------------------------------------------------------------------- */

export function initialsFromName(fullName, fallback) {
    if (typeof fullName !== 'string' || fullName.trim() === '') {
        return fallback ? String(fallback).slice(0, 2).toUpperCase() : '--';
    }
    const parts = fullName.trim().split(/\s+/).slice(0, 2);
    return parts.map((p) => p.charAt(0).toUpperCase()).join('') || '--';
}

export function titleCase(input) {
    if (typeof input !== 'string' || input.length === 0) return '';
    return input
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ');
}

/* ----------------------------------------------------------------------------
 * Validation helpers (lightweight; the Worker is authoritative)
 * ------------------------------------------------------------------------- */

export function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

export function isValidEmail(value) {
    if (typeof value !== 'string') return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function isValidISODate(value) {
    if (typeof value !== 'string') return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const d = new Date(value + 'T00:00:00Z');
    return !isNaN(d.getTime());
}

/* ============================================================================
 * 3. DOM helpers
 * ========================================================================= */

export function el(tag, attrs, children) {
    const node = document.createElement(tag);

    if (attrs && typeof attrs === 'object') {
        for (const [key, value] of Object.entries(attrs)) {
            if (value === null || value === undefined || value === false) continue;

            if (key === 'class') {
                node.className = String(value);
            } else if (key === 'dataset' && typeof value === 'object') {
                for (const [dk, dv] of Object.entries(value)) {
                    node.dataset[dk] = String(dv);
                }
            } else if (key === 'style' && typeof value === 'object') {
                for (const [sk, sv] of Object.entries(value)) {
                    node.style[sk] = sv;
                }
            } else if (key.startsWith('on') && typeof value === 'function') {
                node.addEventListener(key.slice(2).toLowerCase(), value);
            } else if (key === 'text') {
                node.textContent = String(value);
            } else if (key === 'html') {
                node.innerHTML = String(value);
            } else if (value === true) {
                node.setAttribute(key, '');
            } else {
                node.setAttribute(key, String(value));
            }
        }
    }

    appendChildren(node, children);
    return node;
}

export function appendChildren(node, children) {
    if (children === null || children === undefined) return;
    if (Array.isArray(children)) {
        for (const child of children) appendChildren(node, child);
        return;
    }
    if (children instanceof Node) {
        node.appendChild(children);
        return;
    }
    node.appendChild(document.createTextNode(String(children)));
}

/* ----------------------------------------------------------------------------
 * SVG icon factory — monochrome, stroke-based, accessible-friendly
 * ------------------------------------------------------------------------- */

const ICONS = {
    dashboard: '<path d="M3 3h7v7H3z"/><path d="M14 3h7v7h-7z"/><path d="M14 14h7v7h-7z"/><path d="M3 14h7v7H3z"/>',
    users:     '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    user:      '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    calendar:  '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
    leave:     '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="9" y1="15" x2="15" y2="15"/>',
    money:     '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    chart:     '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
    settings:  '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    warning:   '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    info:      '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
    inbox:     '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    search:    '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    plus:      '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    edit:      '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
    trash:     '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    download:  '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    refresh:   '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
};

export function icon(name, size) {
    const path = ICONS[name] || ICONS.info;
    const px = size || 18;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(px));
    svg.setAttribute('height', String(px));
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.75');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = path;
    return svg;
}

/* ============================================================================
 * 4. Toast system
 * ========================================================================= */

const TOAST_DEFAULT_DURATION = 4500;
const TOAST_MAX_VISIBLE = 4;

function getToastContainer() {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = el('div', {
            id: 'toast-container',
            class: 'toast-container',
            'aria-live': 'polite',
            'aria-atomic': 'true',
        });
        document.body.appendChild(container);
    }
    return container;
}

/**
 * Shows a toast message.
 *
 * @param {string} message
 * @param {{ type?: 'info'|'success'|'error', duration?: number }} [options]
 */
export function showToast(message, options) {
    const opts = options || {};
    const container = getToastContainer();

    while (container.children.length >= TOAST_MAX_VISIBLE) {
        container.removeChild(container.firstChild);
    }

    const closeBtn = el('button', {
        type: 'button',
        class: 'toast-close',
        'aria-label': 'Dismiss notification',
    }, [
        (() => {
            const x = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            x.setAttribute('viewBox', '0 0 24 24');
            x.setAttribute('width', '14');
            x.setAttribute('height', '14');
            x.setAttribute('fill', 'none');
            x.setAttribute('stroke', 'currentColor');
            x.setAttribute('stroke-width', '2');
            x.setAttribute('stroke-linecap', 'round');
            x.innerHTML = '<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>';
            return x;
        })(),
    ]);

    const toast = el('div', {
        class: 'toast' + (opts.type ? ` is-${opts.type}` : ''),
        role: 'status',
    }, [
        el('span', { class: 'toast-message', text: String(message || '') }),
        closeBtn,
    ]);

    let dismissed = false;
    const dismiss = () => {
        if (dismissed) return;
        dismissed = true;
        toast.classList.remove('is-visible');
        toast.classList.add('is-leaving');
        window.setTimeout(() => {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 220);
    };

    closeBtn.addEventListener('click', dismiss);

    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('is-visible'));

    const duration = typeof opts.duration === 'number' ? opts.duration : TOAST_DEFAULT_DURATION;
    if (duration > 0) {
        window.setTimeout(dismiss, duration);
    }
}

/* ============================================================================
 * 5. Modal system
 * ========================================================================= */

let openModalCount = 0;
let previousActiveElement = null;

/**
 * Opens a modal dialog.
 *
 * @param {{
 *   title: string,
 *   body: Node|string,
 *   actions?: Array<{ label: string, variant?: string, onClick?: Function, closeOnClick?: boolean, disabled?: boolean }>,
 *   size?: 'sm'|'md'|'lg',
 *   onClose?: Function,
 *   closeOnBackdrop?: boolean,
 * }} options
 * @returns {{ close: Function, root: HTMLElement }}
 */
export function openModal(options) {
    const opts = options || {};
    const sizeClass = opts.size === 'lg' ? ' modal-lg' : opts.size === 'sm' ? ' modal-sm' : '';

    previousActiveElement = document.activeElement;

    const titleId = nextId('modal-title');

    const closeBtn = el('button', {
        type: 'button',
        class: 'modal-close',
        'aria-label': 'Close dialog',
    }, [
        (() => {
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('viewBox', '0 0 24 24');
            svg.setAttribute('width', '16');
            svg.setAttribute('height', '16');
            svg.setAttribute('fill', 'none');
            svg.setAttribute('stroke', 'currentColor');
            svg.setAttribute('stroke-width', '2');
            svg.setAttribute('stroke-linecap', 'round');
            svg.innerHTML = '<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>';
            return svg;
        })(),
    ]);

    const header = el('div', { class: 'modal-header' }, [
        el('h2', { id: titleId, class: 'modal-title', text: String(opts.title || '') }),
        closeBtn,
    ]);

    const body = el('div', { class: 'modal-body' });
    appendChildren(body, opts.body);

    const footer = opts.actions && opts.actions.length > 0
        ? el('div', { class: 'modal-footer' })
        : null;

    const dialog = el('div', {
        class: 'modal' + sizeClass,
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': titleId,
    }, [ header, body ]);

    if (footer) dialog.appendChild(footer);

    const backdrop = el('div', { class: 'modal-backdrop' }, [ dialog ]);

    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        backdrop.classList.remove('is-open');
        document.removeEventListener('keydown', onKeyDown, true);
        window.setTimeout(() => {
            if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
        }, 200);
        openModalCount = Math.max(0, openModalCount - 1);
        if (openModalCount === 0) {
            document.body.style.overflow = '';
        }
        if (previousActiveElement && typeof previousActiveElement.focus === 'function') {
            try { previousActiveElement.focus(); } catch (_err) { /* noop */ }
        }
        if (typeof opts.onClose === 'function') {
            try { opts.onClose(); } catch (_err) { /* noop */ }
        }
    };

    // Wire footer actions.
    if (footer && opts.actions) {
        for (const action of opts.actions) {
            const variant = action.variant || 'secondary';
            const btn = el('button', {
                type: 'button',
                class: `btn btn-${variant}`,
                disabled: action.disabled ? true : null,
                text: String(action.label || ''),
            });
            btn.addEventListener('click', () => {
                if (action.disabled) return;
                let shouldClose = action.closeOnClick !== false;
                if (typeof action.onClick === 'function') {
                    const result = action.onClick(close);
                    if (result === false) shouldClose = false;
                }
                if (shouldClose) close();
            });
            footer.appendChild(btn);
        }
    }

    closeBtn.addEventListener('click', close);

    if (opts.closeOnBackdrop !== false) {
        backdrop.addEventListener('mousedown', (event) => {
            if (event.target === backdrop) close();
        });
    }

    // Focus trap.
    function onKeyDown(event) {
        if (event.key === 'Escape') {
            event.preventDefault();
            close();
            return;
        }
        if (event.key !== 'Tab') return;

        const focusable = dialog.querySelectorAll(
            'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    document.addEventListener('keydown', onKeyDown, true);

    openModalCount += 1;
    if (openModalCount === 1) {
        document.body.style.overflow = 'hidden';
    }

    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add('is-open'));

    // Focus the first focusable element, or the dialog itself.
    const toFocus = dialog.querySelector(
        'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])'
    ) || dialog;
    window.setTimeout(() => {
        try { toFocus.focus(); } catch (_err) { /* noop */ }
    }, 50);

    return { close, root: backdrop };
}

/**
 * Convenience confirmation dialog. Returns a promise that resolves to true
 * if confirmed, false otherwise.
 */
export function confirmDialog(options) {
    const opts = options || {};
    return new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };

        openModal({
            title: opts.title || 'Confirm',
            body: el('p', { text: String(opts.message || 'Are you sure?') }),
            size: 'sm',
            actions: [
                {
                    label: opts.cancelLabel || 'Cancel',
                    variant: 'secondary',
                    onClick: () => { finish(false); },
                },
                {
                    label: opts.confirmLabel || 'Confirm',
                    variant: opts.destructive ? 'destructive' : 'primary',
                    onClick: () => { finish(true); },
                },
            ],
            onClose: () => { finish(false); },
        });
    });
}

/* ============================================================================
 * 6. State components
 * ========================================================================= */

export function createLoadingState(message) {
    return el('div', { class: 'state' }, [
        el('div', { class: 'spinner spinner-lg', 'aria-hidden': 'true' }),
        el('p', { class: 'state-message', text: String(message || 'Loading…') }),
    ]);
}

export function createEmptyState(options) {
    const opts = options || {};
    const children = [
        icon(opts.icon || 'inbox', 32),
        el('p', { class: 'state-title', text: String(opts.title || 'Nothing to show') }),
    ];
    if (opts.message) {
        children.push(el('p', { class: 'state-message', text: String(opts.message) }));
    }
    if (opts.actionLabel && typeof opts.onAction === 'function') {
        const btn = el('button', {
            type: 'button',
            class: 'btn btn-primary',
            text: String(opts.actionLabel),
        });
        btn.addEventListener('click', opts.onAction);
        children.push(el('div', { class: 'state-actions' }, [ btn ]));
    }
    return el('div', { class: 'state' }, children);
}

export function createErrorState(options) {
    const opts = options || {};
    const children = [
        icon('warning', 32),
        el('p', { class: 'state-title', text: String(opts.title || 'Something went wrong') }),
    ];
    if (opts.message) {
        children.push(el('p', { class: 'state-message', text: String(opts.message) }));
    }
    const actions = [];
    if (typeof opts.onRetry === 'function') {
        const retryBtn = el('button', {
            type: 'button',
            class: 'btn btn-primary',
            text: String(opts.retryLabel || 'Retry'),
        });
        retryBtn.addEventListener('click', opts.onRetry);
        actions.push(retryBtn);
    }
    if (opts.secondaryLabel && typeof opts.onSecondary === 'function') {
        const secBtn = el('button', {
            type: 'button',
            class: 'btn btn-secondary',
            text: String(opts.secondaryLabel),
        });
        secBtn.addEventListener('click', opts.onSecondary);
        actions.push(secBtn);
    }
    if (actions.length > 0) {
        children.push(el('div', { class: 'state-actions' }, actions));
    }
    return el('div', { class: 'state' }, children);
}

/* ============================================================================
 * 7. Table and pagination
 * ========================================================================= */

/**
 * Renders a table.
 *
 * @param {{
 *   columns: Array<{ key: string, label: string, sortable?: boolean, align?: 'left'|'right'|'center', render?: (row) => Node|string, className?: string }>,
 *   rows: Array<object>,
 *   rowKey?: (row, index) => string,
 *   sortKey?: string,
 *   sortDir?: 'asc'|'desc',
 *   onSort?: (key: string) => void,
 *   emptyTitle?: string,
 *   emptyMessage?: string,
 * }} options
 * @returns {HTMLElement}
 */
export function renderTable(options) {
    const opts = options || {};
    const columns = Array.isArray(opts.columns) ? opts.columns : [];
    const rows = Array.isArray(opts.rows) ? opts.rows : [];

    if (rows.length === 0) {
        return el('div', { class: 'table-wrapper' }, [
            el('div', { class: 'table-empty' }, [
                createEmptyState({
                    title: opts.emptyTitle || 'No records',
                    message: opts.emptyMessage || '',
                }),
            ]),
        ]);
    }

    const thead = el('thead');
    const headRow = el('tr');
    for (const col of columns) {
        const isSorted = opts.sortKey && opts.sortKey === col.key;
        const th = el('th', {
            class: [
                col.sortable ? 'is-sortable' : '',
                col.align ? `text-${col.align}` : '',
                col.className || '',
            ].filter(Boolean).join(' '),
            'aria-sort': isSorted ? (opts.sortDir === 'desc' ? 'descending' : 'ascending') : null,
        }, [ col.label ]);
        if (col.sortable && typeof opts.onSort === 'function') {
            th.addEventListener('click', () => opts.onSort(col.key));
            th.setAttribute('role', 'button');
            th.setAttribute('tabindex', '0');
            th.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    opts.onSort(col.key);
                }
            });
        }
        headRow.appendChild(th);
    }
    thead.appendChild(headRow);

    const tbody = el('tbody');
    rows.forEach((row, index) => {
        const tr = el('tr');
        if (typeof opts.rowKey === 'function') {
            const key = opts.rowKey(row, index);
            if (key) tr.dataset.key = String(key);
        }
        for (const col of columns) {
            const td = el('td', {
                class: [
                    col.align ? `text-${col.align}` : '',
                    col.className || '',
                ].filter(Boolean).join(' '),
            });
            let content;
            if (typeof col.render === 'function') {
                content = col.render(row);
            } else {
                content = row[col.key];
                if (content === null || content === undefined) content = '';
            }
            if (content instanceof Node) {
                td.appendChild(content);
            } else {
                td.textContent = String(content);
            }
            tr.appendChild(td);
        }
        tbody.appendChild(tr);
    });

    const table = el('table', { class: 'data-table' }, [ thead, tbody ]);
    return el('div', { class: 'table-wrapper' }, [ table ]);
}

/**
 * Renders pagination controls.
 *
 * @param {{
 *   page: number,
 *   pageSize: number,
 *   total: number,
 *   onChange: (page: number) => void,
 * }} options
 * @returns {HTMLElement}
 */
export function renderPagination(options) {
    const opts = options || {};
    const page = Math.max(1, Number(opts.page) || 1);
    const pageSize = Math.max(1, Number(opts.pageSize) || 25);
    const total = Math.max(0, Number(opts.total) || 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    const from = total === 0 ? 0 : ((page - 1) * pageSize) + 1;
    const to = Math.min(page * pageSize, total);

    const info = el('div', { class: 'pagination-info' }, [
        el('span', { text: `Showing ${formatNumber(from)}–${formatNumber(to)} of ${formatNumber(total)}` }),
    ]);

    const prevBtn = el('button', {
        type: 'button',
        class: 'pagination-btn',
        'aria-label': 'Previous page',
        disabled: page <= 1 ? true : null,
        text: 'Previous',
    });
    prevBtn.addEventListener('click', () => {
        if (page > 1) opts.onChange(page - 1);
    });

    const nextBtn = el('button', {
        type: 'button',
        class: 'pagination-btn',
        'aria-label': 'Next page',
        disabled: page >= totalPages ? true : null,
        text: 'Next',
    });
    nextBtn.addEventListener('click', () => {
        if (page < totalPages) opts.onChange(page + 1);
    });

    const pageInfo = el('span', {
        class: 'pagination-page-info',
        text: `Page ${formatNumber(page)} of ${formatNumber(totalPages)}`,
    });

    const controls = el('div', { class: 'pagination-controls' }, [
        prevBtn,
        pageInfo,
        nextBtn,
    ]);

    return el('div', { class: 'pagination' }, [ info, controls ]);
}

/* ============================================================================
 * 8. Form helpers
 * ========================================================================= */

export function createFormField(config) {
    const cfg = config || {};
    const fieldId = cfg.id || nextId('field');
    const errorId = `${fieldId}-error`;
    const helpId = `${fieldId}-help`;

    const describedBy = [];
    if (cfg.help) describedBy.push(helpId);
    if (cfg.error) describedBy.push(errorId);

    const labelChildren = [ String(cfg.label || '') ];
    if (cfg.required) {
        labelChildren.push(el('span', { class: 'required', text: '*' }));
    }

    const group = el('div', { class: 'form-group' }, [
        el('label', { for: fieldId, class: 'form-label' }, labelChildren),
    ]);

    let input;
    if (cfg.type === 'textarea') {
        input = el('textarea', {
            id: fieldId,
            name: cfg.name || fieldId,
            class: 'form-textarea' + (cfg.error ? ' has-error' : ''),
            placeholder: cfg.placeholder || '',
            required: cfg.required ? true : null,
            disabled: cfg.disabled ? true : null,
            rows: cfg.rows || 4,
            'aria-describedby': describedBy.length ? describedBy.join(' ') : null,
            'aria-invalid': cfg.error ? 'true' : null,
        });
        input.value = cfg.value !== undefined && cfg.value !== null ? String(cfg.value) : '';
    } else if (cfg.type === 'select') {
        input = el('select', {
            id: fieldId,
            name: cfg.name || fieldId,
            class: 'form-select' + (cfg.error ? ' has-error' : ''),
            required: cfg.required ? true : null,
            disabled: cfg.disabled ? true : null,
            'aria-describedby': describedBy.length ? describedBy.join(' ') : null,
            'aria-invalid': cfg.error ? 'true' : null,
        });
        const options = Array.isArray(cfg.options) ? cfg.options : [];
        if (cfg.placeholder) {
            input.appendChild(el('option', { value: '', text: cfg.placeholder, disabled: cfg.required ? true : null, selected: cfg.value === undefined || cfg.value === '' ? true : null }));
        }
        for (const opt of options) {
            const optEl = el('option', {
                value: String(opt.value),
                text: String(opt.label),
            });
            if (String(opt.value) === String(cfg.value)) optEl.selected = true;
            input.appendChild(optEl);
        }
    } else {
        input = el('input', {
            id: fieldId,
            name: cfg.name || fieldId,
            type: cfg.type || 'text',
            class: 'form-input' + (cfg.error ? ' has-error' : ''),
            placeholder: cfg.placeholder || '',
            required: cfg.required ? true : null,
            disabled: cfg.disabled ? true : null,
            autocomplete: cfg.autocomplete || null,
            inputmode: cfg.inputmode || null,
            min: cfg.min !== undefined ? cfg.min : null,
            max: cfg.max !== undefined ? cfg.max : null,
            step: cfg.step !== undefined ? cfg.step : null,
            minlength: cfg.minlength !== undefined ? cfg.minlength : null,
            maxlength: cfg.maxlength !== undefined ? cfg.maxlength : null,
            'aria-describedby': describedBy.length ? describedBy.join(' ') : null,
            'aria-invalid': cfg.error ? 'true' : null,
        });
        input.value = cfg.value !== undefined && cfg.value !== null ? String(cfg.value) : '';
    }

    group.appendChild(input);

    if (cfg.help) {
        group.appendChild(el('p', { id: helpId, class: 'form-help', text: String(cfg.help) }));
    }

    const errorEl = el('p', { id: errorId, class: 'form-error', hidden: !cfg.error ? true : null });
    if (cfg.error) errorEl.textContent = String(cfg.error);
    group.appendChild(errorEl);

    return { group, input, errorEl, fieldId };
}

export function setFieldError(field, message) {
    if (!field || !field.input) return;
    if (message) {
        field.input.classList.add('has-error');
        field.input.setAttribute('aria-invalid', 'true');
        field.errorEl.textContent = String(message);
        field.errorEl.hidden = false;
    } else {
        field.input.classList.remove('has-error');
        field.input.removeAttribute('aria-invalid');
        field.errorEl.textContent = '';
        field.errorEl.hidden = true;
    }
}

export function clearFormErrors(fields) {
    if (!Array.isArray(fields)) return;
    for (const field of fields) setFieldError(field, '');
}

/* ============================================================================
 * 9. Navigation renderer
 * ========================================================================= */

/**
 * Renders the sidebar navigation for a role into the given container.
 *
 * @param {HTMLElement} container      the <ul> element
 * @param {string} role                 the backend-verified role
 * @param {string} activeRoute          the current route (e.g. '/dashboard')
 * @param {(route: string) => void} onNavigate
 */
export function renderNavigation(container, role, activeRoute, onNavigate) {
    if (!container) return;
    container.replaceChildren();

    const config = getPortalConfig(role);
    if (!config) {
        return;
    }

    for (const item of config.nav) {
        const isActive = item.route === activeRoute;
        const link = el('a', {
            href: `#${item.route}`,
            class: 'nav-link' + (isActive ? ' is-active' : ''),
            'aria-current': isActive ? 'page' : null,
        });
        link.appendChild(icon(item.icon, 18));
        link.appendChild(el('span', { class: 'nav-text', text: item.label }));
        link.addEventListener('click', (event) => {
            event.preventDefault();
            if (typeof onNavigate === 'function') onNavigate(item.route);
        });
        const li = el('li', { class: 'nav-item' }, [ link ]);
        container.appendChild(li);
    }
}

/* ============================================================================
 * 10. Router
 * ========================================================================= */

/**
 * Route table. Every route maps to a module that must export
 * `mount(container, context)` and, optionally, `unmount()`.
 *
 * The loader is a function returning a Promise that resolves to the module.
 * Using a function (rather than a static import path) allows every module
 * to be code-split and loaded on demand, which satisfies the performance
 * requirement to load only the currently required module.
 *
 * `title` is used for the browser tab and, when relevant, the breadcrumb.
 * `breadcrumbs` is optional.
 */
const ROUTES = [
    {
        path: '/dashboard',
        title: 'Dashboard',
        loader: () => import('./modules/dashboard.js'),
    },
    {
        path: '/employees',
        title: 'Employees',
        loader: () => import('./modules/employees.js'),
    },
    {
        path: '/attendance',
        title: 'Attendance',
        loader: () => import('./modules/attendance.js'),
    },
    {
        path: '/leave',
        title: 'Leave',
        loader: () => import('./modules/leave.js'),
    },
    {
        path: '/payroll',
        title: 'Payroll',
        loader: () => import('./modules/payroll.js'),
    },
    {
        path: '/reports',
        title: 'Reports',
        loader: () => import('./modules/reports.js'),
    },
    {
        path: '/administration',
        title: 'Administration',
        loader: () => import('./modules/administration.js'),
    },
    {
        path: '/profile',
        title: 'Profile',
        loader: () => import('./modules/profile.js'),
    },
];

function findRoute(path) {
    return ROUTES.find((route) => route.path === path) || null;
}

function parseHash(hash) {
    if (typeof hash !== 'string' || hash.length === 0) return '/dashboard';
    let path = hash;
    if (path.startsWith('#')) path = path.slice(1);
    if (!path.startsWith('/')) path = '/' + path;
    // Strip trailing slash except root.
    if (path.length > 1) path = path.replace(/\/+$/, '');
    return path || '/dashboard';
}

/**
 * Creates the application router.
 *
 * @param {{
 *   container: HTMLElement,
 *   context: { role: string, [key: string]: any },
 *   onRouteChange?: (route: { path: string, title: string }) => void,
 * }} options
 * @returns {{ start: Function, destroy: Function, navigate: Function, currentRoute: () => string|null }}
 */
export function createRouter(options) {
    const opts = options || {};
    const container = opts.container;
    const context = opts.context || { role: 'employee' };

    let currentModule = null;
    let currentPath = null;
    let destroyed = false;
    let loadingToken = 0;

    function unmountCurrent() {
        if (currentModule && typeof currentModule.unmount === 'function') {
            try { currentModule.unmount(); } catch (_err) { /* isolate */ }
        }
        currentModule = null;
    }

    function renderAccessDenied(path) {
        unmountCurrent();
        container.replaceChildren();
        container.appendChild(createErrorState({
            title: 'Access denied',
            message: 'Your account does not have permission to open this section.',
            secondaryLabel: 'Go to dashboard',
            onSecondary: () => navigate(getDefaultRoute(context.role)),
        }));
        if (typeof opts.onRouteChange === 'function') {
            try { opts.onRouteChange({ path, title: 'Access denied' }); } catch (_err) { /* isolate */ }
        }
    }

    function renderModuleNotAvailable(path, reason) {
        unmountCurrent();
        container.replaceChildren();
        container.appendChild(createErrorState({
            title: 'This section is not available yet',
            message: reason || 'The module has not been installed in this build.',
            secondaryLabel: 'Go to dashboard',
            onSecondary: () => navigate(getDefaultRoute(context.role)),
        }));
        if (typeof opts.onRouteChange === 'function') {
            try { opts.onRouteChange({ path, title: 'Unavailable' }); } catch (_err) { /* isolate */ }
        }
    }

    function renderUnknownRoute(path) {
        unmountCurrent();
        container.replaceChildren();
        container.appendChild(createErrorState({
            title: 'Page not found',
            message: 'The address you entered does not exist in this application.',
            secondaryLabel: 'Go to dashboard',
            onSecondary: () => navigate(getDefaultRoute(context.role)),
        }));
        if (typeof opts.onRouteChange === 'function') {
            try { opts.onRouteChange({ path, title: 'Not found' }); } catch (_err) { /* isolate */ }
        }
    }

    async function handleRouteChange() {
        if (destroyed) return;

        const path = parseHash(window.location.hash);

        // Determine which route to render.
        const route = findRoute(path);
        if (!route) {
            renderUnknownRoute(path);
            return;
        }

        if (!canAccess(context.role, route.path)) {
            renderAccessDenied(path);
            return;
        }

        // Cancel any in-flight load from a previous navigation.
        loadingToken += 1;
        const myToken = loadingToken;

        // Unmount current module before loading the next.
        unmountCurrent();
        container.replaceChildren();

        // Load the module. If the dynamic import fails (file missing,
        // network error), render a clear message instead of a broken page.
        let mod;
        try {
            mod = await route.loader();
        } catch (_err) {
            if (destroyed || myToken !== loadingToken) return;
            renderModuleNotAvailable(route.path, 'The module could not be loaded. If you are running this build before all modules have been delivered, this is expected.');
            return;
        }

        if (destroyed || myToken !== loadingToken) return;

        if (!mod || typeof mod.mount !== 'function') {
            renderModuleNotAvailable(route.path, 'The module did not export a mount() function.');
            return;
        }

        currentModule = mod;
        currentPath = route.path;

        try {
            await mod.mount(container, context);
        } catch (_err) {
            if (destroyed || myToken !== loadingToken) return;
            currentModule = null;
            renderModuleNotAvailable(route.path, 'The module failed to render.');
            return;
        }

        if (typeof opts.onRouteChange === 'function') {
            try { opts.onRouteChange({ path: route.path, title: route.title }); } catch (_err) { /* isolate */ }
        }
    }

    function navigate(path) {
        const clean = path.startsWith('/') ? path : '/' + path;
        const target = '#' + clean;
        if (window.location.hash === target) {
            // Force re-evaluation even if the hash did not change.
            handleRouteChange();
            return;
        }
        window.location.hash = target;
    }

    return {
        start() {
            window.addEventListener('hashchange', handleRouteChange);
            // If no hash is present, replace with the default route for this
            // role so the address bar reflects where the user actually is.
            if (!window.location.hash || window.location.hash === '#') {
                window.location.replace('#' + getDefaultRoute(context.role));
                // replace() will not fire hashchange in every browser, so
                // trigger the route change manually.
                handleRouteChange();
            } else {
                handleRouteChange();
            }
        },
        destroy() {
            destroyed = true;
            window.removeEventListener('hashchange', handleRouteChange);
            unmountCurrent();
        },
        navigate,
        currentRoute() {
            return currentPath;
        },
    };
}

/**
 * Employee Management & Payroll System
 * Designed and Developed by Yadav Web Technologies
 * ----------------------------------------------------------------------------
 * js/modules/dashboard.js
 *
 * Dashboard module.
 *
 * One module, three renderers. The renderer is chosen from the backend-
 * verified role in the mount context:
 *
 *   super_admin -> Organization Admin dashboard (organization-wide summary)
 *   hr_admin    -> HR Admin dashboard (HR-scoped summary)
 *   employee    -> Employee dashboard (personal summary only)
 *
 * All data comes from GET /dashboard/summary on the Cloudflare Worker.
 * When the database is empty, the endpoint returns zeros and empty arrays,
 * and this module renders honest empty states. No fabricated counts, no
 * placeholder employees, no invented statistics.
 *
 * Lifecycle:
 *   mount(container, context)  -> render into container
 *   unmount()                  -> abort in-flight requests, clear state
 */

import { apiGet, ApiError } from '../api.js';
import {
    el,
    icon,
    formatCurrency,
    formatDateTime,
    formatDate,
    getRoleLabel,
    createLoadingState,
    createErrorState,
    createEmptyState,
    titleCase,
} from '../ui.js';

/* ----------------------------------------------------------------------------
 * Module state
 * ------------------------------------------------------------------------- */

let activeContainer = null;
let activeAbortController = null;
let mounted = false;

/* ----------------------------------------------------------------------------
 * Public API
 * ------------------------------------------------------------------------- */

export async function mount(container, context) {
    if (!container) return;

    mounted = true;
    activeContainer = container;

    // Cancel any previous in-flight request from a prior mount. This module
    // is unmounted and remounted on every navigation, so a stale response
    // must never render into a container that no longer belongs to us.
    if (activeAbortController) {
        try { activeAbortController.abort(); } catch (_e) { /* isolate */ }
    }
    activeAbortController = new AbortController();

    const role = context && typeof context.role === 'string' ? context.role : '';

    // Show a loading state immediately. This is not a page transition —
    // it is an in-place state inside the content outlet, consistent with
    // the animation policy.
    container.replaceChildren();
    container.appendChild(createLoadingState('Loading your dashboard…'));

    let summary;
    try {
        summary = await apiGet('/dashboard/summary', {
            signal: activeAbortController.signal,
        });
    } catch (err) {
        if (!mounted) return;

        // Caller-initiated abort: another navigation replaced this one.
        // Render nothing and let the router handle the new module.
        if (err instanceof ApiError && err.code === 'aborted') {
            return;
        }

        if (err instanceof ApiError && err.code === 'unauthorized') {
            // The API client already triggered sign out and redirect.
            // Render a neutral message in case the redirect is slow.
            renderError(container, 'Session expired', 'Please sign in again.');
            return;
        }

        renderError(
            container,
            'Unable to load dashboard',
            (err && err.message) || 'Please try again.',
            () => mount(container, context)
        );
        return;
    }

    if (!mounted) return;

    if (!summary || typeof summary !== 'object') {
        renderError(
            container,
            'Unable to load dashboard',
            'The server returned an unexpected response.',
            () => mount(container, context)
        );
        return;
    }

    // Branch by role. The summary itself also carries a role field, but we
    // trust the mount context (which comes from /auth/context) as the
    // authoritative source. If the two disagree, prefer the context.
    try {
        if (role === 'employee') {
            renderEmployeeDashboard(container, summary, context);
        } else if (role === 'hr_admin') {
            renderAdminDashboard(container, summary, context, {
                portalTitle: 'HR Administration Portal',
                scopeLabel: 'Organization',
                showAdministrationHint: false,
            });
        } else if (role === 'super_admin') {
            renderAdminDashboard(container, summary, context, {
                portalTitle: 'Organization Admin Portal',
                scopeLabel: 'Organization',
                showAdministrationHint: true,
            });
        } else {
            renderError(
                container,
                'Account not recognized',
                'Your account role is not configured for this application.'
            );
        }
    } catch (_err) {
        renderError(
            container,
            'Unable to render dashboard',
            'Something went wrong while displaying your summary.'
        );
    }
}

export function unmount() {
    mounted = false;
    activeContainer = null;
    if (activeAbortController) {
        try { activeAbortController.abort(); } catch (_e) { /* isolate */ }
        activeAbortController = null;
    }
}

/* ----------------------------------------------------------------------------
 * Admin dashboard (super_admin and hr_admin share this layout)
 * ------------------------------------------------------------------------- */

function renderAdminDashboard(container, summary, context, options) {
    const opts = options || {};
    const orgLabel = opts.scopeLabel || 'Organization';
    const displayName = safeName(context);

    const greeting = el('div', { class: 'page-head' }, [
        el('div', {}, [
            el('h1', { class: 'page-title', text: 'Dashboard' }),
            el('p', {
                class: 'page-subtitle',
                text: `Welcome back, ${displayName}. ${orgLabel}-wide summary as of ${formatDateTime(summary.generatedAt)}.`,
            }),
        ]),
    ]);

    container.replaceChildren();
    container.appendChild(greeting);

    const emp = summary.employees || {};
    const att = summary.attendanceToday || {};
    const leave = summary.leavePending || {};
    const payroll = summary.payrollCurrent;

    // Row 1 — headline statistics.
    const statsRow = el('div', { class: 'stat-grid' }, [
        statCard('Total Employees',   formatNumberOrZero(emp.total),   `${formatNumberOrZero(emp.active)} active`),
        statCard('Present Today',     formatNumberOrZero(att.present), summary.attendanceToday ? `on ${att.date}` : ''),
        statCard('Pending Leave',     formatNumberOrZero(leave.count), leave.count > 0 ? 'awaiting approval' : 'none pending'),
        statCard('Current Payroll',   payroll ? titleCase(payroll.status) : 'Not started', payroll ? payroll.period : summary.period),
    ]);

    // Row 2 — attendance breakdown + payroll snapshot + recent activity.
    const attendanceCard = el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [
            el('h2', { class: 'card-title', text: 'Attendance Today' }),
            el('span', { class: 'text-muted text-mono', text: att.date || '' }),
        ]),
        el('div', { class: 'card-body' }, [
            el('div', { class: 'stat-grid' }, [
                miniStat('Present',   formatNumberOrZero(att.present)),
                miniStat('Absent',    formatNumberOrZero(att.absent)),
                miniStat('On Leave',  formatNumberOrZero(att.leave)),
                miniStat('Not Marked', formatNumberOrZero(att.notMarked)),
            ]),
        ]),
    ]);

    const payrollCard = renderPayrollCard(payroll, summary.period);
    const activityCard = renderActivityCard(summary.recentActivity);

    container.appendChild(el('div', { class: 'grid-2 mt-4' }, [ attendanceCard, payrollCard ]));
    container.appendChild(el('div', { class: 'mt-4' }, [ activityCard ]));
}

/* ----------------------------------------------------------------------------
 * Employee dashboard (personal summary only)
 * ------------------------------------------------------------------------- */

function renderEmployeeDashboard(container, summary, context) {
    const displayName = safeName(context);

    const greeting = el('div', { class: 'page-head' }, [
        el('div', {}, [
            el('h1', { class: 'page-title', text: 'My Dashboard' }),
            el('p', {
                class: 'page-subtitle',
                text: `Welcome back, ${displayName}. Your personal summary as of ${formatDateTime(summary.generatedAt)}.`,
            }),
        ]),
    ]);

    container.replaceChildren();
    container.appendChild(greeting);

    const emp = summary.myEmployee;
    const att = summary.myAttendance || {};
    const balances = summary.myLeaveBalance || {};
    const latestPayslip = summary.myLatestPayslip;

    // If the user has no employee record linked yet, show a clear notice
    // rather than zeros that could be misread as real data.
    if (!emp) {
        container.appendChild(el('div', { class: 'card mt-4' }, [
            el('div', { class: 'card-body' }, [
                createEmptyState({
                    icon: 'info',
                    title: 'Your employee profile is not linked yet',
                    message: 'Your account is active, but it has not been linked to an employee record. Please contact your administrator to complete the setup.',
                }),
            ]),
        ]));

        // Still show the attendance / leave / payslip section headers with
        // honest empty states, so the layout is not misleadingly blank.
        container.appendChild(el('div', { class: 'grid-2 mt-4' }, [
            el('div', { class: 'card' }, [
                el('div', { class: 'card-header' }, [
                    el('h2', { class: 'card-title', text: 'My Attendance This Month' }),
                ]),
                el('div', { class: 'card-body' }, [
                    createEmptyState({ title: 'No data yet' }),
                ]),
            ]),
            el('div', { class: 'card' }, [
                el('div', { class: 'card-header' }, [
                    el('h2', { class: 'card-title', text: 'My Leave Balances' }),
                ]),
                el('div', { class: 'card-body' }, [
                    createEmptyState({ title: 'No data yet' }),
                ]),
            ]),
        ]));

        container.appendChild(el('div', { class: 'mt-4' }, [
            el('div', { class: 'card' }, [
                el('div', { class: 'card-header' }, [
                    el('h2', { class: 'card-title', text: 'My Latest Payslip' }),
                ]),
                el('div', { class: 'card-body' }, [
                    createEmptyState({ title: 'No payslip available yet' }),
                ]),
            ]),
        ]));

        return;
    }

    // Headline stats — attendance for current month.
    const fullName = `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || displayName;

    const statsRow = el('div', { class: 'stat-grid' }, [
        statCard('Present',   formatNumberOrZero(att.present), `in ${att.month || summary.period}`),
        statCard('Absent',    formatNumberOrZero(att.absent),  `in ${att.month || summary.period}`),
        statCard('On Leave',  formatNumberOrZero(att.leave),   `in ${att.month || summary.period}`),
        statCard('Latest Net', latestPayslip ? formatCurrency(latestPayslip.netMinor) : '—', latestPayslip ? latestPayslip.period : 'no payslip yet'),
    ]);

    container.appendChild(statsRow);

    // Row 2 — employment info + leave balances.
    const employmentCard = el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [
            el('h2', { class: 'card-title', text: 'My Employment' }),
        ]),
        el('div', { class: 'card-body' }, [
            definitionList([
                ['Name',            fullName],
                ['Employee Code',   emp.employeeCode || '—'],
                ['Department',      emp.departmentId || 'Not assigned'],
                ['Designation',     emp.designationId || 'Not assigned'],
                ['Status',          titleCase(emp.status || '—')],
            ]),
        ]),
    ]);

    const leaveCard = el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [
            el('h2', { class: 'card-title', text: 'My Leave Balances' }),
            el('span', { class: 'text-muted text-mono', text: summary.year || '' }),
        ]),
        el('div', { class: 'card-body' }, balancesBody(balances)),
    ]);

    container.appendChild(el('div', { class: 'grid-2 mt-4' }, [ employmentCard, leaveCard ]));

    // Row 3 — latest payslip.
    const payslipCard = el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [
            el('h2', { class: 'card-title', text: 'My Latest Payslip' }),
        ]),
        el('div', { class: 'card-body' }, latestPayslip
            ? definitionList([
                ['Period',     latestPayslip.period || '—'],
                ['Net Amount', formatCurrency(latestPayslip.netMinor)],
                ['Issued',     latestPayslip.issuedAt ? formatDate(latestPayslip.issuedAt) : '—'],
            ])
            : createEmptyState({
                title: 'No payslip available yet',
                message: 'Payslips will appear here once payroll has been processed and issued.',
            })
        ),
    ]);

    container.appendChild(el('div', { class: 'mt-4' }, [ payslipCard ]));
}

/* ----------------------------------------------------------------------------
 * Shared cards
 * ------------------------------------------------------------------------- */

function statCard(label, value, meta) {
    const children = [
        el('span', { class: 'stat-label', text: label }),
        el('span', { class: 'stat-value', text: value }),
    ];
    if (meta) children.push(el('span', { class: 'stat-meta', text: meta }));
    return el('div', { class: 'stat-card' }, children);
}

function miniStat(label, value) {
    return el('div', { class: 'stat-card' }, [
        el('span', { class: 'stat-label', text: label }),
        el('span', { class: 'stat-value', text: value }),
    ]);
}

function renderPayrollCard(payroll, fallbackPeriod) {
    if (!payroll) {
        return el('div', { class: 'card' }, [
            el('div', { class: 'card-header' }, [
                el('h2', { class: 'card-title', text: 'Current Payroll' }),
                el('span', { class: 'text-muted text-mono', text: fallbackPeriod || '' }),
            ]),
            el('div', { class: 'card-body' }, [
                createEmptyState({
                    title: 'No payroll run yet',
                    message: 'No payroll has been started for the current period.',
                }),
            ]),
        ]);
    }

    return el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [
            el('h2', { class: 'card-title', text: 'Current Payroll' }),
            el('span', { class: 'text-muted text-mono', text: payroll.period || '' }),
        ]),
        el('div', { class: 'card-body' }, [
            definitionList([
                ['Status',            titleCase(payroll.status || 'draft')],
                ['Employees Covered', formatNumberOrZero(payroll.employeeCount)],
                ['Gross Total',       formatCurrency(payroll.totalGrossMinor || 0)],
                ['Net Total',         formatCurrency(payroll.totalNetMinor || 0)],
            ]),
        ]),
    ]);
}

function renderActivityCard(activity) {
    const header = el('div', { class: 'card-header' }, [
        el('h2', { class: 'card-title', text: 'Recent Activity' }),
    ]);

    if (!Array.isArray(activity) || activity.length === 0) {
        return el('div', { class: 'card' }, [
            header,
            el('div', { class: 'card-body' }, [
                createEmptyState({
                    title: 'No recent activity',
                    message: 'Actions taken in the system will appear here.',
                }),
            ]),
        ]);
    }

    const list = el('ul', { class: 'nav-list' });
    for (const entry of activity) {
        const when = entry.timestamp ? formatDateTime(entry.timestamp) : '';
        list.appendChild(el('li', { class: 'nav-item' }, [
            el('div', { class: 'flex items-center justify-between gap-2', style: { padding: '8px 0' } }, [
                el('div', { class: 'flex items-center gap-2 truncate' }, [
                    icon('info', 16),
                    el('span', { class: 'truncate', text: activityLabel(entry) }),
                ]),
                el('span', { class: 'text-muted text-mono', text: when }),
            ]),
        ]));
    }

    return el('div', { class: 'card' }, [ header, el('div', { class: 'card-body' }, [ list ]) ]);
}

/* ----------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

function definitionList(pairs) {
    const dl = el('div', { class: 'form' });
    for (const [label, value] of pairs) {
        dl.appendChild(el('div', { class: 'flex items-center justify-between gap-3' }, [
            el('span', { class: 'text-muted', text: String(label) }),
            el('span', { class: 'text-mono', text: String(value === null || value === undefined || value === '' ? '—' : value) }),
        ]));
    }
    return dl;
}

function balancesBody(balances) {
    const keys = Object.keys(balances || {});
    if (keys.length === 0) {
        return createEmptyState({
            title: 'No leave balances configured',
            message: 'Your leave balances will appear here once they are set up.',
        });
    }

    const dl = el('div', { class: 'form' });
    for (const key of keys) {
        const b = balances[key] || {};
        dl.appendChild(el('div', { class: 'flex items-center justify-between gap-3' }, [
            el('span', { class: 'text-muted', text: titleCase(key) }),
            el('span', { class: 'text-mono', text: `${formatNumberOrZero(b.remaining)} of ${formatNumberOrZero(b.allocated)} remaining` }),
        ]));
    }
    return dl;
}

function activityLabel(entry) {
    const action = titleCase(entry.action || 'activity');
    const target = entry.target ? titleCase(entry.target) : '';
    const targetId = entry.targetId ? String(entry.targetId) : '';
    if (target && targetId) return `${action} — ${target} ${targetId}`;
    if (target) return `${action} — ${target}`;
    return action;
}

function safeName(context) {
    if (!context) return 'there';
    const display = context.displayName;
    if (typeof display === 'string' && display.trim() !== '') {
        return display.trim().split(/\s+/)[0];
    }
    const email = context.email;
    if (typeof email === 'string' && email.includes('@')) {
        return email.split('@')[0];
    }
    return 'there';
}

function formatNumberOrZero(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '0';
    return new Intl.NumberFormat('en-IN').format(n);
}

function renderError(container, title, message, onRetry) {
    container.replaceChildren();
    container.appendChild(createErrorState({
        title,
        message,
        retryLabel: onRetry ? 'Try again' : undefined,
        onRetry: onRetry || undefined,
    }));
}

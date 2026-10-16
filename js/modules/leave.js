/**
 * Employee Management & Payroll System
 * Designed and Developed by Yadav Web Technologies
 * ----------------------------------------------------------------------------
 * js/modules/leave.js
 *
 * Leave module. Three internal views:
 *   - list   : leave requests with filters and pagination
 *   - apply  : apply-for-leave form
 *   - review : modal for approving / rejecting a request (admins)
 *
 * Role behaviour:
 *   - super_admin, hr_admin : all requests, can approve/reject
 *   - employee              : own requests, can apply, cannot approve
 */

import { apiGet, apiPost, apiPatch, ApiError } from '../api.js';
import {
    el, icon, formatDate, titleCase, debounce,
    createLoadingState, createEmptyState, createErrorState,
    renderTable, renderPagination,
    createFormField, setFieldError, clearFormErrors,
    showToast, openModal, todayISO, isValidISODate,
} from '../ui.js';

let mounted = false;
let containerRef = null;
let contextRef = null;
let abortController = null;

const LEAVE_TYPES = [
    { value: 'casual', label: 'Casual' },
    { value: 'sick',   label: 'Sick' },
    { value: 'earned', label: 'Earned' },
    { value: 'unpaid', label: 'Unpaid' },
    { value: 'other',  label: 'Other' },
];

const listState = {
    status: '',
    filterEmployee: '',
    page: 1,
    pageSize: 25,
};

let employeesById = {};
let employeesLoaded = false;

export async function mount(container, context) {
    if (!container) return;
    mounted = true;
    containerRef = container;
    contextRef = context || {};
    if (abortController) { try { abortController.abort(); } catch (_e) {} }
    abortController = new AbortController();
    if (isAdmin()) loadEmployees();
    await renderListView();
}

export function unmount() {
    mounted = false;
    containerRef = null;
    contextRef = null;
    abortController = null;
}

function isAdmin() {
    const r = contextRef && contextRef.role;
    return r === 'super_admin' || r === 'hr_admin';
}

function isEmployee() {
    return contextRef && contextRef.role === 'employee';
}

async function loadEmployees() {
    if (employeesLoaded) return;
    try {
        const res = await apiGet('/employees', { query: { pageSize: 1000 } });
        const items = Array.isArray(res && res.items) ? res.items : [];
        const map = {};
        for (const e of items) {
            if (!e || !e.employeeId) continue;
            map[e.employeeId] = {
                code: e.employeeCode || '',
                name: `${e.firstName || ''} ${e.lastName || ''}`.trim() || e.email || e.employeeId,
            };
        }
        employeesById = map;
    } catch (_e) { /* leave empty */ }
    employeesLoaded = true;
}

function employeeLabel(id) {
    if (!id) return '—';
    const e = employeesById[id];
    if (!e) return id;
    return e.code ? `${e.code} — ${e.name}` : e.name;
}

/* ----------------------------------------------------------------------------
 * List view
 * ------------------------------------------------------------------------- */

async function renderListView() {
    if (!mounted || !containerRef) return;
    containerRef.replaceChildren();

    const head = el('div', { class: 'page-head' }, [
        el('div', {}, [
            el('h1', { class: 'page-title', text: isEmployee() ? 'My Leave' : 'Leave' }),
            el('p', { class: 'page-subtitle', text: isEmployee()
                ? 'Your leave applications and balances.'
                : 'Review and manage leave requests.' }),
        ]),
        el('div', { class: 'page-head-actions' }, [
            primaryButton('Apply for Leave', 'plus', () => renderApplyView()),
        ]),
    ]);
    containerRef.appendChild(head);

    const filterBar = el('div', { class: 'filter-bar' });

    const statusSelect = el('select', { class: 'form-select', 'aria-label': 'Status filter' }, [
        option('', 'All statuses', !listState.status),
        option('pending', 'Pending', listState.status === 'pending'),
        option('approved', 'Approved', listState.status === 'approved'),
        option('rejected', 'Rejected', listState.status === 'rejected'),
        option('cancelled', 'Cancelled', listState.status === 'cancelled'),
    ]);
    statusSelect.addEventListener('change', () => {
        listState.status = statusSelect.value;
        listState.page = 1;
        refreshList();
    });
    filterBar.appendChild(el('label', { class: 'flex flex-col gap-1' }, [
        el('span', { class: 'form-label', text: 'Status' }), statusSelect,
    ]));

    if (isAdmin()) {
        const empSelect = el('select', { class: 'form-select', 'aria-label': 'Employee filter' }, [
            option('', 'All employees', !listState.filterEmployee),
            ...Object.entries(employeesById).map(([id, info]) =>
                option(id, info.code ? `${info.code} — ${info.name}` : info.name, listState.filterEmployee === id)
            ),
        ]);
        empSelect.addEventListener('change', () => {
            listState.filterEmployee = empSelect.value;
            listState.page = 1;
            refreshList();
        });
        filterBar.appendChild(el('label', { class: 'flex flex-col gap-1' }, [
            el('span', { class: 'form-label', text: 'Employee' }), empSelect,
        ]));
    }

    containerRef.appendChild(filterBar);

    if (isEmployee()) {
        const balancesArea = el('div', { class: 'mt-4', id: 'leave-balances-area' });
        containerRef.appendChild(balancesArea);
        loadEmployeeBalances(balancesArea);
    }

    const listArea = el('div', { class: 'mt-4', id: 'leave-list-area' });
    containerRef.appendChild(listArea);

    await refreshList();
}

async function loadEmployeeBalances(area) {
    const year = String(new Date().getFullYear());
    try {
        const res = await apiGet(`/leave/balances/${encodeURIComponent(contextRef.employeeId || 'me')}/${year}`, {
            signal: abortController ? abortController.signal : undefined,
        });
        if (!mounted || !area.parentNode) return;
        const balances = (res && res.balances) || {};
        const types = Object.keys(balances);
        if (types.length === 0) {
            area.replaceChildren();
            return;
        }
        area.replaceChildren(el('div', { class: 'stat-grid' }, types.map((t) => {
            const b = balances[t] || {};
            return el('div', { class: 'stat-card' }, [
                el('span', { class: 'stat-label', text: titleCase(t) }),
                el('span', { class: 'stat-value', text: String(b.remaining || 0) }),
                el('span', { class: 'stat-meta', text: `of ${b.allocated || 0} days` }),
            ]);
        })));
    } catch (_e) {
        if (area.parentNode) area.replaceChildren();
    }
}

async function refreshList() {
    if (!mounted || !containerRef) return;
    const area = document.getElementById('leave-list-area');
    if (!area) return;
    area.replaceChildren(createLoadingState('Loading leave requests…'));

    let response;
    try {
        response = await apiGet('/leave/requests', {
            query: {
                status: listState.status,
                filterEmployee: isAdmin() ? listState.filterEmployee : '',
                page: listState.page,
                pageSize: listState.pageSize,
            },
            signal: abortController ? abortController.signal : undefined,
        });
    } catch (err) {
        if (err instanceof ApiError && err.code === 'aborted') return;
        if (!mounted) return;
        area.replaceChildren(createErrorState({
            title: 'Unable to load leave requests',
            message: (err && err.message) || 'Please try again.',
            onRetry: refreshList,
        }));
        return;
    }

    if (!mounted) return;

    const items = Array.isArray(response && response.items) ? response.items : [];
    const total = Number(response && response.total) || 0;

    if (items.length === 0) {
        area.replaceChildren(createEmptyState({
            icon: 'leave',
            title: 'No leave requests',
            message: listState.status
                ? 'No requests match the selected filter.'
                : (isEmployee() ? 'You have not applied for any leave yet.' : 'No leave requests have been submitted yet.'),
        }));
        return;
    }

    const columns = [];
    if (isAdmin()) columns.push({
        key: 'employeeId', label: 'Employee',
        render: (r) => el('span', { class: 'truncate', text: employeeLabel(r.employeeId) }),
    });
    columns.push(
        { key: 'leaveType', label: 'Type', render: (r) => el('span', { text: titleCase(r.leaveType) }) },
        { key: 'fromDate',  label: 'From', render: (r) => el('span', { class: 'text-mono', text: formatDate(r.fromDate) }) },
        { key: 'toDate',    label: 'To',   render: (r) => el('span', { class: 'text-mono', text: formatDate(r.toDate) }) },
        { key: 'days',      label: 'Days', render: (r) => el('span', { class: 'text-mono', text: String(r.days) }) },
        { key: 'status',    label: 'Status', render: (r) => statusBadge(r.status) },
        { key: 'appliedAt', label: 'Applied', render: (r) => el('span', { class: 'text-mono', text: r.appliedAt ? formatDate(r.appliedAt) : '—' }) },
    );
    if (isAdmin()) columns.push({
        key: 'actions', label: 'Actions', align: 'right', className: 'col-actions',
        render: (r) => r.status === 'pending'
            ? el('div', { class: 'flex justify-end gap-2' }, [textButton('Review', () => openReviewModal(r))])
            : el('span', { class: 'text-muted text-mono', text: '—' }),
    });
    if (isEmployee()) columns.push({
        key: 'actions', label: '', align: 'right', className: 'col-actions',
        render: (r) => textButton('View', () => openRequestDetail(r)),
    });

    area.replaceChildren(renderTable({ columns, rows: items, rowKey: (r) => r.requestId }));

    area.appendChild(renderPagination({
        page: listState.page, pageSize: listState.pageSize, total,
        onChange: (p) => {
            listState.page = p;
            refreshList();
            const c = document.getElementById('app-content');
            if (c && c.scrollIntoView) c.scrollIntoView({ block: 'start' });
        },
    }));
}

/* ----------------------------------------------------------------------------
 * Apply view
 * ------------------------------------------------------------------------- */

function renderApplyView() {
    if (!mounted || !containerRef) return;
    containerRef.replaceChildren();

    const head = el('div', { class: 'page-head' }, [
        el('div', {}, [
            el('div', { class: 'flex items-center gap-2 mb-2' }, [
                textButton('← Back to Leave', () => renderListView()),
            ]),
            el('h1', { class: 'page-title', text: 'Apply for Leave' }),
            el('p', { class: 'page-subtitle', text: 'Submit a leave request for approval.' }),
        ]),
    ]);
    containerRef.appendChild(head);

    const fields = {};
    fields.leaveType = createFormField({
        label: 'Leave Type', type: 'select', required: true, value: '', name: 'leaveType',
        options: LEAVE_TYPES, placeholder: 'Select',
    });
    fields.fromDate = createFormField({ label: 'From Date', type: 'date', required: true, value: todayISO(), name: 'fromDate' });
    fields.toDate = createFormField({ label: 'To Date', type: 'date', required: true, value: todayISO(), name: 'toDate' });
    fields.reason = createFormField({ label: 'Reason', type: 'textarea', required: true, value: '', name: 'reason' });

    const form = el('form', { class: 'form', novalidate: true }, [
        el('div', { class: 'form-row' }, [fields.fromDate.group, fields.toDate.group]),
        fields.leaveType.group,
        fields.reason.group,
        el('div', { class: 'form-actions mt-4' }, [
            el('button', { type: 'submit', class: 'btn btn-primary', text: 'Submit Request' }),
            (() => {
                const b = el('button', { type: 'button', class: 'btn btn-secondary', text: 'Cancel' });
                b.addEventListener('click', () => renderListView());
                return b;
            })(),
        ]),
    ]);

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        clearFormErrors(Object.values(fields));

        const payload = {
            leaveType: fields.leaveType.input.value,
            fromDate: fields.fromDate.input.value,
            toDate: fields.toDate.input.value,
            reason: fields.reason.input.value.trim(),
        };

        const errs = {};
        if (!payload.leaveType) errs.leaveType = 'Select a leave type.';
        if (!payload.fromDate || !isValidISODate(payload.fromDate)) errs.fromDate = 'Enter a valid date.';
        if (!payload.toDate || !isValidISODate(payload.toDate)) errs.toDate = 'Enter a valid date.';
        if (payload.fromDate && payload.toDate && payload.fromDate > payload.toDate) errs.toDate = 'Must be on or after from date.';
        if (!payload.reason) errs.reason = 'Reason is required.';
        if (Object.keys(errs).length > 0) {
            for (const [k, m] of Object.entries(errs)) if (fields[k]) setFieldError(fields[k], m);
            return;
        }

        const btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        btn.textContent = 'Submitting…';

        try {
            await apiPost('/leave/requests', payload);
            showToast('Leave request submitted.', { type: 'success' });
            await renderListView();
        } catch (err) {
            btn.disabled = false;
            btn.textContent = 'Submit Request';
            showToast(err instanceof ApiError ? err.message : 'Unable to submit.', { type: 'error' });
        }
    });

    containerRef.appendChild(form);
}

/* ----------------------------------------------------------------------------
 * Review modal (admins)
 * ------------------------------------------------------------------------- */

function openReviewModal(record) {
    const noteField = createFormField({
        label: 'Review Note (optional)', type: 'textarea', value: '', name: 'reviewNote',
    });

    openModal({
        title: 'Review Leave Request',
        body: el('div', {}, [
            el('div', { class: 'form mb-4' }, [
                infoRow('Employee', employeeLabel(record.employeeId)),
                infoRow('Type', titleCase(record.leaveType)),
                infoRow('From', formatDate(record.fromDate)),
                infoRow('To', formatDate(record.toDate)),
                infoRow('Days', String(record.days)),
                infoRow('Reason', record.reason),
            ]),
            noteField.group,
        ]),
        actions: [
            { label: 'Cancel', variant: 'secondary' },
            {
                label: 'Reject', variant: 'destructive', closeOnClick: false,
                onClick: async (close) => {
                    try {
                        await apiPatch(`/leave/requests/${encodeURIComponent(record.requestId)}`, {
                            status: 'rejected', reviewNote: noteField.input.value,
                        });
                        showToast('Request rejected.', { type: 'success' });
                        close(); refreshList();
                    } catch (err) {
                        showToast(err instanceof ApiError ? err.message : 'Unable to reject.', { type: 'error' });
                    }
                },
            },
            {
                label: 'Approve', variant: 'primary', closeOnClick: false,
                onClick: async (close) => {
                    try {
                        await apiPatch(`/leave/requests/${encodeURIComponent(record.requestId)}`, {
                            status: 'approved', reviewNote: noteField.input.value,
                        });
                        showToast('Request approved.', { type: 'success' });
                        close(); refreshList();
                    } catch (err) {
                        showToast(err instanceof ApiError ? err.message : 'Unable to approve.', { type: 'error' });
                    }
                },
            },
        ],
    });
}

function openRequestDetail(record) {
    openModal({
        title: 'Leave Request',
        body: el('div', { class: 'form' }, [
            infoRow('Type', titleCase(record.leaveType)),
            infoRow('From', formatDate(record.fromDate)),
            infoRow('To', formatDate(record.toDate)),
            infoRow('Days', String(record.days)),
            infoRow('Status', titleCase(record.status)),
            infoRow('Applied', formatDate(record.appliedAt)),
            infoRow('Reason', record.reason),
            record.reviewNote ? infoRow('Review Note', record.reviewNote) : null,
        ].filter(Boolean)),
        actions: [{ label: 'Close', variant: 'secondary' }],
    });
}

/* ----------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

function statusBadge(status) {
    const s = String(status || '').toLowerCase();
    const cls = 'status' + (s === 'approved' ? ' is-solid' : s === 'rejected' ? ' is-outline' : ' is-muted');
    return el('span', { class: cls }, [titleCase(s)]);
}

function infoRow(label, value) {
    return el('div', { class: 'flex items-center justify-between gap-3' }, [
        el('span', { class: 'text-muted', text: String(label) }),
        el('span', { class: 'text-mono', text: String(value || '—') }),
    ]);
}

function primaryButton(label, iconName, onClick) {
    const b = el('button', { type: 'button', class: 'btn btn-primary' });
    if (iconName) b.appendChild(icon(iconName, 16));
    b.appendChild(document.createTextNode(label));
    b.addEventListener('click', onClick);
    return b;
}

function textButton(label, onClick) {
    const b = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: label });
    b.addEventListener('click', onClick);
    return b;
}

function option(value, label, selected) {
    const o = el('option', { value, text: label });
    if (selected) o.selected = true;
    return o;
}

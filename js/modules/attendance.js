/**
 * Employee Management & Payroll System
 * Designed and Developed by Yadav Web Technologies
 * ----------------------------------------------------------------------------
 * js/modules/attendance.js
 *
 * Attendance module.
 *
 * Views:
 *   - records : date-range list with filters and pagination
 *   - summary : aggregated counts for a date range
 *   - mark    : bulk marking for a chosen date (admins only)
 *   - correct : modal for editing a single record (admins only)
 *
 * Role behaviour:
 *   - super_admin and hr_admin: full records, marking, corrections
 *   - employee: their own records only, read-only
 *
 * Lifecycle:
 *   mount(container, context)  -> render initial view
 *   unmount()                  -> abort in-flight work, drop state
 */

import { apiGet, apiPost, apiPatch, ApiError } from '../api.js';
import {
    el,
    icon,
    formatDate,
    formatISODate,
    titleCase,
    debounce,
    createLoadingState,
    createEmptyState,
    createErrorState,
    renderTable,
    renderPagination,
    createFormField,
    setFieldError,
    clearFormErrors,
    showToast,
    openModal,
    todayISO,
    isValidISODate,
} from '../ui.js';

/* ----------------------------------------------------------------------------
 * Module state
 * ------------------------------------------------------------------------- */

let mounted = false;
let containerRef = null;
let contextRef = null;
let abortController = null;

const ATTENDANCE_STATUSES = [
    { value: 'present',  label: 'Present' },
    { value: 'absent',   label: 'Absent' },
    { value: 'leave',    label: 'Leave' },
    { value: 'half_day', label: 'Half Day' },
    { value: 'holiday',  label: 'Holiday' },
];

const listState = {
    from: '',
    to: '',
    status: '',
    employeeId: '',
    page: 1,
    pageSize: 50,
};

// Cached employees list (id -> {code, name}) for admin filters and marking.
let employeesById = {};
let employeesLoaded = false;

/* ----------------------------------------------------------------------------
 * Public API
 * ------------------------------------------------------------------------- */

export async function mount(container, context) {
    if (!container) return;

    mounted = true;
    containerRef = container;
    contextRef = context || {};

    if (abortController) {
        try { abortController.abort(); } catch (_e) { /* isolate */ }
    }
    abortController = new AbortController();

    // Default date range: current month.
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, '0');
    listState.from = `${y}-${m}-01`;
    listState.to = `${y}-${m}-${String(new Date(y, today.getMonth() + 1, 0).getDate()).padStart(2, '0')}`;

    if (isAdmin()) {
        loadEmployees();
    }

    await renderRecordsView();
}

export function unmount() {
    mounted = false;
    containerRef = null;
    contextRef = null;
    abortController = null;
}

/* ----------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

function isAdmin() {
    const role = contextRef && contextRef.role;
    return role === 'super_admin' || role === 'hr_admin';
}

function isEmployee() {
    const role = contextRef && contextRef.role;
    return role === 'employee';
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
        employeesLoaded = true;
    } catch (_e) {
        // Leave empty. Filters will show raw IDs if the employee list cannot
        // be loaded. No fabricated data.
        employeesLoaded = true;
    }
}

function employeeLabel(id) {
    if (!id) return '—';
    const e = employeesById[id];
    if (!e) return id;
    return e.code ? `${e.code} — ${e.name}` : e.name;
}

/* ----------------------------------------------------------------------------
 * Records view
 * ------------------------------------------------------------------------- */

async function renderRecordsView() {
    if (!mounted || !containerRef) return;
    containerRef.replaceChildren();

    const head = el('div', { class: 'page-head' }, [
        el('div', {}, [
            el('h1', { class: 'page-title', text: isEmployee() ? 'My Attendance' : 'Attendance' }),
            el('p', { class: 'page-subtitle', text: isEmployee()
                ? 'Your attendance records for the selected date range.'
                : 'View, mark, and correct attendance records.' }),
        ]),
        isAdmin() ? el('div', { class: 'page-head-actions' }, [
            primaryButton('Mark Attendance', 'plus', () => renderMarkView()),
        ]) : null,
    ].filter(Boolean));
    containerRef.appendChild(head);

    const filterBar = el('div', { class: 'filter-bar' });

    const fromInput = el('input', {
        type: 'date',
        class: 'form-input',
        'aria-label': 'From date',
        value: listState.from,
    });
    fromInput.addEventListener('change', () => {
        listState.from = fromInput.value;
        listState.page = 1;
        refreshRecords();
    });

    const toInput = el('input', {
        type: 'date',
        class: 'form-input',
        'aria-label': 'To date',
        value: listState.to,
    });
    toInput.addEventListener('change', () => {
        listState.to = toInput.value;
        listState.page = 1;
        refreshRecords();
    });

    const statusSelect = el('select', { class: 'form-select', 'aria-label': 'Status filter' }, [
        option('', 'All statuses', listState.status === ''),
        ...ATTENDANCE_STATUSES.map((s) => option(s.value, s.label, listState.status === s.value)),
    ]);
    statusSelect.addEventListener('change', () => {
        listState.status = statusSelect.value;
        listState.page = 1;
        refreshRecords();
    });

    filterBar.appendChild(el('label', { class: 'flex flex-col gap-1' }, [
        el('span', { class: 'form-label', text: 'From' }),
        fromInput,
    ]));
    filterBar.appendChild(el('label', { class: 'flex flex-col gap-1' }, [
        el('span', { class: 'form-label', text: 'To' }),
        toInput,
    ]));
    filterBar.appendChild(el('label', { class: 'flex flex-col gap-1' }, [
        el('span', { class: 'form-label', text: 'Status' }),
        statusSelect,
    ]));

    if (isAdmin()) {
        const employeeSelect = el('select', { class: 'form-select', 'aria-label': 'Employee filter' }, [
            option('', 'All employees', !listState.employeeId),
            ...Object.entries(employeesById).map(([id, info]) =>
                option(id, info.code ? `${info.code} — ${info.name}` : info.name, listState.employeeId === id)
            ),
        ]);
        employeeSelect.addEventListener('change', () => {
            listState.employeeId = employeeSelect.value;
            listState.page = 1;
            refreshRecords();
        });
        filterBar.appendChild(el('label', { class: 'flex flex-col gap-1' }, [
            el('span', { class: 'form-label', text: 'Employee' }),
            employeeSelect,
        ]));
    }

    containerRef.appendChild(filterBar);

    const summaryArea = el('div', { class: 'mt-4', id: 'attendance-summary-area' });
    containerRef.appendChild(summaryArea);

    const listArea = el('div', { class: 'mt-4', id: 'attendance-list-area' });
    containerRef.appendChild(listArea);

    await refreshSummary();
    await refreshRecords();
}

async function refreshRecords() {
    if (!mounted || !containerRef) return;
    const area = document.getElementById('attendance-list-area');
    if (!area) return;

    area.replaceChildren(createLoadingState('Loading attendance…'));

    const query = {
        from: listState.from,
        to: listState.to,
        status: listState.status,
        employeeId: isAdmin() ? listState.employeeId : '',
        page: listState.page,
        pageSize: listState.pageSize,
    };

    let response;
    try {
        response = await apiGet('/attendance', {
            query,
            signal: abortController ? abortController.signal : undefined,
        });
    } catch (err) {
        if (err instanceof ApiError && err.code === 'aborted') return;
        if (!mounted) return;
        area.replaceChildren(createErrorState({
            title: 'Unable to load attendance',
            message: (err && err.message) || 'Please try again.',
            onRetry: refreshRecords,
        }));
        return;
    }

    if (!mounted) return;

    const items = Array.isArray(response && response.items) ? response.items : [];
    const total = Number(response && response.total) || 0;

    if (items.length === 0) {
        area.replaceChildren(createEmptyState({
            icon: 'calendar',
            title: 'No attendance records',
            message: 'No records match the selected range and filters.',
        }));
        return;
    }

    const columns = [];
    if (isAdmin()) {
        columns.push({
            key: 'employeeId',
            label: 'Employee',
            render: (r) => el('span', { class: 'truncate', text: employeeLabel(r.employeeId) }),
        });
    }
    columns.push(
        { key: 'date', label: 'Date', render: (r) => el('span', { class: 'text-mono', text: formatDate(r.date) }) },
        { key: 'status', label: 'Status', render: (r) => statusBadge(r.status) },
        { key: 'checkIn', label: 'Check In', render: (r) => el('span', { class: 'text-mono', text: r.checkIn || '—' }) },
        { key: 'checkOut', label: 'Check Out', render: (r) => el('span', { class: 'text-mono', text: r.checkOut || '—' }) },
        { key: 'hoursWorked', label: 'Hours', render: (r) => el('span', { class: 'text-mono', text: r.hoursWorked ? String(r.hoursWorked) : '—' }) },
        { key: 'note', label: 'Note', render: (r) => el('span', { class: 'truncate text-muted', text: r.note || '—' }) },
    );
    if (isAdmin()) {
        columns.push({
            key: 'actions',
            label: 'Actions',
            align: 'right',
            className: 'col-actions',
            render: (r) => textButton('Correct', () => openCorrectModal(r)),
        });
    }

    area.replaceChildren(renderTable({ columns, rows: items, rowKey: (r) => `${r.employeeId}-${r.date}` }));

    area.appendChild(renderPagination({
        page: listState.page,
        pageSize: listState.pageSize,
        total,
        onChange: (p) => {
            listState.page = p;
            refreshRecords();
            const content = document.getElementById('app-content');
            if (content && content.scrollIntoView) content.scrollIntoView({ block: 'start' });
        },
    }));
}

async function refreshSummary() {
    if (!mounted || !containerRef) return;
    const area = document.getElementById('attendance-summary-area');
    if (!area) return;

    let response;
    try {
        response = await apiGet('/attendance/summary', {
            query: {
                from: listState.from,
                to: listState.to,
                employeeId: isAdmin() ? listState.employeeId : '',
            },
            signal: abortController ? abortController.signal : undefined,
        });
    } catch (_err) {
        // Summary failure is not fatal; leave the area empty.
        area.replaceChildren();
        return;
    }

    if (!mounted) return;

    const counts = (response && response.counts) || {};
    area.replaceChildren(el('div', { class: 'stat-grid' }, [
        statCard('Present',    counts.present    || 0),
        statCard('Absent',     counts.absent     || 0),
        statCard('On Leave',   counts.leave      || 0),
        statCard('Not Marked', counts.notMarked  || 0),
    ]));
}

/* ----------------------------------------------------------------------------
 * Mark view (admins only)
 * ------------------------------------------------------------------------- */

async function renderMarkView() {
    if (!mounted || !containerRef) return;
    if (!isAdmin()) return;

    containerRef.replaceChildren();

    const head = el('div', { class: 'page-head' }, [
        el('div', {}, [
            el('div', { class: 'flex items-center gap-2 mb-2' }, [
                textButton('← Back to Attendance', () => renderRecordsView()),
            ]),
            el('h1', { class: 'page-title', text: 'Mark Attendance' }),
            el('p', { class: 'page-subtitle', text: 'Choose a date, set status for each employee, then submit.' }),
        ]),
    ]);
    containerRef.appendChild(head);

    const dateField = createFormField({
        label: 'Date',
        type: 'date',
        required: true,
        value: todayISO(),
        id: 'mark-date',
    });

    const rowsArea = el('div', { class: 'mt-4', id: 'mark-rows-area' });

    const dateWrap = el('div', { class: 'form', style: { maxWidth: '320px' } }, [dateField.group]);

    dateField.input.addEventListener('change', () => {
        renderMarkRows(rowsArea, dateField.input.value);
    });

    containerRef.appendChild(dateWrap);
    containerRef.appendChild(el('div', { class: 'divider' }));
    containerRef.appendChild(rowsArea);

    const submitRow = el('div', { class: 'form-actions mt-4' }, [
        (() => {
            const btn = el('button', { type: 'button', class: 'btn btn-primary', text: 'Submit Attendance' });
            btn.addEventListener('click', () => submitBulk(btn));
            return btn;
        })(),
        (() => {
            const btn = el('button', { type: 'button', class: 'btn btn-secondary', text: 'Cancel' });
            btn.addEventListener('click', () => renderRecordsView());
            return btn;
        })(),
    ]);
    containerRef.appendChild(submitRow);

    await loadEmployees();
    renderMarkRows(rowsArea, dateField.input.value);
}

function renderMarkRows(area, dateISO) {
    if (!area) return;
    area.replaceChildren();

    if (!isValidISODate(dateISO)) {
        area.appendChild(createEmptyState({
            title: 'Choose a date',
            message: 'Select a valid date to list employees.',
        }));
        return;
    }

    const entries = Object.entries(employeesById);
    if (entries.length === 0) {
        area.appendChild(createEmptyState({
            title: 'No employees yet',
            message: 'Add employees before marking attendance.',
        }));
        return;
    }

    const table = el('table', { class: 'data-table' });
    const thead = el('thead');
    const hr = el('tr');
    hr.appendChild(el('th', { text: 'Code' }));
    hr.appendChild(el('th', { text: 'Employee' }));
    hr.appendChild(el('th', { text: 'Status' }));
    hr.appendChild(el('th', { text: 'Check In' }));
    hr.appendChild(el('th', { text: 'Check Out' }));
    hr.appendChild(el('th', { text: 'Note' }));
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = el('tbody');

    for (const [id, info] of entries) {
        const tr = el('tr');
        tr.dataset.employeeId = id;

        tr.appendChild(el('td', {}, [el('span', { class: 'text-mono', text: info.code || '—' })]));
        tr.appendChild(el('td', { text: info.name }));

        const statusSelect = el('select', { class: 'form-select' }, ATTENDANCE_STATUSES.map((s) =>
            option(s.value, s.label, s.value === 'present')
        ));
        statusSelect.dataset.field = 'status';
        tr.appendChild(el('td', {}, [statusSelect]));

        const inInput = el('input', { type: 'time', class: 'form-input' });
        inInput.dataset.field = 'checkIn';
        tr.appendChild(el('td', {}, [inInput]));

        const outInput = el('input', { type: 'time', class: 'form-input' });
        outInput.dataset.field = 'checkOut';
        tr.appendChild(el('td', {}, [outInput]));

        const noteInput = el('input', { type: 'text', class: 'form-input', placeholder: 'Optional' });
        noteInput.dataset.field = 'note';
        tr.appendChild(el('td', {}, [noteInput]));

        tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    area.appendChild(el('div', { class: 'table-wrapper' }, [table]));
    area.dataset.date = dateISO;
}

async function submitBulk(button) {
    const area = document.getElementById('mark-rows-area');
    if (!area) return;
    const date = area.dataset.date || '';
    if (!isValidISODate(date)) {
        showToast('Choose a valid date first.', { type: 'error' });
        return;
    }

    const rows = area.querySelectorAll('tbody tr');
    const records = [];
    for (const tr of rows) {
        const employeeId = tr.dataset.employeeId;
        if (!employeeId) continue;
        const status = tr.querySelector('[data-field="status"]').value;
        const checkIn = tr.querySelector('[data-field="checkIn"]').value;
        const checkOut = tr.querySelector('[data-field="checkOut"]').value;
        const note = tr.querySelector('[data-field="note"]').value;
        records.push({ employeeId, status, checkIn, checkOut, note });
    }

    if (records.length === 0) {
        showToast('No employees to mark.', { type: 'error' });
        return;
    }

    const original = button.textContent;
    button.disabled = true;
    button.textContent = 'Submitting…';

    let result;
    try {
        result = await apiPost('/attendance/bulk', { date, records });
    } catch (err) {
        button.disabled = false;
        button.textContent = original;
        if (err instanceof ApiError) showToast(err.message || 'Unable to submit.', { type: 'error' });
        else showToast('Unable to submit.', { type: 'error' });
        return;
    }

    button.disabled = false;
    button.textContent = original;

    const written = Number(result && result.writtenCount) || 0;
    const failed = Number(result && result.failedCount) || 0;

    if (failed === 0) {
        showToast(`Marked attendance for ${written} employee${written === 1 ? '' : 's'}.`, { type: 'success' });
    } else {
        showToast(`Marked ${written}, failed ${failed}. Check the details and retry.`, { type: 'error' });
    }

    renderRecordsView();
}

/* ----------------------------------------------------------------------------
 * Correct modal (admins only)
 * ------------------------------------------------------------------------- */

function openCorrectModal(record) {
    if (!record) return;

    const statusField = createFormField({
        label: 'Status',
        type: 'select',
        required: true,
        value: record.status,
        options: ATTENDANCE_STATUSES,
        id: 'correct-status',
    });
    const inField = createFormField({
        label: 'Check In',
        type: 'time',
        value: record.checkIn || '',
        id: 'correct-checkin',
    });
    const outField = createFormField({
        label: 'Check Out',
        type: 'time',
        value: record.checkOut || '',
        id: 'correct-checkout',
    });
    const noteField = createFormField({
        label: 'Note',
        type: 'textarea',
        value: record.note || '',
        id: 'correct-note',
    });

    openModal({
        title: 'Correct Attendance',
        body: el('div', {}, [
            el('p', { class: 'text-muted', text: `Employee: ${employeeLabel(record.employeeId)}` }),
            el('p', { class: 'text-muted mb-4', text: `Date: ${formatDate(record.date)}` }),
            el('div', { class: 'form' }, [
                statusField.group,
                el('div', { class: 'form-row' }, [inField.group, outField.group]),
                noteField.group,
            ]),
        ]),
        actions: [
            { label: 'Cancel', variant: 'secondary' },
            {
                label: 'Save Correction',
                variant: 'primary',
                closeOnClick: false,
                onClick: async (close) => {
                    clearFormErrors([statusField, inField, outField, noteField]);

                    const payload = {
                        status: statusField.input.value,
                        checkIn: inField.input.value,
                        checkOut: outField.input.value,
                        note: noteField.input.value,
                    };

                    try {
                        await apiPatch(`/attendance/${encodeURIComponent(record.employeeId)}/${record.date}`, payload);
                        showToast('Attendance corrected.', { type: 'success' });
                        close();
                        refreshRecords();
                        refreshSummary();
                    } catch (err) {
                        if (err instanceof ApiError) {
                            showToast(err.message || 'Unable to save correction.', { type: 'error' });
                        } else {
                            showToast('Unable to save correction.', { type: 'error' });
                        }
                    }
                },
            },
        ],
    });
}

/* ----------------------------------------------------------------------------
 * Render helpers
 * ------------------------------------------------------------------------- */

function statusBadge(status) {
    const s = String(status || '').toLowerCase();
    const label = titleCase(s || '—');
    const cls = 'status' +
        (s === 'present' ? ' is-solid' :
         s === 'absent'  ? ' is-outline' :
         ' is-muted');
    return el('span', { class: cls }, [ label ]);
}

function statCard(label, value) {
    return el('div', { class: 'stat-card' }, [
        el('span', { class: 'stat-label', text: label }),
        el('span', { class: 'stat-value', text: String(value) }),
    ]);
}

function primaryButton(label, iconName, onClick) {
    const btn = el('button', { type: 'button', class: 'btn btn-primary' });
    if (iconName) btn.appendChild(icon(iconName, 16));
    btn.appendChild(document.createTextNode(label));
    btn.addEventListener('click', onClick);
    return btn;
}

function textButton(label, onClick) {
    const btn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: label });
    btn.addEventListener('click', onClick);
    return btn;
}

function option(value, label, selected) {
    const opt = el('option', { value, text: label });
    if (selected) opt.selected = true;
    return opt;
}

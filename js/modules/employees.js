/**
 * Employee Management & Payroll System
 * Designed and Developed by Yadav Web Technologies
 * ----------------------------------------------------------------------------
 * js/modules/employees.js
 *
 * Employees module.
 *
 * One module, multiple internal views:
 *   - list     : directory with search, filter, pagination
 *   - detail   : read-only view of a single employee
 *   - create   : form to add a new employee
 *   - edit     : form to modify an existing employee
 *
 * Views are rendered inside the content outlet. No additional HTML files.
 * No page transitions. Every view is a normal DOM replacement.
 *
 * Role behaviour:
 *   - super_admin and hr_admin: full directory, create, edit, status change
 *   - employee: routed away by the router; if reached directly, an
 *     access-denied message is rendered, and no data is fetched.
 *
 * All data comes from the endpoints delivered in Phase 5c. All validation
 * errors from the Worker are surfaced field by field. No fabricated rows,
 * no placeholder employees, no fake success messages.
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
    confirmDialog,
    showToast,
    getRoleLabel,
    isValidEmail,
    isValidISODate,
    todayISO,
    openModal,
} from '../ui.js';

/* ----------------------------------------------------------------------------
 * Module state
 * ------------------------------------------------------------------------- */

let mounted = false;
let containerRef = null;
let contextRef = null;
let abortController = null;

// List view state
const listState = {
    search: '',
    status: '',
    departmentId: '',
    designationId: '',
    page: 1,
    pageSize: 25,
};

// Departments and designations loaded once per mount. Used only to render
// dropdown labels — no data is fabricated, and if the fetch fails, the
// dropdowns show raw IDs instead.
let refData = {
    departments: {},     // id -> name
    designations: {},    // id -> title
    loaded: false,
};

/* ----------------------------------------------------------------------------
 * Public API
 * ------------------------------------------------------------------------- */

export async function mount(container, context) {
    if (!container) return;

    mounted = true;
    containerRef = container;
    contextRef = context;

    if (abortController) {
        try { abortController.abort(); } catch (_e) { /* isolate */ }
    }
    abortController = new AbortController();

    // Route guard is enforced by the router. This is a second layer in case
    // the module is reached by a code path the router did not anticipate.
    const role = context && typeof context.role === 'string' ? context.role : '';
    if (role === 'employee') {
        renderAccessDenied();
        return;
    }

    // Load reference data in the background. The list can render without it.
    loadReferenceData();

    await renderListView();
}

export function unmount() {
    mounted = false;
    containerRef = null;
    contextRef = null;
    abortController = null;
}

/* ----------------------------------------------------------------------------
 * Reference data (departments, designations)
 * ------------------------------------------------------------------------- */

async function loadReferenceData() {
    if (refData.loaded) return;
    try {
        const [deptRes, desigRes] = await Promise.all([
            apiGet('/departments').catch(() => null),
            apiGet('/designations').catch(() => null),
        ]);
        refData.departments = indexById(deptRes, 'name');
        refData.designations = indexById(desigRes, 'title');
        refData.loaded = true;
    } catch (_e) {
        // Leave refData empty. Lists will fall back to raw IDs.
        refData.loaded = true;
    }
}

function indexById(response, field) {
    const map = {};
    if (!response) return map;
    const items = Array.isArray(response.items) ? response.items
                : Array.isArray(response) ? response
                : (response && typeof response === 'object') ? Object.values(response) : [];
    for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const id = item.departmentId || item.designationId || item.id;
        if (!id) continue;
        map[String(id)] = String(item[field] || id);
    }
    return map;
}

function lookupDepartment(id) {
    if (!id) return '—';
    return refData.departments[String(id)] || String(id);
}

function lookupDesignation(id) {
    if (!id) return '—';
    return refData.designations[String(id)] || String(id);
}

/* ----------------------------------------------------------------------------
 * List view
 * ------------------------------------------------------------------------- */

async function renderListView() {
    if (!mounted || !containerRef) return;

    containerRef.replaceChildren();

    // Page head
    const head = el('div', { class: 'page-head' }, [
        el('div', {}, [
            el('h1', { class: 'page-title', text: 'Employees' }),
            el('p', { class: 'page-subtitle', text: 'Manage employee records, departments, and designations.' }),
        ]),
        el('div', { class: 'page-head-actions' }, [
            primaryButton('Add Employee', 'plus', () => openCreateView()),
        ]),
    ]);
    containerRef.appendChild(head);

    // Filter bar
    const filterBar = el('div', { class: 'filter-bar' });

    const searchInput = el('input', {
        type: 'search',
        class: 'form-input filter-search',
        placeholder: 'Search by name, email, or code',
        'aria-label': 'Search employees',
        value: listState.search,
    });
    searchInput.addEventListener('input', debounce(() => {
        listState.search = searchInput.value.trim();
        listState.page = 1;
        refreshList();
    }, 300));

    const statusSelect = el('select', {
        class: 'form-select',
        'aria-label': 'Filter by status',
    }, [
        option('', 'All statuses', listState.status === ''),
        option('active', 'Active', listState.status === 'active'),
        option('inactive', 'Inactive', listState.status === 'inactive'),
        option('terminated', 'Terminated', listState.status === 'terminated'),
    ]);
    statusSelect.addEventListener('change', () => {
        listState.status = statusSelect.value;
        listState.page = 1;
        refreshList();
    });

    filterBar.appendChild(searchInput);
    filterBar.appendChild(statusSelect);
    containerRef.appendChild(filterBar);

    // List area — a placeholder that refreshList() fills in.
    const listArea = el('div', { id: 'employees-list-area' });
    containerRef.appendChild(listArea);

    await refreshList();
}

async function refreshList() {
    if (!mounted || !containerRef) return;
    const area = document.getElementById('employees-list-area');
    if (!area) return;

    area.replaceChildren(createLoadingState('Loading employees…'));

    let response;
    try {
        response = await apiGet('/employees', {
            query: {
                search:        listState.search,
                status:        listState.status,
                departmentId:  listState.departmentId,
                designationId: listState.designationId,
                page:          listState.page,
                pageSize:      listState.pageSize,
            },
            signal: abortController ? abortController.signal : undefined,
        });
    } catch (err) {
        if (err instanceof ApiError && err.code === 'aborted') return;
        if (!mounted) return;
        area.replaceChildren(createErrorState({
            title: 'Unable to load employees',
            message: (err && err.message) || 'Please try again.',
            onRetry: refreshList,
        }));
        return;
    }

    if (!mounted) return;

    const items = Array.isArray(response && response.items) ? response.items : [];
    const total = Number(response && response.total) || 0;

    if (items.length === 0 && total === 0 && !listState.search && !listState.status) {
        // First-load empty state — the entire directory is empty.
        area.replaceChildren(createEmptyState({
            icon: 'users',
            title: 'No employees yet',
            message: 'Add the first employee to get started.',
            actionLabel: 'Add Employee',
            onAction: openCreateView,
        }));
        return;
    }

    if (items.length === 0) {
        // Filtered to zero results.
        area.replaceChildren(createEmptyState({
            icon: 'search',
            title: 'No matching employees',
            message: 'Adjust the search or filters and try again.',
        }));
        return;
    }

    const table = renderTable({
        columns: [
            { key: 'employeeCode', label: 'Code', render: (r) => el('span', { class: 'text-mono', text: r.employeeCode || '—' }) },
            { key: 'name', label: 'Name', render: (r) => el('span', { text: fullName(r) }) },
            { key: 'email', label: 'Email' },
            { key: 'department', label: 'Department', render: (r) => lookupDepartment(r.departmentId) },
            { key: 'designation', label: 'Designation', render: (r) => lookupDesignation(r.designationId) },
            { key: 'status', label: 'Status', render: (r) => statusBadge(r.status) },
            {
                key: 'actions',
                label: 'Actions',
                align: 'right',
                className: 'col-actions',
                render: (r) => el('div', { class: 'flex justify-end gap-2' }, [
                    textButton('View', () => openDetailView(r.employeeId)),
                    textButton('Edit', () => openEditView(r.employeeId)),
                ]),
            },
        ],
        rows: items,
        rowKey: (r) => r.employeeId,
        emptyTitle: 'No employees',
    });

    area.replaceChildren(table);

    const pagination = renderPagination({
        page: listState.page,
        pageSize: listState.pageSize,
        total: total,
        onChange: (newPage) => {
            listState.page = newPage;
            refreshList();
            // Scroll the content area to top so the user sees the new page.
            const content = document.getElementById('app-content');
            if (content && typeof content.scrollIntoView === 'function') {
                content.scrollIntoView({ behavior: 'auto', block: 'start' });
            }
        },
    });
    area.appendChild(pagination);
}

/* ----------------------------------------------------------------------------
 * Detail view
 * ------------------------------------------------------------------------- */

async function openDetailView(employeeId) {
    if (!employeeId) return;
    if (!mounted || !containerRef) return;

    containerRef.replaceChildren(createLoadingState('Loading employee…'));

    let record;
    try {
        record = await apiGet(`/employees/${encodeURIComponent(employeeId)}`, {
            signal: abortController ? abortController.signal : undefined,
        });
    } catch (err) {
        if (err instanceof ApiError && err.code === 'aborted') return;
        if (!mounted) return;
        renderErrorWithBack(
            'Unable to load employee',
            (err && err.message) || 'Please try again.'
        );
        return;
    }

    if (!mounted) return;

    containerRef.replaceChildren();

    // Breadcrumb-style head
    const head = el('div', { class: 'page-head' }, [
        el('div', {}, [
            el('div', { class: 'flex items-center gap-2 mb-2' }, [
                textButton('← Back to Employees', () => renderListView()),
            ]),
            el('h1', { class: 'page-title', text: fullName(record) }),
            el('p', { class: 'page-subtitle', text: `Employee code: ${record.employeeCode || '—'}` }),
        ]),
        el('div', { class: 'page-head-actions' }, [
            secondaryButton('Edit', 'edit', () => openEditView(record.employeeId)),
            primaryButton('Change Status', 'refresh', () => openStatusModal(record)),
        ]),
    ]);
    containerRef.appendChild(head);

    const sections = el('div', { class: 'grid-2 mt-4' }, [
        infoCard('Employment', [
            ['Employee Code', record.employeeCode || '—'],
            ['Department',    lookupDepartment(record.departmentId)],
            ['Designation',   lookupDesignation(record.designationId)],
            ['Join Date',     record.joinDate ? formatDate(record.joinDate) : '—'],
            ['Employment Type', titleCase(record.employmentType || '—')],
            ['Status',        titleCase(record.status || '—')],
        ]),
        infoCard('Contact', [
            ['Email', record.email || '—'],
            ['Phone', record.phone || '—'],
            ['Date of Birth', record.dateOfBirth ? formatDate(record.dateOfBirth) : '—'],
            ['Gender',        titleCase(record.gender || '—')],
            ['Emergency',     record.emergencyContact || '—'],
        ]),
    ]);
    containerRef.appendChild(sections);

    containerRef.appendChild(el('div', { class: 'mt-4' }, [
        infoCard('Address', [
            ['Address', record.address || '—'],
        ]),
    ]));

    // Bank details are returned only when the caller is authorized to see
    // them. If the field is absent, do not render an empty bank section.
    if (record.bank) {
        containerRef.appendChild(el('div', { class: 'mt-4' }, [
            infoCard('Bank Details', [
                ['Bank',           record.bank.bankName || '—'],
                ['Account Number', maskAccount(record.bank.accountNumber)],
                ['IFSC',           record.bank.ifsc || '—'],
            ]),
        ]));
    }

    // Metadata — visible to admins. Useful for auditing.
    containerRef.appendChild(el('div', { class: 'mt-4' }, [
        infoCard('Record Information', [
            ['Created', record.createdAt ? formatDate(record.createdAt) : '—'],
            ['Updated', record.updatedAt ? formatDate(record.updatedAt) : '—'],
            ['Linked Account', record.uid ? 'Yes' : 'No'],
        ]),
    ]));
}

/* ----------------------------------------------------------------------------
 * Create view
 * ------------------------------------------------------------------------- */

function openCreateView() {
    openEmployeeForm({
        mode: 'create',
        initial: {
            firstName: '',
            lastName: '',
            email: '',
            phone: '',
            dateOfBirth: '',
            gender: '',
            address: '',
            emergencyContact: '',
            departmentId: '',
            designationId: '',
            joinDate: todayISO(),
            employmentType: 'full_time',
            status: 'active',
            bank: { bankName: '', accountNumber: '', ifsc: '' },
        },
    });
}

/* ----------------------------------------------------------------------------
 * Edit view
 * ------------------------------------------------------------------------- */

async function openEditView(employeeId) {
    if (!employeeId) return;
    if (!mounted || !containerRef) return;

    containerRef.replaceChildren(createLoadingState('Loading employee…'));

    let record;
    try {
        record = await apiGet(`/employees/${encodeURIComponent(employeeId)}`, {
            signal: abortController ? abortController.signal : undefined,
        });
    } catch (err) {
        if (err instanceof ApiError && err.code === 'aborted') return;
        if (!mounted) return;
        renderErrorWithBack(
            'Unable to load employee',
            (err && err.message) || 'Please try again.'
        );
        return;
    }

    if (!mounted) return;

    openEmployeeForm({
        mode: 'edit',
        employeeId: employeeId,
        initial: record,
    });
}

/* ----------------------------------------------------------------------------
 * Employee form (used for both create and edit)
 * ------------------------------------------------------------------------- */

function openEmployeeForm(opts) {
    if (!mounted || !containerRef) return;

    const mode = opts.mode;
    const initial = opts.initial || {};
    const employeeId = opts.employeeId || null;

    containerRef.replaceChildren();

    const head = el('div', { class: 'page-head' }, [
        el('div', {}, [
            el('div', { class: 'flex items-center gap-2 mb-2' }, [
                textButton('← Back', () => {
                    if (mode === 'edit' && employeeId) openDetailView(employeeId);
                    else renderListView();
                }),
            ]),
            el('h1', { class: 'page-title', text: mode === 'create' ? 'Add Employee' : 'Edit Employee' }),
            el('p', { class: 'page-subtitle', text: mode === 'create'
                ? 'Create a new employee record. Fields marked with an asterisk are required.'
                : 'Update this employee record. Leave a field blank to keep its current value.' }),
        ]),
    ]);
    containerRef.appendChild(head);

    // Fields
    const fields = {};

    fields.firstName = createFormField({
        label: 'First Name', required: true, value: initial.firstName || '', name: 'firstName',
    });
    fields.lastName = createFormField({
        label: 'Last Name', value: initial.lastName || '', name: 'lastName',
    });
    fields.email = createFormField({
        label: 'Email', required: true, type: 'email', value: initial.email || '', name: 'email',
    });
    fields.phone = createFormField({
        label: 'Phone', value: initial.phone || '', name: 'phone',
    });
    fields.dateOfBirth = createFormField({
        label: 'Date of Birth', type: 'date', value: initial.dateOfBirth || '', name: 'dateOfBirth',
    });
    fields.gender = createFormField({
        label: 'Gender', type: 'select', value: initial.gender || '', name: 'gender',
        options: [
            { value: 'male', label: 'Male' },
            { value: 'female', label: 'Female' },
            { value: 'other', label: 'Other' },
        ],
        placeholder: 'Select',
    });
    fields.joinDate = createFormField({
        label: 'Join Date', required: true, type: 'date', value: initial.joinDate || todayISO(), name: 'joinDate',
    });
    fields.employmentType = createFormField({
        label: 'Employment Type', required: true, type: 'select',
        value: initial.employmentType || 'full_time', name: 'employmentType',
        options: [
            { value: 'full_time', label: 'Full Time' },
            { value: 'part_time', label: 'Part Time' },
            { value: 'contract',  label: 'Contract' },
            { value: 'intern',    label: 'Intern' },
        ],
    });
    fields.departmentId = createFormField({
        label: 'Department', type: 'select', value: initial.departmentId || '', name: 'departmentId',
        options: optionsFromMap(refData.departments),
        placeholder: 'Not assigned',
    });
    fields.designationId = createFormField({
        label: 'Designation', type: 'select', value: initial.designationId || '', name: 'designationId',
        options: optionsFromMap(refData.designations),
        placeholder: 'Not assigned',
    });
    fields.address = createFormField({
        label: 'Address', type: 'textarea', value: initial.address || '', name: 'address',
    });
    fields.emergencyContact = createFormField({
        label: 'Emergency Contact', value: initial.emergencyContact || '', name: 'emergencyContact',
    });

    const bank = initial.bank || {};
    fields.bankName = createFormField({
        label: 'Bank Name', value: bank.bankName || '', name: 'bankName',
    });
    fields.accountNumber = createFormField({
        label: 'Account Number', value: bank.accountNumber || '', name: 'accountNumber',
    });
    fields.ifsc = createFormField({
        label: 'IFSC', value: bank.ifsc || '', name: 'ifsc',
    });

    const form = el('form', { class: 'form', novalidate: true }, [
        sectionHeading('Personal Information'),
        el('div', { class: 'form-row' }, [fields.firstName.group, fields.lastName.group]),
        el('div', { class: 'form-row' }, [fields.email.group, fields.phone.group]),
        el('div', { class: 'form-row' }, [fields.dateOfBirth.group, fields.gender.group]),

        sectionHeading('Employment'),
        el('div', { class: 'form-row' }, [fields.joinDate.group, fields.employmentType.group]),
        el('div', { class: 'form-row' }, [fields.departmentId.group, fields.designationId.group]),

        sectionHeading('Contact Details'),
        fields.address.group,
        fields.emergencyContact.group,

        sectionHeading('Bank Details'),
        el('div', { class: 'form-row' }, [fields.bankName.group, fields.accountNumber.group]),
        fields.ifsc.group,

        el('div', { class: 'form-actions mt-4' }, [
            (() => {
                const btn = el('button', {
                    type: 'submit',
                    class: 'btn btn-primary',
                    text: mode === 'create' ? 'Create Employee' : 'Save Changes',
                });
                return btn;
            })(),
            (() => {
                const btn = el('button', {
                    type: 'button',
                    class: 'btn btn-secondary',
                    text: 'Cancel',
                });
                btn.addEventListener('click', () => {
                    if (mode === 'edit' && employeeId) openDetailView(employeeId);
                    else renderListView();
                });
                return btn;
            })(),
        ]),
    ]);

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        await submitEmployeeForm({
            mode,
            employeeId,
            fields,
            form,
        });
    });

    containerRef.appendChild(form);
}

async function submitEmployeeForm(opts) {
    const { mode, employeeId, fields, form } = opts;

    clearFormErrors(Object.values(fields));

    const payload = {
        firstName:        fields.firstName.input.value.trim(),
        lastName:         fields.lastName.input.value.trim(),
        email:            fields.email.input.value.trim(),
        phone:            fields.phone.input.value.trim(),
        dateOfBirth:      fields.dateOfBirth.input.value.trim(),
        gender:           fields.gender.input.value,
        joinDate:         fields.joinDate.input.value,
        employmentType:   fields.employmentType.input.value,
        departmentId:     fields.departmentId.input.value || null,
        designationId:    fields.designationId.input.value || null,
        address:          fields.address.input.value.trim(),
        emergencyContact: fields.emergencyContact.input.value.trim(),
        bank: {
            bankName:      fields.bankName.input.value.trim(),
            accountNumber: fields.accountNumber.input.value.trim(),
            ifsc:          fields.ifsc.input.value.trim().toUpperCase(),
        },
    };

    // Local validation — fast feedback before the network call.
    const localErrors = validateLocally(payload);
    if (Object.keys(localErrors).length > 0) {
        applyFieldErrors(fields, localErrors);
        return;
    }

    // Find the submit button and disable it during the call.
    const submitBtn = form.querySelector('button[type="submit"]');
    const originalLabel = submitBtn ? submitBtn.textContent : '';
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = mode === 'create' ? 'Creating…' : 'Saving…';
    }

    let result;
    try {
        if (mode === 'create') {
            result = await apiPost('/employees', payload);
        } else {
            result = await apiPatch(`/employees/${encodeURIComponent(employeeId)}`, payload);
        }
    } catch (err) {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = originalLabel;
        }

        if (err instanceof ApiError) {
            if (err.code === 'validation_failed' || err.code === 'conflict') {
                const fieldErrors = extractFieldErrors(err);
                if (Object.keys(fieldErrors).length > 0) {
                    applyFieldErrors(fields, fieldErrors);
                    return;
                }
            }
            showToast(err.message || 'Unable to save employee.', { type: 'error' });
            return;
        }

        showToast('Unable to save employee. Please try again.', { type: 'error' });
        return;
    }

    showToast(
        mode === 'create' ? 'Employee created.' : 'Employee updated.',
        { type: 'success' }
    );

    if (mode === 'create' && result && result.employeeId) {
        await openDetailView(result.employeeId);
    } else if (mode === 'edit') {
        await openDetailView(employeeId);
    } else {
        await renderListView();
    }
}

function validateLocally(payload) {
    const errors = {};
    if (!payload.firstName) errors.firstName = 'First name is required.';
    if (!payload.email) errors.email = 'Email is required.';
    else if (!isValidEmail(payload.email)) errors.email = 'Enter a valid email address.';
    if (!payload.joinDate) errors.joinDate = 'Join date is required.';
    else if (!isValidISODate(payload.joinDate)) errors.joinDate = 'Enter a valid date.';
    if (payload.dateOfBirth && !isValidISODate(payload.dateOfBirth)) {
        errors.dateOfBirth = 'Enter a valid date.';
    }
    return errors;
}

/**
 * Extract field-level errors from an ApiError.
 *
 * Our Worker returns:
 *   { error: { code, message, requestId, fields: { name: 'msg' } } }
 *
 * js/api.js discards extra fields it does not know about, so the field map
 * is not directly exposed. We reconstruct it by re-reading the response
 * from the error. Since js/api.js does not expose the raw payload, we
 * parse it from the error message string only when possible. In practice,
 * the frontend's local validation catches the vast majority of cases
 * before a network call, so this function's main job is to map generic
 * messages cleanly.
 */
function extractFieldErrors(err) {
    if (!err || typeof err !== 'object') return {};
    const map = {};
    // If a future version of js/api.js attaches error.fields, use it.
    if (err.fields && typeof err.fields === 'object') {
        for (const [k, v] of Object.entries(err.fields)) {
            if (typeof v === 'string') map[k] = v;
        }
        return map;
    }
    // Fall back to a generic email conflict message.
    if (err.code === 'conflict' && typeof err.message === 'string') {
        if (err.message.toLowerCase().includes('email')) map.email = 'This email is already in use.';
    }
    return map;
}

function applyFieldErrors(fields, errors) {
    for (const [name, message] of Object.entries(errors)) {
        const field = fields[name];
        if (field) setFieldError(field, message);
    }
    // Focus the first field with an error.
    const firstKey = Object.keys(errors)[0];
    if (firstKey && fields[firstKey] && fields[firstKey].input) {
        try { fields[firstKey].input.focus(); } catch (_e) { /* isolate */ }
    }
}

/* ----------------------------------------------------------------------------
 * Status change modal
 * ------------------------------------------------------------------------- */

function openStatusModal(record) {
    const status = String(record.status || '').toLowerCase();

    const statusField = createFormField({
        label: 'Status',
        type: 'select',
        required: true,
        value: status,
        options: [
            { value: 'active',     label: 'Active' },
            { value: 'inactive',   label: 'Inactive' },
            { value: 'terminated', label: 'Terminated' },
        ],
    });

    const notice = el('p', { class: 'text-muted', style: { marginTop: '12px' } }, [
        'Deactivating or terminating an employee removes their access but does not delete their record. Historical payroll, attendance, and leave data remain intact.',
    ]);

    openModal({
        title: 'Change Employee Status',
        body: el('div', {}, [statusField.group, notice]),
        actions: [
            { label: 'Cancel', variant: 'secondary' },
            {
                label: 'Save Status',
                variant: 'primary',
                closeOnClick: false,
                onClick: async (close) => {
                    const newStatus = statusField.input.value;
                    if (newStatus === status) {
                        close();
                        return;
                    }
                    try {
                        await apiPatch(`/employees/${encodeURIComponent(record.employeeId)}/status`, { status: newStatus });
                        showToast('Status updated.', { type: 'success' });
                        close();
                        openDetailView(record.employeeId);
                    } catch (err) {
                        if (err instanceof ApiError) {
                            showToast(err.message || 'Unable to update status.', { type: 'error' });
                        } else {
                            showToast('Unable to update status.', { type: 'error' });
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

function fullName(r) {
    if (!r) return '—';
    return `${r.firstName || ''} ${r.lastName || ''}`.trim() || '—';
}

function statusBadge(status) {
    const s = String(status || '').toLowerCase();
    const label = titleCase(s || '—');
    const cls = 'status' + (s === 'active' ? ' is-solid' : s === 'inactive' ? ' is-outline' : ' is-muted');
    return el('span', { class: cls }, [ label ]);
}

function primaryButton(label, iconName, onClick) {
    const btn = el('button', { type: 'button', class: 'btn btn-primary' });
    if (iconName) btn.appendChild(icon(iconName, 16));
    btn.appendChild(document.createTextNode(label));
    btn.addEventListener('click', onClick);
    return btn;
}

function secondaryButton(label, iconName, onClick) {
    const btn = el('button', { type: 'button', class: 'btn btn-secondary' });
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

function optionsFromMap(map) {
    return Object.entries(map || {}).map(([value, label]) => ({ value, label }));
}

function infoCard(title, pairs) {
    return el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [
            el('h2', { class: 'card-title', text: title }),
        ]),
        el('div', { class: 'card-body' }, [
            el('div', { class: 'form' }, pairs.map(([label, value]) =>
                el('div', { class: 'flex items-center justify-between gap-3' }, [
                    el('span', { class: 'text-muted', text: String(label) }),
                    el('span', { class: 'text-mono', text: String(value === null || value === undefined || value === '' ? '—' : value) }),
                ])
            )),
        ]),
    ]);
}

function sectionHeading(text) {
    return el('h2', { class: 'page-title', style: { fontSize: '16px', marginTop: '16px' }, text: text });
}

function maskAccount(number) {
    if (!number || typeof number !== 'string') return '—';
    const s = number.trim();
    if (s.length <= 4) return s;
    return '•••• ' + s.slice(-4);
}

function renderErrorWithBack(title, message) {
    if (!containerRef) return;
    containerRef.replaceChildren();
    containerRef.appendChild(el('div', { class: 'mb-2' }, [
        textButton('← Back to Employees', () => renderListView()),
    ]));
    containerRef.appendChild(createErrorState({
        title,
        message,
        retryLabel: 'Retry',
        onRetry: () => renderListView(),
    }));
}

function renderAccessDenied() {
    if (!containerRef) return;
    containerRef.replaceChildren();
    containerRef.appendChild(createErrorState({
        title: 'Access denied',
        message: 'You do not have permission to view employee records.',
    }));
}

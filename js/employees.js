/* =========================================================
   EMPLOYEE MANAGEMENT & PAYROLL SYSTEM
   FILE: js/employees.js

   PURPOSE:
   Employee management frontend controller.

   DATA SOURCE:
   Protected backend through EMSFirebase.

   SECURITY:
   - No demo records.
   - No hardcoded employee information.
   - No client-side role assignment.
   - No direct unauthorised database writes.
   - All mutations require backend permission checks.
========================================================= */

"use strict";

(() => {

    /* =====================================================
       01. CONFIGURATION
    ===================================================== */

    const CONFIG = Object.freeze({

        pageSize: 10,

        maxPageSize: 100,

        searchDelay: 350,

        allowedRoles: [
            "super_admin",
            "hr_admin",
            "employee"
        ],

        managementRoles: [
            "super_admin",
            "hr_admin"
        ],

        endpoints: {

            list: "/employees",

            create: "/employees",

            departments: "/settings/departments",

            designations: "/settings/designations"

        }

    });


    /* =====================================================
       02. APPLICATION STATE
    ===================================================== */

    const state = {

        initialized: false,

        context: null,

        employees: [],

        totalRecords: 0,

        currentPage: 1,

        pageSize: CONFIG.pageSize,

        loading: false,

        saving: false,

        requestSequence: 0,

        searchTimer: null,

        editingEmployeeId: null,

        filters: {

            search: "",

            department: "",

            status: ""

        }

    };


    /* =====================================================
       03. DOM UTILITIES
    ===================================================== */

    const get = (id) => document.getElementById(id);


    const firstAvailable = (...ids) => {

        for (const id of ids) {

            const element = get(id);

            if (element) {
                return element;
            }

        }

        return null;

    };


    const setText = (id, value) => {

        const element = get(id);

        if (element) {

            element.textContent = String(value ?? "");

        }

    };


    const setVisible = (id, visible) => {

        const element = get(id);

        if (element) {

            element.hidden = !visible;

        }

    };


    const notify = (message, type = "success") => {

        window.EMSUI?.showToast(message, type);

    };


    const create = (
        tag,
        text = "",
        className = ""
    ) => {

        const element = document.createElement(tag);

        element.textContent = String(text ?? "");

        if (className) {

            element.className = className;

        }

        return element;

    };


    const appendTextCell = (
        row,
        value,
        label
    ) => {

        const cell = create(
            "td",
            value ?? "—"
        );

        cell.dataset.label = label;

        row.appendChild(cell);

        return cell;

    };


    /* =====================================================
       04. SECURITY HELPERS
    ===================================================== */

    const canManageEmployees = () => {

        if (!state.context) {
            return false;
        }

        return CONFIG.managementRoles.includes(
            state.context.role
        );

    };


    const requireManagementAccess = () => {

        if (!canManageEmployees()) {

            throw new Error(
                "You do not have permission to manage employees."
            );

        }

        /*
         * This is a frontend usability check only.
         * The backend must independently enforce
         * permissions for every operation.
         */

    };


    const request = async (
        path,
        options = {}
    ) => {

        if (
            !window.EMSFirebase ||
            typeof window.EMSFirebase.request !== "function"
        ) {

            throw new Error(
                "Application data service is unavailable."
            );

        }

        return window.EMSFirebase.request(
            path,
            options
        );

    };


    const employeeEndpoint = (employeeId) => {

        if (
            typeof employeeId !== "string" ||
            !employeeId.trim()
        ) {

            throw new Error(
                "Invalid employee identifier."
            );

        }

        return (
            "/employees/" +
            encodeURIComponent(employeeId)
        );

    };


    /* =====================================================
       05. FORMATTING
    ===================================================== */

    const formatNumber = (value) => {

        const number = Number(value);

        return Number.isFinite(number)
            ? new Intl.NumberFormat("en-IN").format(number)
            : "—";

    };


    const formatDate = (value) => {

        if (!value) {
            return "—";
        }

        const date = new Date(value);

        if (Number.isNaN(date.getTime())) {
            return "—";
        }

        return new Intl.DateTimeFormat(
            "en-IN",
            {

                day: "2-digit",

                month: "short",

                year: "numeric"

            }
        ).format(date);

    };


    const normalizeStatus = (value) => {

        const status = String(
            value ?? ""
        ).trim().toLowerCase();

        const allowed = new Set([
            "active",
            "inactive",
            "on_leave",
            "suspended"
        ]);

        return allowed.has(status)
            ? status
            : "unknown";

    };


    const statusLabel = (status) => {

        const labels = {

            active: "Active",

            inactive: "Inactive",

            on_leave: "On Leave",

            suspended: "Suspended",

            unknown: "Unavailable"

        };

        return labels[status] || labels.unknown;

    };


    /* =====================================================
       06. LOADING AND ERROR STATES
    ===================================================== */

    const setLoading = (loading) => {

        state.loading = loading;

        setVisible(
            "employeesLoading",
            loading
        );

        const table = firstAvailable(
            "employeesTable",
            "employeeTable"
        );

        table?.setAttribute(
            "aria-busy",
            String(loading)
        );

        const refreshButton = get(
            "refreshEmployees"
        );

        if (refreshButton) {

            refreshButton.disabled = loading;

        }

    };


    const showError = (message) => {

        const element = get("employeesError");

        if (element) {

            element.textContent = message;

            element.hidden = false;

        } else {

            notify(message, "danger");

        }

    };


    const clearError = () => {

        const element = get("employeesError");

        if (element) {

            element.textContent = "";

            element.hidden = true;

        }

    };


    /* =====================================================
       07. FILTER STATE
    ===================================================== */

    const readFilters = () => {

        const searchInput = firstAvailable(
            "employeeSearch",
            "searchEmployees"
        );

        const departmentInput = firstAvailable(
            "departmentFilter",
            "employeeDepartmentFilter"
        );

        const statusInput = firstAvailable(
            "statusFilter",
            "employeeStatusFilter"
        );

        state.filters.search =
            searchInput?.value.trim() || "";

        state.filters.department =
            departmentInput?.value || "";

        state.filters.status =
            statusInput?.value || "";

    };


    const resetFilters = () => {

        const fields = [

            "employeeSearch",

            "searchEmployees",

            "departmentFilter",

            "employeeDepartmentFilter",

            "statusFilter",

            "employeeStatusFilter"

        ];

        fields.forEach((id) => {

            const input = get(id);

            if (input) {

                input.value = "";

            }

        });

        state.filters = {

            search: "",

            department: "",

            status: ""

        };

        state.currentPage = 1;

        loadEmployees();

    };


    const buildQuery = () => {

        const parameters = new URLSearchParams();

        parameters.set(
            "page",
            String(state.currentPage)
        );

        parameters.set(
            "limit",
            String(state.pageSize)
        );

        if (state.filters.search) {

            parameters.set(
                "search",
                state.filters.search
            );

        }

        if (state.filters.department) {

            parameters.set(
                "department",
                state.filters.department
            );

        }

        if (state.filters.status) {

            parameters.set(
                "status",
                state.filters.status
            );

        }

        return parameters.toString();

    };


    /* =====================================================
       08. EMPLOYEE TABLE
    ===================================================== */

    const getTableBody = () => {

        return firstAvailable(
            "employeesTableBody",
            "employeeTableBody"
        );

    };


    const renderEmpty = (message) => {

        const tbody = getTableBody();

        if (!tbody) {
            return;
        }

        const table = tbody.closest("table");

        const columnCount =
            table?.querySelectorAll("thead th").length || 1;

        const row = document.createElement("tr");

        const cell = create(
            "td",
            message
        );

        cell.colSpan = columnCount;

        row.appendChild(cell);

        tbody.replaceChildren(row);

    };


    const createStatusBadge = (value) => {

        const status = normalizeStatus(value);

        const badge = create(
            "span",
            statusLabel(status),
            "badge"
        );

        const classes = {

            active: "badge-success",

            inactive: "badge-danger",

            on_leave: "badge-warning",

            suspended: "badge-danger",

            unknown: "badge-primary"

        };

        badge.classList.add(
            classes[status]
        );

        return badge;

    };


    const createActionButton = (
        label,
        action,
        employeeId,
        className = "btn btn-secondary btn-sm"
    ) => {

        const button = create(
            "button",
            label,
            className
        );

        button.type = "button";

        button.dataset.employeeAction = action;

        button.dataset.employeeId = employeeId;

        button.setAttribute(
            "aria-label",
            `${label} employee`
        );

        return button;

    };


    const renderEmployeeRow = (employee) => {

        const row = document.createElement("tr");

        const employeeId = String(
            employee.id ?? ""
        );

        appendTextCell(
            row,
            employee.employeeCode || "—",
            "Employee ID"
        );

        appendTextCell(
            row,
            employee.fullName || "—",
            "Employee Name"
        );

        appendTextCell(
            row,
            employee.departmentName || "—",
            "Department"
        );

        appendTextCell(
            row,
            employee.designationName || "—",
            "Designation"
        );

        appendTextCell(
            row,
            employee.email || "—",
            "Email"
        );

        appendTextCell(
            row,
            formatDate(employee.joiningDate),
            "Joining Date"
        );


        const statusCell = document.createElement("td");

        statusCell.dataset.label = "Status";

        statusCell.appendChild(
            createStatusBadge(employee.status)
        );

        row.appendChild(statusCell);


        const actionCell = document.createElement("td");

        actionCell.dataset.label = "Actions";

        const actions = create(
            "div",
            "",
            "table-actions"
        );

        actions.appendChild(

            createActionButton(
                "View",
                "view",
                employeeId
            )

        );


        if (canManageEmployees()) {

            actions.appendChild(

                createActionButton(
                    "Edit",
                    "edit",
                    employeeId
                )

            );


            if (
                normalizeStatus(employee.status) ===
                "active"
            ) {

                actions.appendChild(

                    createActionButton(
                        "Deactivate",
                        "deactivate",
                        employeeId,
                        "btn btn-danger btn-sm"
                    )

                );

            }

        }

        actionCell.appendChild(actions);

        row.appendChild(actionCell);

        return row;

    };


    const renderEmployees = () => {

        const tbody = getTableBody();

        if (!tbody) {
            return;
        }

        if (!state.employees.length) {

            renderEmpty(
                "No employee records found."
            );

            return;

        }

        const fragment = document.createDocumentFragment();

        state.employees.forEach((employee) => {

            fragment.appendChild(
                renderEmployeeRow(employee)
            );

        });

        tbody.replaceChildren(fragment);

        window.EMSUI?.refreshTableLabels(
            tbody.closest("table")
        );

    };


    /* =====================================================
       09. PAGINATION
    ===================================================== */

    const renderPagination = () => {

        const totalPages = Math.max(

            1,

            Math.ceil(
                state.totalRecords / state.pageSize
            )

        );

        const start = state.totalRecords === 0
            ? 0
            : (
                (state.currentPage - 1) *
                state.pageSize
            ) + 1;

        const end = Math.min(

            state.currentPage * state.pageSize,

            state.totalRecords

        );


        setText(

            "employeesPaginationInfo",

            `${formatNumber(start)}–${formatNumber(end)} of ${formatNumber(state.totalRecords)}`

        );

        setText(
            "employeesCurrentPage",
            `${state.currentPage} / ${totalPages}`
        );


        const previousButton = firstAvailable(
            "employeesPreviousPage",
            "employeePrevPage"
        );

        const nextButton = firstAvailable(
            "employeesNextPage",
            "employeeNextPage"
        );


        if (previousButton) {

            previousButton.disabled =
                state.currentPage <= 1 ||
                state.loading;

        }

        if (nextButton) {

            nextButton.disabled =
                state.currentPage >= totalPages ||
                state.loading;

        }

    };


    const changePage = (direction) => {

        const totalPages = Math.max(

            1,

            Math.ceil(
                state.totalRecords / state.pageSize
            )

        );

        const nextPage =
            state.currentPage + direction;

        if (
            nextPage < 1 ||
            nextPage > totalPages ||
            state.loading
        ) {

            return;

        }

        state.currentPage = nextPage;

        loadEmployees();

    };


    /* =====================================================
       10. FETCH EMPLOYEES
    ===================================================== */

    const loadEmployees = async () => {

        const requestId = ++state.requestSequence;

        setLoading(true);

        clearError();

        try {

            const query = buildQuery();

            /*
             * Backend contract:
             *
             * GET /employees?page=1&limit=10
             *
             * Response:
             * {
             *   items: [],
             *   total: number,
             *   page: number,
             *   limit: number
             * }
             *
             * The backend determines which employees
             * the authenticated user can access.
             */

            const response = await request(
                `${CONFIG.endpoints.list}?${query}`
            );


            if (
                requestId !== state.requestSequence
            ) {

                return;

            }


            if (
                !response ||
                !Array.isArray(response.items) ||
                !Number.isSafeInteger(response.total) ||
                response.total < 0
            ) {

                throw new Error(
                    "Invalid employee listing response."
                );

            }


            state.employees = response.items;

            state.totalRecords = response.total;

            renderEmployees();

            renderPagination();

        } catch {

            if (
                requestId !== state.requestSequence
            ) {

                return;

            }

            state.employees = [];

            state.totalRecords = 0;

            renderEmpty(
                "Unable to load employee records."
            );

            renderPagination();

            showError(
                "Employee information could not be loaded. Please try again."
            );

        } finally {

            if (
                requestId === state.requestSequence
            ) {

                setLoading(false);

                renderPagination();

            }

        }

    };


    /* =====================================================
       11. DEPARTMENT / DESIGNATION OPTIONS
    ===================================================== */

    const populateSelect = (
        element,
        items,
        placeholder
    ) => {

        if (!element) {
            return;
        }

        const selectedValue = element.value;

        const fragment = document.createDocumentFragment();

        const defaultOption = new Option(
            placeholder,
            ""
        );

        fragment.appendChild(defaultOption);


        items.forEach((item) => {

            if (!item || !item.id) {
                return;
            }

            fragment.appendChild(

                new Option(

                    String(item.name || ""),

                    String(item.id)

                )

            );

        });

        element.replaceChildren(fragment);

        if (
            Array.from(element.options).some(
                (option) => option.value === selectedValue
            )
        ) {

            element.value = selectedValue;

        }

    };


    const loadEmployeeOptions = async () => {

        if (!canManageEmployees()) {
            return;
        }

        try {

            const [
                departments,
                designations
            ] = await Promise.all([

                request(
                    CONFIG.endpoints.departments
                ),

                request(
                    CONFIG.endpoints.designations
                )

            ]);


            if (Array.isArray(departments.items)) {

                populateSelect(

                    get("employeeDepartment"),

                    departments.items,

                    "Select Department"

                );

            }


            if (Array.isArray(designations.items)) {

                populateSelect(

                    get("employeeDesignation"),

                    designations.items,

                    "Select Designation"

                );

            }

        } catch {

            notify(
                "Unable to load employee form options.",
                "danger"
            );

        }

    };


    /* =====================================================
       12. FORM HELPERS
    ===================================================== */

    const getEmployeeForm = () => {

        return get("employeeForm");

    };


    const readFormValue = (id) => {

        const element = get(id);

        return element?.value.trim() || "";

    };


    const readEmployeeForm = () => {

        /*
         * The backend will apply the published
         * Advanced Settings field schema and
         * validate all required fields.
         *
         * Additional dynamic fields can be
         * submitted through data-employee-field.
         */

        const payload = {

            fullName:
                readFormValue("employeeFullName"),

            email:
                readFormValue("employeeEmail"),

            phone:
                readFormValue("employeePhone"),

            departmentId:
                readFormValue("employeeDepartment"),

            designationId:
                readFormValue("employeeDesignation"),

            joiningDate:
                readFormValue("employeeJoiningDate")

        };


        const form = getEmployeeForm();

        if (form) {

            const additionalFields = {};

            form.querySelectorAll(
                "[data-employee-field]"
            ).forEach((input) => {

                const fieldKey =
                    input.dataset.employeeField;

                if (!fieldKey) {
                    return;
                }

                if (
                    input.type === "checkbox"
                ) {

                    additionalFields[fieldKey] =
                        input.checked;

                } else if (
                    input.type !== "file"
                ) {

                    additionalFields[fieldKey] =
                        input.value;

                }

            });

            payload.additionalFields =
                additionalFields;

        }

        return payload;

    };


    const resetEmployeeForm = () => {

        getEmployeeForm()?.reset();

        state.editingEmployeeId = null;

        setText(
            "employeeFormTitle",
            "Add Employee"
        );

        const submitButton = get(
            "saveEmployee"
        );

        if (submitButton) {

            submitButton.textContent =
                "Save Employee";

        }

    };


    const populateEmployeeForm = (employee) => {

        const mappings = {

            employeeFullName: "fullName",

            employeeEmail: "email",

            employeePhone: "phone",

            employeeDepartment: "departmentId",

            employeeDesignation: "designationId",

            employeeJoiningDate: "joiningDate"

        };


        Object.entries(mappings).forEach(
            ([elementId, field]) => {

                const input = get(elementId);

                if (!input) {
                    return;
                }

                input.value = String(
                    employee[field] ?? ""
                );

            }
        );


        const additionalFields =
            employee.additionalFields || {};

        getEmployeeForm()
            ?.querySelectorAll(
                "[data-employee-field]"
            )
            .forEach((input) => {

                const key =
                    input.dataset.employeeField;

                if (
                    !Object.prototype.hasOwnProperty.call(
                        additionalFields,
                        key
                    )
                ) {

                    return;

                }

                if (
                    input.type === "checkbox"
                ) {

                    input.checked = Boolean(
                        additionalFields[key]
                    );

                } else if (
                    input.type !== "file"
                ) {

                    input.value = String(
                        additionalFields[key] ?? ""
                    );

                }

            });

    };


    /* =====================================================
       13. OPEN ADD EMPLOYEE
    ===================================================== */

    const openAddEmployee = async () => {

        try {

            requireManagementAccess();

            resetEmployeeForm();

            await loadEmployeeOptions();

            window.EMSUI?.openModal(
                "employeeFormBackdrop"
            );

        } catch {

            notify(
                "You do not have permission to add employees.",
                "danger"
            );

        }

    };


    /* =====================================================
       14. OPEN EDIT EMPLOYEE
    ===================================================== */

    const openEditEmployee = async (employeeId) => {

        try {

            requireManagementAccess();

            const employee = await request(
                employeeEndpoint(employeeId)
            );

            if (!employee || !employee.id) {

                throw new Error(
                    "Employee record unavailable."
                );

            }

            resetEmployeeForm();

            await loadEmployeeOptions();

            state.editingEmployeeId =
                String(employee.id);

            populateEmployeeForm(employee);

            setText(
                "employeeFormTitle",
                "Edit Employee"
            );

            const submitButton = get(
                "saveEmployee"
            );

            if (submitButton) {

                submitButton.textContent =
                    "Update Employee";

            }

            window.EMSUI?.openModal(
                "employeeFormBackdrop"
            );

        } catch {

            notify(
                "Unable to open the employee record.",
                "danger"
            );

        }

    };


    /* =====================================================
       15. SAVE EMPLOYEE
    ===================================================== */

    const saveEmployee = async (event) => {

        event?.preventDefault();

        if (state.saving) {
            return;
        }

        try {

            requireManagementAccess();

        } catch {

            notify(
                "You do not have permission to save employee records.",
                "danger"
            );

            return;

        }


        const form = getEmployeeForm();

        if (
            form &&
            !form.reportValidity()
        ) {

            return;

        }


        const payload = readEmployeeForm();


        if (
            !payload.fullName ||
            !payload.email ||
            !payload.departmentId ||
            !payload.designationId
        ) {

            notify(
                "Complete the required employee fields.",
                "warning"
            );

            return;

        }


        state.saving = true;

        const submitButton = get(
            "saveEmployee"
        );

        if (submitButton) {

            submitButton.disabled = true;

        }


        try {

            const editing =
                Boolean(state.editingEmployeeId);

            const endpoint = editing
                ? employeeEndpoint(
                    state.editingEmployeeId
                )
                : CONFIG.endpoints.create;


            /*
             * Backend contract:
             *
             * POST /employees
             * PATCH /employees/:id
             *
             * Backend must:
             * - Check the authenticated administrator.
             * - Apply the published employee field schema.
             * - Validate input and uniqueness.
             * - Generate employee ID server-side.
             * - Apply allowed-field restrictions.
             * - Record the operation in the audit log.
             */

            await request(
                endpoint,
                {

                    method: editing
                        ? "PATCH"
                        : "POST",

                    body: payload

                }
            );


            window.EMSUI?.closeModal(
                "employeeFormBackdrop"
            );

            resetEmployeeForm();

            notify(

                editing
                    ? "Employee updated successfully."
                    : "Employee created successfully.",

                "success"

            );


            await loadEmployees();

        } catch {

            notify(
                "Unable to save the employee record. Check the details and try again.",
                "danger"
            );

        } finally {

            state.saving = false;

            if (submitButton) {

                submitButton.disabled = false;

            }

        }

    };


    /* =====================================================
       16. VIEW EMPLOYEE PROFILE
    ===================================================== */

    const viewEmployee = (employeeId) => {

        if (
            typeof employeeId !== "string" ||
            !employeeId.trim()
        ) {

            return;

        }

        /*
         * Employee profile page must independently
         * verify access to the requested record.
         */

        const parameters = new URLSearchParams({

            id: employeeId

        });

        window.location.assign(
            `employee-profile.html?${parameters}`
        );

    };


    /* =====================================================
       17. DEACTIVATE EMPLOYEE
    ===================================================== */

    const deactivateEmployee = async (
        employeeId
    ) => {

        try {

            requireManagementAccess();

        } catch {

            notify(
                "You do not have permission to deactivate employees.",
                "danger"
            );

            return;

        }


        const employee = state.employees.find(
            (item) => String(item.id) === employeeId
        );

        if (!employee) {

            notify(
                "Employee record is unavailable.",
                "danger"
            );

            return;

        }


        const confirmed =
            await window.EMSUI.confirm({

                title: "Deactivate Employee",

                message:
                    `Deactivate ${employee.fullName || "this employee"}? Their account access and employment status will be handled according to company policy.`,

                confirmText: "Deactivate",

                cancelText: "Cancel",

                danger: true

            });


        if (!confirmed) {
            return;
        }


        try {

            /*
             * Backend contract:
             *
             * POST /employees/:id/deactivate
             *
             * The backend must recheck permissions,
             * apply employment rules, handle account
             * access and create an audit record.
             *
             * Do not delete payroll or audit history.
             */

            await request(

                `${employeeEndpoint(employeeId)}/deactivate`,

                {

                    method: "POST"

                }

            );


            notify(
                "Employee deactivated successfully.",
                "success"
            );

            await loadEmployees();

        } catch {

            notify(
                "Unable to deactivate the employee.",
                "danger"
            );

        }

    };


    /* =====================================================
       18. TABLE ACTION DELEGATION
    ===================================================== */

    const initializeTableActions = () => {

        const tbody = getTableBody();

        if (!tbody) {
            return;
        }


        tbody.addEventListener(
            "click",
            async (event) => {

                const button = event.target.closest(
                    "[data-employee-action]"
                );

                if (
                    !button ||
                    !tbody.contains(button)
                ) {

                    return;

                }


                const employeeId =
                    button.dataset.employeeId;

                const action =
                    button.dataset.employeeAction;


                if (!employeeId) {
                    return;
                }


                switch (action) {

                    case "view":

                        viewEmployee(employeeId);

                        break;


                    case "edit":

                        await openEditEmployee(
                            employeeId
                        );

                        break;


                    case "deactivate":

                        await deactivateEmployee(
                            employeeId
                        );

                        break;


                    default:

                        break;

                }

            }
        );

    };


    /* =====================================================
       19. FILTER EVENTS
    ===================================================== */

    const initializeFilters = () => {

        const searchInput = firstAvailable(
            "employeeSearch",
            "searchEmployees"
        );

        const departmentInput = firstAvailable(
            "departmentFilter",
            "employeeDepartmentFilter"
        );

        const statusInput = firstAvailable(
            "statusFilter",
            "employeeStatusFilter"
        );


        searchInput?.addEventListener(
            "input",
            () => {

                window.clearTimeout(
                    state.searchTimer
                );

                state.searchTimer = window.setTimeout(
                    () => {

                        readFilters();

                        state.currentPage = 1;

                        loadEmployees();

                    },
                    CONFIG.searchDelay
                );

            }
        );


        [departmentInput, statusInput]
            .forEach((element) => {

                element?.addEventListener(
                    "change",
                    () => {

                        readFilters();

                        state.currentPage = 1;

                        loadEmployees();

                    }
                );

            });


        firstAvailable(
            "resetEmployeeFilters",
            "clearEmployeeFilters"
        )?.addEventListener(
            "click",
            resetFilters
        );


        get("refreshEmployees")?.addEventListener(
            "click",
            loadEmployees
        );

    };


    /* =====================================================
       20. PAGINATION EVENTS
    ===================================================== */

    const initializePagination = () => {

        firstAvailable(
            "employeesPreviousPage",
            "employeePrevPage"
        )?.addEventListener(
            "click",
            () => changePage(-1)
        );


        firstAvailable(
            "employeesNextPage",
            "employeeNextPage"
        )?.addEventListener(
            "click",
            () => changePage(1)
        );

    };


    /* =====================================================
       21. FORM EVENTS
    ===================================================== */

    const initializeForm = () => {

        firstAvailable(
            "addEmployeeButton",
            "openEmployeeForm"
        )?.addEventListener(
            "click",
            openAddEmployee
        );


        getEmployeeForm()?.addEventListener(
            "submit",
            saveEmployee
        );

    };


    /* =====================================================
       22. ROLE-SPECIFIC INTERFACE
    ===================================================== */

    const applyRoleVisibility = () => {

        const allowed =
            canManageEmployees();


        document.querySelectorAll(
            "[data-employee-management]"
        ).forEach((element) => {

            element.hidden = !allowed;

        });


        /*
         * Employees may access only their own records
         * when the backend authorises that operation.
         *
         * Hiding UI controls is not an authorisation
         * mechanism.
         */

    };


    /* =====================================================
       23. INITIALIZATION
    ===================================================== */

    const initialize = async () => {

        if (state.initialized) {
            return;
        }

        state.initialized = true;

        setLoading(true);

        try {

            const context =
                await window.EMSFirebase.requireAuth(
                    CONFIG.allowedRoles
                );


            if (!context) {
                return;
            }


            state.context = context;

            applyRoleVisibility();

            initializeFilters();

            initializePagination();

            initializeForm();

            initializeTableActions();

            readFilters();

            await loadEmployees();

        } catch {

            showError(
                "Unable to verify employee management access."
            );

        } finally {

            setLoading(false);

        }

    };


    /* =====================================================
       24. PUBLIC MODULE API
    ===================================================== */

    window.EMSEmployees = Object.freeze({

        initialize,

        refresh: loadEmployees,

        openAdd: openAddEmployee,

        openEdit: openEditEmployee,

        view: viewEmployee

    });


    /* =====================================================
       25. START
    ===================================================== */

    const start = () => {

        if (
            document.body.dataset.page !== "employees"
        ) {

            return;

        }

        initialize();

    };


    if (
        document.readyState === "loading"
    ) {

        document.addEventListener(
            "DOMContentLoaded",
            start,
            {
                once: true
            }
        );

    } else {

        start();

    }

})();

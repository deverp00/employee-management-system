/* =========================================================
   EMPLOYEE MANAGEMENT & PAYROLL SYSTEM
   FILE: js/payroll.js

   PURPOSE:
   Secure payroll management frontend controller.

   SECURITY:
   - No client-side salary calculations.
   - No hardcoded salary values.
   - No demo payroll records.
   - No direct database writes.
   - Backend-enforced permissions.
   - Server-calculated financial amounts.
   - Immutable locked payroll.
   - Audited approval and locking operations.
========================================================= */

"use strict";

(() => {

    /* =====================================================
       01. CONFIGURATION
    ===================================================== */

    const CONFIG = Object.freeze({

        allowedRoles: [
            "super_admin",
            "hr_admin"
        ],

        pageSize: 10,

        endpoints: {

            access: "/payroll/access",

            periods: "/payroll/periods",

            runs: "/payroll/runs",

            preview: "/payroll/preview",

            summary: "/payroll/summary"

        }

    });


    /* =====================================================
       02. PRIVATE STATE
    ===================================================== */

    const state = {

        initialized: false,

        context: null,

        permissions: {},

        runs: [],

        totalRecords: 0,

        currentPage: 1,

        selectedPeriod: "",

        selectedRunId: null,

        selectedRun: null,

        preview: null,

        loading: false,

        actionPending: false,

        requestSequence: 0

    };


    /* =====================================================
       03. DOM UTILITIES
    ===================================================== */

    const get = (id) => {

        return document.getElementById(id);

    };


    const setText = (id, value) => {

        const element = get(id);

        if (element) {

            element.textContent = String(
                value ?? "—"
            );

        }

    };


    const setVisible = (id, visible) => {

        const element = get(id);

        if (element) {

            element.hidden = !visible;

        }

    };


    const create = (
        tag,
        value = "",
        className = ""
    ) => {

        const element = document.createElement(tag);

        element.textContent = String(
            value ?? ""
        );

        if (className) {

            element.className = className;

        }

        return element;

    };


    const notify = (
        message,
        type = "success"
    ) => {

        window.EMSUI?.showToast(
            message,
            type
        );

    };


    const appendCell = (
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
       04. FORMATTING
    ===================================================== */

    const formatCurrency = (value) => {

        if (
            value === null ||
            value === undefined ||
            value === ""
        ) {

            return "—";

        }

        const amount = Number(value);

        if (!Number.isFinite(amount)) {

            return "—";

        }

        /*
         * Presentation only.
         * Never use this formatter to calculate payroll.
         */

        return new Intl.NumberFormat(
            "en-IN",
            {

                style: "currency",

                currency: "INR",

                minimumFractionDigits: 2,

                maximumFractionDigits: 2

            }
        ).format(amount);

    };


    const formatNumber = (value) => {

        if (
            value === null ||
            value === undefined ||
            value === ""
        ) {

            return "—";

        }

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

        if (
            Number.isNaN(date.getTime())
        ) {

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


    /* =====================================================
       05. STATUS CONFIGURATION
    ===================================================== */

    const STATUS = Object.freeze({

        draft: {

            label: "Draft",

            className: "badge-warning"

        },

        calculated: {

            label: "Calculated",

            className: "badge-primary"

        },

        approved: {

            label: "Approved",

            className: "badge-success"

        },

        locked: {

            label: "Locked",

            className: "badge-success"

        }

    });


    const createStatusBadge = (status) => {

        const config = STATUS[status];

        const badge = create(

            "span",

            config?.label || "Unavailable",

            "badge"

        );

        badge.classList.add(
            config?.className || "badge-primary"
        );

        return badge;

    };


    /* =====================================================
       06. AUTHENTICATED REQUESTS
    ===================================================== */

    const request = async (
        endpoint,
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
            endpoint,
            options
        );

    };


    const runEndpoint = (
        runId,
        suffix = ""
    ) => {

        if (
            typeof runId !== "string" ||
            !runId.trim()
        ) {

            throw new Error(
                "Invalid payroll run identifier."
            );

        }

        return (
            "/payroll/runs/" +
            encodeURIComponent(runId) +
            suffix
        );

    };


    /* =====================================================
       07. PERMISSIONS
    ===================================================== */

    const hasPermission = (permission) => {

        return state.permissions[permission] === true;

    };


    const requirePermission = (permission) => {

        if (!hasPermission(permission)) {

            throw new Error(
                "This payroll operation is not authorised."
            );

        }

    };


    const applyPermissions = () => {

        document.querySelectorAll(
            "[data-payroll-permission]"
        ).forEach((element) => {

            const permission =
                element.dataset.payrollPermission;

            element.hidden = !hasPermission(
                permission
            );

        });

    };


    const loadPermissions = async () => {

        /*
         * GET /payroll/access
         *
         * Backend verifies the Firebase ID token
         * and determines actual payroll permissions.
         *
         * HR permissions come from published
         * Advanced Settings policies.
         */

        const response = await request(
            CONFIG.endpoints.access
        );

        if (
            !response ||
            !response.permissions ||
            typeof response.permissions !== "object" ||
            Array.isArray(response.permissions)
        ) {

            throw new Error(
                "Payroll permission verification failed."
            );

        }

        const permissions = response.permissions;

        state.permissions = Object.freeze({

            viewPayroll:
                permissions.viewPayroll === true,

            createPayroll:
                permissions.createPayroll === true,

            calculatePayroll:
                permissions.calculatePayroll === true,

            approvePayroll:
                permissions.approvePayroll === true,

            lockPayroll:
                permissions.lockPayroll === true,

            viewPayrollDetails:
                permissions.viewPayrollDetails === true

        });

        applyPermissions();

    };


    /* =====================================================
       08. LOADING AND ERROR STATES
    ===================================================== */

    const setLoading = (loading) => {

        state.loading = loading;

        setVisible(
            "payrollLoading",
            loading
        );

        get("payrollTable")?.setAttribute(
            "aria-busy",
            String(loading)
        );

        const refreshButton = get(
            "refreshPayroll"
        );

        if (refreshButton) {

            refreshButton.disabled =
                loading || state.actionPending;

        }

    };


    const showError = (message) => {

        const element = get("payrollError");

        if (element) {

            element.textContent = message;

            element.hidden = false;

        } else {

            notify(message, "danger");

        }

    };


    const clearError = () => {

        const element = get("payrollError");

        if (element) {

            element.textContent = "";

            element.hidden = true;

        }

    };


    const setActionPending = (pending) => {

        state.actionPending = pending;

        document.querySelectorAll(
            "[data-payroll-action]"
        ).forEach((button) => {

            if (
                button instanceof HTMLButtonElement
            ) {

                button.disabled = pending;

            }

        });

        const refreshButton = get(
            "refreshPayroll"
        );

        if (refreshButton) {

            refreshButton.disabled = pending;

        }

    };


    /* =====================================================
       09. PAYROLL PERIODS
    ===================================================== */

    const loadPeriods = async () => {

        /*
         * Backend supplies valid payroll periods
         * according to the company payroll policy.
         */

        const response = await request(
            CONFIG.endpoints.periods
        );

        if (
            !response ||
            !Array.isArray(response.items)
        ) {

            throw new Error(
                "Payroll periods are unavailable."
            );

        }

        const select = get(
            "payrollPeriod"
        );

        if (!select) {

            return;

        }

        const previousValue = select.value;

        const fragment =
            document.createDocumentFragment();

        fragment.appendChild(

            new Option(
                "Select Payroll Period",
                ""
            )

        );

        response.items.forEach((period) => {

            if (
                !period ||
                typeof period.id !== "string" ||
                !period.id.trim()
            ) {

                return;

            }

            fragment.appendChild(

                new Option(

                    String(
                        period.label || period.id
                    ),

                    period.id

                )

            );

        });

        select.replaceChildren(fragment);

        if (
            Array.from(select.options).some(
                (option) => {
                    return option.value === previousValue;
                }
            )
        ) {

            select.value = previousValue;

        }

        state.selectedPeriod = select.value;

    };


    const getSelectedPeriod = () => {

        const select = get(
            "payrollPeriod"
        );

        const period = (
            select?.value || ""
        ).trim();

        if (
            !period ||
            !select ||
            !Array.from(select.options).some(
                (option) => {
                    return option.value === period;
                }
            )
        ) {

            throw new Error(
                "Select a valid payroll period."
            );

        }

        return period;

    };


    /* =====================================================
       10. PAYROLL SUMMARY
    ===================================================== */

    const SUMMARY_FIELDS = Object.freeze({

        totalEmployees:
            "payrollTotalEmployees",

        processedEmployees:
            "payrollProcessedEmployees",

        pendingEmployees:
            "payrollPendingEmployees"

    });


    const renderSummary = (summary) => {

        Object.entries(SUMMARY_FIELDS)
            .forEach(([key, elementId]) => {

                const value = Object.prototype.hasOwnProperty.call(
                    summary,
                    key
                )
                    ? formatNumber(summary[key])
                    : "—";

                setText(
                    elementId,
                    value
                );

            });

        const monetaryFields = {

            totalGross:
                "payrollTotalGross",

            totalDeductions:
                "payrollTotalDeductions",

            totalNet:
                "payrollTotalNet"

        };

        Object.entries(monetaryFields)
            .forEach(([key, elementId]) => {

                const value = Object.prototype.hasOwnProperty.call(
                    summary,
                    key
                )
                    ? formatCurrency(summary[key])
                    : "—";

                setText(
                    elementId,
                    value
                );

            });

    };


    const loadSummary = async () => {

        try {

            const response = await request(
                CONFIG.endpoints.summary
            );

            if (
                !response ||
                typeof response !== "object" ||
                Array.isArray(response)
            ) {

                throw new Error(
                    "Invalid payroll summary."
                );

            }

            renderSummary(response);

        } catch {

            renderSummary({});

        }

    };


    /* =====================================================
       11. PAYROLL LIST
    ===================================================== */

    const getTableBody = () => {

        return get(
            "payrollTableBody"
        );

    };


    const renderEmpty = (message) => {

        const tbody = getTableBody();

        if (!tbody) {
            return;
        }

        const columnCount =
            tbody.closest("table")
                ?.querySelectorAll("thead th").length || 1;

        const row = document.createElement("tr");

        const cell = create(
            "td",
            message
        );

        cell.colSpan = columnCount;

        row.appendChild(cell);

        tbody.replaceChildren(row);

    };


    const createActionButton = (
        label,
        action,
        runId,
        className = "btn btn-secondary btn-sm"
    ) => {

        const button = create(

            "button",

            label,

            className

        );

        button.type = "button";

        button.dataset.payrollAction = action;

        button.dataset.runId = runId;

        button.disabled = state.actionPending;

        return button;

    };


    const renderRunRow = (run) => {

        const row = document.createElement("tr");

        const runId = String(
            run.id ?? ""
        );

        appendCell(
            row,
            run.periodLabel || "—",
            "Payroll Period"
        );

        appendCell(
            row,
            formatNumber(run.employeeCount),
            "Employees"
        );

        appendCell(
            row,
            formatCurrency(run.grossPay),
            "Gross Pay"
        );

        appendCell(
            row,
            formatCurrency(run.totalDeductions),
            "Deductions"
        );

        appendCell(
            row,
            formatCurrency(run.netPay),
            "Net Pay"
        );

        const statusCell =
            document.createElement("td");

        statusCell.dataset.label = "Status";

        statusCell.appendChild(
            createStatusBadge(run.status)
        );

        row.appendChild(statusCell);

        const actionCell =
            document.createElement("td");

        actionCell.dataset.label = "Actions";

        const actions = create(
            "div",
            "",
            "table-actions"
        );

        if (
            runId &&
            hasPermission("viewPayrollDetails")
        ) {

            actions.appendChild(

                createActionButton(
                    "View",
                    "view",
                    runId
                )

            );

        }

        if (
            runId &&
            run.status === "draft" &&
            run.canCalculate === true &&
            hasPermission("calculatePayroll")
        ) {

            actions.appendChild(

                createActionButton(
                    "Calculate",
                    "calculate",
                    runId,
                    "btn btn-primary btn-sm"
                )

            );

        }

        if (
            runId &&
            run.status === "calculated" &&
            run.canApprove === true &&
            hasPermission("approvePayroll")
        ) {

            actions.appendChild(

                createActionButton(
                    "Approve",
                    "approve",
                    runId,
                    "btn btn-primary btn-sm"
                )

            );

        }

        if (
            runId &&
            run.status === "approved" &&
            run.canLock === true &&
            hasPermission("lockPayroll")
        ) {

            actions.appendChild(

                createActionButton(
                    "Lock",
                    "lock",
                    runId,
                    "btn btn-danger btn-sm"
                )

            );

        }

        actionCell.appendChild(actions);

        row.appendChild(actionCell);

        return row;

    };


    const renderRuns = () => {

        const tbody = getTableBody();

        if (!tbody) {
            return;
        }

        if (!state.runs.length) {

            renderEmpty(
                "No payroll records available."
            );

            return;

        }

        const fragment =
            document.createDocumentFragment();

        state.runs.forEach((run) => {

            fragment.appendChild(
                renderRunRow(run)
            );

        });

        tbody.replaceChildren(fragment);

        window.EMSUI?.refreshTableLabels(
            tbody.closest("table")
        );

    };


    /* =====================================================
       12. PAGINATION
    ===================================================== */

    const renderPagination = () => {

        const totalPages = Math.max(

            1,

            Math.ceil(
                state.totalRecords / CONFIG.pageSize
            )

        );

        const start = state.totalRecords === 0
            ? 0
            : (
                (state.currentPage - 1) *
                CONFIG.pageSize
            ) + 1;

        const end = Math.min(

            state.currentPage * CONFIG.pageSize,

            state.totalRecords

        );

        setText(

            "payrollPaginationInfo",

            `${formatNumber(start)}–${formatNumber(end)} of ${formatNumber(state.totalRecords)}`

        );

        setText(

            "payrollCurrentPage",

            `${state.currentPage} / ${totalPages}`

        );

        const previous = get(
            "payrollPreviousPage"
        );

        const next = get(
            "payrollNextPage"
        );

        if (previous) {

            previous.disabled =
                state.loading ||
                state.currentPage <= 1;

        }

        if (next) {

            next.disabled =
                state.loading ||
                state.currentPage >= totalPages;

        }

    };


    const changePage = (direction) => {

        if (
            state.loading ||
            state.actionPending
        ) {

            return;

        }

        const totalPages = Math.max(

            1,

            Math.ceil(
                state.totalRecords / CONFIG.pageSize
            )

        );

        const target =
            state.currentPage + direction;

        if (
            target < 1 ||
            target > totalPages
        ) {

            return;

        }

        state.currentPage = target;

        loadRuns();

    };


    /* =====================================================
       13. LOAD PAYROLL RUNS
    ===================================================== */

    const loadRuns = async () => {

        const requestId =
            ++state.requestSequence;

        setLoading(true);

        clearError();

        try {

            const parameters = new URLSearchParams({

                page: String(state.currentPage),

                limit: String(CONFIG.pageSize)

            });

            /*
             * GET /payroll/runs
             *
             * Backend returns only authorised
             * payroll information.
             */

            const response = await request(

                `${CONFIG.endpoints.runs}?${parameters}`

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
                    "Invalid payroll listing response."
                );

            }

            state.runs = response.items;

            state.totalRecords = response.total;

            renderRuns();

            renderPagination();

        } catch {

            if (
                requestId !== state.requestSequence
            ) {

                return;

            }

            state.runs = [];

            state.totalRecords = 0;

            renderEmpty(
                "Unable to load payroll records."
            );

            renderPagination();

            showError(
                "Payroll information could not be loaded."
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
       14. PAYROLL PREVIEW
    ===================================================== */

    const renderPreview = (preview) => {

        setText(
            "previewPayrollPeriod",
            preview.periodLabel
        );

        setText(
            "previewEmployeeCount",
            formatNumber(preview.employeeCount)
        );

        setText(
            "previewGrossPay",
            formatCurrency(preview.grossPay)
        );

        setText(
            "previewDeductions",
            formatCurrency(preview.totalDeductions)
        );

        setText(
            "previewNetPay",
            formatCurrency(preview.netPay)
        );

        const warningContainer = get(
            "payrollPreviewWarnings"
        );

        if (warningContainer) {

            warningContainer.replaceChildren();

            if (
                Array.isArray(preview.warnings)
            ) {

                preview.warnings.forEach((warning) => {

                    warningContainer.appendChild(

                        create(
                            "p",
                            String(warning),
                            "text-muted"
                        )

                    );

                });

            }

        }

    };


    const generatePreview = async () => {

        if (
            state.actionPending ||
            state.loading
        ) {

            return;
        }

        try {

            requirePermission("createPayroll");

        } catch {

            notify(
                "Payroll generation is not authorised.",
                "danger"
            );

            return;

        }

        let period;

        try {

            period = getSelectedPeriod();

        } catch {

            notify(
                "Select a valid payroll period.",
                "warning"
            );

            return;

        }

        setActionPending(true);

        state.preview = null;

        state.selectedPeriod = "";

        try {

            /*
             * POST /payroll/preview
             *
             * Only the selected period is submitted.
             *
             * The backend independently calculates:
             * - Eligible employees
             * - Basic salary
             * - Applicable allowances
             * - Attendance adjustments
             * - Leave adjustments
             * - Statutory deductions
             * - Other authorised deductions
             * - Gross and net salary
             *
             * Preview must not create or lock a
             * permanent payroll record.
             */

            const response = await request(

                CONFIG.endpoints.preview,

                {

                    method: "POST",

                    body: {
                        periodId: period
                    }

                }

            );

            if (
                !response ||
                typeof response !== "object" ||
                Array.isArray(response) ||
                response.valid !== true ||
                typeof response.previewToken !== "string" ||
                !response.previewToken ||
                !Number.isSafeInteger(response.employeeCount) ||
                response.employeeCount < 0
            ) {

                throw new Error(
                    "Payroll preview is unavailable."
                );

            }

            state.preview = response;

            state.selectedPeriod = period;

            renderPreview(response);

            window.EMSUI?.openModal(
                "payrollPreviewBackdrop"
            );

        } catch {

            state.preview = null;

            state.selectedPeriod = "";

            notify(
                "Unable to generate payroll preview. Check attendance, leave and payroll settings.",
                "danger"
            );

        } finally {

            setActionPending(false);

        }

    };


    /* =====================================================
       15. CREATE PAYROLL DRAFT
    ===================================================== */

    const createPayrollDraft = async () => {

        if (state.actionPending) {
            return;
        }

        try {

            requirePermission("createPayroll");

        } catch {

            notify(
                "Payroll creation is not authorised.",
                "danger"
            );

            return;

        }

        if (
            !state.preview ||
            !state.selectedPeriod ||
            state.preview.valid !== true
        ) {

            notify(
                "Generate a valid payroll preview first.",
                "warning"
            );

            return;

        }

        const periodId = state.selectedPeriod;

        const previewToken =
            state.preview.previewToken;

        const confirmed =
            await window.EMSUI.confirm({

                title: "Create Payroll Draft",

                message:
                    "Create a payroll draft for the selected period? The backend will revalidate the calculation and applicable company policies.",

                confirmText: "Create Draft",

                cancelText: "Cancel"

            });

        if (!confirmed) {
            return;
        }

        setActionPending(true);

        try {

            /*
             * POST /payroll/runs
             *
             * Backend must:
             * - Verify createPayroll permission.
             * - Validate the short-lived preview token.
             * - Bind the token to the acting account.
             * - Recheck the period and source revisions.
             * - Prevent duplicate payroll runs.
             * - Generate the payroll run ID.
             * - Create an audit entry.
             *
             * Never trust preview monetary values
             * supplied by a client.
             */

            await request(

                CONFIG.endpoints.runs,

                {

                    method: "POST",

                    body: {

                        periodId,

                        previewToken

                    }

                }

            );

            state.preview = null;

            state.selectedPeriod = "";

            window.EMSUI?.closeModal(
                "payrollPreviewBackdrop"
            );

            notify(
                "Payroll draft created successfully."
            );

            state.currentPage = 1;

            await refresh();

        } catch {

            notify(
                "Unable to create payroll draft. Generate a new preview if the underlying records have changed.",
                "danger"
            );

        } finally {

            setActionPending(false);

        }

    };


    /* =====================================================
       16. VIEW PAYROLL DETAILS
    ===================================================== */

    const renderRunDetails = (run) => {

        setText(
            "payrollDetailPeriod",
            run.periodLabel
        );

        setText(
            "payrollDetailStatus",
            STATUS[run.status]?.label || "Unavailable"
        );

        setText(
            "payrollDetailEmployees",
            formatNumber(run.employeeCount)
        );

        setText(
            "payrollDetailGross",
            formatCurrency(run.grossPay)
        );

        setText(
            "payrollDetailDeductions",
            formatCurrency(run.totalDeductions)
        );

        setText(
            "payrollDetailNet",
            formatCurrency(run.netPay)
        );

        setText(
            "payrollDetailCreated",
            formatDate(run.createdAt)
        );

        setText(
            "payrollDetailApproved",
            formatDate(run.approvedAt)
        );

        setText(
            "payrollDetailLocked",
            formatDate(run.lockedAt)
        );

        const tbody = get(
            "payrollDetailsTableBody"
        );

        if (!tbody) {
            return;
        }

        tbody.replaceChildren();

        if (
            !Array.isArray(run.items) ||
            !run.items.length
        ) {

            const row = document.createElement("tr");

            const cell = create(
                "td",
                "No payroll details available."
            );

            cell.colSpan = 6;

            row.appendChild(cell);

            tbody.appendChild(row);

            return;

        }

        const fragment =
            document.createDocumentFragment();

        run.items.forEach((item) => {

            const row = document.createElement("tr");

            appendCell(
                row,
                item.employeeCode || "—",
                "Employee ID"
            );

            appendCell(
                row,
                item.employeeName || "—",
                "Employee"
            );

            appendCell(
                row,
                formatCurrency(item.basicSalary),
                "Basic Salary"
            );

            appendCell(
                row,
                formatCurrency(item.allowances),
                "Allowances"
            );

            appendCell(
                row,
                formatCurrency(item.deductions),
                "Deductions"
            );

            appendCell(
                row,
                formatCurrency(item.netPay),
                "Net Pay"
            );

            fragment.appendChild(row);

        });

        tbody.appendChild(fragment);

        window.EMSUI?.refreshTableLabels(
            tbody.closest("table")
        );

    };


    const viewPayroll = async (runId) => {

        try {

            requirePermission(
                "viewPayrollDetails"
            );

            /*
             * GET /payroll/runs/:id
             *
             * Backend applies payroll permission
             * and financial field visibility.
             */

            const response = await request(
                runEndpoint(runId)
            );

            if (
                !response ||
                String(response.id) !== runId
            ) {

                throw new Error(
                    "Payroll record unavailable."
                );

            }

            state.selectedRunId = runId;

            state.selectedRun = response;

            renderRunDetails(response);

            window.EMSUI?.openModal(
                "payrollDetailsBackdrop"
            );

        } catch {

            notify(
                "Unable to open payroll details.",
                "danger"
            );

        }

    };


    /* =====================================================
       17. CALCULATE PAYROLL
    ===================================================== */

    const calculatePayroll = async (runId) => {

        if (state.actionPending) {
            return;
        }

        try {

            requirePermission(
                "calculatePayroll"
            );

        } catch {

            notify(
                "Payroll calculation is not authorised.",
                "danger"
            );

            return;

        }

        const run = state.runs.find(
            (item) => String(item.id) === runId
        );

        if (
            !run ||
            run.status !== "draft" ||
            run.canCalculate !== true
        ) {

            notify(
                "This payroll draft cannot be calculated.",
                "warning"
            );

            return;

        }

        const confirmed =
            await window.EMSUI.confirm({

                title: "Calculate Payroll",

                message:
                    "Calculate this payroll draft using the current approved salary, attendance, leave and deduction rules?",

                confirmText: "Calculate",

                cancelText: "Cancel"

            });

        if (!confirmed) {
            return;
        }

        setActionPending(true);

        try {

            /*
             * POST /payroll/runs/:id/calculate
             *
             * The backend:
             * - Rechecks authorisation and draft status.
             * - Calculates all amounts server-side.
             * - Saves a versioned calculation snapshot.
             * - Records policy/source revisions.
             * - Rejects incomplete employee records.
             * - Creates an audit event.
             */

            await request(

                runEndpoint(
                    runId,
                    "/calculate"
                ),

                {

                    method: "POST"

                }

            );

            notify(
                "Payroll calculated successfully."
            );

            await refresh();

        } catch {

            notify(
                "Payroll calculation failed. Check the employee and payroll configuration.",
                "danger"
            );

        } finally {

            setActionPending(false);

        }

    };


    /* =====================================================
       18. APPROVE PAYROLL
    ===================================================== */

    const approvePayroll = async (runId) => {

        if (state.actionPending) {
            return;
        }

        try {

            requirePermission(
                "approvePayroll"
            );

        } catch {

            notify(
                "Payroll approval is not authorised.",
                "danger"
            );

            return;

        }

        const run = state.runs.find(
            (item) => String(item.id) === runId
        );

        if (
            !run ||
            run.status !== "calculated" ||
            run.canApprove !== true
        ) {

            notify(
                "This payroll run cannot be approved.",
                "warning"
            );

            return;

        }

        const confirmed =
            await window.EMSUI.confirm({

                title: "Approve Payroll",

                message:
                    "Approve this calculated payroll? Review the salary totals and employee records before continuing.",

                confirmText: "Approve Payroll",

                cancelText: "Cancel"

            });

        if (!confirmed) {
            return;
        }

        setActionPending(true);

        try {

            /*
             * POST /payroll/runs/:id/approve
             *
             * Backend responsibilities:
             * - Verify approver permission.
             * - Enforce separation-of-duties policy.
             * - Confirm calculated snapshot is current.
             * - Recheck unresolved calculation warnings.
             * - Atomically transition to approved.
             * - Record approver UID and server time.
             * - Create immutable audit entry.
             */

            await request(

                runEndpoint(
                    runId,
                    "/approve"
                ),

                {

                    method: "POST"

                }

            );

            notify(
                "Payroll approved successfully."
            );

            await refresh();

        } catch {

            notify(
                "Unable to approve this payroll run.",
                "danger"
            );

        } finally {

            setActionPending(false);

        }

    };


    /* =====================================================
       19. LOCK PAYROLL
    ===================================================== */

    const lockPayroll = async (runId) => {

        if (state.actionPending) {
            return;
        }

        try {

            requirePermission(
                "lockPayroll"
            );

        } catch {

            notify(
                "Payroll locking is not authorised.",
                "danger"
            );

            return;

        }

        const run = state.runs.find(
            (item) => String(item.id) === runId
        );

        if (
            !run ||
            run.status !== "approved" ||
            run.canLock !== true
        ) {

            notify(
                "This payroll run cannot be locked.",
                "warning"
            );

            return;

        }

        const confirmed =
            await window.EMSUI.confirm({

                title: "Lock Payroll Permanently",

                message:
                    "Lock this approved payroll? Its salary calculation snapshot will become immutable. Subsequent corrections must use a separate authorised adjustment workflow.",

                confirmText: "Lock Payroll",

                cancelText: "Cancel",

                danger: true

            });

        if (!confirmed) {
            return;
        }

        setActionPending(true);

        try {

            /*
             * POST /payroll/runs/:id/lock
             *
             * Backend requirements:
             *
             * 1. Verify lockPayroll permission.
             * 2. Confirm current status is approved.
             * 3. Verify approval and policy conditions.
             * 4. Atomically lock the calculation snapshot.
             * 5. Preserve financial line items.
             * 6. Preserve source and policy revisions.
             * 7. Generate the immutable audit record.
             *
             * Locked payroll must never be edited by
             * a frontend request or normal CRUD API.
             */

            await request(

                runEndpoint(
                    runId,
                    "/lock"
                ),

                {

                    method: "POST"

                }

            );

            notify(
                "Payroll locked successfully."
            );

            await refresh();

        } catch {

            notify(
                "Unable to lock this payroll run.",
                "danger"
            );

        } finally {

            setActionPending(false);

        }

    };


    /* =====================================================
       20. REFRESH
    ===================================================== */

    const refresh = async () => {

        await Promise.allSettled([

            loadRuns(),

            loadSummary()

        ]);

    };


    /* =====================================================
       21. TABLE ACTION HANDLER
    ===================================================== */

    const initializeTableActions = () => {

        getTableBody()?.addEventListener(
            "click",
            async (event) => {

                const button = event.target.closest(
                    "[data-payroll-action]"
                );

                if (
                    !button ||
                    !getTableBody().contains(button) ||
                    state.actionPending
                ) {

                    return;

                }

                const runId =
                    button.dataset.runId;

                const action =
                    button.dataset.payrollAction;

                if (!runId) {
                    return;
                }

                switch (action) {

                    case "view":

                        await viewPayroll(runId);

                        break;

                    case "calculate":

                        await calculatePayroll(runId);

                        break;

                    case "approve":

                        await approvePayroll(runId);

                        break;

                    case "lock":

                        await lockPayroll(runId);

                        break;

                    default:

                        break;

                }

            }
        );

    };


    /* =====================================================
       22. EVENT LISTENERS
    ===================================================== */

    const initializeEvents = () => {

        get("payrollPeriod")?.addEventListener(
            "change",
            () => {

                state.selectedPeriod =
                    get("payrollPeriod").value;

                state.preview = null;

            }
        );

        get("generatePayrollButton")?.addEventListener(
            "click",
            generatePreview
        );

        get("createPayrollDraft")?.addEventListener(
            "click",
            createPayrollDraft
        );

        get("refreshPayroll")?.addEventListener(
            "click",
            refresh
        );

        get("payrollPreviousPage")?.addEventListener(
            "click",
            () => changePage(-1)
        );

        get("payrollNextPage")?.addEventListener(
            "click",
            () => changePage(1)
        );

        initializeTableActions();

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

        setVisible(
            "payrollContent",
            false
        );

        try {

            if (!window.EMSFirebase) {

                throw new Error(
                    "Application service is unavailable."
                );

            }

            const context =
                await window.EMSFirebase.requireAuth(
                    CONFIG.allowedRoles
                );

            if (!context) {
                return;
            }

            state.context = context;

            await loadPermissions();

            if (
                !hasPermission("viewPayroll")
            ) {

                throw new Error(
                    "Payroll management access is restricted."
                );

            }

            initializeEvents();

            /*
             * A period loading failure should not
             * prevent an authorised user from seeing
             * existing payroll history.
             */

            try {

                await loadPeriods();

            } catch {

                notify(
                    "Unable to load available payroll periods.",
                    "warning"
                );

            }

            setVisible(
                "payrollContent",
                true
            );

            await refresh();

        } catch {

            state.permissions = {};

            applyPermissions();

            setVisible(
                "payrollContent",
                false
            );

            showError(
                "Unable to verify payroll management access."
            );

        } finally {

            setLoading(false);

        }

    };


    /* =====================================================
       24. PUBLIC MODULE INTERFACE
    ===================================================== */

    window.EMSPayroll = Object.freeze({

        initialize,

        refresh,

        generatePreview,

        viewPayroll,

        getContext: () => state.context

    });


    /* =====================================================
       25. START
    ===================================================== */

    const start = () => {

        if (
            document.body.dataset.page !== "payroll"
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

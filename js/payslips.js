/* =========================================================
   EMPLOYEE MANAGEMENT & PAYROLL SYSTEM
   FILE: js/payslips.js

   PURPOSE:
   Secure payslip viewing and PDF access.

   SECURITY:
   - Firebase authenticated requests.
   - Backend-enforced employee ownership.
   - No client-side salary calculations.
   - No hardcoded employee UID.
   - No public payslip storage links.
   - No demo payroll records.
   - PDF generated from server-side payroll snapshots.
========================================================= */

"use strict";

(() => {

    /* =====================================================
       01. CONFIGURATION
    ===================================================== */

    const CONFIG = Object.freeze({

        allowedRoles: [
            "super_admin",
            "hr_admin",
            "employee"
        ],

        pageSize: 10,

        endpoints: {

            access: "/payslips/access",

            list: "/payslips",

            periods: "/payslips/periods"

        }

    });


    /* =====================================================
       02. APPLICATION STATE
    ===================================================== */

    const state = {

        initialized: false,

        context: null,

        permissions: {},

        records: [],

        totalRecords: 0,

        currentPage: 1,

        loading: false,

        actionPending: false,

        requestSequence: 0,

        selectedPayslip: null,

        filters: {

            period: "",

            employee: ""

        }

    };


    /* =====================================================
       03. DOM HELPERS
    ===================================================== */

    const get = (id) => {

        return document.getElementById(id);

    };


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

        const number = Number(value);

        if (!Number.isFinite(number)) {

            return "—";

        }

        /*
         * Display only.
         * Payroll calculations remain server-side.
         */

        return new Intl.NumberFormat(
            "en-IN",
            {

                style: "currency",

                currency: "INR",

                minimumFractionDigits: 2,

                maximumFractionDigits: 2

            }
        ).format(number);

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


    /* =====================================================
       05. BACKEND REQUEST
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


    const payslipEndpoint = (
        payslipId,
        suffix = ""
    ) => {

        if (
            typeof payslipId !== "string" ||
            !payslipId.trim()
        ) {

            throw new Error(
                "Invalid payslip identifier."
            );

        }

        return (
            "/payslips/" +
            encodeURIComponent(payslipId) +
            suffix
        );

    };


    /* =====================================================
       06. PERMISSIONS
    ===================================================== */

    const hasPermission = (permission) => {

        return state.permissions[permission] === true;

    };


    const requirePermission = (permission) => {

        if (!hasPermission(permission)) {

            throw new Error(
                "Payslip operation is not authorised."
            );

        }

    };


    const applyPermissions = () => {

        document.querySelectorAll(
            "[data-payslip-permission]"
        ).forEach((element) => {

            const permission =
                element.dataset.payslipPermission;

            element.hidden = !hasPermission(
                permission
            );

        });

    };


    const loadPermissions = async () => {

        /*
         * GET /payslips/access
         *
         * Backend determines access using:
         * - Verified Firebase UID
         * - Actual account role
         * - Employee record mapping
         * - Published HR permissions
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
                "Payslip permission verification failed."
            );

        }

        const permissions = response.permissions;

        state.permissions = Object.freeze({

            viewOwnPayslips:
                permissions.viewOwnPayslips === true,

            viewAllPayslips:
                permissions.viewAllPayslips === true,

            downloadPayslips:
                permissions.downloadPayslips === true

        });

        applyPermissions();

    };


    /* =====================================================
       07. LOADING / ERROR
    ===================================================== */

    const setLoading = (loading) => {

        state.loading = loading;

        setVisible(
            "payslipsLoading",
            loading
        );

        get("payslipsTable")?.setAttribute(
            "aria-busy",
            String(loading)
        );

        const refreshButton = get(
            "refreshPayslips"
        );

        if (refreshButton) {

            refreshButton.disabled =
                loading || state.actionPending;

        }

    };


    const showError = (message) => {

        const element = get(
            "payslipsError"
        );

        if (element) {

            element.textContent = message;

            element.hidden = false;

        } else {

            notify(message, "danger");

        }

    };


    const clearError = () => {

        const element = get(
            "payslipsError"
        );

        if (element) {

            element.textContent = "";

            element.hidden = true;

        }

    };


    /* =====================================================
       08. PERIOD FILTER OPTIONS
    ===================================================== */

    const loadPeriods = async () => {

        const response = await request(
            CONFIG.endpoints.periods
        );

        if (
            !response ||
            !Array.isArray(response.items)
        ) {

            throw new Error(
                "Payslip periods are unavailable."
            );

        }

        const select = get(
            "payslipPeriodFilter"
        );

        if (!select) {
            return;
        }

        const previousValue = select.value;

        const fragment =
            document.createDocumentFragment();

        fragment.appendChild(

            new Option(
                "All Periods",
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

    };


    /* =====================================================
       09. FILTER MANAGEMENT
    ===================================================== */

    const readFilters = () => {

        state.filters.period =
            get("payslipPeriodFilter")?.value || "";

        state.filters.employee =
            get("payslipEmployeeSearch")
                ?.value.trim() || "";

        /*
         * Employee search is presentation-only input.
         * Backend still enforces record-level access.
         */

    };


    const buildQuery = () => {

        const parameters = new URLSearchParams({

            page: String(state.currentPage),

            limit: String(CONFIG.pageSize)

        });

        if (state.filters.period) {

            parameters.set(
                "period",
                state.filters.period
            );

        }

        if (
            state.filters.employee &&
            hasPermission("viewAllPayslips")
        ) {

            parameters.set(
                "employee",
                state.filters.employee
            );

        }

        return parameters.toString();

    };


    const resetFilters = () => {

        [

            "payslipPeriodFilter",

            "payslipEmployeeSearch"

        ].forEach((id) => {

            const element = get(id);

            if (element) {

                element.value = "";

            }

        });

        state.filters = {

            period: "",

            employee: ""

        };

        state.currentPage = 1;

        loadPayslips();

    };


    /* =====================================================
       10. TABLE HELPERS
    ===================================================== */

    const getTableBody = () => {

        return firstAvailable(
            "payslipsTableBody",
            "payslipTableBody"
        );

    };


    const renderEmpty = (message) => {

        const tbody = getTableBody();

        if (!tbody) {
            return;
        }

        const columns =
            tbody.closest("table")
                ?.querySelectorAll("thead th").length || 1;

        const row = document.createElement("tr");

        const cell = create(
            "td",
            message
        );

        cell.colSpan = columns;

        row.appendChild(cell);

        tbody.replaceChildren(row);

    };


    const createActionButton = (
        label,
        action,
        payslipId
    ) => {

        const button = create(

            "button",

            label,

            "btn btn-secondary btn-sm"

        );

        button.type = "button";

        button.dataset.payslipAction = action;

        button.dataset.payslipId = payslipId;

        button.disabled = state.actionPending;

        return button;

    };


    /* =====================================================
       11. RENDER PAYSLIP ROW
    ===================================================== */

    const renderPayslipRow = (record) => {

        const row = document.createElement("tr");

        const payslipId = String(
            record.id ?? ""
        );

        appendCell(
            row,
            record.employeeCode || "—",
            "Employee ID"
        );

        appendCell(
            row,
            record.employeeName || "—",
            "Employee"
        );

        appendCell(
            row,
            record.periodLabel || "—",
            "Salary Period"
        );

        appendCell(
            row,
            formatCurrency(record.grossPay),
            "Gross Salary"
        );

        appendCell(
            row,
            formatCurrency(record.totalDeductions),
            "Deductions"
        );

        appendCell(
            row,
            formatCurrency(record.netPay),
            "Net Salary"
        );

        appendCell(
            row,
            record.status || "—",
            "Status"
        );

        const actionCell =
            document.createElement("td");

        actionCell.dataset.label = "Actions";

        const actions = create(
            "div",
            "",
            "table-actions"
        );

        if (payslipId) {

            actions.appendChild(

                createActionButton(
                    "View",
                    "view",
                    payslipId
                )

            );

            if (
                hasPermission("downloadPayslips") &&
                record.canDownload === true
            ) {

                actions.appendChild(

                    createActionButton(
                        "Download",
                        "download",
                        payslipId
                    )

                );

            }

        }

        actionCell.appendChild(actions);

        row.appendChild(actionCell);

        return row;

    };


    const renderPayslips = () => {

        const tbody = getTableBody();

        if (!tbody) {
            return;
        }

        if (!state.records.length) {

            renderEmpty(
                "No payslip records available."
            );

            return;

        }

        const fragment =
            document.createDocumentFragment();

        state.records.forEach((record) => {

            fragment.appendChild(
                renderPayslipRow(record)
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

            "payslipsPaginationInfo",

            `${formatNumber(start)}–${formatNumber(end)} of ${formatNumber(state.totalRecords)}`

        );

        setText(

            "payslipsCurrentPage",

            `${state.currentPage} / ${totalPages}`

        );

        const previous = get(
            "payslipsPreviousPage"
        );

        const next = get(
            "payslipsNextPage"
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

        if (state.loading) {
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

        loadPayslips();

    };


    /* =====================================================
       13. FETCH PAYSLIP RECORDS
    ===================================================== */

    const loadPayslips = async () => {

        const requestId =
            ++state.requestSequence;

        setLoading(true);

        clearError();

        try {

            /*
             * GET /payslips
             *
             * Employee:
             * Own authorised payslips only.
             *
             * HR / Super Admin:
             * Records permitted by backend RBAC.
             */

            const response = await request(

                `${CONFIG.endpoints.list}?${buildQuery()}`

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
                    "Invalid payslip listing response."
                );

            }

            state.records = response.items;

            state.totalRecords = response.total;

            renderPayslips();

            renderPagination();

        } catch {

            if (
                requestId !== state.requestSequence
            ) {

                return;

            }

            state.records = [];

            state.totalRecords = 0;

            renderEmpty(
                "Unable to load payslip records."
            );

            renderPagination();

            showError(
                "Payslip information could not be loaded."
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
       14. SALARY BREAKDOWN
    ===================================================== */

    const renderBreakdown = (
        containerId,
        items
    ) => {

        const container = get(containerId);

        if (!container) {
            return;
        }

        container.replaceChildren();

        if (
            !Array.isArray(items) ||
            items.length === 0
        ) {

            container.appendChild(

                create(
                    "p",
                    "No breakdown information available.",
                    "text-muted"
                )

            );

            return;

        }

        const fragment =
            document.createDocumentFragment();

        items.forEach((item) => {

            if (
                !item ||
                typeof item !== "object"
            ) {

                return;

            }

            const row = create(
                "div",
                "",
                "payslip-breakdown-row"
            );

            const label = create(

                "span",

                item.label || "Item"

            );

            const amount = create(

                "strong",

                formatCurrency(item.amount)

            );

            row.append(
                label,
                amount
            );

            fragment.appendChild(row);

        });

        container.appendChild(fragment);

    };


    /* =====================================================
       15. PAYSLIP DETAILS
    ===================================================== */

    const renderPayslipDetails = (record) => {

        setText(
            "payslipDetailEmployee",
            record.employeeName
        );

        setText(
            "payslipDetailEmployeeCode",
            record.employeeCode
        );

        setText(
            "payslipDetailDepartment",
            record.departmentName
        );

        setText(
            "payslipDetailDesignation",
            record.designationName
        );

        setText(
            "payslipDetailPeriod",
            record.periodLabel
        );

        setText(
            "payslipDetailBasic",
            formatCurrency(record.basicSalary)
        );

        setText(
            "payslipDetailGross",
            formatCurrency(record.grossPay)
        );

        setText(
            "payslipDetailDeductions",
            formatCurrency(record.totalDeductions)
        );

        setText(
            "payslipDetailNet",
            formatCurrency(record.netPay)
        );

        setText(
            "payslipDetailIssuedAt",
            formatDate(record.issuedAt)
        );

        setText(
            "payslipDetailStatus",
            record.status
        );

        renderBreakdown(

            "payslipEarningsList",

            record.earnings

        );

        renderBreakdown(

            "payslipDeductionsList",

            record.deductions

        );

        const downloadButton = get(
            "downloadSelectedPayslip"
        );

        if (downloadButton) {

            downloadButton.hidden =
                !hasPermission("downloadPayslips") ||
                record.canDownload !== true;

        }

    };


    /* =====================================================
       16. VIEW PAYSLIP
    ===================================================== */

    const viewPayslip = async (payslipId) => {

        try {

            /*
             * GET /payslips/:id
             *
             * Backend must check:
             * - Verified account identity
             * - Employee ownership or HR permission
             * - Payroll publication status
             * - Allowed financial field visibility
             */

            const response = await request(
                payslipEndpoint(payslipId)
            );

            if (
                !response ||
                String(response.id) !== payslipId
            ) {

                throw new Error(
                    "Payslip record unavailable."
                );

            }

            state.selectedPayslip = response;

            renderPayslipDetails(response);

            window.EMSUI?.openModal(
                "payslipDetailsBackdrop"
            );

        } catch {

            notify(
                "Unable to open this payslip. Access may be restricted.",
                "danger"
            );

        }

    };


    /* =====================================================
       17. SECURE PDF DOWNLOAD
    ===================================================== */

    const downloadPayslip = async (payslipId) => {

        if (state.actionPending) {
            return;
        }

        try {

            requirePermission(
                "downloadPayslips"
            );

        } catch {

            notify(
                "Payslip download is not authorised.",
                "danger"
            );

            return;

        }

        state.actionPending = true;

        try {

            /*
             * POST /payslips/:id/download
             *
             * The backend must:
             *
             * 1. Verify the Firebase ID token.
             * 2. Verify employee ownership or permission.
             * 3. Verify payslip publication status.
             * 4. Generate or retrieve the PDF from the
             *    authoritative locked payroll snapshot.
             * 5. Return a short-lived signed HTTPS URL.
             * 6. Record the download/access event.
             *
             * Never use a permanently public PDF URL.
             */

            const response = await request(

                payslipEndpoint(
                    payslipId,
                    "/download"
                ),

                {

                    method: "POST"

                }

            );

            if (
                !response ||
                typeof response.url !== "string"
            ) {

                throw new Error(
                    "PDF download is unavailable."
                );

            }

            const downloadUrl = new URL(
                response.url
            );

            if (
                downloadUrl.protocol !== "https:" ||
                downloadUrl.username ||
                downloadUrl.password
            ) {

                throw new Error(
                    "Invalid PDF download URL."
                );

            }

            /*
             * The signed URL is returned by the
             * trusted backend after authorisation.
             */

            const link = document.createElement("a");

            link.href = downloadUrl.href;

            link.target = "_blank";

            link.rel = "noopener noreferrer";

            document.body.appendChild(link);

            link.click();

            link.remove();

        } catch {

            notify(
                "Unable to download this payslip.",
                "danger"
            );

        } finally {

            state.actionPending = false;

        }

    };


    /* =====================================================
       18. URL-BASED PAYSLIP SELECTION
    ===================================================== */

    const openRequestedPayslip = async () => {

        const parameters = new URLSearchParams(
            window.location.search
        );

        const payslipId = parameters.get("id");

        if (
            !payslipId ||
            !payslipId.trim()
        ) {

            return;

        }

        /*
         * URL parameters are untrusted.
         *
         * This only requests the record.
         * Backend authorisation determines access.
         */

        await viewPayslip(
            payslipId.trim()
        );

    };


    /* =====================================================
       19. REFRESH
    ===================================================== */

    const refresh = async () => {

        await loadPayslips();

    };


    /* =====================================================
       20. TABLE ACTION EVENTS
    ===================================================== */

    const initializeTableActions = () => {

        const tbody = getTableBody();

        tbody?.addEventListener(
            "click",
            async (event) => {

                const button = event.target.closest(
                    "[data-payslip-action]"
                );

                if (
                    !button ||
                    !tbody.contains(button) ||
                    state.actionPending
                ) {

                    return;

                }

                const payslipId =
                    button.dataset.payslipId;

                const action =
                    button.dataset.payslipAction;

                if (!payslipId) {
                    return;
                }

                switch (action) {

                    case "view":

                        await viewPayslip(
                            payslipId
                        );

                        break;

                    case "download":

                        await downloadPayslip(
                            payslipId
                        );

                        break;

                    default:

                        break;

                }

            }
        );

    };


    /* =====================================================
       21. REGISTER EVENTS
    ===================================================== */

    const initializeEvents = () => {

        get("payslipPeriodFilter")?.addEventListener(
            "change",
            () => {

                readFilters();

                state.currentPage = 1;

                loadPayslips();

            }
        );

        get("payslipEmployeeSearch")?.addEventListener(
            "change",
            () => {

                readFilters();

                state.currentPage = 1;

                loadPayslips();

            }
        );

        get("resetPayslipFilters")?.addEventListener(
            "click",
            resetFilters
        );

        get("refreshPayslips")?.addEventListener(
            "click",
            refresh
        );

        get("payslipsPreviousPage")?.addEventListener(
            "click",
            () => changePage(-1)
        );

        get("payslipsNextPage")?.addEventListener(
            "click",
            () => changePage(1)
        );

        get("downloadSelectedPayslip")?.addEventListener(
            "click",
            () => {

                const payslipId = String(
                    state.selectedPayslip?.id ?? ""
                );

                if (payslipId) {

                    downloadPayslip(payslipId);

                }

            }
        );

        initializeTableActions();

    };


    /* =====================================================
       22. INITIALIZATION
    ===================================================== */

    const initialize = async () => {

        if (state.initialized) {
            return;
        }

        state.initialized = true;

        setLoading(true);

        setVisible(
            "payslipsContent",
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
                !hasPermission("viewOwnPayslips") &&
                !hasPermission("viewAllPayslips")
            ) {

                throw new Error(
                    "Payslip access is restricted."
                );

            }

            /*
             * Employee search is only available
             * for accounts granted broader access.
             */

            const employeeSearch = get(
                "payslipEmployeeSearch"
            );

            if (employeeSearch) {

                employeeSearch.hidden =
                    !hasPermission("viewAllPayslips");

            }

            initializeEvents();

            try {

                await loadPeriods();

            } catch {

                notify(
                    "Unable to load payslip periods.",
                    "warning"
                );

            }

            readFilters();

            setVisible(
                "payslipsContent",
                true
            );

            await refresh();

            await openRequestedPayslip();

        } catch {

            state.permissions = {};

            applyPermissions();

            setVisible(
                "payslipsContent",
                false
            );

            showError(
                "Unable to verify payslip access."
            );

        } finally {

            setLoading(false);

        }

    };


    /* =====================================================
       23. PUBLIC MODULE INTERFACE
    ===================================================== */

    window.EMSPayslips = Object.freeze({

        initialize,

        refresh,

        view: viewPayslip,

        download: downloadPayslip,

        getContext: () => state.context

    });


    /* =====================================================
       24. START
    ===================================================== */

    const start = () => {

        if (
            document.body.dataset.page !== "payslips"
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

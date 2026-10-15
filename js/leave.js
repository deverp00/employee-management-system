/* =========================================================
   EMPLOYEE MANAGEMENT & PAYROLL SYSTEM
   FILE: js/leave.js

   PURPOSE:
   Secure employee leave management.

   IMPORTANT:
   - No demo records.
   - No hardcoded employee identity.
   - No frontend-generated leave balances.
   - Backend validates leave policy and permissions.
   - Backend performs atomic balance updates.
   - Every decision is recorded in the audit history.
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

        searchDelay: 350,

        endpoints: {

            access: "/leave/access",

            list: "/leave",

            balance: "/leave/balance",

            types: "/leave/types",

            apply: "/leave",

            summary: "/leave/summary"

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

        leaveTypes: [],

        balances: [],

        totalRecords: 0,

        currentPage: 1,

        loading: false,

        submitting: false,

        requestSequence: 0,

        searchTimer: null,

        selectedLeaveId: null,

        selectedAction: null,

        filters: {

            search: "",

            status: "",

            leaveType: "",

            dateFrom: "",

            dateTo: ""

        }

    };


    /* =====================================================
       03. DOM UTILITIES
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

            element.textContent = String(value ?? "—");

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

        element.textContent = String(value ?? "");

        if (className) {

            element.className = className;

        }

        return element;

    };


    const notify = (
        message,
        type = "success"
    ) => {

        window.EMSUI?.showToast(message, type);

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
       04. AUTHENTICATED BACKEND REQUEST
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


    const leaveEndpoint = (leaveId, suffix = "") => {

        if (
            typeof leaveId !== "string" ||
            !leaveId.trim()
        ) {

            throw new Error(
                "Invalid leave application identifier."
            );

        }

        return (
            "/leave/" +
            encodeURIComponent(leaveId) +
            suffix
        );

    };


    /* =====================================================
       05. PERMISSION HELPERS
    ===================================================== */

    const hasPermission = (permission) => {

        return state.permissions[permission] === true;

    };


    const requirePermission = (permission) => {

        if (!hasPermission(permission)) {

            throw new Error(
                "You do not have permission to perform this action."
            );

        }

    };


    const applyPermissions = () => {

        document.querySelectorAll(
            "[data-leave-permission]"
        ).forEach((element) => {

            const permission =
                element.dataset.leavePermission;

            element.hidden = !hasPermission(permission);

        });

    };


    const loadPermissions = async () => {

        /*
         * GET /leave/access
         *
         * Permissions are determined by the backend
         * using the verified Firebase session.
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
                "Leave access verification failed."
            );

        }

        const permissions = response.permissions;

        state.permissions = Object.freeze({

            viewLeave:
                permissions.viewLeave === true,

            applyLeave:
                permissions.applyLeave === true,

            approveLeave:
                permissions.approveLeave === true,

            rejectLeave:
                permissions.rejectLeave === true,

            cancelLeave:
                permissions.cancelLeave === true,

            viewBalances:
                permissions.viewBalances === true

        });

        applyPermissions();

    };


    /* =====================================================
       06. FORMATTING
    ===================================================== */

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

                year: "numeric",

                timeZone: "UTC"

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


    const isValidDate = (value) => {

        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
            return false;
        }

        const [year, month, day] =
            value.split("-").map(Number);

        const date = new Date(
            Date.UTC(year, month - 1, day)
        );

        return (
            date.getUTCFullYear() === year &&
            date.getUTCMonth() === month - 1 &&
            date.getUTCDate() === day
        );

    };


    /* =====================================================
       07. STATUS DISPLAY
    ===================================================== */

    const STATUS_CONFIG = Object.freeze({

        pending: {

            label: "Pending",

            className: "badge-warning"

        },

        approved: {

            label: "Approved",

            className: "badge-success"

        },

        rejected: {

            label: "Rejected",

            className: "badge-danger"

        },

        cancelled: {

            label: "Cancelled",

            className: "badge-primary"

        }

    });


    const createStatusBadge = (value) => {

        const status = String(
            value ?? ""
        ).toLowerCase();

        const config = STATUS_CONFIG[status];

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
       08. LOADING AND ERROR STATES
    ===================================================== */

    const setLoading = (loading) => {

        state.loading = loading;

        setVisible(
            "leaveLoading",
            loading
        );

        get("leaveTable")?.setAttribute(
            "aria-busy",
            String(loading)
        );

        const refreshButton = get(
            "refreshLeave"
        );

        if (refreshButton) {

            refreshButton.disabled = loading;

        }

    };


    const showError = (message) => {

        const element = get("leaveError");

        if (element) {

            element.textContent = message;

            element.hidden = false;

        } else {

            notify(message, "danger");

        }

    };


    const clearError = () => {

        const element = get("leaveError");

        if (element) {

            element.textContent = "";

            element.hidden = true;

        }

    };


    /* =====================================================
       09. LEAVE TYPES
    ===================================================== */

    const populateLeaveTypes = (items) => {

        if (!Array.isArray(items)) {
            return;
        }

        state.leaveTypes = items;

        const selectors = [

            get("leaveType"),

            get("leaveTypeFilter")

        ];

        selectors.forEach((select) => {

            if (!select) {
                return;
            }

            const previousValue = select.value;

            const fragment =
                document.createDocumentFragment();

            fragment.appendChild(

                new Option(

                    select.id === "leaveType"
                        ? "Select Leave Type"
                        : "All Leave Types",

                    ""

                )

            );

            items.forEach((item) => {

                if (
                    !item ||
                    typeof item.id !== "string" ||
                    !item.id.trim() ||
                    item.enabled !== true
                ) {

                    return;
                }

                fragment.appendChild(

                    new Option(

                        String(item.name || item.id),

                        item.id

                    )

                );

            });

            select.replaceChildren(fragment);

            if (
                Array.from(select.options).some(
                    (option) => option.value === previousValue
                )
            ) {

                select.value = previousValue;

            }

        });

    };


    const loadLeaveTypes = async () => {

        const response = await request(
            CONFIG.endpoints.types
        );

        if (
            !response ||
            !Array.isArray(response.items)
        ) {

            throw new Error(
                "Leave policies are unavailable."
            );

        }

        populateLeaveTypes(response.items);

    };


    /* =====================================================
       10. LEAVE BALANCE
    ===================================================== */

    const renderBalances = (items) => {

        const container = get(
            "leaveBalanceContainer"
        );

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
                    "No leave balance information available.",
                    "text-muted"
                )

            );

            return;

        }

        const fragment =
            document.createDocumentFragment();

        items.forEach((item) => {

            if (!item || typeof item !== "object") {
                return;
            }

            const card = create(
                "div",
                "",
                "card"
            );

            const title = create(
                "h3",
                item.leaveTypeName || "Leave"
            );

            const remaining = create(

                "strong",

                formatNumber(item.remaining),

                "leave-balance-value"

            );

            const description = create(

                "p",

                `Available: ${formatNumber(item.available)} | Used: ${formatNumber(item.used)}`,

                "text-muted"

            );

            card.append(
                title,
                remaining,
                description
            );

            fragment.appendChild(card);

        });

        container.appendChild(fragment);

    };


    const loadBalances = async () => {

        if (!hasPermission("viewBalances")) {
            return;
        }

        try {

            /*
             * The backend returns only leave balances
             * this account is authorised to view.
             */

            const response = await request(
                CONFIG.endpoints.balance
            );

            if (
                !response ||
                !Array.isArray(response.items)
            ) {

                throw new Error(
                    "Invalid leave balance response."
                );

            }

            state.balances = response.items;

            renderBalances(response.items);

        } catch {

            state.balances = [];

            renderBalances([]);

            notify(
                "Unable to load leave balances.",
                "danger"
            );

        }

    };


    /* =====================================================
       11. LEAVE SUMMARY
    ===================================================== */

    const renderSummary = (summary) => {

        const fields = {

            totalApplications:
                "totalLeaveApplications",

            pending:
                "pendingLeaveCount",

            approved:
                "approvedLeaveCount",

            rejected:
                "rejectedLeaveCount"

        };

        Object.entries(fields).forEach(
            ([key, id]) => {

                const value =
                    Object.prototype.hasOwnProperty.call(
                        summary,
                        key
                    )
                        ? formatNumber(summary[key])
                        : "—";

                setText(id, value);

            }
        );

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
                    "Invalid leave summary response."
                );

            }

            renderSummary(response);

        } catch {

            renderSummary({});

        }

    };


    /* =====================================================
       12. FILTERS
    ===================================================== */

    const readFilters = () => {

        state.filters.search =
            get("leaveSearch")?.value.trim() || "";

        state.filters.status =
            get("leaveStatusFilter")?.value || "";

        state.filters.leaveType =
            get("leaveTypeFilter")?.value || "";

        state.filters.dateFrom =
            get("leaveDateFrom")?.value || "";

        state.filters.dateTo =
            get("leaveDateTo")?.value || "";

    };


    const validateFilters = () => {

        const { dateFrom, dateTo } = state.filters;

        if (
            (dateFrom && !isValidDate(dateFrom)) ||
            (dateTo && !isValidDate(dateTo))
        ) {

            notify(
                "Enter valid leave filter dates.",
                "warning"
            );

            return false;

        }

        if (
            dateFrom &&
            dateTo &&
            dateFrom > dateTo
        ) {

            notify(
                "Starting date cannot be later than ending date.",
                "warning"
            );

            return false;

        }

        return true;

    };


    const buildQuery = () => {

        const parameters = new URLSearchParams({

            page: String(state.currentPage),

            limit: String(CONFIG.pageSize)

        });

        Object.entries(state.filters).forEach(
            ([key, value]) => {

                if (value) {

                    parameters.set(key, value);

                }

            }
        );

        return parameters.toString();

    };


    const resetFilters = () => {

        [

            "leaveSearch",

            "leaveStatusFilter",

            "leaveTypeFilter",

            "leaveDateFrom",

            "leaveDateTo"

        ].forEach((id) => {

            const element = get(id);

            if (element) {

                element.value = "";

            }

        });

        state.filters = {

            search: "",

            status: "",

            leaveType: "",

            dateFrom: "",

            dateTo: ""

        };

        state.currentPage = 1;

        refresh();

    };


    /* =====================================================
       13. LEAVE TABLE
    ===================================================== */

    const getTableBody = () => {

        return firstAvailable(
            "leaveTableBody",
            "leaveApplicationsBody"
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
        leaveId,
        className = "btn btn-secondary btn-sm"
    ) => {

        const button = create(
            "button",
            label,
            className
        );

        button.type = "button";

        button.dataset.leaveAction = action;

        button.dataset.leaveId = leaveId;

        return button;

    };


    const renderLeaveRow = (record) => {

        const row = document.createElement("tr");

        const leaveId = String(
            record.id ?? ""
        );

        appendCell(
            row,
            record.employeeName || "—",
            "Employee"
        );

        appendCell(
            row,
            record.leaveTypeName || "—",
            "Leave Type"
        );

        appendCell(
            row,
            formatDate(record.startDate),
            "From"
        );

        appendCell(
            row,
            formatDate(record.endDate),
            "To"
        );

        appendCell(
            row,
            formatNumber(record.totalDays),
            "Days"
        );

        const statusCell =
            document.createElement("td");

        statusCell.dataset.label = "Status";

        statusCell.appendChild(
            createStatusBadge(record.status)
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

        if (leaveId) {

            actions.appendChild(

                createActionButton(
                    "View",
                    "view",
                    leaveId
                )

            );

            if (
                record.status === "pending" &&
                record.canApprove === true &&
                hasPermission("approveLeave")
            ) {

                actions.appendChild(

                    createActionButton(
                        "Approve",
                        "approve",
                        leaveId,
                        "btn btn-primary btn-sm"
                    )

                );

            }

            if (
                record.status === "pending" &&
                record.canReject === true &&
                hasPermission("rejectLeave")
            ) {

                actions.appendChild(

                    createActionButton(
                        "Reject",
                        "reject",
                        leaveId,
                        "btn btn-danger btn-sm"
                    )

                );

            }

            if (
                record.canCancel === true &&
                hasPermission("cancelLeave")
            ) {

                actions.appendChild(

                    createActionButton(
                        "Cancel",
                        "cancel",
                        leaveId
                    )

                );

            }

        }

        actionCell.appendChild(actions);

        row.appendChild(actionCell);

        return row;

    };


    const renderLeaveRecords = () => {

        const tbody = getTableBody();

        if (!tbody) {
            return;
        }

        if (!state.records.length) {

            renderEmpty(
                "No leave applications found."
            );

            return;

        }

        const fragment =
            document.createDocumentFragment();

        state.records.forEach((record) => {

            fragment.appendChild(
                renderLeaveRow(record)
            );

        });

        tbody.replaceChildren(fragment);

        window.EMSUI?.refreshTableLabels(
            tbody.closest("table")
        );

    };


    /* =====================================================
       14. PAGINATION
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

            "leavePaginationInfo",

            `${formatNumber(start)}–${formatNumber(end)} of ${formatNumber(state.totalRecords)}`

        );

        setText(

            "leaveCurrentPage",

            `${state.currentPage} / ${totalPages}`

        );

        const previous = get(
            "leavePreviousPage"
        );

        const next = get(
            "leaveNextPage"
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

        loadLeaveRecords();

    };


    /* =====================================================
       15. FETCH LEAVE APPLICATIONS
    ===================================================== */

    const loadLeaveRecords = async () => {

        if (!validateFilters()) {
            return;
        }

        const requestId =
            ++state.requestSequence;

        setLoading(true);

        clearError();

        try {

            /*
             * GET /leave
             *
             * Backend scopes records to the verified
             * account and its granted permissions.
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
                    "Invalid leave listing response."
                );

            }

            state.records = response.items;

            state.totalRecords = response.total;

            renderLeaveRecords();

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
                "Unable to load leave applications."
            );

            renderPagination();

            showError(
                "Leave information could not be loaded."
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
       16. OPEN LEAVE APPLICATION
    ===================================================== */

    const openApplication = () => {

        try {

            requirePermission("applyLeave");

        } catch {

            notify(
                "Leave application is not authorised.",
                "danger"
            );

            return;

        }

        const form = get(
            "leaveApplicationForm"
        );

        form?.reset();

        window.EMSUI?.openModal(
            "leaveApplicationBackdrop"
        );

    };


    /* =====================================================
       17. SUBMIT LEAVE APPLICATION
    ===================================================== */

    const submitApplication = async (event) => {

        event.preventDefault();

        if (state.submitting) {
            return;
        }

        try {

            requirePermission("applyLeave");

        } catch {

            notify(
                "Leave application is not authorised.",
                "danger"
            );

            return;

        }

        const form = get(
            "leaveApplicationForm"
        );

        if (
            form &&
            !form.reportValidity()
        ) {

            return;

        }

        const payload = {

            leaveTypeId:
                get("leaveType")?.value || "",

            startDate:
                get("leaveStartDate")?.value || "",

            endDate:
                get("leaveEndDate")?.value || "",

            reason:
                get("leaveReason")?.value.trim() || ""

        };

        if (
            !payload.leaveTypeId ||
            !payload.startDate ||
            !payload.endDate ||
            !payload.reason
        ) {

            notify(
                "Complete all required leave fields.",
                "warning"
            );

            return;

        }

        if (
            !isValidDate(payload.startDate) ||
            !isValidDate(payload.endDate) ||
            payload.startDate > payload.endDate
        ) {

            notify(
                "Enter a valid leave date range.",
                "warning"
            );

            return;

        }

        const validType = state.leaveTypes.some(
            (item) => {

                return (
                    item.id === payload.leaveTypeId &&
                    item.enabled === true
                );

            }
        );

        if (!validType) {

            notify(
                "Select an available leave type.",
                "warning"
            );

            return;

        }

        state.submitting = true;

        const submitButton = get(
            "submitLeaveApplication"
        );

        if (submitButton) {

            submitButton.disabled = true;

        }

        try {

            /*
             * POST /leave
             *
             * Backend responsibilities:
             *
             * - Derive employee from verified UID.
             * - Validate employment status.
             * - Apply published leave policy.
             * - Calculate chargeable leave days.
             * - Exclude applicable holidays/weekends.
             * - Check overlapping applications.
             * - Check available balance.
             * - Generate leave application ID.
             * - Record audit event.
             *
             * The frontend never calculates or
             * directly deducts leave balances.
             */

            await request(

                CONFIG.endpoints.apply,

                {

                    method: "POST",

                    body: payload

                }

            );

            window.EMSUI?.closeModal(
                "leaveApplicationBackdrop"
            );

            form?.reset();

            notify(
                "Leave application submitted successfully."
            );

            state.currentPage = 1;

            await refresh();

        } catch {

            notify(
                "Unable to submit the leave application. Please check the details.",
                "danger"
            );

        } finally {

            state.submitting = false;

            if (submitButton) {

                submitButton.disabled = false;

            }

        }

    };


    /* =====================================================
       18. VIEW LEAVE DETAILS
    ===================================================== */

    const viewLeave = async (leaveId) => {

        try {

            const response = await request(
                leaveEndpoint(leaveId)
            );

            if (
                !response ||
                typeof response !== "object" ||
                Array.isArray(response)
            ) {

                throw new Error(
                    "Leave application unavailable."
                );

            }

            const details = {

                leaveDetailEmployee:
                    response.employeeName,

                leaveDetailType:
                    response.leaveTypeName,

                leaveDetailFrom:
                    formatDate(response.startDate),

                leaveDetailTo:
                    formatDate(response.endDate),

                leaveDetailDays:
                    formatNumber(response.totalDays),

                leaveDetailStatus:
                    STATUS_CONFIG[response.status]?.label ||
                    "Unavailable",

                leaveDetailReason:
                    response.reason,

                leaveDetailDecisionReason:
                    response.decisionReason,

                leaveDetailAppliedAt:
                    formatDate(response.createdAt)

            };

            Object.entries(details).forEach(
                ([id, value]) => {

                    setText(id, value);

                }
            );

            window.EMSUI?.openModal(
                "leaveDetailsBackdrop"
            );

        } catch {

            notify(
                "Unable to open leave application details.",
                "danger"
            );

        }

    };


    /* =====================================================
       19. APPROVE LEAVE
    ===================================================== */

    const approveLeave = async (leaveId) => {

        if (state.submitting) {
            return;
        }

        try {

            requirePermission("approveLeave");

        } catch {

            notify(
                "Leave approval is not authorised.",
                "danger"
            );

            return;

        }

        const record = state.records.find(
            (item) => String(item.id) === leaveId
        );

        if (
            !record ||
            record.status !== "pending" ||
            record.canApprove !== true
        ) {

            notify(
                "This leave application cannot be approved.",
                "warning"
            );

            return;

        }

        const confirmed =
            await window.EMSUI.confirm({

                title: "Approve Leave",

                message:
                    "Approve this leave application? The backend will validate the current leave policy, balance and application status before processing.",

                confirmText: "Approve",

                cancelText: "Cancel"

            });

        if (!confirmed) {
            return;
        }

        state.submitting = true;

        try {

            /*
             * POST /leave/:id/approve
             *
             * Backend must atomically:
             *
             * - Recheck approver permission.
             * - Prevent unauthorised self-approval.
             * - Verify pending application status.
             * - Revalidate leave balance and policy.
             * - Apply balance changes once.
             * - Prevent concurrent double approval.
             * - Store actual approver UID and time.
             * - Create immutable audit entry.
             */

            await request(

                leaveEndpoint(
                    leaveId,
                    "/approve"
                ),

                {

                    method: "POST"

                }

            );

            notify(
                "Leave application approved successfully."
            );

            await refresh();

        } catch {

            notify(
                "Unable to approve the leave application.",
                "danger"
            );

        } finally {

            state.submitting = false;

        }

    };


    /* =====================================================
       20. OPEN REJECTION FORM
    ===================================================== */

    const openRejection = (leaveId) => {

        try {

            requirePermission("rejectLeave");

        } catch {

            notify(
                "Leave rejection is not authorised.",
                "danger"
            );

            return;

        }

        const record = state.records.find(
            (item) => String(item.id) === leaveId
        );

        if (
            !record ||
            record.status !== "pending" ||
            record.canReject !== true
        ) {

            notify(
                "This leave application cannot be rejected.",
                "warning"
            );

            return;

        }

        state.selectedLeaveId = leaveId;

        state.selectedAction = "reject";

        get("leaveRejectionForm")?.reset();

        setText(
            "rejectionEmployeeName",
            record.employeeName || "Employee"
        );

        window.EMSUI?.openModal(
            "leaveRejectionBackdrop"
        );

    };


    /* =====================================================
       21. SUBMIT REJECTION
    ===================================================== */

    const submitRejection = async (event) => {

        event.preventDefault();

        if (state.submitting) {
            return;
        }

        try {

            requirePermission("rejectLeave");

        } catch {

            notify(
                "Leave rejection is not authorised.",
                "danger"
            );

            return;

        }

        const leaveId = state.selectedLeaveId;

        const reason = (
            get("leaveRejectionReason")?.value || ""
        ).trim();

        if (
            !leaveId ||
            state.selectedAction !== "reject"
        ) {

            notify(
                "Select a valid leave application.",
                "warning"
            );

            return;

        }

        if (!reason) {

            notify(
                "A rejection reason is required.",
                "warning"
            );

            return;

        }

        const confirmed =
            await window.EMSUI.confirm({

                title: "Reject Leave",

                message:
                    "Reject this leave application? The employee will be able to view the recorded reason.",

                confirmText: "Reject Leave",

                cancelText: "Cancel",

                danger: true

            });

        if (!confirmed) {
            return;
        }

        state.submitting = true;

        try {

            /*
             * POST /leave/:id/reject
             *
             * Backend validates the pending state,
             * approver permission and decision reason.
             */

            await request(

                leaveEndpoint(
                    leaveId,
                    "/reject"
                ),

                {

                    method: "POST",

                    body: {
                        reason
                    }

                }

            );

            state.selectedLeaveId = null;

            state.selectedAction = null;

            window.EMSUI?.closeModal(
                "leaveRejectionBackdrop"
            );

            notify(
                "Leave application rejected."
            );

            await refresh();

        } catch {

            notify(
                "Unable to reject the leave application.",
                "danger"
            );

        } finally {

            state.submitting = false;

        }

    };


    /* =====================================================
       22. CANCEL LEAVE
    ===================================================== */

    const cancelLeave = async (leaveId) => {

        if (state.submitting) {
            return;
        }

        try {

            requirePermission("cancelLeave");

        } catch {

            notify(
                "Leave cancellation is not authorised.",
                "danger"
            );

            return;

        }

        const record = state.records.find(
            (item) => String(item.id) === leaveId
        );

        if (
            !record ||
            record.canCancel !== true
        ) {

            notify(
                "This leave application cannot be cancelled.",
                "warning"
            );

            return;

        }

        const confirmed =
            await window.EMSUI.confirm({

                title: "Cancel Leave Application",

                message:
                    "Cancel this leave application? Any applicable leave balance adjustment will be calculated by the backend.",

                confirmText: "Cancel Leave",

                cancelText: "Keep Application",

                danger: true

            });

        if (!confirmed) {
            return;
        }

        state.submitting = true;

        try {

            /*
             * POST /leave/:id/cancel
             *
             * Backend must verify ownership or
             * administrative permission and apply
             * the published cancellation policy.
             *
             * Locked payroll periods must not be
             * silently recalculated or modified.
             */

            await request(

                leaveEndpoint(
                    leaveId,
                    "/cancel"
                ),

                {

                    method: "POST"

                }

            );

            notify(
                "Leave application cancelled successfully."
            );

            await refresh();

        } catch {

            notify(
                "Unable to cancel the leave application.",
                "danger"
            );

        } finally {

            state.submitting = false;

        }

    };


    /* =====================================================
       23. REFRESH
    ===================================================== */

    const refresh = async () => {

        await Promise.allSettled([

            loadLeaveRecords(),

            loadSummary(),

            loadBalances()

        ]);

    };


    /* =====================================================
       24. TABLE ACTION EVENTS
    ===================================================== */

    const initializeTableActions = () => {

        getTableBody()?.addEventListener(
            "click",
            async (event) => {

                const button = event.target.closest(
                    "[data-leave-action]"
                );

                if (!button) {
                    return;
                }

                const leaveId =
                    button.dataset.leaveId;

                const action =
                    button.dataset.leaveAction;

                if (!leaveId) {
                    return;
                }

                switch (action) {

                    case "view":

                        await viewLeave(leaveId);

                        break;

                    case "approve":

                        await approveLeave(leaveId);

                        break;

                    case "reject":

                        openRejection(leaveId);

                        break;

                    case "cancel":

                        await cancelLeave(leaveId);

                        break;

                    default:

                        break;

                }

            }
        );

    };


    /* =====================================================
       25. FILTER EVENTS
    ===================================================== */

    const initializeFilters = () => {

        get("leaveSearch")?.addEventListener(
            "input",
            () => {

                window.clearTimeout(
                    state.searchTimer
                );

                state.searchTimer = window.setTimeout(
                    () => {

                        readFilters();

                        state.currentPage = 1;

                        refresh();

                    },
                    CONFIG.searchDelay
                );

            }
        );

        [

            "leaveStatusFilter",

            "leaveTypeFilter",

            "leaveDateFrom",

            "leaveDateTo"

        ].forEach((id) => {

            get(id)?.addEventListener(
                "change",
                () => {

                    readFilters();

                    state.currentPage = 1;

                    refresh();

                }
            );

        });

        get("resetLeaveFilters")?.addEventListener(
            "click",
            resetFilters
        );

    };


    /* =====================================================
       26. REGISTER EVENTS
    ===================================================== */

    const initializeEvents = () => {

        firstAvailable(
            "applyLeaveButton",
            "openLeaveApplication"
        )?.addEventListener(
            "click",
            openApplication
        );

        get("leaveApplicationForm")?.addEventListener(
            "submit",
            submitApplication
        );

        get("leaveRejectionForm")?.addEventListener(
            "submit",
            submitRejection
        );

        get("refreshLeave")?.addEventListener(
            "click",
            refresh
        );

        get("leavePreviousPage")?.addEventListener(
            "click",
            () => changePage(-1)
        );

        get("leaveNextPage")?.addEventListener(
            "click",
            () => changePage(1)
        );

        initializeFilters();

        initializeTableActions();

    };


    /* =====================================================
       27. INITIALIZATION
    ===================================================== */

    const initialize = async () => {

        if (state.initialized) {
            return;
        }

        state.initialized = true;

        setLoading(true);

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

            if (!hasPermission("viewLeave")) {

                throw new Error(
                    "Leave management access is restricted."
                );

            }

            initializeEvents();

            await loadLeaveTypes();

            readFilters();

            await refresh();

        } catch {

            state.permissions = {};

            applyPermissions();

            showError(
                "Unable to verify leave management access."
            );

        } finally {

            setLoading(false);

        }

    };


    /* =====================================================
       28. PUBLIC MODULE INTERFACE
    ===================================================== */

    window.EMSLeave = Object.freeze({

        initialize,

        refresh,

        openApplication,

        getContext: () => state.context

    });


    /* =====================================================
       29. START
    ===================================================== */

    const start = () => {

        if (
            document.body.dataset.page !== "leave"
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

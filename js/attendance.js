/* =========================================================
   EMPLOYEE MANAGEMENT & PAYROLL SYSTEM
   FILE: js/attendance.js

   PURPOSE:
   Secure employee attendance management.

   SECURITY:
   - Firebase authenticated requests.
   - Backend-generated attendance timestamps.
   - No client-submitted employee UID for check-in.
   - Backend-enforced permissions.
   - Audited attendance corrections.
   - Locked payroll periods remain protected.
   - No demo attendance records.
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

            list: "/attendance",

            summary: "/attendance/summary",

            today: "/attendance/today",

            checkIn: "/attendance/check-in",

            checkOut: "/attendance/check-out",

            correction: "/attendance/corrections"

        }

    });


    /* =====================================================
       02. STATE
    ===================================================== */

    const state = {

        initialized: false,

        context: null,

        permissions: {},

        records: [],

        totalRecords: 0,

        currentPage: 1,

        pageSize: CONFIG.pageSize,

        loading: false,

        actionPending: false,

        requestSequence: 0,

        searchTimer: null,

        today: null,

        filters: {

            search: "",

            dateFrom: "",

            dateTo: "",

            status: ""

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


    const notify = (
        message,
        type = "success"
    ) => {

        window.EMSUI?.showToast(
            message,
            type
        );

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
       04. AUTHENTICATED REQUEST
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


    /* =====================================================
       05. PERMISSION MANAGEMENT
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
            "[data-attendance-permission]"
        ).forEach((element) => {

            const permission =
                element.dataset.attendancePermission;

            element.hidden = !hasPermission(
                permission
            );

        });


        /*
         * Frontend permission visibility is not
         * an authorisation mechanism.
         *
         * Every backend request must independently
         * verify account role and permissions.
         */

    };


    /* =====================================================
       06. DATE FORMATTING
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

                year: "numeric"

            }
        ).format(date);

    };


    const formatTime = (value) => {

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

                hour: "2-digit",

                minute: "2-digit",

                hour12: true

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


    const isValidDateInput = (value) => {

        if (!value) {
            return true;
        }

        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
            return false;
        }

        const [
            year,
            month,
            day
        ] = value.split("-").map(Number);

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
       07. STATUS FORMATTING
    ===================================================== */

    const STATUS_LABELS = Object.freeze({

        present: "Present",

        absent: "Absent",

        late: "Late",

        half_day: "Half Day",

        on_leave: "On Leave",

        holiday: "Holiday",

        weekly_off: "Weekly Off",

        pending: "Pending"

    });


    const STATUS_CLASSES = Object.freeze({

        present: "badge-success",

        absent: "badge-danger",

        late: "badge-warning",

        half_day: "badge-warning",

        on_leave: "badge-primary",

        holiday: "badge-primary",

        weekly_off: "badge-primary",

        pending: "badge-warning"

    });


    const createStatusBadge = (value) => {

        const status = String(
            value ?? ""
        ).trim().toLowerCase();

        const badge = create(

            "span",

            STATUS_LABELS[status] || "Unavailable",

            "badge"

        );

        badge.classList.add(
            STATUS_CLASSES[status] || "badge-primary"
        );

        return badge;

    };


    /* =====================================================
       08. LOADING AND ERROR STATES
    ===================================================== */

    const setLoading = (loading) => {

        state.loading = loading;

        setVisible(
            "attendanceLoading",
            loading
        );

        get("attendanceTable")?.setAttribute(
            "aria-busy",
            String(loading)
        );

        const refreshButton = get(
            "refreshAttendance"
        );

        if (refreshButton) {

            refreshButton.disabled = loading;

        }

    };


    const showError = (message) => {

        const element = get(
            "attendanceError"
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
            "attendanceError"
        );

        if (element) {

            element.textContent = "";

            element.hidden = true;

        }

    };


    /* =====================================================
       09. TODAY'S ATTENDANCE
    ===================================================== */

    const renderToday = (response) => {

        state.today = response;

        setText(
            "todayAttendanceStatus",
            STATUS_LABELS[response.status] ||
            "Not Marked"
        );

        setText(
            "todayCheckIn",
            formatTime(response.checkIn)
        );

        setText(
            "todayCheckOut",
            formatTime(response.checkOut)
        );


        const checkInButton = firstAvailable(
            "checkInButton",
            "attendanceCheckIn"
        );

        const checkOutButton = firstAvailable(
            "checkOutButton",
            "attendanceCheckOut"
        );


        /*
         * Backend supplies permitted actions.
         * Do not infer permission from browser time.
         */

        if (checkInButton) {

            checkInButton.disabled =
                state.actionPending ||
                response.canCheckIn !== true;

        }

        if (checkOutButton) {

            checkOutButton.disabled =
                state.actionPending ||
                response.canCheckOut !== true;

        }


        setVisible(
            "todayAttendanceSection",
            true
        );

    };


    const loadToday = async () => {

        try {

            /*
             * GET /attendance/today
             *
             * The backend derives employee identity
             * from the verified authentication token.
             */

            const response = await request(
                CONFIG.endpoints.today
            );


            if (
                !response ||
                typeof response !== "object" ||
                Array.isArray(response)
            ) {

                throw new Error(
                    "Invalid attendance response."
                );

            }


            renderToday(response);

        } catch {

            state.today = null;

            setText(
                "todayAttendanceStatus",
                "Unavailable"
            );

            setText(
                "todayCheckIn",
                "—"
            );

            setText(
                "todayCheckOut",
                "—"
            );


            const checkInButton = firstAvailable(
                "checkInButton",
                "attendanceCheckIn"
            );

            const checkOutButton = firstAvailable(
                "checkOutButton",
                "attendanceCheckOut"
            );


            if (checkInButton) {

                checkInButton.disabled = true;

            }

            if (checkOutButton) {

                checkOutButton.disabled = true;

            }

        }

    };


    /* =====================================================
       10. CHECK IN / CHECK OUT
    ===================================================== */

    const performAttendanceAction = async (
        action
    ) => {

        if (state.actionPending) {
            return;
        }


        const isCheckIn =
            action === "checkIn";

        const permission = isCheckIn
            ? "checkIn"
            : "checkOut";


        try {

            requirePermission(permission);

        } catch {

            notify(
                "This attendance action is not authorised.",
                "danger"
            );

            return;

        }


        const currentAllowed = isCheckIn
            ? state.today?.canCheckIn === true
            : state.today?.canCheckOut === true;


        if (!currentAllowed) {

            notify(
                "This attendance action is currently unavailable.",
                "warning"
            );

            return;

        }


        const endpoint = isCheckIn
            ? CONFIG.endpoints.checkIn
            : CONFIG.endpoints.checkOut;


        state.actionPending = true;

        try {

            /*
             * No browser timestamp, employee ID,
             * department or attendance status is
             * submitted.
             *
             * Backend derives:
             * - Authenticated employee
             * - Authoritative current time
             * - Attendance policy
             * - Applicable working date
             *
             * Duplicate and invalid actions must
             * be rejected atomically by the backend.
             */

            await request(
                endpoint,
                {

                    method: "POST"

                }
            );


            notify(

                isCheckIn
                    ? "Check In recorded successfully."
                    : "Check Out recorded successfully.",

                "success"

            );

            await Promise.allSettled([

                loadToday(),

                loadAttendance(),

                loadSummary()

            ]);

        } catch {

            notify(
                "Attendance could not be recorded. Please refresh and try again.",
                "danger"
            );

            await loadToday();

        } finally {

            state.actionPending = false;

            /*
             * Reapply server-returned eligibility,
             * rather than enabling buttons locally.
             */

            if (state.today) {

                renderToday(state.today);

            }

        }

    };


    /* =====================================================
       11. ATTENDANCE SUMMARY
    ===================================================== */

    const renderSummary = (summary) => {

        const fields = {

            totalWorkingDays:
                "attendanceTotalDays",

            present:
                "attendancePresentCount",

            absent:
                "attendanceAbsentCount",

            late:
                "attendanceLateCount",

            onLeave:
                "attendanceLeaveCount",

            pending:
                "attendancePendingCount"

        };


        Object.entries(fields).forEach(
            ([key, elementId]) => {

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

            }
        );


        const rate = Number(
            summary.attendanceRate
        );

        setText(

            "attendanceRate",

            Number.isFinite(rate)
                ? `${rate.toFixed(1)}%`
                : "—"

        );

    };


    const loadSummary = async () => {

        try {

            const parameters =
                new URLSearchParams();


            if (state.filters.dateFrom) {

                parameters.set(
                    "dateFrom",
                    state.filters.dateFrom
                );

            }

            if (state.filters.dateTo) {

                parameters.set(
                    "dateTo",
                    state.filters.dateTo
                );

            }


            const query = parameters.toString();

            const endpoint = query
                ? `${CONFIG.endpoints.summary}?${query}`
                : CONFIG.endpoints.summary;


            /*
             * The backend applies permission-based
             * scoping before aggregating records.
             */

            const response = await request(
                endpoint
            );


            if (
                !response ||
                typeof response !== "object" ||
                Array.isArray(response)
            ) {

                throw new Error(
                    "Invalid attendance summary."
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
            firstAvailable(
                "attendanceSearch",
                "searchAttendance"
            )?.value.trim() || "";


        state.filters.dateFrom =
            firstAvailable(
                "attendanceDateFrom",
                "attendanceFromDate"
            )?.value || "";


        state.filters.dateTo =
            firstAvailable(
                "attendanceDateTo",
                "attendanceToDate"
            )?.value || "";


        state.filters.status =
            firstAvailable(
                "attendanceStatusFilter",
                "attendanceFilterStatus"
            )?.value || "";

    };


    const validateFilters = () => {

        const {
            dateFrom,
            dateTo
        } = state.filters;


        if (
            !isValidDateInput(dateFrom) ||
            !isValidDateInput(dateTo)
        ) {

            notify(
                "Enter valid attendance dates.",
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
                "The starting date cannot be later than the ending date.",
                "warning"
            );

            return false;

        }


        return true;

    };


    const buildQuery = () => {

        const parameters = new URLSearchParams({

            page: String(
                state.currentPage
            ),

            limit: String(
                state.pageSize
            )

        });


        Object.entries(state.filters).forEach(
            ([key, value]) => {

                if (value) {

                    parameters.set(
                        key,
                        value
                    );

                }

            }
        );


        return parameters.toString();

    };


    const resetFilters = () => {

        const ids = [

            "attendanceSearch",

            "searchAttendance",

            "attendanceDateFrom",

            "attendanceFromDate",

            "attendanceDateTo",

            "attendanceToDate",

            "attendanceStatusFilter",

            "attendanceFilterStatus"

        ];


        ids.forEach((id) => {

            const input = get(id);

            if (input) {

                input.value = "";

            }

        });


        state.filters = {

            search: "",

            dateFrom: "",

            dateTo: "",

            status: ""

        };


        state.currentPage = 1;

        refresh();

    };


    /* =====================================================
       13. ATTENDANCE TABLE
    ===================================================== */

    const getTableBody = () => {

        return firstAvailable(
            "attendanceTableBody",
            "attendanceBody"
        );

    };


    const renderEmpty = (message) => {

        const tbody = getTableBody();

        if (!tbody) {
            return;
        }


        const table = tbody.closest("table");

        const columns =
            table?.querySelectorAll("thead th").length || 1;


        const row = document.createElement("tr");

        const cell = create(
            "td",
            message
        );

        cell.colSpan = columns;

        row.appendChild(cell);

        tbody.replaceChildren(row);

    };


    const renderAttendance = () => {

        const tbody = getTableBody();

        if (!tbody) {
            return;
        }


        if (!state.records.length) {

            renderEmpty(
                "No attendance records found."
            );

            return;

        }


        const fragment =
            document.createDocumentFragment();


        state.records.forEach((record) => {

            const row = document.createElement("tr");


            appendCell(

                row,

                formatDate(record.date),

                "Date"

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

                formatTime(record.checkIn),

                "Check In"

            );


            appendCell(

                row,

                formatTime(record.checkOut),

                "Check Out"

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


            if (
                hasPermission("correctAttendance") &&
                record.canRequestCorrection === true &&
                record.id
            ) {

                const button = create(

                    "button",

                    "Correct",

                    "btn btn-secondary btn-sm"

                );

                button.type = "button";

                button.dataset.attendanceAction =
                    "correct";

                button.dataset.recordId =
                    String(record.id);

                actionCell.appendChild(button);

            } else {

                actionCell.textContent = "—";

            }


            row.appendChild(actionCell);

            fragment.appendChild(row);

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

            "attendancePaginationInfo",

            `${formatNumber(start)}–${formatNumber(end)} of ${formatNumber(state.totalRecords)}`

        );


        setText(

            "attendanceCurrentPage",

            `${state.currentPage} / ${totalPages}`

        );


        const previous = firstAvailable(
            "attendancePreviousPage",
            "attendancePrevPage"
        );


        const next = get(
            "attendanceNextPage"
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
                state.totalRecords / state.pageSize
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

        loadAttendance();

    };


    /* =====================================================
       15. FETCH ATTENDANCE RECORDS
    ===================================================== */

    const loadAttendance = async () => {

        if (!validateFilters()) {
            return;
        }


        const requestId =
            ++state.requestSequence;


        setLoading(true);

        clearError();


        try {

            /*
             * GET /attendance
             *
             * The backend returns only records
             * accessible to the authenticated user.
             *
             * Employee accounts must be scoped to
             * their own employee record.
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
                    "Invalid attendance listing."
                );

            }


            state.records = response.items;

            state.totalRecords = response.total;


            renderAttendance();

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
                "Unable to load attendance records."
            );

            renderPagination();


            showError(
                "Attendance information could not be loaded."
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
       16. ATTENDANCE CORRECTION FORM
    ===================================================== */

    const openCorrection = (recordId) => {

        try {

            requirePermission(
                "correctAttendance"
            );

        } catch {

            notify(
                "Attendance correction is not authorised.",
                "danger"
            );

            return;

        }


        const record = state.records.find(
            (item) => String(item.id) === recordId
        );


        if (
            !record ||
            record.canRequestCorrection !== true
        ) {

            notify(
                "This attendance record cannot be corrected.",
                "warning"
            );

            return;

        }


        const form = get(
            "attendanceCorrectionForm"
        );

        form?.reset();


        const recordInput = get(
            "correctionRecordId"
        );

        if (recordInput) {

            recordInput.value = recordId;

        }


        setText(

            "correctionEmployeeName",

            record.employeeName || "Employee"

        );


        setText(

            "correctionAttendanceDate",

            formatDate(record.date)

        );


        window.EMSUI?.openModal(
            "attendanceCorrectionBackdrop"
        );

    };


    /* =====================================================
       17. SUBMIT ATTENDANCE CORRECTION
    ===================================================== */

    const saveCorrection = async (event) => {

        event.preventDefault();


        if (state.actionPending) {
            return;
        }


        try {

            requirePermission(
                "correctAttendance"
            );

        } catch {

            notify(
                "Attendance correction is not authorised.",
                "danger"
            );

            return;

        }


        const form = get(
            "attendanceCorrectionForm"
        );


        if (
            form &&
            !form.reportValidity()
        ) {

            return;

        }


        const recordId = get(
            "correctionRecordId"
        )?.value.trim();


        const status = get(
            "correctionStatus"
        )?.value.trim();


        const reason = get(
            "correctionReason"
        )?.value.trim();


        const checkIn = get(
            "correctionCheckIn"
        )?.value || null;


        const checkOut = get(
            "correctionCheckOut"
        )?.value || null;


        if (
            !recordId ||
            !status ||
            !reason
        ) {

            notify(
                "Complete all required correction fields.",
                "warning"
            );

            return;

        }


        const sourceRecord = state.records.find(
            (item) => String(item.id) === recordId
        );


        if (
            !sourceRecord ||
            sourceRecord.canRequestCorrection !== true
        ) {

            notify(
                "This record is no longer available for correction.",
                "warning"
            );

            return;

        }


        const confirmed =
            await window.EMSUI.confirm({

                title: "Submit Attendance Correction",

                message:
                    "Submit this attendance correction? The change will be validated and recorded in the audit history.",

                confirmText: "Submit Correction",

                cancelText: "Cancel"

            });


        if (!confirmed) {
            return;
        }


        state.actionPending = true;


        const submitButton = get(
            "saveAttendanceCorrection"
        );


        if (submitButton) {

            submitButton.disabled = true;

        }


        try {

            /*
             * POST /attendance/corrections
             *
             * Backend requirements:
             *
             * 1. Verify authenticated administrator.
             * 2. Verify correction permission.
             * 3. Validate source attendance record.
             * 4. Reject locked payroll periods.
             * 5. Validate status and timestamps.
             * 6. Store previous and updated values.
             * 7. Record the actual acting UID.
             * 8. Record an authoritative timestamp.
             *
             * The frontend must not overwrite the
             * original attendance record directly.
             */

            await request(

                CONFIG.endpoints.correction,

                {

                    method: "POST",

                    body: {

                        recordId,

                        requestedStatus: status,

                        requestedCheckIn: checkIn,

                        requestedCheckOut: checkOut,

                        reason

                    }

                }

            );


            window.EMSUI?.closeModal(
                "attendanceCorrectionBackdrop"
            );


            notify(
                "Attendance correction submitted successfully."
            );


            await Promise.allSettled([

                loadAttendance(),

                loadSummary(),

                loadToday()

            ]);

        } catch {

            notify(
                "Unable to submit the attendance correction.",
                "danger"
            );

        } finally {

            state.actionPending = false;


            if (submitButton) {

                submitButton.disabled = false;

            }

        }

    };


    /* =====================================================
       18. REFRESH
    ===================================================== */

    const refresh = async () => {

        await Promise.allSettled([

            loadAttendance(),

            loadSummary(),

            loadToday()

        ]);

    };


    /* =====================================================
       19. FILTER EVENT LISTENERS
    ===================================================== */

    const initializeFilters = () => {

        const searchInput = firstAvailable(
            "attendanceSearch",
            "searchAttendance"
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

                        refresh();

                    },
                    CONFIG.searchDelay
                );

            }
        );


        const filterIds = [

            "attendanceDateFrom",

            "attendanceFromDate",

            "attendanceDateTo",

            "attendanceToDate",

            "attendanceStatusFilter",

            "attendanceFilterStatus"

        ];


        filterIds.forEach((id) => {

            get(id)?.addEventListener(
                "change",
                () => {

                    readFilters();

                    state.currentPage = 1;

                    refresh();

                }
            );

        });


        firstAvailable(
            "resetAttendanceFilters",
            "clearAttendanceFilters"
        )?.addEventListener(
            "click",
            resetFilters
        );

    };


    /* =====================================================
       20. ATTENDANCE EVENT LISTENERS
    ===================================================== */

    const initializeEvents = () => {

        firstAvailable(
            "checkInButton",
            "attendanceCheckIn"
        )?.addEventListener(
            "click",
            () => performAttendanceAction("checkIn")
        );


        firstAvailable(
            "checkOutButton",
            "attendanceCheckOut"
        )?.addEventListener(
            "click",
            () => performAttendanceAction("checkOut")
        );


        get("refreshAttendance")?.addEventListener(
            "click",
            refresh
        );


        firstAvailable(
            "attendancePreviousPage",
            "attendancePrevPage"
        )?.addEventListener(
            "click",
            () => changePage(-1)
        );


        get("attendanceNextPage")?.addEventListener(
            "click",
            () => changePage(1)
        );


        getTableBody()?.addEventListener(
            "click",
            (event) => {

                const button = event.target.closest(
                    '[data-attendance-action="correct"]'
                );


                if (!button) {
                    return;
                }


                openCorrection(
                    button.dataset.recordId || ""
                );

            }
        );


        get("attendanceCorrectionForm")?.addEventListener(
            "submit",
            saveCorrection
        );


        initializeFilters();

    };


    /* =====================================================
       21. INITIAL PERMISSION CONTEXT
    ===================================================== */

    const loadPermissionContext = async () => {

        /*
         * GET /attendance/access
         *
         * Expected response:
         *
         * {
         *   permissions: {
         *     viewAttendance: boolean,
         *     checkIn: boolean,
         *     checkOut: boolean,
         *     correctAttendance: boolean
         *   }
         * }
         *
         * The backend decides these permissions
         * using the authenticated account and
         * published Advanced Settings policy.
         */

        const response = await request(
            "/attendance/access"
        );


        if (
            !response ||
            !response.permissions ||
            typeof response.permissions !== "object" ||
            Array.isArray(response.permissions)
        ) {

            throw new Error(
                "Attendance permission verification failed."
            );

        }


        const permissions = response.permissions;


        state.permissions = Object.freeze({

            viewAttendance:
                permissions.viewAttendance === true,

            checkIn:
                permissions.checkIn === true,

            checkOut:
                permissions.checkOut === true,

            correctAttendance:
                permissions.correctAttendance === true

        });


        applyPermissions();

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


        /*
         * Attendance actions remain unavailable
         * until verification completes.
         */

        const checkInButton = firstAvailable(
            "checkInButton",
            "attendanceCheckIn"
        );


        const checkOutButton = firstAvailable(
            "checkOutButton",
            "attendanceCheckOut"
        );


        if (checkInButton) {

            checkInButton.disabled = true;

        }


        if (checkOutButton) {

            checkOutButton.disabled = true;

        }


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


            await loadPermissionContext();


            if (
                !hasPermission("viewAttendance")
            ) {

                throw new Error(
                    "Attendance access is restricted."
                );

            }


            initializeEvents();

            readFilters();

            setLoading(false);

            await refresh();

        } catch {

            state.permissions = {};

            applyPermissions();


            showError(
                "Unable to verify attendance access."
            );

        } finally {

            setLoading(false);

        }

    };


    /* =====================================================
       23. PUBLIC MODULE API
    ===================================================== */

    window.EMSAttendance = Object.freeze({

        initialize,

        refresh,

        checkIn: () => {
            return performAttendanceAction("checkIn");
        },

        checkOut: () => {
            return performAttendanceAction("checkOut");
        },

        getContext: () => state.context

    });


    /* =====================================================
       24. START
    ===================================================== */

    const start = () => {

        if (
            document.body.dataset.page !== "attendance"
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

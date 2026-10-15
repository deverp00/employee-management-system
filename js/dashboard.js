/* =========================================================
   EMPLOYEE MANAGEMENT & PAYROLL SYSTEM
   FILE: js/dashboard.js

   PURPOSE:
   Secure, role-aware dashboard controller.

   DATA SOURCE:
   Authenticated backend through EMSFirebase.

   IMPORTANT:
   - No demo records.
   - No hardcoded employee data.
   - No client-side permission assignment.
   - Backend decides which dashboard data is visible.
========================================================= */

"use strict";

(() => {

    /* =====================================================
       01. STATE
    ===================================================== */

    const state = {

        initialized: false,

        loading: false,

        context: null,

        dashboard: null,

        requestId: 0

    };


    /* =====================================================
       02. DOM HELPERS
    ===================================================== */

    const get = (id) => {

        return document.getElementById(id);

    };


    const setText = (id, value) => {

        const element = get(id);

        if (!element) {
            return;
        }

        element.textContent = String(value ?? "");

    };


    const setVisible = (id, visible) => {

        const element = get(id);

        if (element) {

            element.hidden = !visible;

        }

    };


    const createElement = (
        tag,
        className = "",
        text = ""
    ) => {

        const element = document.createElement(tag);

        if (className) {

            element.className = className;

        }

        element.textContent = String(text ?? "");

        return element;

    };


    /* =====================================================
       03. NUMBER / CURRENCY FORMATTING
    ===================================================== */

    const formatNumber = (value) => {

        const number = Number(value);

        if (!Number.isFinite(number)) {

            return "—";

        }

        return new Intl.NumberFormat(
            "en-IN"
        ).format(number);

    };


    const formatCurrency = (value) => {

        const number = Number(value);

        if (!Number.isFinite(number)) {

            return "—";

        }

        return new Intl.NumberFormat(
            "en-IN",
            {

                style: "currency",

                currency: "INR",

                maximumFractionDigits: 2

            }
        ).format(number);

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
       04. DASHBOARD LOADING STATE
    ===================================================== */

    const setLoading = (loading) => {

        state.loading = loading;

        setVisible(
            "dashboardLoading",
            loading
        );

        const content = get(
            "dashboardContent"
        );

        if (content) {

            content.setAttribute(
                "aria-busy",
                String(loading)
            );

        }

        const refreshButton = get(
            "refreshDashboard"
        );

        if (refreshButton) {

            refreshButton.disabled = loading;

        }

    };


    /* =====================================================
       05. DASHBOARD ERROR HANDLING
    ===================================================== */

    const showError = (message) => {

        const errorElement = get(
            "dashboardError"
        );

        if (errorElement) {

            errorElement.textContent = message;

            errorElement.hidden = false;

        }

        setVisible(
            "dashboardContent",
            false
        );

    };


    const clearError = () => {

        const errorElement = get(
            "dashboardError"
        );

        if (errorElement) {

            errorElement.textContent = "";

            errorElement.hidden = true;

        }

    };


    /* =====================================================
       06. ROLE-BASED INTERFACE
    ===================================================== */

    const applyRoleVisibility = (context) => {

        /*
         * data-dashboard-role:
         *
         * super_admin
         * hr_admin
         * employee
         *
         * Multiple roles may be comma-separated.
         *
         * This controls presentation only.
         * Backend permission checks remain mandatory.
         */

        document.querySelectorAll(
            "[data-dashboard-role]"
        ).forEach((element) => {

            const roles = (
                element.dataset.dashboardRole || ""
            )
                .split(",")
                .map((role) => role.trim())
                .filter(Boolean);

            element.hidden = !roles.includes(
                context.role
            );

        });

    };


    /* =====================================================
       07. DASHBOARD IDENTITY
    ===================================================== */

    const renderIdentity = (context) => {

        setText(
            "dashboardUserName",
            context.displayName || "Account"
        );

        const roleNames = {

            super_admin: "Super Administrator",

            hr_admin: "HR Administrator",

            employee: "Employee"

        };

        setText(
            "dashboardUserRole",
            roleNames[context.role] || ""
        );

    };


    /* =====================================================
       08. STATISTICS
    ===================================================== */

    const STAT_FIELDS = Object.freeze({

        totalEmployees: {

            id: "totalEmployees",

            formatter: formatNumber

        },

        activeEmployees: {

            id: "activeEmployees",

            formatter: formatNumber

        },

        presentToday: {

            id: "presentToday",

            formatter: formatNumber

        },

        absentToday: {

            id: "absentToday",

            formatter: formatNumber

        },

        pendingLeaves: {

            id: "pendingLeaves",

            formatter: formatNumber

        },

        monthlyPayroll: {

            id: "monthlyPayroll",

            formatter: formatCurrency

        },

        attendancePercentage: {

            id: "attendancePercentage",

            formatter: (value) => {

                const number = Number(value);

                return Number.isFinite(number)
                    ? `${number.toFixed(1)}%`
                    : "—";

            }

        },

        remainingLeaves: {

            id: "remainingLeaves",

            formatter: formatNumber

        }

    });


    const clearStatistics = () => {

        Object.values(STAT_FIELDS)
            .forEach((field) => {

                setText(
                    field.id,
                    "—"
                );

            });

    };


    const renderStatistics = (statistics) => {

        if (
            !statistics ||
            typeof statistics !== "object"
        ) {

            return;

        }

        Object.entries(STAT_FIELDS)
            .forEach(([key, field]) => {

                /*
                 * Missing values remain unavailable.
                 * Never display a fabricated zero.
                 */

                if (
                    !Object.prototype.hasOwnProperty.call(
                        statistics,
                        key
                    )
                ) {

                    setText(
                        field.id,
                        "—"
                    );

                    return;

                }

                setText(

                    field.id,

                    field.formatter(
                        statistics[key]
                    )

                );

            });

    };


    /* =====================================================
       09. RECENT ACTIVITY
    ===================================================== */

    const renderActivities = (activities) => {

        const container = get(
            "recentActivityList"
        );

        if (!container) {
            return;
        }

        container.replaceChildren();

        if (
            !Array.isArray(activities) ||
            activities.length === 0
        ) {

            const empty = createElement(

                "p",

                "text-muted",

                "No recent activity available."

            );

            container.appendChild(empty);

            return;

        }


        activities.forEach((activity) => {

            if (
                !activity ||
                typeof activity !== "object"
            ) {

                return;

            }

            const item = createElement(
                "div",
                "dashboard-activity-item"
            );

            const content = createElement(
                "div",
                "dashboard-activity-content"
            );

            const title = createElement(

                "strong",

                "dashboard-activity-title",

                activity.title || "Activity"

            );

            const description = createElement(

                "p",

                "text-muted",

                activity.description || ""

            );

            const date = createElement(

                "small",

                "dashboard-activity-date",

                formatDate(activity.createdAt)

            );


            content.append(
                title,
                description,
                date
            );

            item.appendChild(content);

            container.appendChild(item);

        });

    };


    /* =====================================================
       10. PENDING APPROVALS
    ===================================================== */

    const renderApprovals = (approvals) => {

        const container = get(
            "pendingApprovalsList"
        );

        if (!container) {
            return;
        }

        container.replaceChildren();


        if (
            !Array.isArray(approvals) ||
            approvals.length === 0
        ) {

            container.appendChild(

                createElement(

                    "p",

                    "text-muted",

                    "No pending approvals."

                )

            );

            return;

        }


        approvals.forEach((approval) => {

            if (
                !approval ||
                typeof approval !== "object"
            ) {

                return;

            }

            const item = createElement(

                "div",

                "dashboard-approval-item"

            );

            const information = createElement(

                "div",

                "dashboard-approval-info"

            );

            const title = createElement(

                "strong",

                "",

                approval.title || "Pending Request"

            );

            const subtitle = createElement(

                "small",

                "text-muted",

                approval.description || ""

            );


            information.append(
                title,
                subtitle
            );

            item.appendChild(information);


            /*
             * The backend supplies only approvals
             * this authenticated account may view.
             *
             * Approval actions themselves will be
             * implemented in the leave/payroll modules.
             */

            container.appendChild(item);

        });

    };


    /* =====================================================
       11. ATTENDANCE SUMMARY
    ===================================================== */

    const renderAttendance = (attendance) => {

        if (
            !attendance ||
            typeof attendance !== "object"
        ) {

            return;

        }

        setText(
            "attendanceSummaryPresent",
            formatNumber(attendance.present)
        );

        setText(
            "attendanceSummaryAbsent",
            formatNumber(attendance.absent)
        );

        setText(
            "attendanceSummaryLeave",
            formatNumber(attendance.onLeave)
        );

    };


    /* =====================================================
       12. PAYROLL SUMMARY
    ===================================================== */

    const renderPayroll = (payroll) => {

        if (
            !payroll ||
            typeof payroll !== "object"
        ) {

            return;

        }

        setText(
            "payrollSummaryAmount",
            formatCurrency(payroll.totalAmount)
        );

        setText(
            "payrollSummaryProcessed",
            formatNumber(payroll.processedCount)
        );

        setText(
            "payrollSummaryPending",
            formatNumber(payroll.pendingCount)
        );

        setText(
            "payrollSummaryPeriod",
            payroll.period || "—"
        );

    };


    /* =====================================================
       13. COMPLETE DASHBOARD RENDER
    ===================================================== */

    const renderDashboard = (data) => {

        if (
            !data ||
            typeof data !== "object" ||
            Array.isArray(data)
        ) {

            throw new Error(
                "Invalid dashboard response."
            );

        }

        clearStatistics();

        renderStatistics(
            data.statistics
        );

        renderActivities(
            data.recentActivities
        );

        renderApprovals(
            data.pendingApprovals
        );

        renderAttendance(
            data.attendanceSummary
        );

        renderPayroll(
            data.payrollSummary
        );

        setText(
            "dashboardLastUpdated",
            formatDate(data.updatedAt)
        );

        setVisible(
            "dashboardContent",
            true
        );

    };


    /* =====================================================
       14. FETCH AUTHORISED DASHBOARD DATA
    ===================================================== */

    const loadDashboard = async () => {

        if (state.loading) {
            return;
        }

        const requestId = ++state.requestId;

        setLoading(true);

        clearError();

        try {

            if (
                !window.EMSFirebase ||
                typeof window.EMSFirebase.request !== "function"
            ) {

                throw new Error(
                    "Application data service is unavailable."
                );

            }

            /*
             * Backend endpoint:
             *
             * GET /dashboard
             *
             * Backend derives the authenticated UID
             * and role from the verified Firebase token.
             *
             * Never pass a role or UID from a dropdown
             * to decide which private records to return.
             */

            const response = await window.EMSFirebase.request(
                "/dashboard"
            );

            if (
                requestId !== state.requestId
            ) {

                return;

            }

            state.dashboard = response;

            renderDashboard(response);

        } catch (error) {

            if (
                requestId !== state.requestId
            ) {

                return;

            }

            state.dashboard = null;

            clearStatistics();

            showError(
                "Unable to load dashboard information. Please try again."
            );

            console.error(
                "Dashboard request failed."
            );

            window.EMSUI?.showToast(

                "Dashboard information could not be loaded.",

                "danger"

            );

        } finally {

            if (
                requestId === state.requestId
            ) {

                setLoading(false);

            }

        }

    };


    /* =====================================================
       15. REFRESH CONTROL
    ===================================================== */

    const initializeRefresh = () => {

        get("refreshDashboard")?.addEventListener(

            "click",

            loadDashboard

        );

    };


    /* =====================================================
       16. DASHBOARD INITIALIZATION
    ===================================================== */

    const initialize = async () => {

        if (state.initialized) {
            return;
        }

        state.initialized = true;

        clearStatistics();

        setVisible(
            "dashboardContent",
            false
        );

        setLoading(true);

        try {

            if (!window.EMSFirebase) {

                throw new Error(
                    "Firebase service bridge is unavailable."
                );

            }

            /*
             * Wait for the authenticated session
             * and protected backend role verification.
             */

            const context =
                await window.EMSFirebase.requireAuth([

                    "super_admin",

                    "hr_admin",

                    "employee"

                ]);


            if (!context) {
                return;
            }

            state.context = context;

            renderIdentity(context);

            applyRoleVisibility(context);

            setLoading(false);

            await loadDashboard();

        } catch {

            showError(
                "Unable to verify your account. Please sign in again."
            );

            setLoading(false);

        }

    };


    /* =====================================================
       17. PUBLIC DASHBOARD INTERFACE
    ===================================================== */

    window.EMSDashboard = Object.freeze({

        initialize,

        refresh: loadDashboard,

        getContext: () => state.context

    });


    /* =====================================================
       18. START
    ===================================================== */

    const start = () => {

        if (
            document.body.dataset.page !== "dashboard"
        ) {

            return;

        }

        initializeRefresh();

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


/* =========================================================
   EMPLOYEE MANAGEMENT & PAYROLL SYSTEM
   FILE: js/dashboard.js

   PURPOSE:
   Super Admin Dashboard Controller.

   SECURITY:
   - Super Admin access only.
   - Backend-verified role required.
   - Dashboard hidden until authorization succeeds.
   - No demo records or hardcoded employee data.
   - Backend must independently protect /dashboard.
========================================================= */

"use strict";

(() => {

    /* =====================================================
       01. CONFIGURATION & STATE
    ===================================================== */

    const ALLOWED_ROLES = Object.freeze([
        "super_admin"
    ]);

    const state = {
        initialized: false,
        authorized: false,
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

        if (!element) return;

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

        return new Intl.NumberFormat("en-IN").format(number);

    };

    const formatCurrency = (value) => {

        const number = Number(value);

        if (!Number.isFinite(number)) {
            return "—";
        }

        return new Intl.NumberFormat("en-IN", {
            style: "currency",
            currency: "INR",
            maximumFractionDigits: 2
        }).format(number);

    };

    const formatDate = (value) => {

        if (!value) return "—";

        const date = new Date(value);

        if (Number.isNaN(date.getTime())) {
            return "—";
        }

        return new Intl.DateTimeFormat("en-IN", {
            day: "2-digit",
            month: "short",
            year: "numeric"
        }).format(date);

    };


    /* =====================================================
       04. LOADING STATE
    ===================================================== */

    const setLoading = (loading) => {

        state.loading = loading;

        setVisible("dashboardLoading", loading);

        const content = get("dashboardContent");

        if (content) {
            content.setAttribute(
                "aria-busy",
                String(loading)
            );
        }

        const refreshButton = get("refreshDashboard");

        if (refreshButton) {
            refreshButton.disabled =
                loading || !state.authorized;
        }

    };


    /* =====================================================
       05. ERROR HANDLING
    ===================================================== */

    const showError = (message) => {

        const element = get("dashboardError");

        if (element) {
            element.textContent = message;
            element.hidden = false;
        }

        setVisible("dashboardContent", false);

    };

    const clearError = () => {

        const element = get("dashboardError");

        if (element) {
            element.textContent = "";
            element.hidden = true;
        }

    };


    /* =====================================================
       06. ACCESS CONTROL
    ===================================================== */

    const hideProtectedContent = () => {

        setVisible("dashboardContent", false);

        const refreshButton = get("refreshDashboard");

        if (refreshButton) {
            refreshButton.disabled = true;
        }

    };

    const denyAccess = () => {

        state.authorized = false;
        state.context = null;
        state.dashboard = null;

        ++state.requestId;

        hideProtectedContent();

        setLoading(false);

        showError(
            "Access denied. This dashboard is restricted to Super Administrators."
        );

    };

    const verifySuperAdmin = async () => {

        if (
            !window.EMSFirebase ||
            typeof window.EMSFirebase.requireAuth !== "function"
        ) {
            throw new Error(
                "Authentication service is unavailable."
            );
        }

        /*
         * requireAuth must validate the Firebase session
         * against the protected backend /auth/context.
         *
         * The role must never come from the login dropdown
         * or browser storage.
         */

        const context = await window.EMSFirebase.requireAuth(
            ALLOWED_ROLES
        );

        if (!context) {
            return null;
        }

        /*
         * Additional explicit verification.
         * Fail closed if the returned role is unexpected.
         */

        if (
            context.role !== "super_admin" ||
            context.enabled !== true
        ) {
            return null;
        }

        return context;

    };


    /* =====================================================
       07. ROLE-BASED INTERFACE
    ===================================================== */

    const applyRoleVisibility = (context) => {

        document.querySelectorAll(
            "[data-dashboard-role]"
        ).forEach((element) => {

            const roles = (
                element.dataset.dashboardRole || ""
            )
                .split(",")
                .map(role => role.trim())
                .filter(Boolean);

            element.hidden = !roles.includes(context.role);

        });

    };


    /* =====================================================
       08. DASHBOARD IDENTITY
    ===================================================== */

    const renderIdentity = (context) => {

        setText(
            "dashboardUserName",
            context.displayName || "Account"
        );

        setText(
            "dashboardUserRole",
            "Super Administrator"
        );

    };


    /* =====================================================
       09. STATISTICS
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

        Object.values(STAT_FIELDS).forEach((field) => {

            setText(field.id, "—");

        });

    };

    const renderStatistics = (statistics) => {

        if (
            !statistics ||
            typeof statistics !== "object"
        ) {
            return;
        }

        Object.entries(STAT_FIELDS).forEach(
            ([key, field]) => {

                if (
                    !Object.prototype.hasOwnProperty.call(
                        statistics,
                        key
                    )
                ) {
                    setText(field.id, "—");
                    return;
                }

                setText(
                    field.id,
                    field.formatter(statistics[key])
                );

            }
        );

    };


    /* =====================================================
       10. RECENT ACTIVITY
    ===================================================== */

    const renderActivities = (activities) => {

        const container = get("recentActivityList");

        if (!container) return;

        container.replaceChildren();

        if (
            !Array.isArray(activities) ||
            activities.length === 0
        ) {

            container.appendChild(
                createElement(
                    "p",
                    "text-muted",
                    "No recent activity available."
                )
            );

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
       11. PENDING APPROVALS
    ===================================================== */

    const renderApprovals = (approvals) => {

        const container = get("pendingApprovalsList");

        if (!container) return;

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

            container.appendChild(item);

        });

    };


    /* =====================================================
       12. ATTENDANCE SUMMARY
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
       13. PAYROLL SUMMARY
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
       14. DASHBOARD RENDERING
    ===================================================== */

    const renderDashboard = (data) => {

        if (!state.authorized) {
            return;
        }

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

        renderStatistics(data.statistics);

        renderActivities(data.recentActivities);

        renderApprovals(data.pendingApprovals);

        renderAttendance(data.attendanceSummary);

        renderPayroll(data.payrollSummary);

        setText(
            "dashboardLastUpdated",
            formatDate(data.updatedAt)
        );

        setVisible("dashboardContent", true);

    };


    /* =====================================================
       15. FETCH AUTHORIZED DASHBOARD DATA
    ===================================================== */

    const loadDashboard = async () => {

        /*
         * Never request dashboard data before
         * successful Super Admin verification.
         */

        if (
            !state.authorized ||
            state.context?.role !== "super_admin" ||
            state.loading
        ) {
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
             * IMPORTANT:
             *
             * Backend GET /dashboard must independently
             * verify the Firebase token and enforce
             * super_admin access.
             */

            const response = await window.EMSFirebase.request(
                "/dashboard"
            );

            if (
                requestId !== state.requestId ||
                !state.authorized
            ) {
                return;
            }

            state.dashboard = response;

            renderDashboard(response);

        } catch (error) {

            if (requestId !== state.requestId) {
                return;
            }

            state.dashboard = null;

            clearStatistics();

            showError(
                "Unable to load dashboard information. Please try again."
            );

            console.error(
                "Dashboard request failed:",
                error
            );

            window.EMSUI?.showToast(
                "Dashboard information could not be loaded.",
                "danger"
            );

        } finally {

            if (requestId === state.requestId) {
                setLoading(false);
            }

        }

    };


    /* =====================================================
       16. REFRESH CONTROL
    ===================================================== */

    const initializeRefresh = () => {

        get("refreshDashboard")?.addEventListener(
            "click",
            loadDashboard
        );

    };


    /* =====================================================
       17. DASHBOARD INITIALIZATION
    ===================================================== */

    const initialize = async () => {

        if (state.initialized) {
            return;
        }

        state.initialized = true;

        /*
         * Keep sensitive interface hidden until the
         * backend confirms Super Admin access.
         */

        hideProtectedContent();

        clearStatistics();

        clearError();

        setLoading(true);

        try {

            const context = await verifySuperAdmin();

            if (!context) {

                denyAccess();

                return;

            }

            /*
             * Access granted only after backend
             * role verification succeeds.
             */

            state.context = context;

            state.authorized = true;

            renderIdentity(context);

            applyRoleVisibility(context);

            setLoading(false);

            await loadDashboard();

        } catch (error) {

            state.authorized = false;
            state.context = null;

            hideProtectedContent();

            showError(
                "Unable to verify your account. Please sign in again."
            );

            setLoading(false);

            console.error(
                "Dashboard authorization failed:",
                error
            );

        }

    };


    /* =====================================================
       18. PUBLIC DASHBOARD INTERFACE
    ===================================================== */

    window.EMSDashboard = Object.freeze({

        initialize,

        refresh: loadDashboard,

        getContext: () => state.context

    });


    /* =====================================================
       19. START
    ===================================================== */

    const start = () => {

        if (
            document.body.dataset.page !== "dashboard"
        ) {
            return;
        }

        hideProtectedContent();

        initializeRefresh();

        initialize();

    };

    if (document.readyState === "loading") {

        document.addEventListener(
            "DOMContentLoaded",
            start,
            { once: true }
        );

    } else {

        start();

    }

})();

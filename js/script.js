/* =========================================================
   EMPLOYEE MANAGEMENT & PAYROLL SYSTEM
   FILE: js/script.js

   PURPOSE:
   Universal application interface controller.

   RESPONSIBILITIES:
   - Sidebar navigation
   - Shared modal management
   - Confirmation dialogs
   - Toast notifications
   - Responsive table labels
   - Logout integration
   - Shared UI accessibility

   IMPORTANT:
   This file does not implement authentication.
   Authentication and permissions must be verified
   through the dedicated authentication/backend layer.

   NO DEMO DATA.
   NO PRIVATE CREDENTIALS.
   NO HARDCODED AUTHENTICATION BYPASS.
========================================================= */

"use strict";

(() => {

    /* =====================================================
       01. UNIVERSAL CONFIGURATION
    ===================================================== */

    const CONFIG = Object.freeze({

        toastDuration: 4500,

        toastLimit: 4,

        mobileBreakpoint: 900,

        focusableSelector: [
            "a[href]",
            "button:not([disabled])",
            "input:not([disabled])",
            "select:not([disabled])",
            "textarea:not([disabled])",
            '[tabindex]:not([tabindex="-1"])'
        ].join(",")

    });


    /* =====================================================
       02. APPLICATION STATE
    ===================================================== */

    const state = {

        activeModal: null,

        previousFocus: null,

        confirmationResolver: null,

        confirmationPending: false,

        sidebarOpen: false,

        toastCounter: 0,

        tableObserver: null

    };


    /* =====================================================
       03. DOM UTILITIES
    ===================================================== */

    const getElement = (id) => {

        if (typeof id !== "string") {
            return null;
        }

        return document.getElementById(id);

    };


    const getFocusableElements = (container) => {

        if (!container) {
            return [];
        }

        return Array.from(
            container.querySelectorAll(
                CONFIG.focusableSelector
            )
        ).filter((element) => {

            return (
                !element.hidden &&
                element.getClientRects().length > 0 &&
                !element.closest("[hidden]") &&
                element.getAttribute("aria-hidden") !== "true"
            );

        });

    };


    const setText = (id, value) => {

        const element = getElement(id);

        if (!element) {
            return false;
        }

        element.textContent = String(value ?? "");

        return true;

    };


    /* =====================================================
       04. SIDEBAR MANAGEMENT
    ===================================================== */

    const sidebar = getElement("appSidebar");

    const sidebarBackdrop = getElement("sidebarBackdrop");

    const menuToggle = getElement("menuToggle");


    const openSidebar = () => {

        if (!sidebar || !menuToggle) {
            return;
        }

        sidebar.classList.add("open");

        sidebarBackdrop?.classList.add("active");

        menuToggle.setAttribute(
            "aria-expanded",
            "true"
        );

        state.sidebarOpen = true;

    };


    const closeSidebar = () => {

        if (!sidebar) {
            return;
        }

        sidebar.classList.remove("open");

        sidebarBackdrop?.classList.remove("active");

        menuToggle?.setAttribute(
            "aria-expanded",
            "false"
        );

        state.sidebarOpen = false;

    };


    const toggleSidebar = () => {

        if (state.sidebarOpen) {

            closeSidebar();

        } else {

            openSidebar();

        }

    };


    const initializeSidebar = () => {

        menuToggle?.addEventListener(
            "click",
            toggleSidebar
        );

        sidebarBackdrop?.addEventListener(
            "click",
            closeSidebar
        );

        sidebar?.querySelectorAll(".nav-link")
            .forEach((link) => {

                link.addEventListener(
                    "click",
                    closeSidebar
                );

            });


        window.addEventListener("resize", () => {

            if (
                window.innerWidth >
                CONFIG.mobileBreakpoint
            ) {

                closeSidebar();

            }

        });

    };


    /* =====================================================
       05. UNIVERSAL MODAL MANAGEMENT
    ===================================================== */

    const isModalOpen = (element) => {

        return Boolean(
            element &&
            !element.hidden
        );

    };


    const restoreFocus = () => {

        const previousElement = state.previousFocus;

        state.previousFocus = null;

        if (
            previousElement &&
            previousElement.isConnected &&
            typeof previousElement.focus === "function"
        ) {

            previousElement.focus();

        }

    };


    const openModal = (modalId) => {

        const modal = getElement(modalId);

        if (!modal) {
            return false;
        }

        if (state.activeModal === modal) {
            return true;
        }

        if (state.activeModal) {

            /*
             * Only one ordinary overlay is displayed at a
             * time. Confirmation dialogs are managed by
             * the dedicated confirmation controller.
             */

            closeModal(
                state.activeModal.id,
                false
            );

        }

        state.previousFocus = document.activeElement;

        modal.hidden = false;

        document.body.classList.add("modal-open");

        state.activeModal = modal;

        const focusable = getFocusableElements(modal);

        if (focusable.length > 0) {

            focusable[0].focus();

        } else {

            const dialog = modal.querySelector(
                '[role="dialog"]'
            );

            if (dialog) {

                dialog.setAttribute("tabindex", "-1");

                dialog.focus();

            }

        }

        document.dispatchEvent(
            new CustomEvent("ems:modal-opened", {

                detail: {
                    modalId
                }

            })
        );

        return true;

    };


    const closeModal = (
        modalId,
        shouldRestoreFocus = true
    ) => {

        const modal = getElement(modalId);

        if (!modal) {
            return false;
        }

        /*
         * The confirmation dialog must be resolved
         * through its own controller.
         */

        if (
            modalId === "confirmBackdrop" &&
            state.confirmationResolver
        ) {

            return false;

        }

        modal.hidden = true;

        if (state.activeModal === modal) {

            state.activeModal = null;

        }

        if (
            !state.activeModal &&
            !state.confirmationResolver
        ) {

            document.body.classList.remove(
                "modal-open"
            );

        }

        if (shouldRestoreFocus) {

            restoreFocus();

        }

        document.dispatchEvent(
            new CustomEvent("ems:modal-closed", {

                detail: {
                    modalId
                }

            })
        );

        return true;

    };


    /* =====================================================
       06. MODAL CLOSE BUTTON REGISTRATION
    ===================================================== */

    const MODAL_CLOSE_BINDINGS = Object.freeze({

        /* Employees */

        closeEmployeeForm:
            "employeeFormBackdrop",

        cancelEmployeeForm:
            "employeeFormBackdrop",

        closeEmployeeProfile:
            "employeeProfileBackdrop",


        /* Attendance */

        closeAttendanceForm:
            "attendanceFormBackdrop",

        cancelAttendanceForm:
            "attendanceFormBackdrop",

        closeAttendanceDetails:
            "attendanceDetailsBackdrop",

        attendanceDetailsCloseButton:
            "attendanceDetailsBackdrop",


        /* Leave */

        closeLeaveForm:
            "leaveFormBackdrop",

        cancelLeaveForm:
            "leaveFormBackdrop",

        closeLeaveDetails:
            "leaveDetailsBackdrop",

        leaveDetailsCloseButton:
            "leaveDetailsBackdrop",

        closeLeaveDecision:
            "leaveDecisionBackdrop",

        cancelLeaveDecision:
            "leaveDecisionBackdrop",


        /* Payroll */

        closeGeneratePayroll:
            "generatePayrollBackdrop",

        cancelGeneratePayroll:
            "generatePayrollBackdrop",

        closePayrollDetails:
            "payrollDetailsBackdrop",

        payrollDetailsCloseButton:
            "payrollDetailsBackdrop",

        closePayrollAdjustment:
            "payrollAdjustmentBackdrop",

        cancelPayrollAdjustment:
            "payrollAdjustmentBackdrop",


        /* Payslips */

        closePayslipPreview:
            "payslipPreviewBackdrop",

        payslipPreviewCloseButton:
            "payslipPreviewBackdrop",


        /* Reports */

        closeReportExport:
            "reportExportBackdrop",

        cancelReportExport:
            "reportExportBackdrop",

        closeReportRecord:
            "reportRecordBackdrop",

        reportRecordCloseButton:
            "reportRecordBackdrop",


        /* Advanced Settings */

        closeSettingsEditor:
            "settingsEditorBackdrop",

        cancelSettingsEditor:
            "settingsEditorBackdrop",

        closeSettingsPreview:
            "settingsPreviewBackdrop",

        settingsPreviewCloseButton:
            "settingsPreviewBackdrop",

        closeSettingsPublish:
            "settingsPublishBackdrop",

        cancelSettingsPublish:
            "settingsPublishBackdrop",


        /* FAQ */

        closeFAQArticle:
            "faqArticleBackdrop",

        faqArticleCloseButton:
            "faqArticleBackdrop",

        closeSupportRequest:
            "supportRequestBackdrop",

        cancelSupportRequest:
            "supportRequestBackdrop",


        /* Employee Profile */

        closeProfileEditor:
            "profileEditorBackdrop",

        cancelProfileEditor:
            "profileEditorBackdrop",

        closeDocumentUpload:
            "documentUploadBackdrop",

        cancelDocumentUpload:
            "documentUploadBackdrop",

        closeDocumentPreview:
            "documentPreviewBackdrop",

        documentPreviewCloseButton:
            "documentPreviewBackdrop"

    });


    const initializeModalControls = () => {

        Object.entries(MODAL_CLOSE_BINDINGS)
            .forEach(([buttonId, modalId]) => {

                const button = getElement(buttonId);

                if (!button) {
                    return;
                }

                button.addEventListener("click", () => {

                    closeModal(modalId);

                });

            });


        /*
         * Clicking outside an ordinary modal closes it.
         * Confirmation dialogs require an explicit choice.
         */

        document.querySelectorAll(
            ".modal-backdrop"
        ).forEach((backdrop) => {

            if (
                backdrop.id === "confirmBackdrop"
            ) {

                return;

            }

            backdrop.addEventListener(
                "click",
                (event) => {

                    if (event.target !== backdrop) {
                        return;
                    }

                    if (
                        state.activeModal === backdrop
                    ) {

                        closeModal(backdrop.id);

                    }

                }
            );

        });

    };


    /* =====================================================
       07. CONFIRMATION DIALOG
    ===================================================== */

    const confirmBackdrop = getElement(
        "confirmBackdrop"
    );

    const confirmCancel = getElement(
        "confirmCancel"
    );

    const confirmProceed = getElement(
        "confirmProceed"
    );


    const resolveConfirmation = (result) => {

        if (!state.confirmationResolver) {
            return;
        }

        const resolver = state.confirmationResolver;

        state.confirmationResolver = null;

        state.confirmationPending = false;

        if (confirmBackdrop) {

            confirmBackdrop.hidden = true;

        }

        if (confirmProceed) {

            confirmProceed.disabled = false;

        }

        if (!state.activeModal) {

            document.body.classList.remove(
                "modal-open"
            );

        }

        restoreFocus();

        resolver(Boolean(result));

    };


    const confirmAction = (options = {}) => {

        if (
            !confirmBackdrop ||
            !confirmCancel ||
            !confirmProceed
        ) {

            /*
             * Fail closed: never automatically approve
             * an action if the confirmation UI is missing.
             */

            return Promise.resolve(false);

        }

        if (
            state.confirmationResolver ||
            state.confirmationPending
        ) {

            return Promise.resolve(false);

        }

        const {

            title = "Confirm Action",

            message = "Are you sure you want to continue?",

            confirmText = "Confirm",

            cancelText = "Cancel",

            danger = false

        } = options;


        setText("confirmTitle", title);

        setText("confirmMessage", message);

        confirmProceed.textContent = confirmText;

        confirmCancel.textContent = cancelText;


        confirmProceed.classList.toggle(
            "btn-danger",
            Boolean(danger)
        );

        confirmProceed.classList.toggle(
            "btn-primary",
            !danger
        );


        state.previousFocus = document.activeElement;

        confirmBackdrop.hidden = false;

        document.body.classList.add(
            "modal-open"
        );

        state.confirmationPending = true;

        confirmCancel.focus();


        return new Promise((resolve) => {

            state.confirmationResolver = resolve;

        });

    };


    const initializeConfirmation = () => {

        confirmCancel?.addEventListener(
            "click",
            () => {

                resolveConfirmation(false);

            }
        );


        confirmProceed?.addEventListener(
            "click",
            () => {

                resolveConfirmation(true);

            }
        );

    };


    /* =====================================================
       08. KEYBOARD ACCESSIBILITY
    ===================================================== */

    const handleFocusTrap = (
        event,
        container
    ) => {

        if (
            event.key !== "Tab" ||
            !container
        ) {

            return;

        }

        const focusable = getFocusableElements(
            container
        );

        if (focusable.length === 0) {

            event.preventDefault();

            return;

        }

        const first = focusable[0];

        const last = focusable[
            focusable.length - 1
        ];


        if (
            event.shiftKey &&
            document.activeElement === first
        ) {

            event.preventDefault();

            last.focus();

        } else if (
            !event.shiftKey &&
            document.activeElement === last
        ) {

            event.preventDefault();

            first.focus();

        }

    };


    const initializeKeyboardControls = () => {

        document.addEventListener(
            "keydown",
            (event) => {

                if (
                    isModalOpen(confirmBackdrop) &&
                    state.confirmationResolver
                ) {

                    if (event.key === "Escape") {

                        event.preventDefault();

                        resolveConfirmation(false);

                        return;

                    }

                    handleFocusTrap(
                        event,
                        confirmBackdrop
                    );

                    return;

                }


                if (state.activeModal) {

                    if (event.key === "Escape") {

                        event.preventDefault();

                        closeModal(
                            state.activeModal.id
                        );

                        return;

                    }

                    handleFocusTrap(
                        event,
                        state.activeModal
                    );

                    return;

                }


                if (
                    event.key === "Escape" &&
                    state.sidebarOpen
                ) {

                    closeSidebar();

                    menuToggle?.focus();

                }

            }
        );

    };


    /* =====================================================
       09. UNIVERSAL TOAST NOTIFICATIONS
    ===================================================== */

    const toastContainer = getElement(
        "toastContainer"
    );


    const removeToast = (toast) => {

        if (!toast || !toast.isConnected) {
            return;
        }

        toast.remove();

    };


    const showToast = (
        message,
        type = "success",
        duration = CONFIG.toastDuration
    ) => {

        if (!toastContainer) {
            return null;
        }

        const allowedTypes = new Set([
            "success",
            "danger",
            "warning",
            "info"
        ]);

        const resolvedType = allowedTypes.has(type)
            ? type
            : "info";


        /*
         * Limit simultaneously displayed notifications.
         */

        while (
            toastContainer.children.length >=
            CONFIG.toastLimit
        ) {

            toastContainer.firstElementChild?.remove();

        }


        state.toastCounter += 1;

        const toast = document.createElement("div");

        toast.classList.add("toast");

        if (resolvedType === "success") {

            toast.classList.add("toast-success");

        } else if (resolvedType === "danger") {

            toast.classList.add("toast-danger");

        } else if (resolvedType === "warning") {

            toast.classList.add("toast-warning");

        }


        toast.dataset.toastId = String(
            state.toastCounter
        );

        /*
         * textContent prevents HTML injection when
         * showing messages returned by external services.
         */

        toast.textContent = String(message ?? "");

        toast.setAttribute(
            "role",
            resolvedType === "danger"
                ? "alert"
                : "status"
        );

        toastContainer.appendChild(toast);


        if (
            Number.isFinite(duration) &&
            duration > 0
        ) {

            window.setTimeout(() => {

                removeToast(toast);

            }, duration);

        }

        return toast;

    };


    /* =====================================================
       10. RESPONSIVE TABLE LABEL GENERATOR
    ===================================================== */

    const normalizeTableLabel = (value) => {

        return String(value ?? "")
            .replace(/\s+/g, " ")
            .trim();

    };


    const applyTableLabels = (table) => {

        if (
            !(table instanceof HTMLTableElement)
        ) {

            return;

        }

        const headings = Array.from(
            table.querySelectorAll(
                ":scope > thead > tr:last-child > th"
            )
        ).map((heading) => {

            return normalizeTableLabel(
                heading.textContent
            );

        });


        /*
         * Tables with multi-row or dynamically merged
         * headings may provide explicit data-label
         * attributes through their module JavaScript.
         */

        if (headings.length === 0) {
            return;
        }


        const rows = table.querySelectorAll(
            ":scope > tbody > tr"
        );


        rows.forEach((row) => {

            const cells = Array.from(
                row.children
            ).filter((element) => {

                return element.tagName === "TD";

            });


            let headingIndex = 0;


            cells.forEach((cell) => {

                /*
                 * An empty-state colspan cell must
                 * never be converted into a labelled
                 * mobile data row.
                 */

                if (cell.hasAttribute("colspan")) {

                    const span = Number(
                        cell.getAttribute("colspan")
                    );

                    headingIndex += (
                        Number.isFinite(span) && span > 0
                            ? span
                            : 1
                    );

                    return;

                }


                if (!cell.hasAttribute("data-label")) {

                    cell.setAttribute(
                        "data-label",
                        headings[headingIndex] ?? ""
                    );

                }

                headingIndex += 1;

            });

        });

    };


    const refreshTableLabels = (
        scope = document
    ) => {

        if (
            scope instanceof HTMLTableElement
        ) {

            applyTableLabels(scope);

            return;

        }

        if (
            !scope ||
            typeof scope.querySelectorAll !== "function"
        ) {

            return;

        }

        scope.querySelectorAll(
            ".data-table"
        ).forEach(applyTableLabels);

    };


    const initializeResponsiveTables = () => {

        refreshTableLabels();


        /*
         * Firebase-driven modules will add or replace
         * table rows after their asynchronous queries.
         *
         * Observe structural changes only, avoiding
         * mutation loops from data-label updates.
         */

        state.tableObserver = new MutationObserver(
            (mutations) => {

                const affectedTables = new Set();


                mutations.forEach((mutation) => {

                    const target = mutation.target;

                    if (!(target instanceof Element)) {
                        return;
                    }

                    const parentTable = target.closest(
                        "table.data-table"
                    );

                    if (parentTable) {

                        affectedTables.add(parentTable);

                    }


                    mutation.addedNodes.forEach((node) => {

                        if (!(node instanceof Element)) {
                            return;
                        }

                        if (
                            node.matches(
                                "table.data-table"
                            )
                        ) {

                            affectedTables.add(node);

                        }

                        node.querySelectorAll?.(
                            "table.data-table"
                        ).forEach((table) => {

                            affectedTables.add(table);

                        });

                    });

                });


                affectedTables.forEach(
                    applyTableLabels
                );

            }
        );


        state.tableObserver.observe(
            document.body,
            {

                childList: true,

                subtree: true

            }
        );

    };


    /* =====================================================
       11. FULL-PAGE VIEW MANAGEMENT
    ===================================================== */

    const FULLPAGE_BINDINGS = Object.freeze({

        exitEmployeeFullpage:
            "employeeFullpageView",

        exitLeaveFullpage:
            "leaveFullpageView",

        exitPayrollFullpage:
            "payrollFullpageView",

        exitPayslipFullpage:
            "payslipFullpageView",

        exitReportFullpage:
            "reportFullpageView"

    });


    const closeFullpage = (viewId) => {

        const view = getElement(viewId);

        if (!view) {
            return false;
        }

        view.hidden = true;

        document.dispatchEvent(
            new CustomEvent("ems:fullpage-closed", {

                detail: {
                    viewId
                }

            })
        );

        return true;

    };


    const openFullpage = (viewId) => {

        const view = getElement(viewId);

        if (!view) {
            return false;
        }

        /*
         * A module must first retrieve and render
         * authorised information before opening
         * the full-page view.
         */

        view.hidden = false;

        document.dispatchEvent(
            new CustomEvent("ems:fullpage-opened", {

                detail: {
                    viewId
                }

            })
        );

        return true;

    };


    const initializeFullpageControls = () => {

        Object.entries(FULLPAGE_BINDINGS)
            .forEach(([buttonId, viewId]) => {

                getElement(buttonId)?.addEventListener(
                    "click",
                    () => {

                        closeFullpage(viewId);

                    }
                );

            });

    };


    /* =====================================================
       12. LOGOUT INTEGRATION
    ===================================================== */

    const initializeLogout = () => {

        const logoutButton = getElement(
            "logoutButton"
        );

        if (!logoutButton) {
            return;
        }


        logoutButton.addEventListener(
            "click",
            async () => {

                const confirmed = await confirmAction({

                    title: "Confirm Logout",

                    message:
                        "Are you sure you want to log out of your account?",

                    confirmText: "Logout",

                    cancelText: "Stay Logged In",

                    danger: false

                });


                if (!confirmed) {
                    return;
                }


                /*
                 * Authentication must be implemented by
                 * js/auth.js.
                 *
                 * Never simulate a successful logout by
                 * merely changing the browser URL.
                 */

                const auth = window.EMSAuth;

                if (
                    !auth ||
                    typeof auth.logout !== "function"
                ) {

                    showToast(
                        "Authentication service is unavailable.",
                        "danger"
                    );

                    return;

                }


                logoutButton.disabled = true;


                try {

                    await auth.logout();

                    /*
                     * Successful logout navigation and
                     * session invalidation belong to
                     * the authentication controller.
                     */

                } catch (error) {

                    console.error(
                        "Logout operation failed."
                    );

                    showToast(
                        "Unable to complete logout. Please try again.",
                        "danger"
                    );

                } finally {

                    logoutButton.disabled = false;

                }

            }
        );

    };


    /* =====================================================
       13. SHARED NOTIFICATION BUTTON
    ===================================================== */

    const initializeNotifications = () => {

        const notificationButton = getElement(
            "notificationButton"
        );

        notificationButton?.addEventListener(
            "click",
            () => {

                /*
                 * The authenticated notification module
                 * will listen for this event.
                 *
                 * No fake notification data is created.
                 */

                document.dispatchEvent(
                    new CustomEvent(
                        "ems:notifications-requested"
                    )
                );

            }
        );

    };


    /* =====================================================
       14. INITIALIZATION
    ===================================================== */

    const initializeApplicationUI = () => {

        initializeSidebar();

        initializeModalControls();

        initializeConfirmation();

        initializeKeyboardControls();

        initializeResponsiveTables();

        initializeFullpageControls();

        initializeLogout();

        initializeNotifications();

        document.dispatchEvent(
            new CustomEvent("ems:ui-ready")
        );

    };


    /* =====================================================
       15. PUBLIC UNIVERSAL INTERFACE API
    ===================================================== */

    /*
     * Individual module scripts can call these methods.
     *
     * Examples:
     *
     * EMSUI.openModal("employeeFormBackdrop");
     *
     * EMSUI.showToast(
     *     "Record saved successfully.",
     *     "success"
     * );
     *
     * const approved = await EMSUI.confirm({
     *     title: "Confirm Action",
     *     message: "Proceed with this operation?"
     * });
     *
     * These are UI examples, not demo records,
     * credentials or authentication shortcuts.
     */

    window.EMSUI = Object.freeze({

        getElement,

        setText,

        openModal,

        closeModal,

        confirm: confirmAction,

        showToast,

        openSidebar,

        closeSidebar,

        toggleSidebar,

        refreshTableLabels,

        openFullpage,

        closeFullpage

    });


    /* =====================================================
       16. START APPLICATION UI
    ===================================================== */

    if (
        document.readyState === "loading"
    ) {

        document.addEventListener(
            "DOMContentLoaded",
            initializeApplicationUI,
            {
                once: true
            }
        );

    } else {

        initializeApplicationUI();

    }

})();

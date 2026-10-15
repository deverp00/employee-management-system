/* =========================================================
   EMPLOYEE MANAGEMENT & PAYROLL SYSTEM
   FILE: js/faq.js

   PURPOSE:
   Dynamic FAQ and Help Centre controller.

   SECURITY:
   - Authenticated backend requests.
   - Server-enforced permissions.
   - No hardcoded FAQ records.
   - No unsafe innerHTML rendering.
   - Drafts restricted to authorised administrators.
   - Published content remains versioned.
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

        searchDelay: 300,

        endpoints: {

            access: "/faq/access",

            list: "/faq",

            categories: "/faq/categories",

            create: "/faq"

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

        categories: [],

        totalRecords: 0,

        currentPage: 1,

        loading: false,

        saving: false,

        requestSequence: 0,

        searchTimer: null,

        editingId: null,

        editingRevision: null,

        filters: {

            search: "",

            category: "",

            status: ""

        }

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
                value ?? ""
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


    /* =====================================================
       04. BACKEND REQUEST
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


    const faqEndpoint = (
        id,
        suffix = ""
    ) => {

        if (
            typeof id !== "string" ||
            !id.trim()
        ) {

            throw new Error(
                "Invalid FAQ identifier."
            );

        }

        return (
            "/faq/" +
            encodeURIComponent(id) +
            suffix
        );

    };


    /* =====================================================
       05. PERMISSIONS
    ===================================================== */

    const hasPermission = (permission) => {

        return state.permissions[permission] === true;

    };


    const requirePermission = (permission) => {

        if (!hasPermission(permission)) {

            throw new Error(
                "This FAQ operation is not authorised."
            );

        }

    };


    const applyPermissions = () => {

        document.querySelectorAll(
            "[data-faq-permission]"
        ).forEach((element) => {

            const permission =
                element.dataset.faqPermission;

            element.hidden = !hasPermission(
                permission
            );

        });

        const statusFilter = get(
            "faqStatusFilter"
        );

        if (statusFilter) {

            statusFilter.hidden =
                !hasPermission("manageFAQ");

        }

    };


    const loadPermissions = async () => {

        /*
         * GET /faq/access
         *
         * The backend derives actual permissions
         * from the verified Firebase session.
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
                "FAQ permission verification failed."
            );

        }

        const permissions = response.permissions;

        state.permissions = Object.freeze({

            viewFAQ:
                permissions.viewFAQ === true,

            manageFAQ:
                permissions.manageFAQ === true,

            publishFAQ:
                permissions.publishFAQ === true,

            archiveFAQ:
                permissions.archiveFAQ === true

        });

        applyPermissions();

    };


    /* =====================================================
       06. LOADING / ERROR
    ===================================================== */

    const setLoading = (loading) => {

        state.loading = loading;

        setVisible(
            "faqLoading",
            loading
        );

        get("faqList")?.setAttribute(
            "aria-busy",
            String(loading)
        );

        const refreshButton = get(
            "refreshFAQ"
        );

        if (refreshButton) {

            refreshButton.disabled = loading;

        }

    };


    const showError = (message) => {

        const element = get(
            "faqError"
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
            "faqError"
        );

        if (element) {

            element.textContent = "";

            element.hidden = true;

        }

    };


    /* =====================================================
       07. CATEGORIES
    ===================================================== */

    const populateSelect = (
        select,
        placeholder
    ) => {

        if (!select) {
            return;
        }

        const previous = select.value;

        const fragment =
            document.createDocumentFragment();

        fragment.appendChild(

            new Option(
                placeholder,
                ""
            )

        );

        state.categories.forEach((category) => {

            if (
                !category ||
                typeof category.id !== "string" ||
                !category.id.trim()
            ) {

                return;

            }

            fragment.appendChild(

                new Option(

                    String(
                        category.name || category.id
                    ),

                    category.id

                )

            );

        });

        select.replaceChildren(fragment);

        if (
            Array.from(select.options).some(
                (option) => option.value === previous
            )
        ) {

            select.value = previous;

        }

    };


    const loadCategories = async () => {

        /*
         * GET /faq/categories
         *
         * Only backend-authorised category data
         * will be returned.
         */

        const response = await request(
            CONFIG.endpoints.categories
        );

        if (
            !response ||
            !Array.isArray(response.items)
        ) {

            throw new Error(
                "FAQ categories are unavailable."
            );

        }

        state.categories = response.items;

        populateSelect(
            get("faqCategoryFilter"),
            "All Categories"
        );

        populateSelect(
            get("faqCategory"),
            "Select Category"
        );

    };


    /* =====================================================
       08. FILTER MANAGEMENT
    ===================================================== */

    const readFilters = () => {

        state.filters.search =
            get("faqSearch")?.value.trim() || "";

        state.filters.category =
            get("faqCategoryFilter")?.value || "";

        state.filters.status =
            hasPermission("manageFAQ")
                ? get("faqStatusFilter")?.value || ""
                : "published";

    };


    const buildQuery = () => {

        const parameters = new URLSearchParams({

            page: String(state.currentPage),

            limit: String(CONFIG.pageSize)

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

        [

            "faqSearch",

            "faqCategoryFilter",

            "faqStatusFilter"

        ].forEach((id) => {

            const element = get(id);

            if (element) {

                element.value = "";

            }

        });

        readFilters();

        state.currentPage = 1;

        loadFAQ();

    };


    /* =====================================================
       09. FAQ ACCORDION
    ===================================================== */

    const createActionButton = (
        label,
        action,
        id
    ) => {

        const button = create(
            "button",
            label,
            "btn btn-secondary btn-sm"
        );

        button.type = "button";

        button.dataset.faqAction = action;

        button.dataset.faqId = id;

        return button;

    };


    const createFAQItem = (record) => {

        const wrapper = create(
            "article",
            "",
            "faq-item"
        );

        const faqId = String(
            record.id ?? ""
        );

        const heading = document.createElement(
            "h3"
        );

        heading.className = "faq-question";

        const toggle = create(

            "button",

            record.question || "Untitled Question",

            "faq-toggle"

        );

        toggle.type = "button";

        toggle.setAttribute(
            "aria-expanded",
            "false"
        );

        toggle.dataset.faqAction = "toggle";

        toggle.dataset.faqId = faqId;

        const answerId = (
            "faq-answer-" +
            encodeURIComponent(faqId)
                .replace(/%/g, "-")
        );

        toggle.setAttribute(
            "aria-controls",
            answerId
        );

        heading.appendChild(toggle);

        const answer = create(

            "div",

            "",

            "faq-answer"

        );

        answer.id = answerId;

        answer.hidden = true;

        /*
         * FAQ text is rendered as plain text.
         * This prevents stored HTML/script injection.
         *
         * CSS white-space: pre-line can preserve
         * paragraph line breaks during integration.
         */

        const answerText = create(

            "p",

            record.answer || ""

        );

        answer.appendChild(answerText);

        wrapper.append(
            heading,
            answer
        );

        if (
            hasPermission("manageFAQ") &&
            faqId
        ) {

            const actions = create(
                "div",
                "",
                "faq-actions"
            );

            const status = create(

                "span",

                String(record.status || "Unknown"),

                "badge"

            );

            actions.appendChild(status);

            actions.appendChild(

                createActionButton(
                    "Edit",
                    "edit",
                    faqId
                )

            );

            if (
                record.status === "draft" &&
                record.canPublish === true &&
                hasPermission("publishFAQ")
            ) {

                actions.appendChild(

                    createActionButton(
                        "Publish",
                        "publish",
                        faqId
                    )

                );

            }

            if (
                record.status !== "archived" &&
                record.canArchive === true &&
                hasPermission("archiveFAQ")
            ) {

                actions.appendChild(

                    createActionButton(
                        "Archive",
                        "archive",
                        faqId
                    )

                );

            }

            wrapper.appendChild(actions);

        }

        return wrapper;

    };


    const renderEmpty = (message) => {

        const container = get(
            "faqList"
        );

        if (!container) {
            return;
        }

        container.replaceChildren(

            create(
                "p",
                message,
                "empty-state"
            )

        );

    };


    const renderFAQ = () => {

        const container = get(
            "faqList"
        );

        if (!container) {
            return;
        }

        if (!state.records.length) {

            renderEmpty(
                "No FAQ entries found."
            );

            return;

        }

        const fragment =
            document.createDocumentFragment();

        state.records.forEach((record) => {

            if (
                record &&
                typeof record === "object"
            ) {

                fragment.appendChild(
                    createFAQItem(record)
                );

            }

        });

        container.replaceChildren(fragment);

    };


    /* =====================================================
       10. PAGINATION
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

        const formatter = new Intl.NumberFormat(
            "en-IN"
        );

        setText(

            "faqPaginationInfo",

            `${formatter.format(start)}–${formatter.format(end)} of ${formatter.format(state.totalRecords)}`

        );

        setText(

            "faqCurrentPage",

            `${state.currentPage} / ${totalPages}`

        );

        const previous = get(
            "faqPreviousPage"
        );

        const next = get(
            "faqNextPage"
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

        loadFAQ();

    };


    /* =====================================================
       11. FETCH FAQ RECORDS
    ===================================================== */

    const loadFAQ = async () => {

        const requestId =
            ++state.requestSequence;

        setLoading(true);

        clearError();

        try {

            /*
             * GET /faq?page=...&limit=...
             *
             * Backend requirements:
             *
             * Employees:
             * Published, authorised FAQs only.
             *
             * Super Admin:
             * Published/draft/archived records
             * according to granted permissions.
             *
             * Client filter values must never
             * override backend visibility rules.
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
                    "Invalid FAQ listing response."
                );

            }

            state.records = response.items;

            state.totalRecords = response.total;

            renderFAQ();

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
                "Unable to load FAQ information."
            );

            renderPagination();

            showError(
                "FAQ information could not be loaded."
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
       12. FAQ FORM
    ===================================================== */

    const resetForm = () => {

        get("faqForm")?.reset();

        state.editingId = null;

        state.editingRevision = null;

        setText(
            "faqFormTitle",
            "Add FAQ"
        );

        setText(
            "saveFAQ",
            "Save Draft"
        );

    };


    const openAddFAQ = () => {

        try {

            requirePermission("manageFAQ");

        } catch {

            notify(
                "FAQ management is not authorised.",
                "danger"
            );

            return;

        }

        resetForm();

        window.EMSUI?.openModal(
            "faqFormBackdrop"
        );

    };


    const openEditFAQ = async (faqId) => {

        try {

            requirePermission("manageFAQ");

            /*
             * Fetch the authoritative record rather
             * than trusting stale list information.
             */

            const record = await request(
                faqEndpoint(faqId)
            );

            if (
                !record ||
                String(record.id) !== faqId ||
                typeof record.revision !== "string"
            ) {

                throw new Error(
                    "FAQ record is unavailable."
                );

            }

            resetForm();

            state.editingId = faqId;

            state.editingRevision =
                record.revision;

            const question = get(
                "faqQuestion"
            );

            const answer = get(
                "faqAnswer"
            );

            const category = get(
                "faqCategory"
            );

            if (question) {

                question.value =
                    String(record.question || "");

            }

            if (answer) {

                answer.value =
                    String(record.answer || "");

            }

            if (category) {

                category.value =
                    String(record.categoryId || "");

            }

            setText(
                "faqFormTitle",
                "Edit FAQ"
            );

            setText(
                "saveFAQ",
                "Save Changes"
            );

            window.EMSUI?.openModal(
                "faqFormBackdrop"
            );

        } catch {

            notify(
                "Unable to open the FAQ record.",
                "danger"
            );

        }

    };


    /* =====================================================
       13. SAVE FAQ
    ===================================================== */

    const saveFAQ = async (event) => {

        event.preventDefault();

        if (state.saving) {
            return;
        }

        try {

            requirePermission("manageFAQ");

        } catch {

            notify(
                "FAQ editing is not authorised.",
                "danger"
            );

            return;

        }

        const form = get(
            "faqForm"
        );

        if (
            form &&
            !form.reportValidity()
        ) {

            return;

        }

        const payload = {

            question:
                get("faqQuestion")?.value.trim() || "",

            answer:
                get("faqAnswer")?.value.trim() || "",

            categoryId:
                get("faqCategory")?.value || ""

        };

        if (
            !payload.question ||
            !payload.answer ||
            !payload.categoryId
        ) {

            notify(
                "Complete all required FAQ fields.",
                "warning"
            );

            return;

        }

        const validCategory =
            state.categories.some((category) => {

                return (
                    category.id === payload.categoryId
                );

            });

        if (!validCategory) {

            notify(
                "Select a valid FAQ category.",
                "warning"
            );

            return;

        }

        state.saving = true;

        const saveButton = get(
            "saveFAQ"
        );

        if (saveButton) {

            saveButton.disabled = true;

        }

        try {

            const editing =
                Boolean(state.editingId);

            /*
             * POST /faq
             * PATCH /faq/:id
             *
             * Newly created FAQs start as drafts.
             *
             * Editing a published FAQ must create
             * a new draft revision rather than
             * silently modifying the published text.
             *
             * Backend handles:
             * - Permission verification
             * - Input validation
             * - Revision conflicts
             * - Content versioning
             * - Audit history
             */

            await request(

                editing
                    ? faqEndpoint(state.editingId)
                    : CONFIG.endpoints.create,

                {

                    method: editing
                        ? "PATCH"
                        : "POST",

                    body: editing
                        ? {
                            ...payload,

                            expectedRevision:
                                state.editingRevision
                        }
                        : payload

                }

            );

            window.EMSUI?.closeModal(
                "faqFormBackdrop"
            );

            resetForm();

            notify(

                editing
                    ? "FAQ changes saved successfully."
                    : "FAQ draft created successfully."

            );

            state.currentPage = 1;

            await loadFAQ();

        } catch {

            notify(
                "Unable to save the FAQ. Reload the record if another administrator has updated it.",
                "danger"
            );

        } finally {

            state.saving = false;

            if (saveButton) {

                saveButton.disabled = false;

            }

        }

    };


    /* =====================================================
       14. PUBLISH FAQ
    ===================================================== */

    const publishFAQ = async (faqId) => {

        if (state.saving) {
            return;
        }

        try {

            requirePermission("publishFAQ");

        } catch {

            notify(
                "FAQ publishing is not authorised.",
                "danger"
            );

            return;

        }

        const record = state.records.find(
            (item) => String(item.id) === faqId
        );

        if (
            !record ||
            record.status !== "draft" ||
            record.canPublish !== true ||
            typeof record.revision !== "string"
        ) {

            notify(
                "This FAQ is not available for publishing.",
                "warning"
            );

            return;

        }

        const confirmed =
            await window.EMSUI.confirm({

                title: "Publish FAQ",

                message:
                    "Publish this FAQ version? Authorised users will be able to see its published content.",

                confirmText: "Publish",

                cancelText: "Cancel"

            });

        if (!confirmed) {
            return;
        }

        state.saving = true;

        try {

            /*
             * POST /faq/:id/publish
             *
             * Backend must verify the current
             * revision and publication permission.
             */

            await request(

                faqEndpoint(
                    faqId,
                    "/publish"
                ),

                {

                    method: "POST",

                    body: {

                        expectedRevision:
                            record.revision

                    }

                }

            );

            notify(
                "FAQ published successfully."
            );

            await loadFAQ();

        } catch {

            notify(
                "Unable to publish this FAQ. Its revision may have changed.",
                "danger"
            );

        } finally {

            state.saving = false;

        }

    };


    /* =====================================================
       15. ARCHIVE FAQ
    ===================================================== */

    const archiveFAQ = async (faqId) => {

        if (state.saving) {
            return;
        }

        try {

            requirePermission("archiveFAQ");

        } catch {

            notify(
                "FAQ archiving is not authorised.",
                "danger"
            );

            return;

        }

        const record = state.records.find(
            (item) => String(item.id) === faqId
        );

        if (
            !record ||
            record.canArchive !== true ||
            typeof record.revision !== "string"
        ) {

            notify(
                "This FAQ cannot be archived.",
                "warning"
            );

            return;

        }

        const confirmed =
            await window.EMSUI.confirm({

                title: "Archive FAQ",

                message:
                    "Archive this FAQ? It will be removed from the published Help Centre, but its version history will be preserved.",

                confirmText: "Archive",

                cancelText: "Cancel",

                danger: true

            });

        if (!confirmed) {
            return;
        }

        state.saving = true;

        try {

            await request(

                faqEndpoint(
                    faqId,
                    "/archive"
                ),

                {

                    method: "POST",

                    body: {

                        expectedRevision:
                            record.revision

                    }

                }

            );

            notify(
                "FAQ archived successfully."
            );

            await loadFAQ();

        } catch {

            notify(
                "Unable to archive this FAQ.",
                "danger"
            );

        } finally {

            state.saving = false;

        }

    };


    /* =====================================================
       16. ACCORDION INTERACTION
    ===================================================== */

    const toggleFAQ = (button) => {

        const answerId = button.getAttribute(
            "aria-controls"
        );

        if (!answerId) {
            return;
        }

        const answer = get(
            answerId
        );

        if (!answer) {
            return;
        }

        const currentlyExpanded =
            button.getAttribute("aria-expanded") ===
            "true";

        const nextExpanded =
            !currentlyExpanded;

        button.setAttribute(
            "aria-expanded",
            String(nextExpanded)
        );

        answer.hidden = !nextExpanded;

        button.closest(".faq-item")
            ?.classList.toggle(
                "active",
                nextExpanded
            );

    };


    /* =====================================================
       17. REFRESH
    ===================================================== */

    const refresh = async () => {

        if (state.saving) {
            return;
        }

        await Promise.allSettled([

            loadCategories(),

            loadFAQ()

        ]);

    };


    /* =====================================================
       18. EVENT LISTENERS
    ===================================================== */

    const initializeEvents = () => {

        get("faqSearch")?.addEventListener(
            "input",
            () => {

                window.clearTimeout(
                    state.searchTimer
                );

                state.searchTimer = window.setTimeout(
                    () => {

                        readFilters();

                        state.currentPage = 1;

                        loadFAQ();

                    },
                    CONFIG.searchDelay
                );

            }
        );

        [

            "faqCategoryFilter",

            "faqStatusFilter"

        ].forEach((id) => {

            get(id)?.addEventListener(
                "change",
                () => {

                    readFilters();

                    state.currentPage = 1;

                    loadFAQ();

                }
            );

        });

        get("resetFAQFilters")?.addEventListener(
            "click",
            resetFilters
        );

        get("refreshFAQ")?.addEventListener(
            "click",
            refresh
        );

        get("faqPreviousPage")?.addEventListener(
            "click",
            () => changePage(-1)
        );

        get("faqNextPage")?.addEventListener(
            "click",
            () => changePage(1)
        );

        get("addFAQButton")?.addEventListener(
            "click",
            openAddFAQ
        );

        get("faqForm")?.addEventListener(
            "submit",
            saveFAQ
        );

        get("faqList")?.addEventListener(
            "click",
            async (event) => {

                const button = event.target.closest(
                    "[data-faq-action]"
                );

                if (
                    !button ||
                    state.saving
                ) {

                    return;

                }

                const action =
                    button.dataset.faqAction;

                const faqId =
                    button.dataset.faqId;

                switch (action) {

                    case "toggle":

                        toggleFAQ(button);

                        break;

                    case "edit":

                        if (faqId) {

                            await openEditFAQ(faqId);

                        }

                        break;

                    case "publish":

                        if (faqId) {

                            await publishFAQ(faqId);

                        }

                        break;

                    case "archive":

                        if (faqId) {

                            await archiveFAQ(faqId);

                        }

                        break;

                    default:

                        break;

                }

            }
        );

    };


    /* =====================================================
       19. INITIALIZATION
    ===================================================== */

    const initialize = async () => {

        if (state.initialized) {
            return;
        }

        state.initialized = true;

        setLoading(true);

        setVisible(
            "faqContent",
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

            if (!hasPermission("viewFAQ")) {

                throw new Error(
                    "FAQ access is restricted."
                );

            }

            initializeEvents();

            await loadCategories();

            readFilters();

            setVisible(
                "faqContent",
                true
            );

            await loadFAQ();

        } catch {

            state.permissions = {};

            applyPermissions();

            setVisible(
                "faqContent",
                false
            );

            showError(
                "Unable to verify Help Centre access."
            );

        } finally {

            setLoading(false);

        }

    };


    /* =====================================================
       20. PUBLIC MODULE INTERFACE
    ===================================================== */

    window.EMSFAQ = Object.freeze({

        initialize,

        refresh,

        openAdd: openAddFAQ,

        openEdit: openEditFAQ,

        getContext: () => state.context

    });


    /* =====================================================
       21. START
    ===================================================== */

    const start = () => {

        if (
            document.body.dataset.page !== "faq"
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

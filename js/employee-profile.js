/* ========================================================
   EMPLOYEE MANAGEMENT & PAYROLL SYSTEM
   FILE: js/employee-profile.js

   PURPOSE:
   Secure employee profile management.

   SECURITY:
   - No demo records.
   - No hardcoded employee UID.
   - No client-side permission assignment.
   - Backend validates record ownership.
   - Document access requires authorization.
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

        managementRoles: [
            "super_admin",
            "hr_admin"
        ],

        pageSize: 10,

        maxDocumentSize: 10 * 1024 * 1024,

        allowedDocumentTypes: [
            "application/pdf",
            "image/jpeg",
            "image/png",
            "image/webp"
        ]

    });


    /* =====================================================
       02. STATE
    ===================================================== */

    const state = {

        initialized: false,

        context: null,

        employeeId: null,

        profile: null,

        permissions: {},

        loading: false,

        saving: false,

        requestSequence: 0,

        documentUpload: null,

        pagination: {

            attendance: 1,

            leave: 1,

            payslips: 1,

            documents: 1

        }

    };


    /* =====================================================
       03. DOM HELPERS
    ===================================================== */

    const get = (id) => document.getElementById(id);


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


    const notify = (
        message,
        type = "success"
    ) => {

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

        return new Intl.NumberFormat(
            "en-IN",
            {

                style: "currency",

                currency: "INR"

            }
        ).format(number);

    };


    /* =====================================================
       05. EMPLOYEE IDENTIFIER
    ===================================================== */

    const readEmployeeId = () => {

        const parameters = new URLSearchParams(
            window.location.search
        );

        const employeeId = parameters.get("id");

        if (!employeeId || !employeeId.trim()) {

            return null;

        }

        return employeeId.trim();

    };


    const employeeEndpoint = (suffix = "") => {

        if (!state.employeeId) {

            throw new Error(
                "Employee identifier is unavailable."
            );

        }

        return (
            "/employees/" +
            encodeURIComponent(state.employeeId) +
            suffix
        );

    };


    /* =====================================================
       06. AUTHENTICATED REQUEST
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
       07. PERMISSION HELPERS
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
            "[data-profile-permission]"
        ).forEach((element) => {

            const permission =
                element.dataset.profilePermission;

            element.hidden = !hasPermission(
                permission
            );

        });

    };


    /* =====================================================
       08. LOADING AND ERROR STATES
    ===================================================== */

    const setLoading = (loading) => {

        state.loading = loading;

        setVisible(
            "profileLoading",
            loading
        );

        get("employeeProfileContent")?.setAttribute(
            "aria-busy",
            String(loading)
        );

    };


    const showError = (message) => {

        const element = get("profileError");

        if (element) {

            element.textContent = message;

            element.hidden = false;

        } else {

            notify(message, "danger");

        }

    };


    const clearError = () => {

        const element = get("profileError");

        if (element) {

            element.textContent = "";

            element.hidden = true;

        }

    };


    /* =====================================================
       09. PROFILE DETAILS
    ===================================================== */

    const PROFILE_FIELDS = Object.freeze({

        profileEmployeeCode: "employeeCode",

        profileFullName: "fullName",

        profileEmail: "email",

        profilePhone: "phone",

        profileDepartment: "departmentName",

        profileDesignation: "designationName",

        profileEmploymentType: "employmentType",

        profileStatus: "status",

        profileAddress: "address",

        profileEmergencyContact: "emergencyContact"

    });


    const renderProfile = (profile) => {

        Object.entries(PROFILE_FIELDS)
            .forEach(([elementId, field]) => {

                setText(
                    elementId,
                    profile[field]
                );

            });


        setText(
            "profileJoiningDate",
            formatDate(profile.joiningDate)
        );

        setText(
            "profileDateOfBirth",
            formatDate(profile.dateOfBirth)
        );


        const avatar = get("profileAvatar");

        if (avatar) {

            /*
             * Only an authorised image URL returned
             * by the backend may be displayed.
             */

            if (
                typeof profile.photoUrl === "string" &&
                profile.photoUrl.startsWith("https://")
            ) {

                avatar.src = profile.photoUrl;

                avatar.alt = (
                    profile.fullName || "Employee"
                ) + " profile photograph";

                avatar.hidden = false;

            } else {

                avatar.removeAttribute("src");

                avatar.hidden = true;

            }

        }


        const dynamicContainer = get(
            "profileAdditionalFields"
        );

        if (dynamicContainer) {

            dynamicContainer.replaceChildren();

            const fields = profile.additionalFields;

            if (
                fields &&
                typeof fields === "object" &&
                !Array.isArray(fields)
            ) {

                Object.entries(fields)
                    .forEach(([label, value]) => {

                        const item = create(
                            "div",
                            "",
                            "form-group"
                        );

                        const heading = create(
                            "span",
                            label,
                            "form-label"
                        );

                        const content = create(
                            "p",
                            value ?? "—"
                        );

                        item.append(
                            heading,
                            content
                        );

                        dynamicContainer.appendChild(
                            item
                        );

                    });

            }

        }

    };


    /* =====================================================
       10. GENERIC HISTORY TABLE
    ===================================================== */

    const renderTable = (
        bodyId,
        records,
        columns,
        emptyMessage,
        actionRenderer = null
    ) => {

        const tbody = get(bodyId);

        if (!tbody) {
            return;
        }

        tbody.replaceChildren();

        const table = tbody.closest("table");

        const columnCount =
            table?.querySelectorAll("thead th").length ||
            columns.length;


        if (
            !Array.isArray(records) ||
            records.length === 0
        ) {

            const row = document.createElement("tr");

            const cell = create(
                "td",
                emptyMessage
            );

            cell.colSpan = columnCount;

            row.appendChild(cell);

            tbody.appendChild(row);

            return;

        }


        const fragment = document.createDocumentFragment();


        records.forEach((record) => {

            if (
                !record ||
                typeof record !== "object"
            ) {

                return;

            }

            const row = document.createElement("tr");


            columns.forEach((column) => {

                const value = column.formatter
                    ? column.formatter(
                        record[column.key]
                    )
                    : record[column.key];

                appendCell(
                    row,
                    value,
                    column.label
                );

            });


            if (typeof actionRenderer === "function") {

                actionRenderer(row, record);

            }

            fragment.appendChild(row);

        });


        tbody.appendChild(fragment);

        window.EMSUI?.refreshTableLabels(table);

    };


    /* =====================================================
       11. ATTENDANCE HISTORY
    ===================================================== */

    const renderAttendance = (records) => {

        renderTable(

            "profileAttendanceBody",

            records,

            [

                {
                    key: "date",
                    label: "Date",
                    formatter: formatDate
                },

                {
                    key: "checkIn",
                    label: "Check In"
                },

                {
                    key: "checkOut",
                    label: "Check Out"
                },

                {
                    key: "status",
                    label: "Status"
                }

            ],

            "No attendance records available."

        );

    };


    /* =====================================================
       12. LEAVE HISTORY
    ===================================================== */

    const renderLeave = (records) => {

        renderTable(

            "profileLeaveBody",

            records,

            [

                {
                    key: "leaveType",
                    label: "Leave Type"
                },

                {
                    key: "startDate",
                    label: "Start Date",
                    formatter: formatDate
                },

                {
                    key: "endDate",
                    label: "End Date",
                    formatter: formatDate
                },

                {
                    key: "status",
                    label: "Status"
                }

            ],

            "No leave records available."

        );

    };


    /* =====================================================
       13. PAYSLIP HISTORY
    ===================================================== */

    const renderPayslips = (records) => {

        renderTable(

            "profilePayslipsBody",

            records,

            [

                {
                    key: "period",
                    label: "Period"
                },

                {
                    key: "grossPay",
                    label: "Gross Pay",
                    formatter: formatCurrency
                },

                {
                    key: "netPay",
                    label: "Net Pay",
                    formatter: formatCurrency
                },

                {
                    key: "status",
                    label: "Status"
                }

            ],

            "No payslips available.",

            (row, record) => {

                const cell = document.createElement("td");

                cell.dataset.label = "Actions";

                const button = create(
                    "button",
                    "View",
                    "btn btn-secondary btn-sm"
                );

                button.type = "button";

                button.dataset.profileAction =
                    "view-payslip";

                button.dataset.recordId =
                    String(record.id ?? "");

                cell.appendChild(button);

                row.appendChild(cell);

            }

        );

    };


    /* =====================================================
       14. DOCUMENT HISTORY
    ===================================================== */

    const renderDocuments = (records) => {

        renderTable(

            "profileDocumentsBody",

            records,

            [

                {
                    key: "name",
                    label: "Document"
                },

                {
                    key: "category",
                    label: "Category"
                },

                {
                    key: "uploadedAt",
                    label: "Uploaded",
                    formatter: formatDate
                }

            ],

            "No documents available.",

            (row, record) => {

                const cell = document.createElement("td");

                cell.dataset.label = "Actions";

                const button = create(
                    "button",
                    "View",
                    "btn btn-secondary btn-sm"
                );

                button.type = "button";

                button.dataset.profileAction =
                    "view-document";

                button.dataset.recordId =
                    String(record.id ?? "");

                cell.appendChild(button);

                row.appendChild(cell);

            }

        );

    };


    /* =====================================================
       15. LOAD PROFILE
    ===================================================== */

    const loadProfile = async () => {

        const sequence = ++state.requestSequence;

        setLoading(true);

        clearError();

        try {

            /*
             * Backend contract:
             *
             * GET /employees/:id/profile
             *
             * Response:
             * {
             *   profile: {},
             *   permissions: {
             *     edit: boolean,
             *     uploadDocument: boolean,
             *     viewDocuments: boolean,
             *     viewPayroll: boolean
             *   }
             * }
             *
             * Backend must validate ownership,
             * permissions and field-level visibility.
             */

            const response = await request(
                employeeEndpoint("/profile")
            );


            if (
                sequence !== state.requestSequence
            ) {

                return;

            }


            if (
                !response ||
                !response.profile ||
                typeof response.profile !== "object"
            ) {

                throw new Error(
                    "Invalid employee profile response."
                );

            }


            state.profile = response.profile;

            state.permissions =
                response.permissions &&
                typeof response.permissions === "object"
                    ? response.permissions
                    : {};


            renderProfile(state.profile);

            applyPermissions();

            setVisible(
                "employeeProfileContent",
                true
            );

        } catch {

            state.profile = null;

            state.permissions = {};

            setVisible(
                "employeeProfileContent",
                false
            );

            showError(
                "Unable to load this employee profile. Access may be restricted."
            );

        } finally {

            if (
                sequence === state.requestSequence
            ) {

                setLoading(false);

            }

        }

    };


    /* =====================================================
       16. LOAD PROFILE HISTORY
    ===================================================== */

    const HISTORY_CONFIG = Object.freeze({

        attendance: {

            endpoint: "/attendance",

            render: renderAttendance

        },

        leave: {

            endpoint: "/leave",

            render: renderLeave

        },

        payslips: {

            endpoint: "/payslips",

            render: renderPayslips

        },

        documents: {

            endpoint: "/documents",

            render: renderDocuments

        }

    });


    const loadHistory = async (type) => {

        const config = HISTORY_CONFIG[type];

        if (!config || !state.profile) {
            return;
        }


        if (
            type === "documents" &&
            !hasPermission("viewDocuments")
        ) {

            return;

        }

        if (
            type === "payslips" &&
            !hasPermission("viewPayroll")
        ) {

            return;

        }


        try {

            const query = new URLSearchParams({

                page: String(
                    state.pagination[type]
                ),

                limit: String(
                    CONFIG.pageSize
                )

            });


            const response = await request(

                employeeEndpoint(
                    `${config.endpoint}?${query}`
                )

            );


            if (
                !response ||
                !Array.isArray(response.items)
            ) {

                throw new Error(
                    "Invalid history response."
                );

            }


            config.render(response.items);

        } catch {

            config.render([]);

            notify(
                `Unable to load ${type} history.`,
                "danger"
            );

        }

    };


    const loadAllHistory = async () => {

        /*
         * Promise.allSettled prevents one unavailable
         * history section from blocking the others.
         */

        await Promise.allSettled(

            Object.keys(HISTORY_CONFIG).map(
                loadHistory
            )

        );

    };


    /* =====================================================
       17. EDIT PROFILE
    ===================================================== */

    const openProfileEditor = () => {

        try {

            requirePermission("edit");

            if (!state.profile) {
                return;
            }


            const mappings = {

                profileEditFullName: "fullName",

                profileEditPhone: "phone",

                profileEditAddress: "address",

                profileEditEmergencyContact:
                    "emergencyContact"

            };


            Object.entries(mappings)
                .forEach(([id, key]) => {

                    const input = get(id);

                    if (input) {

                        input.value = String(
                            state.profile[key] ?? ""
                        );

                    }

                });


            window.EMSUI?.openModal(
                "profileEditorBackdrop"
            );

        } catch {

            notify(
                "You do not have permission to edit this profile.",
                "danger"
            );

        }

    };


    const saveProfile = async (event) => {

        event?.preventDefault();

        if (state.saving) {
            return;
        }


        try {

            requirePermission("edit");

        } catch {

            notify(
                "Profile editing is not authorised.",
                "danger"
            );

            return;

        }


        const form = get("profileEditForm");

        if (
            form &&
            !form.reportValidity()
        ) {

            return;

        }


        const payload = {

            fullName:
                get("profileEditFullName")?.value.trim() || "",

            phone:
                get("profileEditPhone")?.value.trim() || "",

            address:
                get("profileEditAddress")?.value.trim() || "",

            emergencyContact:
                get("profileEditEmergencyContact")?.value.trim() || ""

        };


        state.saving = true;

        const saveButton = get(
            "saveProfileChanges"
        );

        if (saveButton) {

            saveButton.disabled = true;

        }


        try {

            /*
             * Backend applies field-level permissions.
             * Employees must not be able to modify
             * protected salary, role or employment data
             * merely by submitting extra JSON fields.
             */

            await request(

                employeeEndpoint("/profile"),

                {

                    method: "PATCH",

                    body: payload

                }

            );


            window.EMSUI?.closeModal(
                "profileEditorBackdrop"
            );

            notify(
                "Employee profile updated successfully."
            );

            await loadProfile();

        } catch {

            notify(
                "Unable to update employee profile.",
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
       18. DOCUMENT UPLOAD
    ===================================================== */

    const openDocumentUpload = () => {

        if (!hasPermission("uploadDocument")) {

            notify(
                "Document upload is not authorised.",
                "danger"
            );

            return;

        }

        get("documentUploadForm")?.reset();

        window.EMSUI?.openModal(
            "documentUploadBackdrop"
        );

    };


    const uploadDocument = async (event) => {

        event?.preventDefault();


        if (!hasPermission("uploadDocument")) {

            notify(
                "Document upload is not authorised.",
                "danger"
            );

            return;

        }


        if (state.documentUpload) {
            return;
        }


        const fileInput = get(
            "profileDocumentFile"
        );

        const file = fileInput?.files?.[0];

        if (!file) {

            notify(
                "Select a document to upload.",
                "warning"
            );

            return;

        }


        if (
            !CONFIG.allowedDocumentTypes.includes(
                file.type
            )
        ) {

            notify(
                "Unsupported document format.",
                "warning"
            );

            return;

        }


        if (
            file.size <= 0 ||
            file.size > CONFIG.maxDocumentSize
        ) {

            notify(
                "Document must not exceed 10 MB.",
                "warning"
            );

            return;

        }


        const category = (
            get("profileDocumentCategory")?.value || ""
        ).trim();


        if (!category) {

            notify(
                "Select a document category.",
                "warning"
            );

            return;

        }


        /*
         * Document upload uses a protected,
         * short-lived upload authorization.
         *
         * The backend must validate:
         * - Account permission
         * - Employee ownership
         * - File size and actual file type
         * - Storage destination
         * - Document metadata
         *
         * No unrestricted public upload preset.
         */


        state.documentUpload = true;

        try {

            const authorization = await request(

                employeeEndpoint(
                    "/documents/upload-authorization"
                ),

                {

                    method: "POST",

                    body: {

                        fileName: file.name,

                        contentType: file.type,

                        fileSize: file.size,

                        category

                    }

                }

            );


            if (
                !authorization ||
                typeof authorization.uploadUrl !== "string" ||
                !authorization.uploadUrl.startsWith("https://") ||
                authorization.method !== "PUT"
            ) {

                throw new Error(
                    "Invalid upload authorization."
                );

            }


            const uploadResponse = await fetch(

                authorization.uploadUrl,

                {

                    method: "PUT",

                    headers: {

                        "Content-Type": file.type

                    },

                    body: file,

                    credentials: "omit"

                }

            );


            if (!uploadResponse.ok) {

                throw new Error(
                    "Document transfer failed."
                );

            }


            /*
             * Finalization must be independently
             * verified by the backend.
             *
             * Never trust a client-submitted file URL
             * as proof of a completed upload.
             */

            await request(

                employeeEndpoint(
                    "/documents/finalize"
                ),

                {

                    method: "POST",

                    body: {

                        uploadId:
                            authorization.uploadId

                    }

                }

            );


            window.EMSUI?.closeModal(
                "documentUploadBackdrop"
            );

            notify(
                "Document uploaded successfully."
            );

            await loadHistory("documents");

        } catch {

            notify(
                "Unable to upload the document.",
                "danger"
            );

        } finally {

            state.documentUpload = false;

        }

    };


    /* =====================================================
       19. DOCUMENT VIEW
    ===================================================== */

    const viewDocument = async (documentId) => {

        if (!hasPermission("viewDocuments")) {

            notify(
                "Document access is restricted.",
                "danger"
            );

            return;

        }


        try {

            const response = await request(

                employeeEndpoint(
                    "/documents/" +
                    encodeURIComponent(documentId) +
                    "/access"
                )

            );


            if (
                !response ||
                typeof response.url !== "string" ||
                !response.url.startsWith("https://")
            ) {

                throw new Error(
                    "Document access is unavailable."
                );

            }


            /*
             * The backend returns a short-lived,
             * authorised document access URL.
             */

            window.open(

                response.url,

                "_blank",

                "noopener,noreferrer"

            );

        } catch {

            notify(
                "Unable to open this document.",
                "danger"
            );

        }

    };


    /* =====================================================
       20. PAYSLIP VIEW
    ===================================================== */

    const viewPayslip = (payslipId) => {

        if (!hasPermission("viewPayroll")) {

            notify(
                "Payslip access is restricted.",
                "danger"
            );

            return;

        }


        const parameters = new URLSearchParams({

            id: payslipId

        });


        /*
         * The payslips module independently verifies
         * the requested record's ownership.
         */

        window.location.assign(
            `payslips.html?${parameters}`
        );

    };


    /* =====================================================
       21. TABLE ACTIONS
    ===================================================== */

    const initializeTableActions = () => {

        document.addEventListener(
            "click",
            async (event) => {

                const button = event.target.closest(
                    "[data-profile-action]"
                );

                if (!button) {
                    return;
                }


                const action =
                    button.dataset.profileAction;

                const recordId =
                    button.dataset.recordId;


                if (!recordId) {
                    return;
                }


                switch (action) {

                    case "view-document":

                        await viewDocument(recordId);

                        break;


                    case "view-payslip":

                        viewPayslip(recordId);

                        break;


                    default:

                        break;

                }

            }
        );

    };


    /* =====================================================
       22. EVENT REGISTRATION
    ===================================================== */

    const initializeEvents = () => {

        get("editProfileButton")?.addEventListener(
            "click",
            openProfileEditor
        );


        get("profileEditForm")?.addEventListener(
            "submit",
            saveProfile
        );


        get("uploadDocumentButton")?.addEventListener(
            "click",
            openDocumentUpload
        );


        get("documentUploadForm")?.addEventListener(
            "submit",
            uploadDocument
        );


        get("refreshEmployeeProfile")?.addEventListener(
            "click",
            async () => {

                await loadProfile();

                if (state.profile) {

                    await loadAllHistory();

                }

            }
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
            "employeeProfileContent",
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


            /*
             * Employees opening this page without
             * an explicit ID are directed to their
             * own backend-mapped employee record.
             */

            state.employeeId =
                readEmployeeId() ||
                context.employeeId;


            if (!state.employeeId) {

                throw new Error(
                    "Employee identifier is unavailable."
                );

            }


            initializeEvents();

            await loadProfile();


            if (state.profile) {

                await loadAllHistory();

            }

        } catch {

            showError(
                "Unable to open the employee profile."
            );

        } finally {

            setLoading(false);

        }

    };


    /* =====================================================
       24. PUBLIC MODULE INTERFACE
    ===================================================== */

    window.EMSEmployeeProfile = Object.freeze({

        initialize,

        refresh: loadProfile,

        refreshHistory: loadHistory,

        openEditor: openProfileEditor,

        openDocumentUpload

    });


    /* =====================================================
       25. START
    ===================================================== */

    const start = () => {

        if (
            document.body.dataset.page !==
            "employee-profile"
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

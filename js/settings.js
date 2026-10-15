/* =========================================================
   EMPLOYEE MANAGEMENT & PAYROLL SYSTEM
   FILE: js/settings.js

   PURPOSE:
   Secure, schema-driven Advanced Settings controller.

   SECURITY:
   - Super Admin only.
   - No private credentials in browser settings.
   - No direct Firebase database writes.
   - Backend validates every configuration change.
   - Draft -> Validate -> Preview -> Publish.
   - Optimistic concurrency through revision tokens.
   - Locked payroll snapshots remain immutable.
========================================================= */

"use strict";

(() => {

    /* =====================================================
       01. CONFIGURATION
    ===================================================== */

    const CONFIG = Object.freeze({

        allowedRoles: ["super_admin"],

        sections: Object.freeze([

            "company",
            "branding",
            "departments",
            "designations",
            "employeeFields",
            "permissions",
            "attendance",
            "leave",
            "payroll",
            "appearance",
            "templates",
            "faq"

        ]),

        endpoints: Object.freeze({

            bootstrap: "/settings/bootstrap",

            createDraft: "/settings/drafts",

            validate: "/validate",

            preview: "/preview",

            publish: "/publish",

            versions: "/settings/versions",

            backups: "/settings/backups"

        })

    });


    /*
     * These identifiers must never be accepted as
     * editable setting keys.
     *
     * This is defence in depth. Backend validation
     * and explicit allowlists are still mandatory.
     */

    const FORBIDDEN_KEYS = new Set([

        "__proto__",
        "prototype",
        "constructor",

        "apikey",
        "api_key",
        "secret",
        "privatekey",
        "private_key",
        "serviceaccount",
        "service_account",
        "clientsecret",
        "client_secret",
        "accesstoken",
        "access_token",
        "refreshtoken",
        "refresh_token",
        "password",
        "credential",
        "credentials",

        "uid",
        "firebaseuid",
        "firebase_uid",

        "superadminuid",
        "super_admin_uid",
        "superadminemail",
        "super_admin_email"

    ]);


    /* =====================================================
       02. APPLICATION STATE
    ===================================================== */

    const state = {

        initialized: false,

        context: null,

        loading: false,

        saving: false,

        publishing: false,

        activeSection: "company",

        publishedRevision: null,

        draft: null,

        schemas: {},

        permissions: {},

        dirtySections: new Set(),

        validation: null,

        preview: null,

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


    const notify = (
        message,
        type = "success"
    ) => {

        window.EMSUI?.showToast(
            message,
            type
        );

    };


    const clearElement = (element) => {

        element?.replaceChildren();

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


    const draftEndpoint = (suffix = "") => {

        const draftId = state.draft?.id;

        if (
            typeof draftId !== "string" ||
            !draftId.trim()
        ) {

            throw new Error(
                "No configuration draft is available."
            );

        }

        return (
            "/settings/drafts/" +
            encodeURIComponent(draftId) +
            suffix
        );

    };


    /* =====================================================
       05. BASIC VALIDATION
    ===================================================== */

    const validSection = (section) => {

        return CONFIG.sections.includes(section);

    };


    const safeKey = (key) => {

        if (
            typeof key !== "string" ||
            !/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(key)
        ) {

            return false;

        }

        return !FORBIDDEN_KEYS.has(
            key.toLowerCase()
        );

    };


    const isPlainObject = (value) => {

        if (
            value === null ||
            typeof value !== "object" ||
            Array.isArray(value)
        ) {

            return false;

        }

        const prototype = Object.getPrototypeOf(value);

        return (
            prototype === Object.prototype ||
            prototype === null
        );

    };


    const assertSafeValue = (
        value,
        depth = 0
    ) => {

        if (depth > 12) {

            throw new Error(
                "Configuration nesting limit exceeded."
            );

        }

        if (Array.isArray(value)) {

            if (value.length > 500) {

                throw new Error(
                    "Configuration array is too large."
                );

            }

            value.forEach((item) => {

                assertSafeValue(
                    item,
                    depth + 1
                );

            });

            return;

        }

        if (isPlainObject(value)) {

            Object.entries(value).forEach(
                ([key, child]) => {

                    if (!safeKey(key)) {

                        throw new Error(
                            "Configuration contains a restricted field."
                        );

                    }

                    assertSafeValue(
                        child,
                        depth + 1
                    );

                }
            );

            return;

        }

        if (
            value !== null &&
            typeof value !== "string" &&
            typeof value !== "number" &&
            typeof value !== "boolean"
        ) {

            throw new Error(
                "Unsupported configuration value."
            );

        }

        if (
            typeof value === "number" &&
            !Number.isFinite(value)
        ) {

            throw new Error(
                "Invalid numeric configuration value."
            );

        }

        if (
            typeof value === "string" &&
            value.length > 20000
        ) {

            throw new Error(
                "Configuration text exceeds the permitted limit."
            );

        }

    };


    /* =====================================================
       06. PERMISSIONS
    ===================================================== */

    const hasPermission = (permission) => {

        return (
            state.permissions[permission] === true
        );

    };


    const requirePermission = (permission) => {

        if (!hasPermission(permission)) {

            throw new Error(
                "This settings operation is not authorised."
            );

        }

    };


    const applyPermissions = () => {

        document.querySelectorAll(
            "[data-settings-permission]"
        ).forEach((element) => {

            const permission =
                element.dataset.settingsPermission;

            element.hidden = !hasPermission(
                permission
            );

        });

    };


    /* =====================================================
       07. LOADING / ERROR
    ===================================================== */

    const setLoading = (loading) => {

        state.loading = loading;

        setVisible(
            "settingsLoading",
            loading
        );

        get("settingsContent")?.setAttribute(
            "aria-busy",
            String(loading)
        );

        updateActionButtons();

    };


    const showError = (message) => {

        const element = get(
            "settingsError"
        );

        if (element) {

            element.textContent = message;

            element.hidden = false;

        } else {

            notify(
                message,
                "danger"
            );

        }

    };


    const clearError = () => {

        const element = get(
            "settingsError"
        );

        if (element) {

            element.textContent = "";

            element.hidden = true;

        }

    };


    const updateActionButtons = () => {

        const busy = (
            state.loading ||
            state.saving ||
            state.publishing
        );

        const saveButton = get(
            "saveSettingsDraft"
        );

        if (saveButton) {

            saveButton.disabled = (
                busy ||
                !hasPermission("editSettings") ||
                state.dirtySections.size === 0
            );

        }

        const validateButton = get(
            "validateSettingsDraft"
        );

        if (validateButton) {

            validateButton.disabled = (
                busy ||
                !hasPermission("validateSettings") ||
                !state.draft ||
                state.dirtySections.size > 0
            );

        }

        const previewButton = get(
            "previewSettingsDraft"
        );

        if (previewButton) {

            previewButton.disabled = (
                busy ||
                !hasPermission("previewSettings") ||
                !state.draft ||
                state.dirtySections.size > 0
            );

        }

        const publishButton = get(
            "publishSettingsDraft"
        );

        if (publishButton) {

            publishButton.disabled = (
                busy ||
                !hasPermission("publishSettings") ||
                state.validation?.valid !== true ||
                state.preview?.ready !== true ||
                !state.draft ||
                state.dirtySections.size > 0
            );

        }

    };


    /* =====================================================
       08. BOOTSTRAP
    ===================================================== */

    const loadBootstrap = async () => {

        const response = await request(
            CONFIG.endpoints.bootstrap
        );

        /*
         * Expected backend response:
         *
         * {
         *   permissions: {
         *     viewSettings: true,
         *     editSettings: true,
         *     validateSettings: true,
         *     previewSettings: true,
         *     publishSettings: true,
         *     viewVersions: true,
         *     manageBackups: true
         *   },
         *
         *   publishedRevision: "revision-token",
         *
         *   draft: {
         *     id: "server-generated-id",
         *     revision: "draft-revision",
         *     baseRevision: "published-revision",
         *     sections: {}
         *   },
         *
         *   schemas: {
         *     company: { fields: [] },
         *     branding: { fields: [] }
         *   }
         * }
         *
         * Server must never return secrets.
         */

        if (
            !isPlainObject(response) ||
            !isPlainObject(response.permissions) ||
            !isPlainObject(response.schemas) ||
            typeof response.publishedRevision !== "string"
        ) {

            throw new Error(
                "Invalid settings bootstrap response."
            );

        }

        state.permissions = Object.freeze({

            viewSettings:
                response.permissions.viewSettings === true,

            editSettings:
                response.permissions.editSettings === true,

            validateSettings:
                response.permissions.validateSettings === true,

            previewSettings:
                response.permissions.previewSettings === true,

            publishSettings:
                response.permissions.publishSettings === true,

            viewVersions:
                response.permissions.viewVersions === true,

            manageBackups:
                response.permissions.manageBackups === true

        });

        requirePermission(
            "viewSettings"
        );

        state.publishedRevision =
            response.publishedRevision;

        state.schemas = response.schemas;

        state.draft = null;

        if (response.draft !== null) {

            if (
                !isPlainObject(response.draft) ||
                typeof response.draft.id !== "string" ||
                typeof response.draft.revision !== "string" ||
                typeof response.draft.baseRevision !== "string" ||
                !isPlainObject(response.draft.sections)
            ) {

                throw new Error(
                    "Invalid configuration draft."
                );

            }

            assertSafeValue(
                response.draft.sections
            );

            state.draft = response.draft;

        }

        state.dirtySections.clear();

        state.validation = null;

        state.preview = null;

        applyPermissions();

        renderRevisionInformation();

        renderSectionNavigation();

        renderActiveSection();

        updateActionButtons();

    };


    /* =====================================================
       09. CREATE DRAFT
    ===================================================== */

    const createDraft = async () => {

        requirePermission(
            "editSettings"
        );

        if (state.draft) {

            return state.draft;

        }

        /*
         * POST /settings/drafts
         *
         * Backend copies the latest published config
         * into a new versioned draft.
         *
         * It must prevent duplicate active drafts
         * according to the organisation's policy.
         */

        const response = await request(

            CONFIG.endpoints.createDraft,

            {

                method: "POST",

                body: {

                    baseRevision:
                        state.publishedRevision

                }

            }

        );

        if (
            !isPlainObject(response) ||
            typeof response.id !== "string" ||
            typeof response.revision !== "string" ||
            typeof response.baseRevision !== "string" ||
            !isPlainObject(response.sections)
        ) {

            throw new Error(
                "Unable to create configuration draft."
            );

        }

        assertSafeValue(
            response.sections
        );

        state.draft = response;

        renderRevisionInformation();

        return state.draft;

    };


    /* =====================================================
       10. SECTION NAVIGATION
    ===================================================== */

    const SECTION_LABELS = Object.freeze({

        company: "Company Details",

        branding: "Branding",

        departments: "Departments",

        designations: "Designations",

        employeeFields: "Employee Fields",

        permissions: "HR Permissions",

        attendance: "Attendance Policies",

        leave: "Leave Policies",

        payroll: "Payroll Rules",

        appearance: "Appearance",

        templates: "Document Templates",

        faq: "FAQ Management"

    });


    const renderSectionNavigation = () => {

        const container = get(
            "settingsNavigation"
        );

        if (!container) {
            return;
        }

        const fragment =
            document.createDocumentFragment();

        CONFIG.sections.forEach((section) => {

            const button = create(

                "button",

                SECTION_LABELS[section],

                "settings-nav-item"

            );

            button.type = "button";

            button.dataset.settingsSection =
                section;

            button.classList.toggle(

                "active",

                section === state.activeSection

            );

            if (
                state.dirtySections.has(section)
            ) {

                button.appendChild(

                    create(
                        "span",
                        "Unsaved",
                        "settings-unsaved-label"
                    )

                );

            }

            fragment.appendChild(button);

        });

        container.replaceChildren(fragment);

    };


    const changeSection = (section) => {

        if (
            !validSection(section) ||
            state.loading ||
            state.saving ||
            state.publishing
        ) {

            return;

        }

        state.activeSection = section;

        renderSectionNavigation();

        renderActiveSection();

    };


    /* =====================================================
       11. SCHEMA-DRIVEN FIELD RENDERING
    ===================================================== */

    const allowedFieldTypes = new Set([

        "text",
        "email",
        "tel",
        "url",
        "number",
        "date",
        "textarea",
        "checkbox",
        "select"

    ]);


    const createFieldControl = (
        field,
        value
    ) => {

        if (
            !isPlainObject(field) ||
            !safeKey(field.key) ||
            !allowedFieldTypes.has(field.type)
        ) {

            return null;

        }

        const fieldId = (
            "setting-" +
            state.activeSection +
            "-" +
            field.key
        );

        let control;

        if (field.type === "textarea") {

            control = document.createElement(
                "textarea"
            );

            control.value = String(
                value ?? ""
            );

            control.rows = 4;

        } else if (field.type === "select") {

            control = document.createElement(
                "select"
            );

            const options = Array.isArray(field.options)
                ? field.options
                : [];

            options.forEach((option) => {

                if (
                    !isPlainObject(option) ||
                    typeof option.value !== "string"
                ) {

                    return;

                }

                control.appendChild(

                    new Option(

                        String(
                            option.label ?? option.value
                        ),

                        option.value

                    )

                );

            });

            control.value = String(
                value ?? ""
            );

        } else {

            control = document.createElement(
                "input"
            );

            control.type = field.type;

            if (field.type === "checkbox") {

                control.checked =
                    value === true;

            } else {

                control.value = String(
                    value ?? ""
                );

            }

        }

        control.id = fieldId;

        control.name = field.key;

        control.dataset.settingsField =
            field.key;

        control.dataset.settingsType =
            field.type;

        control.classList.add(
            "form-control"
        );

        control.required =
            field.required === true;

        control.disabled = (
            !hasPermission("editSettings") ||
            field.readOnly === true
        );

        if (
            typeof field.maxLength === "number" &&
            field.maxLength > 0 &&
            field.maxLength <= 20000 &&
            control.maxLength !== undefined
        ) {

            control.maxLength = field.maxLength;

        }

        if (
            field.type === "number"
        ) {

            if (
                typeof field.min === "number"
            ) {

                control.min = String(
                    field.min
                );

            }

            if (
                typeof field.max === "number"
            ) {

                control.max = String(
                    field.max
                );

            }

            if (
                typeof field.step === "number" &&
                field.step > 0
            ) {

                control.step = String(
                    field.step
                );

            }

        }

        return control;

    };


    const renderActiveSection = () => {

        const container = get(
            "settingsFields"
        );

        if (!container) {
            return;
        }

        container.replaceChildren();

        setText(
            "settingsSectionTitle",
            SECTION_LABELS[state.activeSection]
        );

        const schema =
            state.schemas[state.activeSection];

        if (
            !isPlainObject(schema) ||
            !Array.isArray(schema.fields)
        ) {

            container.appendChild(

                create(

                    "p",

                    "This settings section is unavailable.",

                    "text-muted"

                )

            );

            return;

        }

        const values =
            state.draft?.sections?.[state.activeSection];

        const sectionValues =
            isPlainObject(values)
                ? values
                : {};

        const fragment =
            document.createDocumentFragment();

        schema.fields.forEach((field) => {

            if (
                !isPlainObject(field) ||
                !safeKey(field.key)
            ) {

                return;

            }

            const control = createFieldControl(

                field,

                sectionValues[field.key]

            );

            if (!control) {
                return;
            }

            const group = create(
                "div",
                "",
                "form-group"
            );

            const label = create(

                "label",

                field.label || field.key,

                "form-label"

            );

            label.htmlFor = control.id;

            group.append(
                label,
                control
            );

            if (field.description) {

                group.appendChild(

                    create(

                        "small",

                        field.description,

                        "text-muted"

                    )

                );

            }

            fragment.appendChild(group);

        });

        container.appendChild(fragment);

    };


    /* =====================================================
       12. READ SECTION VALUES
    ===================================================== */

    const readActiveSection = () => {

        const schema =
            state.schemas[state.activeSection];

        if (
            !schema ||
            !Array.isArray(schema.fields)
        ) {

            throw new Error(
                "This section has no editable schema."
            );

        }

        const values = Object.create(null);

        for (const field of schema.fields) {

            if (
                !isPlainObject(field) ||
                !safeKey(field.key)
            ) {

                continue;

            }

            const control = get(

                "setting-" +
                state.activeSection +
                "-" +
                field.key

            );

            if (!control) {
                continue;
            }

            if (!control.reportValidity()) {

                throw new Error(
                    "Complete the required settings fields."
                );

            }

            if (control.disabled) {

                /*
                 * Existing read-only values are never
                 * sent as editable client input.
                 */

                continue;

            }

            let value;

            switch (field.type) {

                case "checkbox":

                    value = control.checked;

                    break;

                case "number":

                    value = control.value === ""
                        ? null
                        : Number(control.value);

                    break;

                default:

                    value = control.value.trim();

                    break;

            }

            values[field.key] = value;

        }

        assertSafeValue(values);

        return values;

    };


    /* =====================================================
       13. MARK UNSAVED CHANGES
    ===================================================== */

    const markDirty = () => {

        state.dirtySections.add(
            state.activeSection
        );

        state.validation = null;

        state.preview = null;

        setText(
            "settingsDraftStatus",
            "Unsaved Changes"
        );

        renderSectionNavigation();

        updateActionButtons();

    };


    /* =====================================================
       14. SAVE ACTIVE SECTION
    ===================================================== */

    const saveActiveSection = async () => {

        if (state.saving || state.publishing) {
            return false;
        }

        try {

            requirePermission(
                "editSettings"
            );

        } catch {

            notify(
                "Settings editing is not authorised.",
                "danger"
            );

            return false;

        }

        let values;

        try {

            values = readActiveSection();

        } catch (error) {

            notify(
                error.message,
                "warning"
            );

            return false;

        }

        const section = state.activeSection;

        state.saving = true;

        updateActionButtons();

        try {

            await createDraft();

            /*
             * PATCH /settings/drafts/:id/sections/:section
             *
             * The backend must:
             * - Verify Super Admin identity.
             * - Apply an explicit schema allowlist.
             * - Reject secrets and forbidden settings.
             * - Validate each field's type and range.
             * - Check the expected draft revision.
             * - Apply changes atomically.
             * - Generate a new revision token.
             * - Record the editor and server timestamp.
             *
             * Conflicts must return HTTP 409.
             */

            const response = await request(

                draftEndpoint(
                    "/sections/" +
                    encodeURIComponent(section)
                ),

                {

                    method: "PATCH",

                    body: {

                        expectedRevision:
                            state.draft.revision,

                        values

                    }

                }

            );

            if (
                !isPlainObject(response) ||
                typeof response.revision !== "string" ||
                !isPlainObject(response.section)
            ) {

                throw new Error(
                    "Invalid settings save response."
                );

            }

            assertSafeValue(
                response.section
            );

            state.draft.revision =
                response.revision;

            state.draft.sections[section] =
                response.section;

            state.dirtySections.delete(
                section
            );

            state.validation = null;

            state.preview = null;

            renderRevisionInformation();

            renderSectionNavigation();

            renderActiveSection();

            notify(
                "Settings draft saved successfully."
            );

            return true;

        } catch {

            notify(
                "Unable to save the settings draft. If another administrator changed it, reload the latest revision.",
                "danger"
            );

            return false;

        } finally {

            state.saving = false;

            updateActionButtons();

        }

    };


    /* =====================================================
       15. VERSION INFORMATION
    ===================================================== */

    const renderRevisionInformation = () => {

        setText(
            "settingsPublishedRevision",
            state.publishedRevision || "Unavailable"
        );

        setText(
            "settingsDraftRevision",
            state.draft?.revision || "No Draft"
        );

        setText(

            "settingsDraftStatus",

            state.dirtySections.size
                ? "Unsaved Changes"
                : state.draft
                    ? "Draft"
                    : "Published"

        );

    };


    /* =====================================================
       16. VALIDATE DRAFT
    ===================================================== */

    const validateDraft = async () => {

        try {

            requirePermission(
                "validateSettings"
            );

            if (!state.draft) {

                throw new Error(
                    "Create a settings draft first."
                );

            }

            if (state.dirtySections.size) {

                throw new Error(
                    "Save unsaved changes before validation."
                );

            }

            /*
             * POST /settings/drafts/:id/validate
             *
             * Backend must validate cross-section
             * dependencies, including:
             *
             * - Department/designation references
             * - Employee field compatibility
             * - HR permission escalation restrictions
             * - Attendance/leave policy constraints
             * - Payroll calculation safety
             * - Template field compatibility
             * - Existing data migration requirements
             * - Locked payroll preservation
             */

            const response = await request(

                draftEndpoint(
                    CONFIG.endpoints.validate
                ),

                {

                    method: "POST",

                    body: {

                        expectedRevision:
                            state.draft.revision

                    }

                }

            );

            if (
                !isPlainObject(response) ||
                typeof response.valid !== "boolean" ||
                typeof response.validationToken !== "string" ||
                !Array.isArray(response.issues)
            ) {

                throw new Error(
                    "Invalid validation response."
                );

            }

            state.validation = {

                ...response,

                draftRevision:
                    state.draft.revision

            };

            state.preview = null;

            renderValidation(response);

            updateActionButtons();

            return response.valid;

        } catch (error) {

            state.validation = null;

            state.preview = null;

            notify(
                error.message ||
                "Unable to validate this settings draft.",
                "danger"
            );

            updateActionButtons();

            return false;

        }

    };


    const renderValidation = (result) => {

        const container = get(
            "settingsValidationResults"
        );

        if (!container) {
            return;
        }

        container.replaceChildren();

        container.appendChild(

            create(

                "strong",

                result.valid
                    ? "Validation Passed"
                    : "Validation Failed"

            )

        );

        result.issues.forEach((issue) => {

            if (!isPlainObject(issue)) {
                return;
            }

            const item = create(

                "p",

                String(
                    issue.message || "Configuration issue"
                ),

                "settings-validation-item"

            );

            container.appendChild(item);

        });

    };


    /* =====================================================
       17. PREVIEW DRAFT
    ===================================================== */

    const previewDraft = async () => {

        try {

            requirePermission(
                "previewSettings"
            );

            if (
                !state.draft ||
                state.dirtySections.size
            ) {

                throw new Error(
                    "Save your settings draft first."
                );

            }

            if (
                state.validation?.valid !== true ||
                state.validation.draftRevision !==
                    state.draft.revision
            ) {

                throw new Error(
                    "Validate the current draft before preview."
                );

            }

            /*
             * POST /settings/drafts/:id/preview
             *
             * Preview is generated server-side.
             * It must not mutate published settings.
             */

            const response = await request(

                draftEndpoint(
                    CONFIG.endpoints.preview
                ),

                {

                    method: "POST",

                    body: {

                        expectedRevision:
                            state.draft.revision,

                        validationToken:
                            state.validation.validationToken

                    }

                }

            );

            if (
                !isPlainObject(response) ||
                typeof response.ready !== "boolean" ||
                typeof response.previewToken !== "string" ||
                !Array.isArray(response.changes)
            ) {

                throw new Error(
                    "Invalid settings preview."
                );

            }

            state.preview = {

                ...response,

                draftRevision:
                    state.draft.revision

            };

            renderPreview(response);

            updateActionButtons();

            window.EMSUI?.openModal(
                "settingsPreviewBackdrop"
            );

        } catch (error) {

            state.preview = null;

            updateActionButtons();

            notify(
                error.message ||
                "Unable to generate settings preview.",
                "danger"
            );

        }

    };


    const renderPreview = (preview) => {

        const container = get(
            "settingsPreviewContent"
        );

        if (!container) {
            return;
        }

        container.replaceChildren();

        preview.changes.forEach((change) => {

            if (!isPlainObject(change)) {
                return;
            }

            const item = create(
                "div",
                "",
                "settings-preview-item"
            );

            item.appendChild(

                create(

                    "strong",

                    change.title || "Configuration Change"

                )

            );

            item.appendChild(

                create(

                    "p",

                    change.description || "",

                    "text-muted"

                )

            );

            container.appendChild(item);

        });

        if (
            preview.changes.length === 0
        ) {

            container.appendChild(

                create(
                    "p",
                    "No configuration differences detected.",
                    "text-muted"
                )

            );

        }

    };


    /* =====================================================
       18. PUBLISH CONFIGURATION
    ===================================================== */

    const publishDraft = async () => {

        if (
            state.publishing ||
            state.saving
        ) {

            return;
        }

        try {

            requirePermission(
                "publishSettings"
            );

            if (
                !state.draft ||
                state.dirtySections.size ||
                state.validation?.valid !== true ||
                state.preview?.ready !== true
            ) {

                throw new Error(
                    "Save, validate and preview the draft before publishing."
                );

            }

            if (
                state.validation.draftRevision !==
                    state.draft.revision ||
                state.preview.draftRevision !==
                    state.draft.revision
            ) {

                throw new Error(
                    "Draft changed. Generate a new validation and preview."
                );

            }

        } catch (error) {

            notify(
                error.message,
                "warning"
            );

            return;

        }

        const confirmed =
            await window.EMSUI.confirm({

                title: "Publish Advanced Settings",

                message:
                    "Publish this configuration version? New policies will apply according to their effective dates. Historical locked payroll records will remain unchanged.",

                confirmText: "Publish Settings",

                cancelText: "Cancel"

            });

        if (!confirmed) {
            return;
        }

        state.publishing = true;

        updateActionButtons();

        try {

            /*
             * POST /settings/drafts/:id/publish
             *
             * Backend must:
             *
             * 1. Verify Super Admin authorisation.
             * 2. Verify exact draft revision.
             * 3. Verify exact published base revision.
             * 4. Recheck validation/preview tokens.
             * 5. Atomically publish the new version.
             * 6. Preserve the previous configuration.
             * 7. Record actor UID and server timestamp.
             * 8. Apply effective-date rules.
             * 9. Preserve immutable payroll snapshots.
             * 10. Never modify protected credentials.
             */

            const response = await request(

                draftEndpoint(
                    CONFIG.endpoints.publish
                ),

                {

                    method: "POST",

                    body: {

                        expectedDraftRevision:
                            state.draft.revision,

                        expectedPublishedRevision:
                            state.publishedRevision,

                        validationToken:
                            state.validation.validationToken,

                        previewToken:
                            state.preview.previewToken

                    }

                }

            );

            if (
                !isPlainObject(response) ||
                response.published !== true ||
                typeof response.revision !== "string"
            ) {

                throw new Error(
                    "Invalid publication response."
                );

            }

            state.publishedRevision =
                response.revision;

            state.validation = null;

            state.preview = null;

            state.draft = null;

            state.dirtySections.clear();

            window.EMSUI?.closeModal(
                "settingsPreviewBackdrop"
            );

            notify(
                "Advanced Settings published successfully."
            );

            await loadBootstrap();

        } catch {

            notify(
                "Unable to publish settings. Reload and verify the current configuration revision before retrying.",
                "danger"
            );

        } finally {

            state.publishing = false;

            updateActionButtons();

        }

    };


    /* =====================================================
       19. CONFIGURATION VERSION HISTORY
    ===================================================== */

    const loadVersions = async () => {

        try {

            requirePermission(
                "viewVersions"
            );

            const response = await request(
                CONFIG.endpoints.versions
            );

            if (
                !isPlainObject(response) ||
                !Array.isArray(response.items)
            ) {

                throw new Error(
                    "Version history unavailable."
                );

            }

            const container = get(
                "settingsVersionHistory"
            );

            if (!container) {
                return;
            }

            container.replaceChildren();

            response.items.forEach((version) => {

                if (!isPlainObject(version)) {
                    return;
                }

                const item = create(
                    "div",
                    "",
                    "settings-version-item"
                );

                item.appendChild(

                    create(

                        "strong",

                        version.label ||
                        version.revision ||
                        "Configuration Version"

                    )

                );

                item.appendChild(

                    create(

                        "p",

                        version.description || "",

                        "text-muted"

                    )

                );

                item.appendChild(

                    create(

                        "small",

                        version.publishedAt || "",

                        "text-muted"

                    )

                );

                container.appendChild(item);

            });

        } catch {

            notify(
                "Unable to load configuration version history.",
                "danger"
            );

        }

    };


    /* =====================================================
       20. BACKUP REQUEST
    ===================================================== */

    const requestBackup = async () => {

        try {

            requirePermission(
                "manageBackups"
            );

        } catch {

            notify(
                "Backup management is not authorised.",
                "danger"
            );

            return;

        }

        const confirmed =
            await window.EMSUI.confirm({

                title: "Create Configuration Backup",

                message:
                    "Create a protected, versioned configuration backup? Private service credentials will not be included.",

                confirmText: "Create Backup",

                cancelText: "Cancel"

            });

        if (!confirmed) {
            return;
        }

        try {

            /*
             * POST /settings/backups
             *
             * Backend handles:
             * - Authorization
             * - Secret exclusion
             * - Snapshot creation
             * - Integrity metadata
             * - Protected storage
             * - Audit logging
             *
             * This is a configuration backup.
             * Full database recovery is a separate
             * privileged backend operation.
             */

            await request(

                CONFIG.endpoints.backups,

                {

                    method: "POST",

                    body: {

                        revision:
                            state.publishedRevision

                    }

                }

            );

            notify(
                "Configuration backup request completed."
            );

        } catch {

            notify(
                "Unable to create configuration backup.",
                "danger"
            );

        }

    };


    /* =====================================================
       21. REFRESH
    ===================================================== */

    const refresh = async () => {

        if (
            state.saving ||
            state.publishing
        ) {

            return;
        }

        if (
            state.dirtySections.size > 0
        ) {

            const confirmed =
                await window.EMSUI.confirm({

                    title: "Discard Unsaved Changes",

                    message:
                        "Reload the latest settings? Your unsaved browser changes will be discarded.",

                    confirmText: "Reload",

                    cancelText: "Keep Editing",

                    danger: true

                });

            if (!confirmed) {
                return;
            }

        }

        const sequence =
            ++state.requestSequence;

        setLoading(true);

        clearError();

        try {

            await loadBootstrap();

            if (
                sequence !== state.requestSequence
            ) {

                return;

            }

            notify(
                "Settings refreshed successfully."
            );

        } catch {

            showError(
                "Unable to load the current settings configuration."
            );

        } finally {

            setLoading(false);

        }

    };


    /* =====================================================
       22. EVENT LISTENERS
    ===================================================== */

    const initializeEvents = () => {

        get("settingsNavigation")?.addEventListener(
            "click",
            (event) => {

                const button = event.target.closest(
                    "[data-settings-section]"
                );

                if (!button) {
                    return;
                }

                changeSection(
                    button.dataset.settingsSection
                );

            }
        );

        get("settingsFields")?.addEventListener(
            "input",
            (event) => {

                if (
                    event.target.matches(
                        "[data-settings-field]"
                    )
                ) {

                    markDirty();

                }

            }
        );

        get("settingsFields")?.addEventListener(
            "change",
            (event) => {

                if (
                    event.target.matches(
                        "[data-settings-field]"
                    )
                ) {

                    markDirty();

                }

            }
        );

        get("saveSettingsDraft")?.addEventListener(
            "click",
            saveActiveSection
        );

        get("validateSettingsDraft")?.addEventListener(
            "click",
            validateDraft
        );

        get("previewSettingsDraft")?.addEventListener(
            "click",
            previewDraft
        );

        get("publishSettingsDraft")?.addEventListener(
            "click",
            publishDraft
        );

        get("refreshSettings")?.addEventListener(
            "click",
            refresh
        );

        get("viewSettingsVersions")?.addEventListener(
            "click",
            loadVersions
        );

        get("createSettingsBackup")?.addEventListener(
            "click",
            requestBackup
        );

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
            "settingsContent",
            false
        );

        try {

            if (!window.EMSFirebase) {

                throw new Error(
                    "Application service is unavailable."
                );

            }

            /*
             * A role selected on the login screen
             * does not establish Super Admin access.
             *
             * requireAuth verifies the account role
             * against the protected backend.
             */

            const context =
                await window.EMSFirebase.requireAuth(
                    CONFIG.allowedRoles
                );

            if (!context) {
                return;
            }

            if (
                context.role !== "super_admin"
            ) {

                throw new Error(
                    "Advanced Settings access is restricted."
                );

            }

            state.context = context;

            await loadBootstrap();

            initializeEvents();

            setVisible(
                "settingsContent",
                true
            );

        } catch {

            state.permissions = {};

            applyPermissions();

            setVisible(
                "settingsContent",
                false
            );

            showError(
                "Unable to verify Advanced Settings access."
            );

        } finally {

            setLoading(false);

        }

    };


    /* =====================================================
       24. PUBLIC MODULE INTERFACE
    ===================================================== */

    window.EMSSettings = Object.freeze({

        initialize,

        refresh,

        changeSection,

        saveDraft: saveActiveSection,

        validateDraft,

        previewDraft,

        publishDraft,

        loadVersions,

        requestBackup,

        getContext: () => state.context

    });


    /* =====================================================
       25. START
    ===================================================== */

    const start = () => {

        if (
            document.body.dataset.page !== "settings"
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

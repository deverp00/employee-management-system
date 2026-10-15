
/* =========================================================
   EMPLOYEE MANAGEMENT & PAYROLL SYSTEM
   FILE: js/auth.js

   Firebase Authentication + Verified Backend Roles

   SECURITY:
   - Runtime configuration is loaded before Firebase.
   - No hardcoded credentials or Firebase UID.
   - Login role selection never grants permissions.
   - Backend verifies all account roles.
   - Browser-session Firebase persistence.
========================================================= */

"use strict";

(() => {

    const ROLES = Object.freeze([
        "super_admin",
        "hr_admin",
        "employee"
    ]);

    const LOGIN_PAGE = "index.html";
    const DASHBOARD_PAGE = "dashboard.html";

    const SDK_BASE =
        "https://www.gstatic.com/firebasejs/13.0.0";

    const REQUEST_TIMEOUT = 15000;

    const state = {
        app: null,
        auth: null,
        sdk: null,
        apiBase: null,
        context: null,
        initPromise: null,
        loginPending: false,
        logoutPending: false
    };

    /* =====================================================
       DOM HELPERS
    ===================================================== */

    const get = (id) => document.getElementById(id);

    const feedback = (id, message) => {
        const element = get(id);

        if (!element) return;

        element.textContent = message;
        element.hidden = !message;
    };

    const setBusy = (busy) => {
        const button = get("loginButton");
        const label = get("loginButtonText");
        const form = get("loginForm");

        if (button) button.disabled = busy;

        if (label) {
            label.textContent = busy
                ? "Verifying Account..."
                : "Login";
        }

        form?.setAttribute("aria-busy", String(busy));
    };

    /* =====================================================
       RUNTIME CONFIGURATION
    ===================================================== */

    const getConfiguration = async () => {

        /*
         * runtime-config.js must be loaded before
         * auth.js in every HTML page.
         */

        if (!window.EMS_RUNTIME_CONFIG_READY) {
            throw new Error(
                "Application configuration loader is missing."
            );
        }

        const config =
            await window.EMS_RUNTIME_CONFIG_READY;

        if (
            !config ||
            typeof config !== "object" ||
            !config.firebase ||
            typeof config.apiBase !== "string"
        ) {
            throw new Error(
                "Application configuration is unavailable."
            );
        }

        const required = [
            "apiKey",
            "authDomain",
            "projectId",
            "appId"
        ];

        for (const field of required) {
            if (
                typeof config.firebase[field] !== "string" ||
                !config.firebase[field].trim()
            ) {
                throw new Error(
                    "Firebase configuration is incomplete."
                );
            }
        }

        const url = new URL(config.apiBase);

        if (
            url.protocol !== "https:" ||
            url.username ||
            url.password ||
            url.search ||
            url.hash
        ) {
            throw new Error(
                "Invalid secure backend configuration."
            );
        }

        return {
            firebase: config.firebase,
            apiBase: url.href.replace(/\/+$/, "")
        };
    };

    /* =====================================================
       FIREBASE INITIALIZATION
    ===================================================== */

    const initialize = () => {

        if (state.initPromise) {
            return state.initPromise;
        }

        state.initPromise = (async () => {

            const config = await getConfiguration();

            const [appSDK, authSDK] = await Promise.all([
                import(`${SDK_BASE}/firebase-app.js`),
                import(`${SDK_BASE}/firebase-auth.js`)
            ]);

            const app = appSDK.initializeApp(
                config.firebase
            );

            const auth = authSDK.getAuth(app);

            /*
             * Session persistence:
             * Sign-in survives a same-tab navigation,
             * but does not use custom token storage.
             */

            await authSDK.setPersistence(
                auth,
                authSDK.browserSessionPersistence
            );

            /*
             * Wait until Firebase resolves the initial
             * authentication state before inspecting
             * auth.currentUser.
             */

            await auth.authStateReady();

            state.app = app;
            state.auth = auth;
            state.sdk = authSDK;
            state.apiBase = config.apiBase;

            authSDK.onAuthStateChanged(auth, (user) => {
                if (
                    !user ||
                    (state.context &&
                     state.context.uid !== user.uid)
                ) {
                    state.context = null;
                }
            });

            return true;

        })().catch((error) => {
            state.initPromise = null;
            throw error;
        });

        return state.initPromise;
    };

    /* =====================================================
       AUTHENTICATED API REQUEST
    ===================================================== */

    const authenticatedRequest = async (
        path,
        options = {}
    ) => {

        await initialize();

        if (
            typeof path !== "string" ||
            !path.startsWith("/") ||
            path.startsWith("//") ||
            path.includes("#")
        ) {
            throw new Error("Invalid API path.");
        }

        const user = state.auth.currentUser;

        if (!user) {
            state.context = null;
            throw new Error("Authentication required.");
        }

        /*
         * This token proves Firebase identity only.
         * Backend must independently verify role,
         * account status and operation permissions.
         */

        const token = await state.sdk.getIdToken(user);

        const controller = new AbortController();

        const timeout = window.setTimeout(
            () => controller.abort(),
            REQUEST_TIMEOUT
        );

        try {

            const hasBody =
                options.body !== undefined &&
                options.body !== null;

            const response = await fetch(
                `${state.apiBase}${path}`,
                {
                    method: options.method || "GET",

                    headers: {
                        Authorization: `Bearer ${token}`,
                        Accept: "application/json",

                        ...(hasBody ? {
                            "Content-Type": "application/json"
                        } : {})
                    },

                    body: hasBody
                        ? JSON.stringify(options.body)
                        : undefined,

                    credentials: "omit",
                    cache: "no-store",
                    signal: controller.signal
                }
            );

            if (response.status === 401) {
                state.context = null;
                throw new Error("Authentication required.");
            }

            if (response.status === 403) {
                throw new Error(
                    "This operation is not authorised."
                );
            }

            if (!response.ok) {
                throw new Error(
                    "The requested operation failed."
                );
            }

            if (response.status === 204) {
                return null;
            }

            const contentType =
                response.headers.get("content-type") || "";

            if (!contentType.includes("application/json")) {
                throw new Error(
                    "Invalid API response format."
                );
            }

            return response.json();

        } finally {
            window.clearTimeout(timeout);
        }
    };

    /* =====================================================
       VERIFY BACKEND ACCOUNT CONTEXT
    ===================================================== */

    const verifyAccountContext = async (
        requestedRole = null
    ) => {

        state.context = null;

        await initialize();

        const user = state.auth.currentUser;

        if (!user) {
            throw new Error("Authentication required.");
        }

        /*
         * GET /auth/context
         *
         * Backend must:
         * 1. Verify the Firebase ID token.
         * 2. Derive UID from the verified token.
         * 3. Read protected account assignment.
         * 4. Verify account is enabled.
         * 5. Return authoritative role and employeeId.
         */

        const response = await authenticatedRequest(
            "/auth/context"
        );

        if (
            !response ||
            response.uid !== user.uid ||
            response.enabled !== true ||
            !ROLES.includes(response.role)
        ) {
            throw new Error(
                "Your account is not authorised."
            );
        }

        if (
            requestedRole &&
            response.role !== requestedRole
        ) {
            throw new Error(
                "The selected login role does not match your assigned account role."
            );
        }

        const context = Object.freeze({
            uid: user.uid,
            role: response.role,

            employeeId:
                typeof response.employeeId === "string"
                    ? response.employeeId
                    : null,

            displayName:
                typeof response.displayName === "string"
                    ? response.displayName
                    : "",

            enabled: true
        });

        state.context = context;

        return context;
    };

    /* =====================================================
       LOGIN
    ===================================================== */

    const login = async (
        email,
        password,
        requestedRole
    ) => {

        if (state.loginPending) {
            throw new Error(
                "A login request is already in progress."
            );
        }

        if (!ROLES.includes(requestedRole)) {
            throw new Error(
                "Please select a valid login role."
            );
        }

        if (
            typeof email !== "string" ||
            !email.trim() ||
            typeof password !== "string" ||
            !password
        ) {
            throw new Error(
                "Enter your email address and password."
            );
        }

        state.loginPending = true;
        state.context = null;

        try {

            await initialize();

            const credential =
                await state.sdk.signInWithEmailAndPassword(
                    state.auth,
                    email.trim(),
                    password
                );

            if (!credential.user) {
                throw new Error("Authentication failed.");
            }

            return await verifyAccountContext(
                requestedRole
            );

        } catch (error) {

            state.context = null;

            /*
             * Do not retain a Firebase session after
             * a failed application-role verification.
             */

            if (state.auth?.currentUser) {
                try {
                    await state.sdk.signOut(state.auth);
                } catch {
                    // No sensitive error details exposed.
                }
            }

            throw error;

        } finally {
            state.loginPending = false;
        }
    };

    /* =====================================================
       LOGOUT
    ===================================================== */

    const logout = async () => {

        if (state.logoutPending) return;

        state.logoutPending = true;
        state.context = null;

        try {

            /*
             * A configuration outage should not
             * prevent the browser from reaching the
             * login page.
             */

            if (state.auth && state.sdk) {
                await state.sdk.signOut(state.auth);
            }

            window.location.replace(LOGIN_PAGE);

        } finally {
            state.logoutPending = false;
        }
    };

    /* =====================================================
       PROTECTED PAGE ACCESS
    ===================================================== */

    const requireAuth = async (
        allowedRoles = ROLES
    ) => {

        try {

            const permittedRoles =
                Array.isArray(allowedRoles)
                    ? allowedRoles
                    : ROLES;

            await initialize();

            const user = state.auth.currentUser;

            if (!user) {
                state.context = null;
                window.location.replace(LOGIN_PAGE);
                return null;
            }

            const context =
                await verifyAccountContext();

            if (!permittedRoles.includes(context.role)) {
                throw new Error(
                    "This page is not authorised."
                );
            }

            document.dispatchEvent(
                new CustomEvent("ems:auth-ready", {
                    detail: {
                        role: context.role,
                        employeeId: context.employeeId
                    }
                })
            );

            return context;

        } catch {

            state.context = null;

            document.dispatchEvent(
                new CustomEvent("ems:auth-denied")
            );

            window.location.replace(LOGIN_PAGE);

            return null;
        }
    };

    /* =====================================================
       LOGIN FORM
    ===================================================== */

    const initializeLoginForm = () => {

        const form = get("loginForm");

        if (!form) return;

        const emailInput = get("loginEmail");
        const passwordInput = get("loginPassword");
        const roleInput = get("loginRole");
        const passwordToggle = get("showPassword");

        passwordToggle?.addEventListener(
            "change",
            () => {
                if (passwordInput) {
                    passwordInput.type =
                        passwordToggle.checked
                            ? "text"
                            : "password";
                }
            }
        );

        form.addEventListener(
            "submit",
            async (event) => {

                event.preventDefault();

                if (state.loginPending) return;

                feedback("loginError", "");
                feedback("loginStatus", "");

                setBusy(true);

                try {

                    const context = await login(
                        emailInput?.value || "",
                        passwordInput?.value || "",
                        roleInput?.value || ""
                    );

                    if (passwordInput) {
                        passwordInput.value = "";
                    }

                    feedback(
                        "loginStatus",
                        "Account verified. Opening dashboard..."
                    );

                    if (!ROLES.includes(context.role)) {
                        throw new Error(
                            "Invalid account destination."
                        );
                    }

                    window.location.replace(
                        DASHBOARD_PAGE
                    );

                } catch (error) {

                    const messages = new Set([
                        "Please select a valid login role.",
                        "Enter your email address and password.",
                        "The selected login role does not match your assigned account role.",
                        "Your account is not authorised."
                    ]);

                    feedback(
                        "loginError",
                        messages.has(error.message)
                            ? error.message
                            : "Unable to sign in. Check your credentials or contact your administrator."
                    );

                } finally {
                    setBusy(false);
                }
            }
        );
    };

    /* =====================================================
       EXISTING SESSION ON LOGIN PAGE
    ===================================================== */

    const checkExistingSession = async () => {

        if (document.body.dataset.page !== "login") {
            return;
        }

        try {

            await initialize();

            if (
                !state.auth.currentUser ||
                state.loginPending
            ) {
                return;
            }

            const context =
                await verifyAccountContext();

            if (
                ROLES.includes(context.role) &&
                !state.loginPending
            ) {
                window.location.replace(
                    DASHBOARD_PAGE
                );
            }

        } catch {

            state.context = null;

            /*
             * An invalid application session must not
             * redirect into a protected page.
             */

            if (state.auth?.currentUser) {
                try {
                    await state.sdk.signOut(state.auth);
                } catch {
                    // Keep login access available.
                }
            }
        }
    };

    /* =====================================================
       PUBLIC INTERFACE
    ===================================================== */

    window.EMSAuth = Object.freeze({

        initialize,
        login,
        logout,
        requireAuth,
        authenticatedRequest,

        getContext: () => state.context,

        getCurrentUser: () =>
            state.auth?.currentUser || null

    });

    /* =====================================================
       START
    ===================================================== */

    const start = () => {

        if (document.body.dataset.page !== "login") {
            return;
        }

        initializeLoginForm();

        checkExistingSession();
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

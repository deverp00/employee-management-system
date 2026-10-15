/* =========================================================
   EMPLOYEE MANAGEMENT & PAYROLL SYSTEM
   FILE: js/auth.js

   PURPOSE:
   Firebase Authentication and verified role-based access.

   SECURITY:
   - No credentials hardcoded.
   - No demo authentication.
   - No frontend role assignment.
   - No private keys.
   - No authentication bypass.
   - Backend verifies every requested role.
========================================================= */

"use strict";

(() => {

    /* =====================================================
       01. CONSTANTS
    ===================================================== */

    const ALLOWED_ROLES = Object.freeze([
        "super_admin",
        "hr_admin",
        "employee"
    ]);

    const ROLE_DESTINATIONS = Object.freeze({

        super_admin: "dashboard.html",

        hr_admin: "dashboard.html",

        employee: "dashboard.html"

    });

    const LOGIN_PAGE = "index.html";

    const REQUEST_TIMEOUT = 15000;

    /*
     * SDK version is public library information.
     * This is not a Firebase API key or credential.
     */

    const FIREBASE_SDK_VERSION = "13.0.0";

    const SDK_BASE =
        `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}`;


    /* =====================================================
       02. PRIVATE APPLICATION STATE
    ===================================================== */

    const state = {

        app: null,

        auth: null,

        sdk: null,

        apiBase: null,

        context: null,

        initializationPromise: null,

        loginPending: false,

        loggingOut: false,

        observerUnsubscribe: null,

        sessionCheck: null

    };


    /* =====================================================
       03. DOM HELPERS
    ===================================================== */

    const getElement = (id) => {

        return document.getElementById(id);

    };


    const setLoginError = (message = "") => {

        const element = getElement("loginError");

        if (!element) {
            return;
        }

        element.textContent = message;

        element.hidden = !message;

    };


    const setLoginStatus = (message = "") => {

        const element = getElement("loginStatus");

        if (!element) {
            return;
        }

        element.textContent = message;

        element.hidden = !message;

    };


    const setLoginBusy = (busy) => {

        const button = getElement("loginButton");

        const buttonText = getElement("loginButtonText");

        const form = getElement("loginForm");

        if (button) {

            button.disabled = busy;

        }

        if (buttonText) {

            buttonText.textContent = busy
                ? "Verifying Account..."
                : "Login";

        }

        if (form) {

            form.setAttribute(
                "aria-busy",
                String(busy)
            );

        }

    };


    /* =====================================================
       04. RUNTIME CONFIGURATION
    ===================================================== */

    /*
     * Supplied by the deployment integration.
     *
     * Expected public runtime configuration:
     *
     * window.EMS_RUNTIME_CONFIG = {
     *     firebase: { ...public Firebase web config... },
     *     apiBase: "...backend origin..."
     * };
     *
     * This file intentionally contains neither actual
     * Firebase project values nor backend credentials.
     *
     * Firebase web configuration is public application
     * identification, NOT a server-side secret.
     *
     * Actual secrets remain in protected backend storage.
     */

    const getRuntimeConfiguration = () => {

        const config = window.EMS_RUNTIME_CONFIG;

        if (!config || typeof config !== "object") {

            throw new Error(
                "Application runtime configuration is unavailable."
            );

        }

        if (
            !config.firebase ||
            typeof config.firebase !== "object"
        ) {

            throw new Error(
                "Firebase web configuration is unavailable."
            );

        }

        const requiredFields = [
            "apiKey",
            "authDomain",
            "projectId",
            "appId"
        ];

        for (const field of requiredFields) {

            if (
                typeof config.firebase[field] !== "string" ||
                !config.firebase[field].trim()
            ) {

                throw new Error(
                    "Firebase configuration is incomplete."
                );

            }

        }

        if (
            typeof config.apiBase !== "string" ||
            !config.apiBase.trim()
        ) {

            throw new Error(
                "Backend endpoint is not configured."
            );

        }

        const apiURL = new URL(
            config.apiBase,
            window.location.origin
        );

        const localDevelopment =
            ["localhost", "127.0.0.1"].includes(
                apiURL.hostname
            );

        if (
            apiURL.protocol !== "https:" &&
            !(
                localDevelopment &&
                apiURL.protocol === "http:"
            )
        ) {

            throw new Error(
                "A secure backend endpoint is required."
            );

        }

        return {

            firebase: config.firebase,

            apiBase: apiURL.href.replace(/\/+$/, "")

        };

    };


    /* =====================================================
       05. FIREBASE SDK INITIALIZATION
    ===================================================== */

    const initialize = () => {

        if (state.initializationPromise) {

            return state.initializationPromise;

        }

        state.initializationPromise = (
            async () => {

                const config = getRuntimeConfiguration();

                const [
                    appModule,
                    authModule
                ] = await Promise.all([

                    import(
                        `${SDK_BASE}/firebase-app.js`
                    ),

                    import(
                        `${SDK_BASE}/firebase-auth.js`
                    )

                ]);

                const app = appModule.initializeApp(
                    config.firebase
                );

                const auth = authModule.getAuth(app);

                /*
                 * Browser-session persistence.
                 * Passwords and ID tokens are never copied
                 * into custom localStorage/sessionStorage keys.
                 */

                await authModule.setPersistence(
                    auth,
                    authModule.browserSessionPersistence
                );

                state.app = app;

                state.auth = auth;

                state.sdk = authModule;

                state.apiBase = config.apiBase;

                return true;

            }
        )().catch((error) => {

            state.initializationPromise = null;

            throw error;

        });

        return state.initializationPromise;

    };


    /* =====================================================
       06. AUTHENTICATED BACKEND REQUEST
    ===================================================== */

    const authenticatedRequest = async (
        path,
        options = {}
    ) => {

        await initialize();

        const user = state.auth.currentUser;

        if (!user) {

            throw new Error(
                "Authentication required."
            );

        }

        /*
         * Firebase issues the ID token.
         * Never accept a UID supplied by an HTML field
         * as proof of user identity.
         */

        const token = await state.sdk.getIdToken(
            user
        );

        const controller = new AbortController();

        const timeout = window.setTimeout(() => {

            controller.abort();

        }, REQUEST_TIMEOUT);

        try {

            const response = await fetch(
                `${state.apiBase}${path}`,
                {

                    method: options.method || "GET",

                    headers: {

                        Authorization: `Bearer ${token}`,

                        Accept: "application/json",

                        ...(options.body
                            ? {
                                "Content-Type":
                                    "application/json"
                            }
                            : {})

                    },

                    body: options.body
                        ? JSON.stringify(options.body)
                        : undefined,

                    signal: controller.signal,

                    credentials: "omit",

                    cache: "no-store"

                }
            );

            if (!response.ok) {

                if (
                    response.status === 401 ||
                    response.status === 403
                ) {

                    throw new Error(
                        "Authentication or permission verification failed."
                    );

                }

                throw new Error(
                    "The requested operation could not be completed."
                );

            }

            return response.json();

        } finally {

            window.clearTimeout(timeout);

        }

    };


    /* =====================================================
       07. VERIFY AUTHENTICATED ACCOUNT CONTEXT
    ===================================================== */

    const verifyAccountContext = async (
        requestedRole = null
    ) => {

        state.context = null;

        const user = state.auth?.currentUser;

        if (!user) {

            throw new Error(
                "No authenticated account was found."
            );

        }

        /*
         * Backend contract:
         *
         * GET /auth/context
         *
         * Backend must:
         * 1. Verify Firebase ID token using Admin SDK.
         * 2. Derive UID from verified token.
         * 3. Read protected user-role assignment.
         * 4. Verify active account status.
         * 5. Return the authorised account context.
         *
         * The backend must never trust a client-submitted
         * UID, role or permission claim without verification.
         */

        const result = await authenticatedRequest(
            "/auth/context"
        );

        if (
            !result ||
            result.uid !== user.uid ||
            result.enabled !== true ||
            !ALLOWED_ROLES.includes(result.role)
        ) {

            throw new Error(
                "Your account is not authorised to access this application."
            );

        }

        if (
            requestedRole &&
            result.role !== requestedRole
        ) {

            throw new Error(
                "The selected login role does not match your assigned account role."
            );

        }

        const context = Object.freeze({

            uid: user.uid,

            role: result.role,

            employeeId: result.employeeId || null,

            displayName: result.displayName || "",

            enabled: true

        });

        state.context = context;

        return context;

    };


    /* =====================================================
       08. LOGIN
    ===================================================== */

    const login = async (
        email,
        password,
        requestedRole
    ) => {

        if (state.loginPending) {

            throw new Error(
                "A login request is already being processed."
            );

        }

        if (!ALLOWED_ROLES.includes(requestedRole)) {

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

            /*
             * Firebase validates the supplied credentials.
             */

            const credential =
                await state.sdk.signInWithEmailAndPassword(

                    state.auth,

                    email.trim(),

                    password

                );

            if (!credential.user) {

                throw new Error(
                    "Authentication failed."
                );

            }

            /*
             * Actual administrative role is retrieved
             * from the protected backend.
             */

            const context = await verifyAccountContext(
                requestedRole
            );

            return context;

        } catch (error) {

            state.context = null;

            /*
             * An authenticated Firebase session without
             * verified application permission must not
             * remain active after a failed login attempt.
             */

            if (state.auth?.currentUser) {

                try {

                    await state.sdk.signOut(
                        state.auth
                    );

                } catch {

                    // Do not expose internal error details.

                }

            }

            throw error;

        } finally {

            state.loginPending = false;

        }

    };


    /* =====================================================
       09. LOGOUT
    ===================================================== */

    const logout = async () => {

        if (state.loggingOut) {
            return;
        }

        state.loggingOut = true;

        try {

            await initialize();

            await state.sdk.signOut(
                state.auth
            );

            state.context = null;

            /*
             * Backend operations must independently
             * verify Firebase tokens and permissions.
             */

            window.location.replace(
                LOGIN_PAGE
            );

        } finally {

            state.loggingOut = false;

        }

    };


    /* =====================================================
       10. AUTHENTICATION STATE RESOLUTION
    ===================================================== */

    const waitForAuthState = () => {

        if (state.sessionCheck) {

            return state.sessionCheck;

        }

        state.sessionCheck = new Promise(
            (resolve, reject) => {

                let unsubscribe = null;

                unsubscribe = state.sdk.onAuthStateChanged(

                    state.auth,

                    (user) => {

                        unsubscribe?.();

                        resolve(user);

                    },

                    (error) => {

                        unsubscribe?.();

                        reject(error);

                    }

                );

            }
        );

        return state.sessionCheck;

    };


    /* =====================================================
       11. PROTECTED PAGE VERIFICATION
    ===================================================== */

    const requireAuth = async (
        allowedRoles = ALLOWED_ROLES
    ) => {

        const permittedRoles = Array.isArray(
            allowedRoles
        )
            ? allowedRoles
            : ALLOWED_ROLES;

        try {

            await initialize();

            const user = await waitForAuthState();

            if (!user) {

                state.context = null;

                window.location.replace(
                    LOGIN_PAGE
                );

                return null;

            }

            const context = await verifyAccountContext();

            if (
                !permittedRoles.includes(
                    context.role
                )
            ) {

                throw new Error(
                    "You do not have permission to access this page."
                );

            }

            document.dispatchEvent(
                new CustomEvent(
                    "ems:auth-ready",
                    {

                        detail: {

                            role: context.role,

                            employeeId: context.employeeId

                        }

                    }
                )
            );

            return context;

        } catch {

            state.context = null;

            document.dispatchEvent(
                new CustomEvent(
                    "ems:auth-denied"
                )
            );

            window.location.replace(
                LOGIN_PAGE
            );

            return null;

        }

    };


    /* =====================================================
       12. LOGIN FORM INITIALIZATION
    ===================================================== */

    const initializeLoginForm = () => {

        const form = getElement("loginForm");

        if (!form) {
            return;
        }

        const emailInput = getElement(
            "loginEmail"
        );

        const passwordInput = getElement(
            "loginPassword"
        );

        const roleInput = getElement(
            "loginRole"
        );

        const showPassword = getElement(
            "showPassword"
        );


        showPassword?.addEventListener(
            "change",
            () => {

                if (!passwordInput) {
                    return;
                }

                passwordInput.type =
                    showPassword.checked
                        ? "text"
                        : "password";

            }
        );


        form.addEventListener(
            "submit",
            async (event) => {

                event.preventDefault();

                if (state.loginPending) {
                    return;
                }

                setLoginError("");

                setLoginStatus("");

                const email = emailInput?.value || "";

                const password =
                    passwordInput?.value || "";

                const requestedRole =
                    roleInput?.value || "";

                setLoginBusy(true);

                try {

                    const context = await login(

                        email,

                        password,

                        requestedRole

                    );

                    /*
                     * Immediately clear the password input
                     * after successful verification.
                     */

                    if (passwordInput) {

                        passwordInput.value = "";

                    }

                    setLoginStatus(
                        "Account verified. Opening your dashboard..."
                    );

                    const destination =
                        ROLE_DESTINATIONS[context.role];

                    if (!destination) {

                        throw new Error(
                            "Your account dashboard is unavailable."
                        );

                    }

                    window.location.replace(
                        destination
                    );

                } catch (error) {

                    const safeMessages = [

                        "Please select a valid login role.",

                        "Enter your email address and password.",

                        "The selected login role does not match your assigned account role.",

                        "Your account is not authorised to access this application."

                    ];

                    const message =
                        safeMessages.includes(error.message)
                            ? error.message
                            : "Unable to sign in. Check your credentials or contact your administrator.";

                    setLoginError(message);

                } finally {

                    setLoginBusy(false);

                }

            }
        );

    };


    /* =====================================================
       13. EXISTING SESSION ON LOGIN PAGE
    ===================================================== */

    const checkExistingLoginSession = async () => {

        if (
            document.body.dataset.page !== "login"
        ) {

            return;

        }

        try {

            await initialize();

            const user = await waitForAuthState();

            if (!user || state.loginPending) {
                return;
            }

            const context = await verifyAccountContext();

            const destination =
                ROLE_DESTINATIONS[context.role];

            if (destination) {

                window.location.replace(
                    destination
                );

            }

        } catch {

            state.context = null;

            /*
             * A failed configuration or backend check
             * must never create a successful session.
             */

        }

    };


    /* =====================================================
       14. PUBLIC AUTHENTICATION INTERFACE
    ===================================================== */

    window.EMSAuth = Object.freeze({

        initialize,

        login,

        logout,

        requireAuth,

        authenticatedRequest,

        getContext: () => state.context,

        getCurrentUser: () => {

            return state.auth?.currentUser || null;

        }

    });


    /* =====================================================
       15. INITIALIZATION
    ===================================================== */

    const start = () => {

        initializeLoginForm();

        if (
            document.body.dataset.page === "login"
        ) {

            checkExistingLoginSession();

        }

        /*
         * Protected-page verification will be invoked
         * by the shared authentication bootstrap before
         * any sensitive module requests are performed.
         */

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

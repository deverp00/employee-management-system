
/* =========================================================
   EMPLOYEE MANAGEMENT & PAYROLL SYSTEM
   FILE: js/firebase-config.js

   PURPOSE:
   Shared Firebase configuration and protected API bridge.

   SECURITY:
   - No hardcoded Firebase project values.
   - No private credentials.
   - No hardcoded UID or account role.
   - No duplicate Firebase app initialization.
   - Authentication is managed exclusively by auth.js.
   - Protected requests use verified Firebase ID tokens.
========================================================= */

"use strict";

(() => {

    /* =====================================================
       01. INTERNAL STATE
    ===================================================== */

    const state = {

        ready: false,

        initializing: null,

        publicInfo: null

    };


    /* =====================================================
       02. VALIDATE CONFIGURATION
    ===================================================== */

    const validateConfiguration = (config) => {

        if (
            !config ||
            typeof config !== "object" ||
            Array.isArray(config)
        ) {

            throw new Error(
                "Application configuration is unavailable."
            );

        }

        if (
            !config.firebase ||
            typeof config.firebase !== "object" ||
            Array.isArray(config.firebase)
        ) {

            throw new Error(
                "Firebase public configuration is unavailable."
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
                    "Firebase public configuration is incomplete."
                );

            }

        }

        if (
            typeof config.apiBase !== "string" ||
            !config.apiBase.trim()
        ) {

            throw new Error(
                "Application backend is not configured."
            );

        }

        const apiUrl = new URL(config.apiBase);

        if (
            apiUrl.protocol !== "https:" ||
            apiUrl.username ||
            apiUrl.password ||
            apiUrl.search ||
            apiUrl.hash
        ) {

            throw new Error(
                "Invalid backend API address."
            );

        }

        return Object.freeze({

            projectId: config.firebase.projectId,

            apiBase: apiUrl.href.replace(/\/+$/, "")

        });

    };


    /* =====================================================
       03. INITIALIZE SHARED SERVICE
    ===================================================== */

    const initialize = () => {

        if (state.ready) {

            return Promise.resolve(true);

        }

        if (state.initializing) {

            return state.initializing;

        }

        state.initializing = (async () => {

            /*
             * runtime-config.js runs before this file.
             *
             * The promise must resolve before the
             * configuration is accessed.
             */

            if (!window.EMS_RUNTIME_CONFIG_READY) {

                throw new Error(
                    "Runtime configuration loader is missing."
                );

            }

            const configuration =
                await window.EMS_RUNTIME_CONFIG_READY;

            const publicInfo =
                validateConfiguration(configuration);

            /*
             * auth.js is responsible for Firebase SDK
             * imports, app initialization, Auth session
             * persistence and ID token retrieval.
             *
             * Do not initialize a second Firebase app.
             */

            if (
                !window.EMSAuth ||
                typeof window.EMSAuth.initialize !== "function" ||
                typeof window.EMSAuth.requireAuth !== "function" ||
                typeof window.EMSAuth.authenticatedRequest !== "function"
            ) {

                throw new Error(
                    "Authentication service is unavailable."
                );

            }

            await window.EMSAuth.initialize();

            state.publicInfo = publicInfo;

            state.ready = true;

            document.dispatchEvent(

                new CustomEvent(
                    "ems:firebase-ready",
                    {

                        detail: {

                            projectId:
                                publicInfo.projectId

                        }

                    }
                )

            );

            return true;

        })().catch((error) => {

            /*
             * A failed attempt is not treated as
             * successful initialization.
             *
             * A later explicit call may retry.
             */

            state.ready = false;

            state.publicInfo = null;

            state.initializing = null;

            document.dispatchEvent(

                new CustomEvent(
                    "ems:firebase-error"
                )

            );

            throw error;

        });

        return state.initializing;

    };


    /* =====================================================
       04. VERIFY PROTECTED PAGE ACCESS
    ===================================================== */

    const requireAuth = async (
        allowedRoles = [

            "super_admin",

            "hr_admin",

            "employee"

        ]
    ) => {

        /*
         * Role arrays determine which authenticated
         * account types may access a page.
         *
         * They never assign an account its role.
         */

        if (
            !Array.isArray(allowedRoles) ||
            allowedRoles.length === 0
        ) {

            throw new Error(
                "A valid page access policy is required."
            );

        }

        /*
         * If public configuration is temporarily
         * unavailable, fail closed.
         */

        await initialize();

        return window.EMSAuth.requireAuth(
            allowedRoles
        );

    };


    /* =====================================================
       05. AUTHENTICATED API REQUESTS
    ===================================================== */

    const request = async (
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

            throw new Error(
                "Invalid protected API path."
            );

        }

        if (
            options === null ||
            typeof options !== "object" ||
            Array.isArray(options)
        ) {

            throw new Error(
                "Invalid API request options."
            );

        }

        /*
         * auth.js adds the Firebase ID token.
         *
         * The backend verifies the token and
         * independently enforces account status,
         * resource ownership and RBAC permissions.
         *
         * Never accept an arbitrary client-provided
         * role or UID as proof of authorization.
         */

        return window.EMSAuth.authenticatedRequest(
            path,
            options
        );

    };


    /* =====================================================
       06. VERIFIED ACCOUNT CONTEXT
    ===================================================== */

    const getAuthContext = () => {

        if (
            !state.ready ||
            !window.EMSAuth
        ) {

            return null;

        }

        /*
         * This context is for frontend presentation.
         * It is not a substitute for backend checks.
         */

        return window.EMSAuth.getContext();

    };


    /* =====================================================
       07. PUBLIC CONFIGURATION INFORMATION
    ===================================================== */

    const getPublicInfo = () => {

        if (
            !state.ready ||
            !state.publicInfo
        ) {

            return null;

        }

        return state.publicInfo;

    };


    /* =====================================================
       08. SERVICE STATUS
    ===================================================== */

    const isReady = () => {

        return state.ready;

    };


    /* =====================================================
       09. PUBLIC SERVICE INTERFACE
    ===================================================== */

    window.EMSFirebase = Object.freeze({

        initialize,

        requireAuth,

        request,

        getAuthContext,

        getPublicInfo,

        isReady

    });

})();

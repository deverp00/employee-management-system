/* =========================================================
   EMPLOYEE MANAGEMENT & PAYROLL SYSTEM
   FILE: js/firebase-config.js

   PURPOSE:
   Shared Firebase configuration and service bridge.

   SECURITY RULES:
   - No actual Firebase project values in this file.
   - No service-account credentials.
   - No private API tokens.
   - No hardcoded user UID.
   - No hardcoded roles or passwords.
   - No demo configuration.
   - No authentication bypass.

   Firebase Auth initialization belongs to auth.js.
========================================================= */

"use strict";

(() => {

    /* =====================================================
       01. INTERNAL STATE
    ===================================================== */

    const state = {

        ready: false,

        initializing: null,

        configuration: null

    };


    /* =====================================================
       02. CONFIGURATION VALIDATION
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
            typeof config.firebase !== "object"
        ) {

            throw new Error(
                "Firebase configuration is unavailable."
            );

        }

        const requiredFields = [

            "apiKey",

            "authDomain",

            "projectId",

            "appId"

        ];


        for (const field of requiredFields) {

            const value = config.firebase[field];

            if (
                typeof value !== "string" ||
                !value.trim()
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
                "Application backend is not configured."
            );

        }


        const backendURL = new URL(

            config.apiBase,

            window.location.origin

        );


        const isLocalDevelopment = [

            "localhost",

            "127.0.0.1"

        ].includes(backendURL.hostname);


        if (
            backendURL.protocol !== "https:" &&
            !(
                isLocalDevelopment &&
                backendURL.protocol === "http:"
            )
        ) {

            throw new Error(
                "A secure backend connection is required."
            );

        }


        if (
            backendURL.username ||
            backendURL.password ||
            backendURL.search ||
            backendURL.hash
        ) {

            throw new Error(
                "Invalid backend endpoint configuration."
            );

        }


        return true;

    };


    /* =====================================================
       03. READ DEPLOYMENT CONFIGURATION
    ===================================================== */

    const readConfiguration = () => {

        /*
         * The deployment integration must provide:
         *
         * window.EMS_RUNTIME_CONFIG
         *
         * BEFORE this file and auth.js execute.
         *
         * No fallback credentials are permitted.
         */

        const config = window.EMS_RUNTIME_CONFIG;

        validateConfiguration(config);

        return config;

    };


    /* =====================================================
       04. INITIALIZE SHARED SERVICE BRIDGE
    ===================================================== */

    const initialize = () => {

        if (state.initializing) {

            return state.initializing;

        }


        state.initializing = (
            async () => {

                const config = readConfiguration();

                /*
                 * Authentication initialization is
                 * delegated to the existing auth.js.
                 *
                 * This prevents multiple competing
                 * Firebase initialization routines.
                 */

                if (
                    !window.EMSAuth ||
                    typeof window.EMSAuth.initialize !== "function"
                ) {

                    throw new Error(
                        "Authentication module is unavailable."
                    );

                }


                await window.EMSAuth.initialize();


                state.configuration = Object.freeze({

                    projectId: config.firebase.projectId,

                    apiBase: new URL(

                        config.apiBase,

                        window.location.origin

                    ).href.replace(/\/+$/, "")

                });


                state.ready = true;


                document.dispatchEvent(

                    new CustomEvent(
                        "ems:firebase-ready"
                    )

                );


                return true;

            }
        )().catch((error) => {

            state.ready = false;

            state.configuration = null;

            state.initializing = null;

            throw error;

        });


        return state.initializing;

    };


    /* =====================================================
       05. AUTHENTICATION CONTEXT
    ===================================================== */

    const getAuthContext = () => {

        if (!state.ready) {

            return null;

        }

        return window.EMSAuth?.getContext() || null;

    };


    /* =====================================================
       06. PROTECTED PAGE ACCESS
    ===================================================== */

    const requireAuth = async (allowedRoles) => {

        await initialize();

        if (
            !window.EMSAuth ||
            typeof window.EMSAuth.requireAuth !== "function"
        ) {

            throw new Error(
                "Authentication service is unavailable."
            );

        }


        return window.EMSAuth.requireAuth(
            allowedRoles
        );

    };


    /* =====================================================
       07. AUTHENTICATED BACKEND REQUESTS
    ===================================================== */

    const request = async (
        path,
        options = {}
    ) => {

        await initialize();


        if (
            typeof path !== "string" ||
            !path.startsWith("/") ||
            path.startsWith("//")
        ) {

            throw new Error(
                "Invalid application endpoint."
            );

        }


        if (
            !window.EMSAuth ||
            typeof window.EMSAuth.authenticatedRequest !== "function"
        ) {

            throw new Error(
                "Authenticated request service is unavailable."
            );

        }


        /*
         * auth.js attaches the current Firebase ID token.
         *
         * The backend must independently verify:
         * - Token validity
         * - Authenticated UID
         * - Account status
         * - Role
         * - Resource ownership
         * - Requested operation permission
         */

        return window.EMSAuth.authenticatedRequest(

            path,

            options

        );

    };


    /* =====================================================
       08. READINESS CHECK
    ===================================================== */

    const isReady = () => {

        return state.ready;

    };


    const getPublicInfo = () => {

        if (!state.ready) {

            return null;

        }


        /*
         * Return only minimal public integration
         * information, never authentication tokens.
         */

        return {

            projectId: state.configuration.projectId,

            apiBase: state.configuration.apiBase

        };

    };


    /* =====================================================
       09. PUBLIC MODULE INTERFACE
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

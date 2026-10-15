
/* =========================================================
   EMPLOYEE MANAGEMENT & PAYROLL SYSTEM
   FILE: js/runtime-config.js

   PURPOSE:
   Load public application configuration at runtime.

   SECURITY:
   - No Firebase Admin credentials.
   - No private API keys.
   - No service-account JSON.
   - No hardcoded Firebase project values.
   - No demo configuration.
========================================================= */

"use strict";

(() => {

    /*
     * PUBLIC BACKEND ADDRESS
     *
     * This address will be configured after
     * deploying the Cloudflare Worker.
     *
     * It is a public URL, not a credential.
     *
     * Do not insert any private key here.
     */

    const API_BASE_URL = "https://employee-management-api.yadavsubba2003.workers.dev";


    /* =====================================================
       01. CONFIGURATION STATE
    ===================================================== */

    const state = {

        ready: false,

        error: null

    };


    /* =====================================================
       02. VALIDATION
    ===================================================== */

    const validateApiBase = (value) => {

        if (
            typeof value !== "string" ||
            !value.trim()
        ) {

            throw new Error(
                "The public API endpoint has not been configured."
            );

        }

        const url = new URL(value);

        if (
            url.protocol !== "https:" ||
            url.username ||
            url.password ||
            url.search ||
            url.hash
        ) {

            throw new Error(
                "Invalid public API endpoint."
            );

        }

        return url.href.replace(/\/+$/, "");

    };


    const validateFirebaseConfig = (firebase) => {

        if (
            !firebase ||
            typeof firebase !== "object" ||
            Array.isArray(firebase)
        ) {

            throw new Error(
                "Firebase public configuration is unavailable."
            );

        }

        const required = [

            "apiKey",

            "authDomain",

            "projectId",

            "appId"

        ];

        const result = {};

        for (const key of required) {

            const value = firebase[key];

            if (
                typeof value !== "string" ||
                !value.trim()
            ) {

                throw new Error(
                    "Incomplete Firebase public configuration."
                );

            }

            result[key] = value.trim();

        }

        /*
         * Optional public Firebase Web SDK fields.
         */

        for (const key of [

            "databaseURL",

            "storageBucket",

            "messagingSenderId",

            "measurementId"

        ]) {

            if (
                typeof firebase[key] === "string" &&
                firebase[key].trim()
            ) {

                result[key] = firebase[key].trim();

            }

        }

        return Object.freeze(result);

    };


    /* =====================================================
       03. LOAD PUBLIC CONFIGURATION
    ===================================================== */

    const loadConfiguration = async () => {

        const apiBase = validateApiBase(
            API_BASE_URL
        );

        /*
         * Planned Cloudflare Worker endpoint:
         *
         * GET /public/config
         *
         * This endpoint returns PUBLIC values only.
         *
         * No Firebase ID token is required because
         * the login page needs this configuration
         * before the user can authenticate.
         */

        const controller = new AbortController();

        const timeout = window.setTimeout(
            () => controller.abort(),
            15000
        );

        let response;

        try {

            response = await fetch(

                `${apiBase}/public/config`,

                {

                    method: "GET",

                    headers: {

                        Accept: "application/json"

                    },

                    credentials: "omit",

                    cache: "no-store",

                    signal: controller.signal

                }

            );

        } finally {

            window.clearTimeout(timeout);

        }

        if (!response.ok) {

            throw new Error(
                "Unable to retrieve application configuration."
            );

        }

        const payload = await response.json();

        if (
            !payload ||
            typeof payload !== "object" ||
            Array.isArray(payload)
        ) {

            throw new Error(
                "Invalid public configuration response."
            );

        }

        const firebase = validateFirebaseConfig(
            payload.firebase
        );

        const configuration = Object.freeze({

            firebase,

            apiBase

        });

        window.EMS_RUNTIME_CONFIG =
            configuration;

        state.ready = true;

        window.dispatchEvent(

            new CustomEvent(
                "ems:runtime-config-ready"
            )

        );

        return configuration;

    };


    /* =====================================================
       04. EXPOSE INITIALIZATION PROMISE
    ===================================================== */

    /*
     * The authentication module must await:
     *
     * window.EMS_RUNTIME_CONFIG_READY
     *
     * before accessing EMS_RUNTIME_CONFIG.
     *
     * This avoids a race condition between fetching
     * configuration and initializing Firebase Auth.
     */

    window.EMS_RUNTIME_CONFIG_READY =
        loadConfiguration().catch((error) => {

            state.ready = false;

            state.error = error;

            /*
             * Do not silently substitute demo,
             * hardcoded or fabricated Firebase values.
             */

            window.dispatchEvent(

                new CustomEvent(
                    "ems:runtime-config-error"
                )

            );

            throw error;

        });


    /* =====================================================
       05. READ-ONLY PUBLIC STATUS
    ===================================================== */

    window.EMSRuntime = Object.freeze({

        isReady: () => state.ready,

        getError: () => {

            return state.error
                ? state.error.message
                : null;

        }

    });

})();

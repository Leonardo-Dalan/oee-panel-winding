/* ==========================================================================
   config.js — Central configuration + seed database
   --------------------------------------------------------------------------
   Everything that used to be a magic number in the source lives here.
   Values marked `ui: true` are editable in Setup & Admin and persisted in
   db.settings. Values marked `ui: false` are technical knobs: change them
   here (or via localStorage) but there is no UI for them.

   Loaded first - everything else depends on OEE.config.
   ========================================================================== */

(function (OEE) {
    'use strict';

    /* ----------------------------------------------------------------------
       CONFIG — single source of truth
       ---------------------------------------------------------------------- */
    OEE.config = Object.freeze({
        /* Storage ---------------------------------------------------------- */
        STORAGE_KEY: 'OEE_WINDING_MES_V3',   // keep: existing installs must not lose data
        FIREBASE_KEY: 'OEE_FIREBASE_URL_V3',
        BROADCAST_CHANNEL: 'oee_panel_live_channel',

        /* Firebase node layout --------------------------------------------- */
        FIREBASE_ROOT_PATH: 'oee_winding_state',

        /* --- Values exposed in the UI -------------------------------------- */
        settings: Object.freeze({
            oeeTarget: {
                ui: true,
                default: 85,
                min: 1,
                max: 100,
                label: 'OEE Target (%)'
            },
            performanceMode: {
                ui: true,
                /* LEARNED by default: with FIXED_100 the Performance metric can
                   never move, which makes one third of the OEE formula dead
                   weight on the dashboard. */
                default: 'LEARNED',
                options: ['LEARNED', 'FIXED_100'],
                label: 'Performance Mode'
            },
            cooldownSec: {
                ui: true,
                default: 3,
                min: 0,
                max: 30,
                label: 'Cooldown after each press (seconds)'
            },
            retentionDays: {
                ui: true,
                default: 180,
                min: 1,
                max: 3650,
                label: 'Keep event history for (days)'
            },
            /* The shift is the unit of accountability. Its length is the
               FIXED denominator the shift OEE is measured against, so a loss
               recorded at the start of a shift is still there at the end. */
            shiftStartHour: {
                ui: true,
                default: 6,
                min: 0,
                max: 23,
                label: 'Shift start hour (0-23)'
            },
            shiftLengthHours: {
                ui: true,
                /* fractional shifts are real: 8.5 = 08h30 */
                default: 8,
                min: 0.5,
                max: 24,
                label: 'Shift length (hours)'
            }
        }),

        /* --- Technical knobs (no UI) --------------------------------------- */
        tech: Object.freeze({
            heartbeatMs: 1000,        // 1s timer tick: clock, step timers, live OEE
            cloudPollMs: 2000,        // 2s cloud poll (only when a Firebase URL is set)
            cloudPushDebounceMs: 800, // coalesce rapid writes into a single PUT
            maxEvents: 20000,         // hard cap on db.events, independent of retention
            qualityMinBase: 1,        // minimum denominator so Quality is never NaN
            csvDelimiter: ';',        // Excel pt-BR opens ';' natively
            defaultPeriodDays: 365,   // Dashboard default time period
            layerHistoryLimit: 40,    // rows shown in Layer History
            noteHistoryLimit: 25      // rows shown in Shift Notes
        })
    });

    /* ----------------------------------------------------------------------
       Defaults applied when db.settings is missing or partially corrupt
       ---------------------------------------------------------------------- */
    OEE.defaultSettings = function () {
        var out = {};
        var defs = OEE.config.settings;
        Object.keys(defs).forEach(function (key) {
            out[key] = defs[key].default;
        });
        return out;
    };

    /* ----------------------------------------------------------------------
       Fill missing/invalid settings with defaults.
       Returns a clean settings object; never throws.
       ---------------------------------------------------------------------- */
    OEE.normalizeSettings = function (raw) {
        var clean = OEE.defaultSettings();
        if (!raw || typeof raw !== 'object') return clean;

        Object.keys(clean).forEach(function (key) {
            if (raw[key] === undefined || raw[key] === null || raw[key] === '') return;

            var def = OEE.config.settings[key];

            if (def.options) {                       // enum-like value
                if (def.options.indexOf(raw[key]) !== -1) clean[key] = raw[key];
                return;
            }

            var num = Number(raw[key]);
            if (!isFinite(num)) return;

            if (def.min !== undefined && num < def.min) return;
            if (def.max !== undefined && num > def.max) return;

            clean[key] = num;
        });

        return clean;
    };

    /* ----------------------------------------------------------------------
       Validate ONE setting against its definition.
       Returns { ok, value }. On failure `fallback` is returned so an invalid
       value typed in the form keeps whatever was already configured instead
       of silently snapping back to the factory default.
       ---------------------------------------------------------------------- */
    OEE.validateSetting = function (key, raw, fallback) {
        var def = OEE.config.settings[key];
        if (!def) return { ok: false, value: fallback };

        if (raw === undefined || raw === null || raw === '') {
            return { ok: false, value: fallback };
        }

        if (def.options) {
            return def.options.indexOf(raw) !== -1
                ? { ok: true, value: raw }
                : { ok: false, value: fallback };
        }

        var num = Number(raw);
        if (!isFinite(num)) return { ok: false, value: fallback };
        if (def.min !== undefined && num < def.min) return { ok: false, value: fallback };
        if (def.max !== undefined && num > def.max) return { ok: false, value: fallback };

        return { ok: true, value: num };
    };

    /* ----------------------------------------------------------------------
       Runtime settings object (always normalized).
       Storage.js keeps this in sync with db.settings on every save/load.
       ---------------------------------------------------------------------- */
    OEE.settings = OEE.defaultSettings();

    /* ----------------------------------------------------------------------
       Seed data for a fresh install.
       NOTE: no plaintext passwords here - passwords are hashed at seed time
       by crypto.js. The raw secrets only exist inside buildSeedUsers().
       ---------------------------------------------------------------------- */
    OEE.buildSeedUsers = function () {
        var C = OEE.crypto;
        return [
            withRole(C.hashPassword('operador', 'operador123'), 'OPERATOR'),
            withRole(C.hashPassword('gestor', 'gestor123'), 'MANAGER'),
            withRole(C.hashPassword('admin', 'admin123'), 'ADMIN')
        ];
    };

    function withRole(record, role) {
        record.role = role;
        return record;
    }

    OEE.createDefaultMachine = function (code, name) {
        return {
            code: code,
            name: name,
            status: 'IDLE',          // 'IDLE' (Standby) | 'RUNNING' | 'PLANNED' | 'UNPLANNED'
            stopReason: '',
            stopWo: '',
            stateStartTime: Date.now(),
            stepStartTime: Date.now(),
            transformer: null,
            undoSnapshot: null
        };
    };

    OEE.createDefaultDB = function () {
        return {
            updatedAt: Date.now(),
            settings: OEE.defaultSettings(),
            users: OEE.buildSeedUsers(),
            models: [
                /* stdBoxSec / stdLayerSec = 0 means AUTO: the engine calibrates
                   the standard from that model's own measured average once it
                   has enough finished steps. Set an explicit number to override. */
                { id: 'm1', name: 'Sample Model A - 500kVA', layers: 80, rating: '500 kVA', voltage: '13.8kV / 380V', stdLayerSec: 0, stdBoxSec: 0 },
                { id: 'm2', name: 'Distribution 150kVA', layers: 45, rating: '150 kVA', voltage: '13.8kV / 220V', stdLayerSec: 0, stdBoxSec: 0 },
                { id: 'm3', name: 'Power Transf. 1500kVA', layers: 120, rating: '1500 kVA', voltage: '34.5kV / 440V', stdLayerSec: 0, stdBoxSec: 0 }
            ],
            stopReasons: [
                { id: 's1', name: 'Insulation adjustment', category: 'UNPLANNED' },
                { id: 's2', name: 'Machine breakdown', category: 'UNPLANNED' },
                { id: 's3', name: 'Material shortage', category: 'UNPLANNED' },
                { id: 's4', name: 'Setup / Changeover', category: 'PLANNED' },
                { id: 's5', name: 'Waiting for crane / handling', category: 'UNPLANNED' },
                { id: 's6', name: 'Welding issue', category: 'UNPLANNED' },
                { id: 's7', name: 'Wire break', category: 'UNPLANNED' },
                { id: 's8', name: "5's - Clean", category: 'PLANNED' },
                { id: 's9', name: 'Meal / Break', category: 'PLANNED' },
                { id: 's10', name: 'Meetings', category: 'PLANNED' },
                { id: 's11', name: 'Preventive maintenance', category: 'PLANNED' },
                { id: 's12', name: 'Shift Handover', category: 'PLANNED' }
            ],
            machines: [
                OEE.createDefaultMachine('W01', 'Winding Machine 01'),
                OEE.createDefaultMachine('W02', 'Winding Machine 02'),
                OEE.createDefaultMachine('W03', 'Winding Machine 03'),
                OEE.createDefaultMachine('W04', 'Winding Machine 04'),
                OEE.createDefaultMachine('W05', 'Winding Machine 05')
            ],
            events: [],
            notes: []
        };
    };

}(window.OEE = window.OEE || {}));
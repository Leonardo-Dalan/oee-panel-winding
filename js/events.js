/* ==========================================================================
   events.js — Production event log
   --------------------------------------------------------------------------
   Every meaningful thing an operator does lands here as one record. The OEE
   engine (metrics.js) and the CSV export read ONLY from this list.

   Event types
     BOX_DONE         box assembly finished
     LAYER_DONE       a copper layer finished
     TRANSF_FINISHED  transformer completed
     RUN_SEGMENT      banked running time, written when production stops
     STOP_UNPLANNED   unexpected stop (hurts Availability)
     STOP_PLANNED     scheduled stop (excluded from the OEE denominator)
     REWORK           layers unwound and redone (hurts Quality)
     NOTE             shift note / handover

   Fix vs. the original: durationSec keeps one decimal instead of being
   rounded up with Math.max(1, ...), which systematically inflated every
   short segment. Rounding happens only at display time.
   ========================================================================== */

(function (OEE) {
    'use strict';

    /* Types that mean "the machine was actually producing" */
    var RUN_TYPES = ['BOX_DONE', 'LAYER_DONE', 'TRANSF_FINISHED', 'RUN_SEGMENT'];

    /* Types that count as a failure for MTBF / MTTR */
    var FAILURE_TYPES = ['STOP_UNPLANNED'];

    function logEvent(machineCode, type, detail, durationSec, extra) {
        var db = OEE.db;
        if (!db) return null;

        if (!OEE.storage.isArray(db.events)) db.events = [];

        var record = {
            id: OEE.utils.uid('ev'),
            timestamp: Date.now(),
            dateStr: new Date().toLocaleDateString('pt-BR'),
            timeStr: new Date().toLocaleTimeString('pt-BR'),
            machineCode: machineCode,
            operator: OEE.currentUser ? OEE.currentUser.username : 'System',
            shift: OEE.currentUser ? OEE.currentUser.shift : '-',
            type: type,
            detail: String(detail == null ? '' : detail),
            durationSec: normalizeDuration(durationSec)
        };

        if (extra) {
            Object.keys(extra).forEach(function (k) { record[k] = extra[k]; });
        }

        /* unshift = newest first, matching the sort in migrateDB */
        db.events.unshift(record);

        OEE.storage.save();
        return record;
    }

    /* Keep 1 decimal, never negative, never Infinity/NaN.
       A zero-length segment is recorded as 0 rather than a fake 1s. */
    function normalizeDuration(sec) {
        var n = Number(sec);
        if (!isFinite(n) || n <= 0) return 0;
        return Math.round(n * 10) / 10;
    }

    /* Bank the running time accumulated since the machine started/resumed.
       Called before ANY transition away from RUNNING so that no running time
       is ever lost, and so it is never counted twice. */
    function bankRunSegment(machine, label) {
        if (!machine || machine.status !== 'RUNNING') return null;

        var endTime = Date.now();
        var startTime = machine.stateStartTime || endTime;
        var elapsed = Math.max(0, (endTime - startTime) / 1000);

        if (elapsed <= 1) return null;

        return logEvent(
            machine.code,
            'RUN_SEGMENT',
            'Running before ' + label,
            elapsed,
            { startTime: startTime, endTime: endTime }
        );
    }

    /* Bank the downtime accumulated since the machine stopped.
       startTime comes from machine.stateStartTime, which is set the moment
       the machine entered the stopped state. Without it the log only knew
       when the stop ENDED, so the history could not show "inicio -> fim". */
    function bankStopSegment(machine, type, reason) {
        if (!machine) return null;

        var endTime = Date.now();
        var startTime = machine.stateStartTime || endTime;
        var elapsed = Math.max(0, (endTime - startTime) / 1000);

        if (elapsed <= 0) return null;

        return logEvent(machine.code, type, 'Stopped: ' + reason, elapsed, {
            reason: reason,
            startTime: startTime,
            endTime: endTime,
            stopType: type === 'STOP_UNPLANNED' ? 'UNPLANNED' : 'PLANNED'
        });
    }

    function removeEventById(eventId) {
        var db = OEE.db;
        if (!db || !OEE.storage.isArray(db.events) || !eventId) return false;

        var idx = -1;
        for (var i = 0; i < db.events.length; i++) {
            if (db.events[i].id === eventId) { idx = i; break; }
        }
        if (idx === -1) return false;

        db.events.splice(idx, 1);
        return true;
    }

    OEE.log = {
        RUN_TYPES: RUN_TYPES,
        FAILURE_TYPES: FAILURE_TYPES,
        logEvent: logEvent,
        normalizeDuration: normalizeDuration,
        bankRunSegment: bankRunSegment,
        bankStopSegment: bankStopSegment,
        removeEventById: removeEventById
    };

}(window.OEE = window.OEE || {}));
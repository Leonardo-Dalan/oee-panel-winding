/* ==========================================================================
   utils.js — DOM + formatting helpers
   --------------------------------------------------------------------------
   escapeHtml() is the security boundary for every value that reaches
   innerHTML. Anything that came from a user (transformer SN, notes, stop
   reasons, machine names) MUST go through it.
   ========================================================================== */

(function (OEE) {
    'use strict';

    /* ------------------------------------------------------------------
       DOM
       ------------------------------------------------------------------ */
    function $(id) {
        return document.getElementById(id);
    }

    function $$(selector, root) {
        return Array.prototype.slice.call((root || document).querySelectorAll(selector));
    }

    /* setText - safe for any string content */
    function setText(id, value) {
        var el = $(id);
        if (el) el.textContent = value == null ? '' : String(value);
    }

    /* ------------------------------------------------------------------
       ESCAPING (security)
       ------------------------------------------------------------------ */

    var HTML_ESCAPES = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
        '`': '&#96;'
    };

    function escapeHtml(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/[&<>"'`]/g, function (ch) {
            return HTML_ESCAPES[ch];
        });
    }

    /* Escape a value for use inside a double-quoted HTML attribute */
    function escapeAttr(value) {
        return escapeHtml(value);
    }

    /* ------------------------------------------------------------------
       Formatting
       ------------------------------------------------------------------ */
    function pad2(n) {
        return String(n).padStart(2, '0');
    }

    /* Seconds -> "MM:SS". Used by the step timers and the CSV export. */
    function formatTimer(sec) {
        var total = Math.max(0, Math.floor(sec || 0));
        return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
    }

    /* Seconds -> "1.5m" / "45s" for MTBF / MTTR */
    function formatMinutes(sec) {
        var s = Math.max(0, sec || 0);
        if (s < 60) return Math.round(s) + 's';
        return (Math.round(s / 60) / 10 * 10 >= 10
            ? Math.round(s / 60)
            : Math.round(s / 60 * 10) / 10) + 'm';
    }

    /* ------------------------------------------------------------------
       Data
       ------------------------------------------------------------------ */
    function deepClone(value) {
        if (value === null || typeof value !== 'object') return value;
        if (typeof window.structuredClone === 'function') {
            try { return window.structuredClone(value); } catch (e) { /* fall through */ }
        }
        return JSON.parse(JSON.stringify(value));
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function isFiniteNumber(n) {
        return typeof n === 'number' && isFinite(n);
    }

    /* Collision-resistant id without depending on crypto.randomUUID */
    function uid(prefix) {
        return (prefix || 'id') + '_' + Date.now().toString(36) + '_' +
            Math.floor(Math.random() * 1e9).toString(36);
    }

    /* ------------------------------------------------------------------
       Timing
       ------------------------------------------------------------------ */
    function debounce(fn, wait) {
        var timer = null;
        return function () {
            var ctx = this;
            var args = arguments;
            if (timer) clearTimeout(timer);
            timer = setTimeout(function () {
                timer = null;
                fn.apply(ctx, args);
            }, wait);
        };
    }

    /* ------------------------------------------------------------------
       Metric colouring
       A percentage below the configured OEE Target is flagged red so the
       operator sees it without reading the number.
       ------------------------------------------------------------------ */
    function setMetric(id, value, target) {
        var el = $(id);
        if (!el) return;

        el.textContent = value;
        el.classList.remove('metric-ok', 'metric-bad');

        if (target === null || target === undefined) return;

        var num = parseFloat(value);
        if (!isFinite(num)) return;

        el.classList.add(num < Number(target) ? 'metric-bad' : 'metric-ok');
    }

    /* ------------------------------------------------------------------
       Modals
       ------------------------------------------------------------------ */
    function openModal(id) {
        var el = $(id);
        if (el) el.classList.add('open');
    }

    function closeModal(id) {
        var el = $(id);
        if (el) el.classList.remove('open');
    }

    function isAnyModalOpen() {
        return !!document.querySelector('.modal-backdrop.open');
    }

    /* ------------------------------------------------------------------
       Toast (replaces the 14 native alert() calls)
       ------------------------------------------------------------------ */
    var TOAST_MS = 3200;

    function toast(message, kind, ms) {
        var host = $('toastContainer');
        if (!host) {
            window.alert(message);
            return;
        }

        var el = document.createElement('div');
        el.className = 'toast' + (kind ? ' toast-' + kind : '');
        el.textContent = String(message);
        host.appendChild(el);

        setTimeout(function () {
            el.classList.add('is-leaving');
            setTimeout(function () {
                if (el.parentNode) el.parentNode.removeChild(el);
            }, 200);
        }, ms || TOAST_MS);
    }

    /* ------------------------------------------------------------------
       Confirm (replaces the native confirm() used before the factory reset)
       ------------------------------------------------------------------ */
    function confirmDialog(message) {
        return window.confirm(message);
    }

    /* ------------------------------------------------------------------
       Export surface
       ------------------------------------------------------------------ */
    OEE.utils = {
        $: $,
        $$: $$,
        setText: setText,
        escapeHtml: escapeHtml,
        escapeAttr: escapeAttr,
        formatTimer: formatTimer,
        formatMinutes: formatMinutes,
        deepClone: deepClone,
        clamp: clamp,
        isFiniteNumber: isFiniteNumber,
        uid: uid,
        debounce: debounce,
        setMetric: setMetric,
        openModal: openModal,
        closeModal: closeModal,
        isAnyModalOpen: isAnyModalOpen,
        toast: toast,
        confirmDialog: confirmDialog
    };

}(window.OEE = window.OEE || {}));
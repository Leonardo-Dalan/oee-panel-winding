/* ==========================================================================
   main.js — Bootstrap and wiring
   --------------------------------------------------------------------------
   Loaded last. Owns:
     - navigation (tab switching, refresh of the visible view)
     - the single delegated click handler for every data-action button
     - the 1-second heartbeat (clock, step timers, live OEE)
     - the keyboard listener for SPACE / ENTER / pedal
   ========================================================================== */

(function (OEE) {
    'use strict';

    var $ = OEE.utils.$;

    var VIEWS = ['viewStation', 'viewDashboard', 'viewSetup'];
    var TABS = { station: 'tabBtnStation', dashboard: 'tabBtnDashboard', setup: 'tabBtnSetup' };
    var ACTIONS = { station: 'viewStation', dashboard: 'viewDashboard', setup: 'viewSetup' };

    var rightSubTab = 'layers';

    /* ==================================================================
       NAVIGATION
       ================================================================== */
    function switchView(view) {
        VIEWS.forEach(function (id) { $(id).classList.add('hidden'); });

        Object.keys(TABS).forEach(function (key) {
            $(TABS[key]).classList.remove('active');
        });

        var host = $(ACTIONS[view]);
        if (!host) return;

        host.classList.remove('hidden');
        $(TABS[view]).classList.add('active');

        if (view === 'station') OEE.views.station.render();
        else if (view === 'dashboard') OEE.views.dashboard.render();
        else if (view === 'setup') {
            $('firebaseUrlInput').value = OEE.sync.getFirebaseUrl();
            OEE.views.setup.render();
        }
    }

    function switchRightSubTab(tab) {
        rightSubTab = tab;

        $('btnSubTabLayers').classList.toggle('active', tab === 'layers');
        $('btnSubTabNotes').classList.toggle('active', tab === 'notes');
        $('subTabLayersContent').classList.toggle('hidden', tab !== 'layers');
        $('subTabNotesContent').classList.toggle('hidden', tab !== 'notes');
    }

    /* Re-render whatever is on screen after the data changed elsewhere
       (another tab, or a cloud pull).

       The original never rebuilt the machine <select> elements here, so a
       machine created on another PC stayed invisible on this operator's
       screen until they logged out and back in. */
    function refreshActiveScreen() {
        if (!OEE.currentUser) return;

        OEE.machines.populateMachineSelectors();

        if (!$('viewStation').classList.contains('hidden')) OEE.views.station.render();
        if (!$('viewDashboard').classList.contains('hidden')) OEE.views.dashboard.render();
        if (!$('viewSetup').classList.contains('hidden')) OEE.views.setup.render();

        OEE.sync.updateSyncBadge();
    }

    /* ==================================================================
       DELEGATED EVENTS
       One listener for the whole document. Buttons declare
       data-action (+ optional data-arg / data-id / data-reason).
       This replaces every inline onclick="..." - and closes the HTML
       attribute injection hole that came with interpolating user text
       (machine names, stop reasons, usernames) into a handler string.
       ================================================================== */
    var HANDLERS = {
        'nav': function (el) { switchView(el.getAttribute('data-arg')); },
        'subtab': function (el) { switchRightSubTab(el.getAttribute('data-arg')); },
        'login': function () { OEE.auth.doLogin(); },
        'logout': function () { OEE.auth.logout(); },
        'export-csv': function () { OEE.exporter.exportCSV(); },

        'pad-press': function () { OEE.views.station.handleMainPadPress(); },
        'undo': function () { OEE.views.station.undoLastPress(); },
        'resume': function () { OEE.views.station.resumeMachineFromStop(); },
        'start-transformer': function () { OEE.views.station.openNewTransformerModal(); },

        'open-stop': function () { OEE.views.station.openStopModal(); },
        'confirm-stop': function (el) {
            OEE.views.station.confirmStopMachine(
                el.getAttribute('data-reason') || '',
                el.getAttribute('data-category') || 'UNPLANNED'
            );
        },

        'open-rework': function () { OEE.views.station.openReworkModal(); },
        'confirm-rework': function () { OEE.views.station.confirmReworkLayer(); },

        'open-note': function (el) {
            OEE.views.station.openNoteModal(el.getAttribute('data-arg') === '1');
        },
        'confirm-note': function () { OEE.views.station.confirmSaveNote(); },

        'open-transformer': function () { OEE.views.station.openNewTransformerModal(); },
        'confirm-transformer': function () { OEE.views.station.confirmStartTransformer(); },

        'close-modal': function (el) {
            var id = el.getAttribute('data-arg');
            if (id) OEE.utils.closeModal(id);
        },

        'add-model': function () { OEE.views.setup.addTransformerModel(); },
        'delete-model': function (el) { OEE.views.setup.deleteModel(el.getAttribute('data-id')); },
        'add-stop': function () { OEE.views.setup.addStopReason(); },
        'delete-stop': function (el) { OEE.views.setup.deleteStopReason(el.getAttribute('data-id')); },
        'add-machine': function () { OEE.views.setup.addMachine(); },
        'set-standby': function (el) { OEE.machines.setMachineStandby(el.getAttribute('data-code')); },
        'add-user': function () { OEE.views.setup.addUser(); },
        'delete-user': function (el) { OEE.views.setup.deleteUser(el.getAttribute('data-id')); },
        'reset-demo': function () { OEE.views.setup.resetFactoryDemoData(); },
        'save-firebase': function () { OEE.views.setup.saveFirebaseUrl(); },
        'save-settings': function () { OEE.views.setup.saveSettings(); }
    };

    function onDocumentClick(ev) {
        var el = ev.target.closest ? ev.target.closest('[data-action]') : null;
        if (!el) return;

        /* A backdrop is an ANCESTOR of the dialog, so any click inside the
           dialog bubbles up to it. Close ONLY when the backdrop itself was
           the element clicked - otherwise filling in a form field closed
           the modal instantly. */
        if (el.classList.contains('modal-backdrop') && ev.target !== el) {
            return;
        }

        var action = el.getAttribute('data-action');
        var handler = HANDLERS[action];
        if (!handler) return;

        /* Clicking the pad itself fires pad-press; clicking a button inside
           the pad must NOT also count as a pad press. closest() already
           resolves to the nearest [data-action], so the inner button wins. */
        ev.preventDefault();
        handler(el);
    }

    /* ==================================================================
       KEYBOARD / PEDAL
       ================================================================== */
    function onKeyDown(ev) {
        if (ev.repeat) return;                       // key auto-repeat
        if (ev.ctrlKey || ev.altKey || ev.metaKey) return;

        if (ev.key === 'Enter' && OEE.currentUser &&
            !$('viewLogin').classList.contains('hidden')) {
            OEE.auth.doLogin();
            return;
        }

        if (ev.code !== 'Space' && ev.code !== 'Enter') return;

        var inStation = OEE.currentUser &&
                        !$('viewStation').classList.contains('hidden');
        if (!inStation) return;
        if (OEE.utils.isAnyModalOpen()) return;

        /* The original only excluded INPUT/TEXTAREA/SELECT. Pressing SPACE
           while a <button> still had focus (which is what happens right after
           clicking "Stop Machine" and the modal closes) fired both the
           button's click and a pad press - a phantom layer was logged. */
        var target = ev.target;
        var tag = target && target.tagName ? target.tagName.toUpperCase() : '';

        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
            tag === 'BUTTON' || tag === 'A' || tag === 'LABEL') {
            return;
        }

        if (target && target.isContentEditable) return;

        ev.preventDefault();
        OEE.views.station.handleMainPadPress();
    }

    /* ==================================================================
       HEARTBEAT (1 second)
       Only the volatile parts of the screen are touched here.
       ================================================================== */
    function heartbeat() {
        OEE.utils.setText('subbarClock', new Date().toLocaleTimeString('pt-BR'));

        if (!OEE.currentUser) return;

        if (!$('viewStation').classList.contains('hidden')) {
            var m = OEE.machines.getActiveMachine();
            var timer = $('liveMainTimer');

            if (m && timer) {
                var ref = m.status === 'RUNNING' ? m.stepStartTime : m.stateStartTime;
                timer.textContent = OEE.utils.formatTimer(Math.max(0, (Date.now() - ref) / 1000));
            }

            if (m) OEE.views.station.renderStationOEE(m.code);
        }

        if (!$('viewDashboard').classList.contains('hidden')) {
            OEE.views.dashboard.renderLive();
        }

        /* Keep the cloud badge and the Setup status line live at all times
           (they show "Local sync only" when no URL is configured too). */
        OEE.sync.updateSyncBadge();
    }

    /* ==================================================================
       SELECT CHANGE HANDLERS
       (were onchange="" in the original markup)
       ================================================================== */
    function onChange(ev) {
        var target = ev.target;
        var id = target.id;

        /* inline-edited model standard times (Performance metric) */
        if (target.getAttribute && target.getAttribute('data-action') === 'save-std') {
            OEE.views.setup.updateModelStd(
                target.getAttribute('data-model'),
                target.getAttribute('data-field'),
                target.value
            );
            return;
        }

        if (id === 'stationMachineSelect') {
            OEE.machines.changeActiveMachine(target.value);
        } else if (id === 'dashMachineFilter' || id === 'dashPeriodFilter') {
            OEE.views.dashboard.render();
        } else if (id === 'ntModelSelect') {
            OEE.views.station.autoFillModelSpecs();
        }
    }

    /* ==================================================================
       BOOT
       ================================================================== */
    function boot() {
        OEE.storage.load();
        OEE.sync.init();

        document.addEventListener('click', onDocumentClick);
        document.addEventListener('change', onChange);
        document.addEventListener('keydown', onKeyDown);

        setInterval(heartbeat, OEE.config.tech.heartbeatMs);

        /* Belt and braces: never leave the session logged in after a reload */
        window.addEventListener('beforeunload', function () {
            if (OEE.db) {
                try {
                    OEE.db.updatedAt = OEE.db.updatedAt || Date.now();
                } catch (e) { /* ignore */ }
            }
        });
    }

    OEE.nav = {
        switchView: switchView,
        switchRightSubTab: switchRightSubTab,
        refreshActiveScreen: refreshActiveScreen
    };

    OEE.refreshActiveScreen = refreshActiveScreen;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

}(window.OEE = window.OEE || {}));
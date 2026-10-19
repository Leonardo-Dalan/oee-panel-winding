/* ==========================================================================
   machines.js — Machine registry helpers
   ========================================================================== */

(function (OEE) {
    'use strict';

    OEE.activeMachineCode = 'W01';

    function getAll() {
        return (OEE.db && OEE.db.machines) || [];
    }

    function getActiveMachine() {
        var machines = getAll();
        for (var i = 0; i < machines.length; i++) {
            if (machines[i].code === OEE.activeMachineCode) return machines[i];
        }
        return machines[0] || null;
    }

    function getByCode(code) {
        var machines = getAll();
        for (var i = 0; i < machines.length; i++) {
            if (machines[i].code === code) return machines[i];
        }
        return null;
    }

    /* ------------------------------------------------------------------
       Selectors
       Rebuilt from scratch whenever the machine list changes, which is also
       what happens when a cloud pull adds a machine created on another PC
       (the original never called this after a pull, so new machines stayed
       invisible on the operator's screen).
       ------------------------------------------------------------------ */
    function populateMachineSelectors() {
        var $ = OEE.utils.$;
        var machines = getAll();

        var selStation = $('stationMachineSelect');
        var selDash = $('dashMachineFilter');

        var currentDash = selDash ? selDash.value : 'ALL';

        if (selStation) {
            selStation.textContent = '';
            machines.forEach(function (m) {
                var opt = document.createElement('option');
                opt.value = m.code;
                opt.textContent = m.name + ' (' + m.code + ')';
                if (m.code === OEE.activeMachineCode) opt.selected = true;
                selStation.appendChild(opt);
            });
        }

        if (selDash) {
            selDash.textContent = '';

            var all = document.createElement('option');
            all.value = 'ALL';
            all.textContent = 'All Winding Machines';
            selDash.appendChild(all);

            machines.forEach(function (m) {
                var opt = document.createElement('option');
                opt.value = m.code;
                opt.textContent = m.name + ' (' + m.code + ')';
                if (m.code === currentDash) opt.selected = true;
                selDash.appendChild(opt);
            });
        }
    }

    function changeActiveMachine(code) {
        OEE.activeMachineCode = code;
        OEE.views.station.render();
    }

    /* ------------------------------------------------------------------
       Force a machine back to Standby.
       Guarded by role: hiding the Setup tab is not access control.
       ------------------------------------------------------------------ */
    function setMachineStandby(code) {
        if (!OEE.auth.requireRole('ADMIN')) return;

        var m = getByCode(code);
        if (!m) return;

        m.status = 'IDLE';
        m.stopReason = '';
        m.transformer = null;
        m.undoSnapshot = null;
        m.stateStartTime = Date.now();
        m.stepStartTime = m.stateStartTime;

        OEE.storage.save();
        OEE.refreshActiveScreen();
        OEE.utils.toast(m.code + ' set back to Standby.', 'success');
    }

    OEE.machines = {
        getAll: getAll,
        getActiveMachine: getActiveMachine,
        getByCode: getByCode,
        populateMachineSelectors: populateMachineSelectors,
        changeActiveMachine: changeActiveMachine,
        setMachineStandby: setMachineStandby,
        createDefaultMachine: OEE.createDefaultMachine
    };

}(window.OEE = window.OEE || {}));
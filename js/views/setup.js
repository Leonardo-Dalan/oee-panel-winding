/* ==========================================================================
   views/setup.js — Admin: models, stop reasons, machines, users, settings
   --------------------------------------------------------------------------
   Every mutating action is guarded by requireRole('ADMIN'). The original
   only hid the Setup tab with style.display, so any logged-in user could
   still call these functions from the console.
   ========================================================================== */

(function (OEE) {
    'use strict';

    var $ = OEE.utils.$;

    /* ==================================================================
       SETTINGS  (values that used to be hardcoded in the source)
       ================================================================== */
    function loadSettingsForm() {
        var s = OEE.settings;

        if ($('setOeeTarget')) $('setOeeTarget').value = s.oeeTarget;
        if ($('setPerformanceMode')) $('setPerformanceMode').value = s.performanceMode;
        if ($('setCooldownSec')) $('setCooldownSec').value = s.cooldownSec;
        if ($('setRetentionDays')) $('setRetentionDays').value = s.retentionDays;
        if ($('setShiftStartHour')) $('setShiftStartHour').value = s.shiftStartHour;
        if ($('setShiftLengthHours')) $('setShiftLengthHours').value = s.shiftLengthHours;

        /* keep the "TARGET nn%" label on the station card in sync */
        var tag = $('infoOeeTarget');
        if (tag) tag.textContent = 'TARGET ' + s.oeeTarget + '%';
    }

    var FIELDS = [
        { key: 'oeeTarget', el: 'setOeeTarget', parse: function (v) { return parseInt(v, 10); } },
        { key: 'performanceMode', el: 'setPerformanceMode', parse: function (v) { return v; } },
        { key: 'cooldownSec', el: 'setCooldownSec', parse: function (v) { return parseInt(v, 10); } },
        { key: 'retentionDays', el: 'setRetentionDays', parse: function (v) { return parseInt(v, 10); } },
        { key: 'shiftStartHour', el: 'setShiftStartHour', parse: function (v) { return parseInt(v, 10); } },
        /* parseFloat: an 8h30 shift must stay 8.5, not be truncated to 8 */
        { key: 'shiftLengthHours', el: 'setShiftLengthHours', parse: function (v) { return parseFloat(v); } }
    ];

    function saveSettings() {
        if (!OEE.auth.requireRole('ADMIN')) return;

        var next = Object.assign({}, OEE.settings);
        var rejected = [];

        FIELDS.forEach(function (field) {
            var input = $(field.el);
            if (!input) return;

            var result = OEE.validateSetting(
                field.key,
                field.parse(input.value),
                OEE.settings[field.key]
            );

            if (result.ok) {
                next[field.key] = result.value;
            } else {
                rejected.push(OEE.config.settings[field.key].label);
            }
        });

        if (rejected.length) {
            OEE.utils.toast(
                'Out of range, keeping the previous value: ' + rejected.join(', ') + '.',
                'warn', 6000
            );
        }

        OEE.settings = next;
        OEE.db.settings = next;

        OEE.metrics.invalidateCache();
        OEE.storage.save();

        loadSettingsForm();
        OEE.refreshActiveScreen();

        if (!rejected.length) OEE.utils.toast('Production settings saved.', 'success');
    }

    /* ==================================================================
       TABLE RENDERING
       ================================================================== */
    function render() {
        if (!OEE.currentUser) return;

        renderModels();
        renderStops();
        renderMachines();
        renderUsers();
        loadSettingsForm();
        refreshFirebaseSecurityNotice();
    }

    function renderModels() {
        var body = $('setupModelsTable');
        if (!body) return;

        body.textContent = '';

        (OEE.db.models || []).forEach(function (mod) {
            var tr = document.createElement('tr');

            var name = document.createElement('td');
            var b = document.createElement('strong');
            b.textContent = mod.name;
            name.appendChild(b);

            var layers = document.createElement('td');
            layers.textContent = mod.layers;

            var spec = document.createElement('td');
            spec.textContent = mod.rating + ' (' + mod.voltage + ')';

            tr.appendChild(name);
            tr.appendChild(layers);
            tr.appendChild(spec);
            tr.appendChild(stdInput(mod, 'stdBoxSec'));
            tr.appendChild(stdInput(mod, 'stdLayerSec'));
            tr.appendChild(stdEffectiveNote(mod));
            tr.appendChild(iconButton('🗑️', 'delete-model', mod.id));

            body.appendChild(tr);
        });
    }

    /* Inline editable standard time, committed on change.
       0 means AUTO: use the model's own measured average. */
    function stdInput(mod, field) {
        var td = document.createElement('td');

        var input = document.createElement('input');
        input.type = 'number';
        input.min = '0';
        input.step = '10';
        input.className = 'form-control std-input';
        input.value = mod[field] > 0 ? mod[field] : 0;
        input.placeholder = 'auto';
        input.setAttribute('data-action', 'save-std');
        input.setAttribute('data-model', mod.id);
        input.setAttribute('data-field', field);

        td.appendChild(input);
        return td;
    }

    /* Show what the engine is actually using right now, so a 0 is not
       mistaken for "no standard". */
    function stdEffectiveNote(mod) {
        var s = OEE.metrics.standardsForModel(mod);
        var box = s.boxAuto ? 'auto ' + Math.round(s.boxSec) + 's'
                            : Math.round(s.stdBoxSec) + 's';
        var layer = s.layerAuto ? 'auto ' + Math.round(s.layerSec) + 's'
                                : Math.round(s.stdLayerSec) + 's';

        var td = document.createElement('td');
        td.className = 'fs-11 text-muted';
        td.textContent = 'box ' + box + ' / layer ' + layer +
                         (s.boxAuto || s.layerAuto ? '' : ' (fallback)');
        td.style.whiteSpace = 'nowrap';
        return td;
    }

    function updateModelStd(modelId, field, rawValue) {
        if (!OEE.auth.requireRole('ADMIN')) return;

        if (field !== 'stdBoxSec' && field !== 'stdLayerSec') return;

        var mod = (OEE.db.models || []).filter(function (m) { return m.id === modelId; })[0];
        if (!mod) return;

        var value = parseInt(rawValue, 10);

        if (!isFinite(value) || value < 0) {
            OEE.utils.toast('Standard time must be 0 (auto) or a positive number of seconds.', 'warn');
            renderModels();
            return;
        }

        mod[field] = value;
        OEE.metrics.invalidateCache();
        OEE.storage.save();
        renderModels();

        OEE.utils.toast(
            mod.name + ': ' + (field === 'stdBoxSec' ? 'box' : 'layer') +
            ' standard = ' + (value === 0 ? 'AUTO (measured average)' : value + 's'),
            'success'
        );
    }

    function renderStops() {
        var body = $('setupStopsTable');
        if (!body) return;

        body.textContent = '';

        (OEE.db.stopReasons || []).forEach(function (s) {
            var tr = document.createElement('tr');

            var name = document.createElement('td');
            name.textContent = s.name;

            var cat = document.createElement('td');
            cat.className = 'fw-700';
            cat.style.color = s.category === 'UNPLANNED' ? 'var(--red)' : 'var(--amber)';
            cat.textContent = s.category;

            var actions = document.createElement('td');
            actions.appendChild(iconButton('🗑️', 'delete-stop', s.id));

            tr.appendChild(name);
            tr.appendChild(cat);
            tr.appendChild(actions);
            body.appendChild(tr);
        });
    }

    function renderMachines() {
        var body = $('setupMachinesTable');
        if (!body) return;

        body.textContent = '';

        OEE.machines.getAll().forEach(function (m) {
            var tr = document.createElement('tr');

            var code = document.createElement('td');
            var b = document.createElement('strong');
            b.textContent = m.code;
            code.appendChild(b);

            var name = document.createElement('td');
            name.textContent = m.name;

            var status = document.createElement('td');
            status.textContent = m.status;

            var actions = document.createElement('td');

            var standby = document.createElement('button');
            standby.className = 'btn-sm';
            standby.setAttribute('data-action', 'set-standby');
            standby.setAttribute('data-code', m.code);
            standby.textContent = 'Set Standby';
            actions.appendChild(standby);

            tr.appendChild(code);
            tr.appendChild(name);
            tr.appendChild(status);
            tr.appendChild(actions);
            body.appendChild(tr);
        });
    }

    function renderUsers() {
        var body = $('setupUsersTable');
        if (!body) return;

        body.textContent = '';

        (OEE.db.users || []).forEach(function (u) {
            var tr = document.createElement('tr');

            var name = document.createElement('td');
            var b = document.createElement('strong');
            b.textContent = u.username;
            name.appendChild(b);

            var role = document.createElement('td');
            role.textContent = u.role;

            var actions = document.createElement('td');
            if (u.username !== 'admin') {
                actions.appendChild(iconButton('🗑️', 'delete-user', u.username));
            }

            tr.appendChild(name);
            tr.appendChild(role);
            tr.appendChild(actions);
            body.appendChild(tr);
        });
    }

    function iconButton(glyph, action, id) {
        var btn = document.createElement('button');
        btn.className = 'btn-sm';
        btn.setAttribute('data-action', action);
        btn.setAttribute('data-id', id);
        btn.textContent = glyph;
        return btn;
    }

    /* ==================================================================
       CRUD
       ================================================================== */
    function addTransformerModel() {
        if (!OEE.auth.requireRole('ADMIN')) return;

        var name = $('newModelName').value.trim();
        if (!name) {
            OEE.utils.toast('Enter a model name.', 'warn');
            return;
        }

        OEE.db.models.push({
            id: OEE.utils.uid('m'),
            name: name,
            layers: parseInt($('newModelLayers').value, 10) || 80,
            rating: $('newModelRating').value.trim() || '500 kVA',
            voltage: $('newModelVolt').value.trim() || '13.8kV / 380V',
            /* 0 = AUTO: calibrate the standard from this model's own history */
            stdLayerSec: 0,
            stdBoxSec: 0
        });

        OEE.storage.save();
        render();
        $('newModelName').value = '';
        OEE.utils.toast('Model "' + name + '" added.', 'success');
    }

    function deleteModel(id) {
        if (!OEE.auth.requireRole('ADMIN')) return;

        OEE.db.models = OEE.db.models.filter(function (m) { return m.id !== id; });
        OEE.metrics.invalidateCache();
        OEE.storage.save();
        render();
    }

    function addStopReason() {
        if (!OEE.auth.requireRole('ADMIN')) return;

        var name = $('newStopName').value.trim();
        if (!name) {
            OEE.utils.toast('Enter a stop reason.', 'warn');
            return;
        }

        OEE.db.stopReasons.push({
            id: OEE.utils.uid('s'),
            name: name,
            category: $('newStopCategory').value
        });

        OEE.storage.save();
        render();
        $('newStopName').value = '';
        OEE.utils.toast('Stop reason "' + name + '" added.', 'success');
    }

    function deleteStopReason(id) {
        if (!OEE.auth.requireRole('ADMIN')) return;

        OEE.db.stopReasons = OEE.db.stopReasons.filter(function (s) { return s.id !== id; });
        OEE.storage.save();
        render();
    }

    function addMachine() {
        if (!OEE.auth.requireRole('ADMIN')) return;

        var code = $('newMachCode').value.trim().toUpperCase();
        var name = $('newMachName').value.trim();

        if (!code || !name) {
            OEE.utils.toast('Enter both code and name.', 'warn');
            return;
        }

        /* Codes end up in the storage key and in CSV columns - keep them tame */
        if (!/^[A-Z0-9_-]{1,12}$/.test(code)) {
            OEE.utils.toast('Code may only use letters, numbers, dash and underscore.', 'warn');
            return;
        }

        var exists = OEE.machines.getAll().some(function (m) { return m.code === code; });
        if (exists) {
            OEE.utils.toast('Machine code already exists.', 'warn');
            return;
        }

        OEE.db.machines.push(OEE.createDefaultMachine(code, name));

        OEE.storage.save();
        OEE.machines.populateMachineSelectors();
        render();

        $('newMachCode').value = '';
        $('newMachName').value = '';
        OEE.utils.toast('Machine ' + code + ' added.', 'success');
    }

    function addUser() {
        if (!OEE.auth.requireRole('ADMIN')) return;

        var username = $('newUserName').value.trim();
        var password = $('newUserPass').value;
        var role = $('newUserRole').value;

        if (!username || !password) {
            OEE.utils.toast('Enter a username and a password.', 'warn');
            return;
        }

        if (username.toLowerCase() === 'admin') {
            OEE.utils.toast('"admin" is a reserved username.', 'warn');
            return;
        }

        var taken = (OEE.db.users || []).some(function (u) {
            return u.username.toLowerCase() === username.toLowerCase();
        });
        if (taken) {
            OEE.utils.toast('That username already exists.', 'warn');
            return;
        }

        var record = OEE.crypto.hashPassword(username, password);
        record.role = role;

        OEE.db.users.push(record);

        OEE.storage.save();
        render();

        $('newUserName').value = '';
        $('newUserPass').value = '';
        OEE.utils.toast('User "' + username + '" created.', 'success');
    }

    function deleteUser(username) {
        if (!OEE.auth.requireRole('ADMIN')) return;

        if (username === 'admin') return;

        OEE.db.users = OEE.db.users.filter(function (u) { return u.username !== username; });
        OEE.storage.save();
        render();
    }

    /* ==================================================================
       FACTORY RESET
       ================================================================== */
    function resetFactoryDemoData() {
        if (!OEE.auth.requireRole('ADMIN')) return;

        if (!OEE.utils.confirmDialog(
            'Reset all machines to Standby (100% OEE) and clear the historical log?\n\n' +
            'This deletes every recorded event, note and machine on this PC.')) {
            return;
        }

        var fresh = OEE.createDefaultDB();
        fresh.updatedAt = Date.now();

        OEE.storage.adopt(fresh);

        try {
            window.localStorage.setItem(OEE.config.STORAGE_KEY, JSON.stringify(fresh));
        } catch (e) { /* ignore */ }

        OEE.metrics.invalidateCache();
        OEE.sync.pushNow();

        OEE.machines.populateMachineSelectors();
        render();
        OEE.refreshActiveScreen();

        OEE.utils.toast('All machines reset to clean 100% OEE Standby.', 'success');
    }

    /* ==================================================================
       FIREBASE
       ================================================================== */
    function refreshFirebaseSecurityNotice() {
        var el = $('firebaseSecurityWarning');
        if (!el) return;
        el.classList.toggle('hidden', !OEE.sync.getFirebaseUrl());
    }

    function saveFirebaseUrl() {
        if (!OEE.auth.requireRole('ADMIN')) return;

        var value = $('firebaseUrlInput').value.trim();
        OEE.sync.setFirebaseUrl(value);

        refreshFirebaseSecurityNotice();

        if (value) {
            OEE.utils.toast(
                'Connecting to Firebase... every PC using this URL syncs every ' +
                Math.round(OEE.config.tech.cloudPollMs / 1000) + ' seconds. ' +
                'Watch the status line below and the badge in the top bar.',
                'info', 5000
            );
        } else {
            OEE.utils.toast('Switched to Local Sync mode.', 'info');
        }
    }

    OEE.views = OEE.views || {};
    OEE.views.setup = {
        render: render,
        loadSettingsForm: loadSettingsForm,
        saveSettings: saveSettings,
        addTransformerModel: addTransformerModel,
        deleteModel: deleteModel,
        updateModelStd: updateModelStd,
        addStopReason: addStopReason,
        deleteStopReason: deleteStopReason,
        addMachine: addMachine,
        addUser: addUser,
        deleteUser: deleteUser,
        resetFactoryDemoData: resetFactoryDemoData,
        saveFirebaseUrl: saveFirebaseUrl,
        refreshFirebaseSecurityNotice: refreshFirebaseSecurityNotice
    };

}(window.OEE = window.OEE || {}));
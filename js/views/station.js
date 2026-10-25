/* ==========================================================================
   views/station.js — Operator station
   --------------------------------------------------------------------------
   The screen the operator actually works on: machine selector, the big pad,
   the transformer card, the live OEE card and the layer/note history.

   Rendering is split into parts so the 1-second heartbeat only touches the
   timer and the OEE numbers instead of rebuilding the whole column.

   All user-supplied text (SN, model, stop reason, notes, operator) goes
   through escapeHtml() or textContent.
   ========================================================================== */

(function (OEE) {
    'use strict';

    var $ = OEE.utils.$;
    var fmt = OEE.utils.formatTimer;

    /* ------------------------------------------------------------------
       Cooldown: per machine, stored as an absolute timestamp.
       The original used a single global boolean, so switching machines
       during the 3 s window locked the *other* machine too.
       ------------------------------------------------------------------ */
    var cooldownUntil = Object.create(null);

    function isCoolingDown(code) {
        return Date.now() < (cooldownUntil[code] || 0);
    }

    function triggerCooldown(code) {
        cooldownUntil[code] = Date.now() + (OEE.settings.cooldownSec * 1000);

        /* paint the locked state immediately */
        renderMainPad(OEE.machines.getByCode(code));

        setTimeout(function () {
            delete cooldownUntil[code];
            if (OEE.machines.getActiveMachine() &&
                OEE.machines.getActiveMachine().code === code &&
                isStationVisible()) {
                render();
            }
        }, OEE.settings.cooldownSec * 1000 + 50);
    }

    function isStationVisible() {
        return !$('viewStation').classList.contains('hidden');
    }

    /* ==================================================================
       RENDER
       ================================================================== */
    function render() {
        var m = OEE.machines.getActiveMachine();
        if (!m) return;

        renderStatusBadge(m);
        renderTransformerCard(m);
        renderMainPad(m);
        renderStationOEE(m.code);
        renderLayerHistory(m);
        renderNotes(m.code);
    }

    /* --- status pill --------------------------------------------------- */
    function renderStatusBadge(m) {
        var badge = $('stationStatusBadge');
        var text = $('stationStatusText');
        if (!badge || !text) return;

        badge.className = 'status-pill status-' + m.status;

        if (m.status === 'IDLE') text.textContent = 'STANDBY / IDLE';
        else if (m.status === 'RUNNING') text.textContent = 'RUNNING';
        else if (m.status === 'PLANNED') text.textContent = 'PLANNED STOP (' + m.stopReason + ')';
        else text.textContent = 'UNPLANNED / SETUP (' + m.stopReason + ')';
    }

    /* --- transformer card ---------------------------------------------- */
    function renderTransformerCard(m) {
        var t = m.transformer;

        if (!t) {
            var idle = m.status === 'IDLE';

            OEE.utils.setText('subbarTransfInfo',
                idle ? 'Standby - Waiting Operator to Start'
                     : 'Machine in Changeover - Waiting Next Transformer');

            OEE.utils.setText('infoSN', 'NO ACTIVE UNIT');
            OEE.utils.setText('infoModel',
                idle ? 'Machine on Standby (OEE at 100%)'
                     : 'Machine in Changeover (Planned Stop)');

            ['infoWO', 'infoBatch', 'infoRating'].forEach(function (id) {
                OEE.utils.setText(id, '—');
            });

            OEE.utils.setText('infoReworks', '0');
            OEE.utils.setText('infoPercent', '0%');
            OEE.utils.setText('infoLayerCount', '0 / 0 layers');

            var fill = $('infoProgFill');
            if (fill) fill.style.width = '0%';
            return;
        }

        OEE.utils.setText('subbarTransfInfo',
            t.sn + ' • Batch ' + t.batch + ' • ' +
            (OEE.currentUser ? OEE.currentUser.shift : ''));

        OEE.utils.setText('infoSN', t.sn);
        OEE.utils.setText('infoModel', t.modelName);
        OEE.utils.setText('infoWO', t.wo);
        OEE.utils.setText('infoBatch', t.batch);
        OEE.utils.setText('infoRating', t.rating + ' • ' + t.voltage);
        OEE.utils.setText('infoReworks', t.reworkedLayers || 0);

        var doneLayers = t.phase === 'BOX'
            ? 0
            : (t.phase === 'FINALIZE' ? t.totalLayers : t.currentLayer - 1);

        var pct = t.totalLayers > 0
            ? ((doneLayers / t.totalLayers) * 100).toFixed(1)
            : '0.0';

        OEE.utils.setText('infoPercent', pct + '%');
        OEE.utils.setText('infoLayerCount', doneLayers + ' / ' + t.totalLayers + ' layers');

        var bar = $('infoProgFill');
        if (bar) bar.style.width = pct + '%';
    }

    /* --- the big pad ---------------------------------------------------- */
    function renderMainPad(m) {
        var pad = $('mainPad');
        if (!pad || !m) return;

        pad.textContent = '';

        var cooling = isCoolingDown(m.code);

        /* Case 0 - standby / idle, nothing to do */
        if (m.status === 'IDLE' && !m.transformer) {
            pad.className = 'main-pad pad-idle';
            pad.appendChild(badge('⚪ MACHINE ON STANDBY (OEE 100%)', 'badge-idle'));
            pad.appendChild(title('READY TO START PRODUCTION', 'fs-30 mt-4'));
            pad.appendChild(sub('NO DOWNTIME COUNTING WHILE IN STANDBY'));
            pad.appendChild(padButton('+ START NEW TRANSFORMER', 'start-transformer'));
            return;
        }

        /* Case 1 - machine in changeover, waiting for the next transformer */
        if (!m.transformer) {
            pad.className = 'main-pad pad-setup';
            pad.appendChild(badge('🟡 MACHINE IN SETUP / CHANGEOVER', 'badge-amber'));
            pad.appendChild(bigTimer(m.stateStartTime, 'timer-amber'));
            pad.appendChild(sub('PLANNED STOP (DOES NOT HURT AVAILABILITY)'));
            pad.appendChild(padButton('+ NEW TRANSFORMER (EXIT SETUP)', 'start-transformer'));
            return;
        }

        /* Case 2 - machine paused */
        if (m.status !== 'RUNNING') {
            var isPlanned = m.status === 'PLANNED';

            pad.className = 'main-pad pad-stopped';
            pad.appendChild(badge(
                '⏸ ' + m.status + ' STOP: ' + m.stopReason,
                isPlanned ? 'badge-amber' : 'badge-red'
            ));
            pad.appendChild(bigTimer(m.stateStartTime, isPlanned ? 'timer-amber' : 'timer-red'));
            pad.appendChild(sub(isPlanned
                ? 'PLANNED STOP (DOES NOT HURT OEE)'
                : 'UNPLANNED DOWNTIME (REDUCING AVAILABILITY IN REAL TIME)'));

            var resume = padButton('▶ RESUME PRODUCTION', 'resume', 'pad-btn-narrow pad-btn-resume');
            pad.appendChild(resume);
            return;
        }

        /* Case 3 - running */
        var t = m.transformer;
        pad.className = 'main-pad' + (cooling ? ' pad-cooldown' : '');

        if (t.phase === 'BOX') {
            pad.appendChild(badge('STEP 1 OF 3 • BOX ASSEMBLY & 1ST COMPONENTS'));
            pad.appendChild(bigTimer(m.stepStartTime, 'timer-green'));
            pad.appendChild(sub('ASSEMBLE BOX & FIRST COMPONENT LAYER'));
            pad.appendChild(title(cooling ? '⏳ WAIT ' + OEE.settings.cooldownSec + 's...' : 'BOX DONE → START LAYER 1'));
            pad.appendChild(hint('TAP • SPACE • ENTER • FOOT PEDAL'));

        } else if (t.phase === 'LAYER') {
            pad.appendChild(badge('WINDING LAYER ' + t.currentLayer + ' / ' + t.totalLayers));
            pad.appendChild(bigTimer(m.stepStartTime, 'timer-green'));
            pad.appendChild(sub('COPPER WINDING + INSULATION + COMPONENTS'));
            pad.appendChild(title(cooling
                ? '⏳ LOCKED (' + OEE.settings.cooldownSec + 's COOLDOWN)...'
                : 'LAYER DONE'));
            pad.appendChild(hint('TAP • SPACE • ENTER • FOOT PEDAL'));

        } else if (t.phase === 'FINALIZE') {
            pad.appendChild(badge('ALL ' + t.totalLayers + ' LAYERS COMPLETED!', 'badge-green'));
            pad.appendChild(bigTimer(m.stepStartTime, 'timer-green'));
            pad.appendChild(sub('PERFORM FINAL FINISHING & TAP CHECK'));

            var fin = title(cooling ? '⏳ WAIT ' + OEE.settings.cooldownSec + 's...'
                                    : '✅ FINALIZE TRANSFORMER',
                            'finalize-ready');
            pad.appendChild(fin);
            pad.appendChild(hint('PRESS TO COMPLETE & ENTER SETUP MODE'));
        }
    }

    /* Pad sub-element builders (DOM nodes, never innerHTML) */
    function badge(text, extraClass) {
        var el = document.createElement('span');
        el.className = 'step-badge' + (extraClass ? ' ' + extraClass : '');
        el.textContent = text;
        return el;
    }

    function title(text, extraClass) {
        var el = document.createElement('div');
        el.className = 'pad-action-title' + (extraClass ? ' ' + extraClass : '');
        el.textContent = text;
        return el;
    }

    function sub(text) {
        var el = document.createElement('div');
        el.className = 'est-sub';
        el.textContent = text;
        return el;
    }

    function hint(text) {
        var el = document.createElement('div');
        el.className = 'pedal-hint';
        el.textContent = text;
        return el;
    }

    function bigTimer(since, colorClass) {
        var el = document.createElement('div');
        el.className = 'big-timer ' + (colorClass || 'timer-green');
        el.id = 'liveMainTimer';
        el.textContent = fmt(Math.max(0, (Date.now() - since) / 1000));
        return el;
    }

    function padButton(text, action, extraClass) {
        var btn = document.createElement('button');
        btn.className = 'btn-primary pad-btn' + (extraClass ? ' ' + extraClass : '');
        btn.setAttribute('data-action', action);
        btn.textContent = text;
        return btn;
    }

    /* --- live OEE card --------------------------------------------------
       Measured against the CURRENT SHIFT, not a rolling window: the shift
       has a fixed denominator, so a loss recorded at the start of the shift
       is still fully visible at the end. */
    function renderStationOEE(machineCode) {
        var m = OEE.metrics.computeShiftMetrics(machineCode);

        OEE.utils.setMetric('stationOEE', m.oee + '%', m.oeeTarget);

        /* Performance with no completed step has nothing to compare against,
           so show "-" rather than a flat 100% that looks stuck. */
        if (m.performanceMode === 'LEARNED' && !m.perfHasData) {
            OEE.utils.setText('stationPerf', '—');
        } else {
            OEE.utils.setText('stationPerf', m.perf + '%');
        }

        OEE.utils.setText('stationAvail', m.avail + '%');
        OEE.utils.setText('stationQual', m.qual + '%');
    }

    /* --- layer history ---------------------------------------------------
       Shows the manufacturing steps AND every downtime, planned or not, so
       the operator sees the whole story of the machine in one list.       */
    var HISTORY_TYPES = [
        'BOX_DONE', 'LAYER_DONE', 'REWORK', 'TRANSF_FINISHED',
        'STOP_UNPLANNED', 'STOP_PLANNED'
    ];

    function isStopEvent(e) {
        return e.type === 'STOP_UNPLANNED' || e.type === 'STOP_PLANNED';
    }

    function hhmm(ts) {
        if (!OEE.utils.isFiniteNumber(ts)) return '--:--';
        return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    }

    function renderLayerHistory(m) {
        var box = $('subTabLayersContent');
        if (!box) return;

        var rows = (OEE.db.events || []).filter(function (e) {
            return e.machineCode === m.code && HISTORY_TYPES.indexOf(e.type) !== -1;
        }).slice(0, OEE.config.tech.layerHistoryLimit);

        box.textContent = '';

        if (!rows.length) {
            box.appendChild(emptyNote('No activity recorded on ' + m.code + ' yet.'));
            return;
        }

        rows.forEach(function (e) {
            box.appendChild(isStopEvent(e) ? buildStopItem(e) : buildStepItem(e));
        });
    }

    /* --- a completed step / rework ---------------------------------------- */
    function buildStepItem(e) {
        var isRework = e.type === 'REWORK';

        var item = document.createElement('div');
        item.className = 'layer-log-item' + (isRework ? ' rework' : '');

        var left = document.createElement('div');

        var head = document.createElement('div');
        var strong = document.createElement('strong');
        strong.className = isRework ? 'am' : 'gr';
        strong.textContent = isRework ? '↺ REWORK: ' : '✓ STEP DONE: ';

        var detail = document.createElement('span');
        detail.style.marginLeft = '4px';
        detail.textContent = e.detail;

        var meta = document.createElement('div');
        meta.className = 'fs-11 text-muted';
        meta.textContent = '👤 ' + e.operator + ' • ' + e.timeStr;

        head.appendChild(strong);
        head.appendChild(detail);
        left.appendChild(head);
        left.appendChild(meta);

        var right = document.createElement('div');
        right.className = 'mono fw-800 cy';
        right.style.fontSize = '13px';
        right.textContent = isRework
            ? '-' + (e.layersLost || 0) + ' Lay.'
            : fmt(e.durationSec);

        item.appendChild(left);
        item.appendChild(right);
        return item;
    }

    /* --- a downtime (planned or unplanned) ------------------------------- */
    function buildStopItem(e) {
        var planned = e.type === 'STOP_PLANNED';

        var item = document.createElement('div');
        item.className = 'layer-log-item stop ' + (planned ? 'planned' : 'unplanned');

        var left = document.createElement('div');

        /* badge: PLANNED / UNPLANNED */
        var head = document.createElement('div');

        var badge = document.createElement('strong');
        badge.className = 'stop-badge ' + (planned ? 'badge-planned' : 'badge-unplanned');
        badge.textContent = planned ? '⏸ PLANNED STOP' : '🔴 UNPLANNED STOP';

        var reason = document.createElement('span');
        reason.style.marginLeft = '6px';
        reason.textContent = e.reason || stripPrefix(e.detail, 'Stopped: ');

        var meta = document.createElement('div');
        meta.className = 'fs-11 text-muted';
        meta.textContent = '👤 ' + e.operator + ' • ' +
            hhmm(e.startTime) + ' → ' + hhmm(e.endTime || e.timestamp);

        head.appendChild(badge);
        head.appendChild(reason);

        if (e.wo) {
            var wo = document.createElement('span');
            wo.className = 'stop-badge badge-wo';
            wo.style.marginLeft = '6px';
            wo.textContent = 'OS ' + e.wo;
            head.appendChild(wo);
        }

        left.appendChild(head);
        left.appendChild(meta);

        var right = document.createElement('div');
        right.className = 'mono fw-800 ' + (planned ? 'am' : 'rd');
        right.style.fontSize = '13px';
        right.textContent = fmt(e.durationSec);

        item.appendChild(left);
        item.appendChild(right);
        return item;
    }

    function stripPrefix(text, prefix) {
        var s = String(text || '');
        return s.indexOf(prefix) === 0 ? s.slice(prefix.length) : s;
    }

    /* --- shift notes ------------------------------------------------------ */
    function renderNotes(machineCode) {
        var box = $('subTabNotesContent');
        if (!box) return;

        var rows = (OEE.db.notes || []).filter(function (n) {
            return n.machineCode === machineCode;
        }).slice(0, OEE.config.tech.noteHistoryLimit);

        box.textContent = '';

        if (!rows.length) {
            box.appendChild(emptyNote('No shift notes recorded for ' + machineCode + ' yet.'));
            return;
        }

        rows.forEach(function (n) {
            var item = document.createElement('div');
            item.className = 'note-item';

            var head = document.createElement('div');
            head.className = 'note-head';

            var who = document.createElement('strong');
            who.textContent = '👤 ' + n.operator + ' • ' + n.sn;

            var when = document.createElement('span');
            when.textContent = n.timeStr;

            head.appendChild(who);
            head.appendChild(when);

            var ctx = document.createElement('div');
            ctx.className = 'cy fw-700';
            ctx.style.fontSize = '11px';
            ctx.textContent = '[' + n.stepLabel + ' • ' + n.subStep + ']';

            var body = document.createElement('div');
            body.style.marginTop = '2px';
            body.textContent = n.text;

            item.appendChild(head);
            item.appendChild(ctx);
            item.appendChild(body);
            box.appendChild(item);
        });
    }

    function emptyNote(text) {
        var el = document.createElement('div');
        el.className = 'empty-hint';
        el.textContent = text;
        return el;
    }

    /* ==================================================================
       PRODUCTION FLOW
       ================================================================== */
    function handleMainPadPress() {
        if (!OEE.auth.requireLogin()) return;

        var m = OEE.machines.getActiveMachine();
        if (!m || !m.transformer || m.status !== 'RUNNING') return;
        if (isCoolingDown(m.code)) return;

        var now = Date.now();
        var t = m.transformer;
        var stepDur = (now - m.stepStartTime) / 1000;

        /* Snapshot for Undo. Store the id of the event we are about to
           create, so Undo removes exactly that record instead of guessing. */
        m.undoSnapshot = OEE.utils.deepClone(t);
        m.undoSnapshot.stepStartTime = m.stepStartTime;
        m.undoSnapshot.eventType = null;

        if (t.phase === 'BOX') {
            m.undoSnapshot.eventType = 'BOX_DONE';
            OEE.log.logEvent(m.code, 'BOX_DONE', 'Box Assembly (' + t.sn + ')', stepDur, {
                modelName: t.modelName, modelId: t.modelId, sn: t.sn
            });

            t.phase = 'LAYER';
            t.currentLayer = 1;
            m.stepStartTime = now;
            triggerCooldown(m.code);

        } else if (t.phase === 'LAYER') {
            m.undoSnapshot.eventType = 'LAYER_DONE';
            OEE.log.logEvent(m.code, 'LAYER_DONE',
                'Layer ' + t.currentLayer + '/' + t.totalLayers + ' (' + t.sn + ')',
                stepDur,
                { modelName: t.modelName, modelId: t.modelId, sn: t.sn, layer: t.currentLayer });

            t.goodLayersCompleted = (t.goodLayersCompleted || 0) + 1;

            if (t.currentLayer < t.totalLayers) {
                t.currentLayer++;
            } else {
                t.phase = 'FINALIZE';
            }

            m.stepStartTime = now;
            triggerCooldown(m.code);

        } else if (t.phase === 'FINALIZE') {
            OEE.log.logEvent(m.code, 'TRANSF_FINISHED', 'Finalized ' + t.sn + ' (' + t.batch + ')',
                stepDur, { modelName: t.modelName, modelId: t.modelId, sn: t.sn });

            m.transformer = null;
            m.undoSnapshot = null;

            /* Finishing a transformer moves the machine into changeover.
               Deliberately PLANNED: it is a known, conscious stop, and it must
               not be charged against Availability. A dedicated changeover KPI
               can be built later without rewriting the history, because the
               reason is already recorded on the stop record. */
            OEE.log.bankRunSegment(m, 'finishing ' + t.sn);

            m.status = 'PLANNED';
            m.stopReason = 'Setup / Changeover';
            m.stateStartTime = now;
            m.stepStartTime = now;
        }

        OEE.storage.save();
        render();
    }

    function undoLastPress() {
        if (!OEE.auth.requireLogin()) return;

        var m = OEE.machines.getActiveMachine();

        if (!m || !m.transformer || !m.undoSnapshot) {
            OEE.utils.toast('No recent step press available to undo on this transformer.', 'warn');
            return;
        }

        /* Remove the exact event that this press created. */
        var type = m.undoSnapshot.eventType;
        if (type) removeLatestEventOfType(m.code, type);

        m.transformer = OEE.utils.deepClone(m.undoSnapshot);
        delete m.transformer.eventType;
        delete m.transformer.stepStartTime;

        m.stepStartTime = m.undoSnapshot.stepStartTime || Date.now();
        m.undoSnapshot = null;

        OEE.storage.save();
        render();
        OEE.utils.toast('Last press undone.', 'success');
    }

    function removeLatestEventOfType(machineCode, type) {
        var events = OEE.db.events || [];
        for (var i = 0; i < events.length; i++) {
            var e = events[i];
            if (e.machineCode === machineCode && e.type === type) {
                events.splice(i, 1);
                return true;
            }
        }
        return false;
    }

    /* ==================================================================
       NEW TRANSFORMER
       ================================================================== */
    function openNewTransformerModal() {
        if (!OEE.auth.requireLogin()) return;

        var sel = $('ntModelSelect');
        sel.textContent = '';

        (OEE.db.models || []).forEach(function (mod, i) {
            var opt = document.createElement('option');
            opt.value = mod.id;
            opt.textContent = mod.name + ' (' + mod.layers + ' layers)';
            if (i === 0) opt.selected = true;
            sel.appendChild(opt);
        });

        autoFillModelSpecs();
        $('ntSN').value = 'SN ' + Math.floor(100 + Math.random() * 899);
        $('ntWO').value = 'WO-' + Math.floor(1000 + Math.random() * 8999);

        OEE.utils.openModal('modalNewTransf');
    }

    function autoFillModelSpecs() {
        var modId = $('ntModelSelect').value;
        var mod = (OEE.db.models || []).filter(function (m) { return m.id === modId; })[0];
        if (mod) $('ntLayers').value = mod.layers;
    }

    function confirmStartTransformer() {
        if (!OEE.auth.requireLogin()) return;

        var m = OEE.machines.getActiveMachine();
        if (!m) return;

        var models = OEE.db.models || [];
        var modId = $('ntModelSelect').value;
        var mod = models.filter(function (x) { return x.id === modId; })[0] || models[0];

        var sn = $('ntSN').value.trim() || 'SN-001';
        var wo = $('ntWO').value.trim() || 'WO-001';
        var batch = $('ntBatch').value.trim() || '1 of 1';
        var layers = parseInt($('ntLayers').value, 10) || 80;

        var now = Date.now();

        /* Bank whatever downtime was open. The original only did this for
           UNPLANNED, so a PLANNED stop (e.g. shift handover) left no record
           at all in the history and in the Pareto analysis. */
        if (m.status !== 'RUNNING' && m.status !== 'IDLE') {
            OEE.log.bankStopSegment(
                m,
                m.status === 'UNPLANNED' ? 'STOP_UNPLANNED' : 'STOP_PLANNED',
                m.stopReason || (m.status === 'UNPLANNED' ? 'Setup / Changeover' : 'Planned stop')
            );
        }

        m.transformer = {
            sn: sn,
            wo: wo,
            batch: batch,
            modelId: mod ? mod.id : '',
            modelName: mod ? mod.name : 'Custom Model',
            rating: mod ? mod.rating : '—',
            voltage: mod ? mod.voltage : '—',
            totalLayers: layers,
            phase: 'BOX',
            currentLayer: 1,
            goodLayersCompleted: 0,
            reworkedLayers: 0
        };

        m.status = 'RUNNING';
        m.stopReason = '';
        m.stopWo = '';
        m.stateStartTime = now;
        m.stepStartTime = now;
        m.undoSnapshot = null;

        OEE.storage.save();
        OEE.utils.closeModal('modalNewTransf');
        render();
        OEE.utils.toast('Started ' + sn + '.', 'success');
    }

    /* ==================================================================
       STOP / PAUSE
       ================================================================== */

    /* Only the "Machine breakdown" reason requires a CMMS work order. */
    function isBreakdownReason(reasonName) {
        return String(reasonName == null ? '' : reasonName)
            .trim().toLowerCase().replace(/\s+/g, ' ') === 'machine breakdown';
    }

    /* Accepts "WO-0001", "wo 1", "0001" or "1" and always returns WO-0001.
       Anything else returns '' so the stop is rejected. */
    function normalizeCmmsWo(raw) {
        var s = String(raw == null ? '' : raw).trim().toUpperCase();
        if (!s) return '';

        var match = /^WO[-\s]?(\d+)$/.exec(s) || /^(\d+)$/.exec(s);
        if (!match) return '';

        var digits = match[1];
        if (digits.length < 4) digits = ('0000' + digits).slice(-4);

        return 'WO-' + digits;
    }

    function showWoField(reasonName, category) {
        var section = $('stopWoSection');
        var input = $('stopWoInput');
        var confirm = $('stopWoConfirmBtn');
        if (!section) return;

        if (confirm) {
            confirm.setAttribute('data-reason', reasonName);
            confirm.setAttribute('data-category', category);
        }

        section.classList.remove('hidden');
        if (input) input.focus();
    }

    function hideWoField() {
        var section = $('stopWoSection');
        var input = $('stopWoInput');
        if (section) section.classList.add('hidden');
        if (input) input.value = '';
    }

    function openStopModal() {
        if (!OEE.auth.requireLogin()) return;

        var m = OEE.machines.getActiveMachine();
        if (!m || m.status !== 'RUNNING') {
            OEE.utils.toast('Machine must be RUNNING to trigger a Stop.', 'warn');
            return;
        }

        var unplanned = $('stopGridUnplanned');
        var planned = $('stopGridPlanned');

        unplanned.textContent = '';
        planned.textContent = '';

        (OEE.db.stopReasons || []).forEach(function (r) {
            var btn = document.createElement('button');

            /* data-* instead of an interpolated onclick="..." - this is what
               closed the attribute-injection hole (a reason named
               "'); alert(1); //" used to break out of the handler). */
            btn.className = 'stop-option-btn ' + r.category.toLowerCase();
            btn.setAttribute('data-action', 'confirm-stop');
            btn.setAttribute('data-reason', r.name);
            btn.setAttribute('data-category', r.category);
            btn.textContent = r.name;

            (r.category === 'PLANNED' ? planned : unplanned).appendChild(btn);
        });

        hideWoField();
        OEE.utils.openModal('modalStop');
    }

    function confirmStopMachine(reasonName, category, woValue) {
        var m = OEE.machines.getActiveMachine();
        if (!m || m.status !== 'RUNNING') {
            OEE.utils.toast('Machine must be RUNNING to trigger a Stop.', 'warn');
            return false;
        }

        var wo = '';

        if (isBreakdownReason(reasonName)) {
            wo = normalizeCmmsWo(
                woValue != null ? woValue : ($('stopWoInput') ? $('stopWoInput').value : '')
            );

            /* Mandatory for breakdowns: reveal the field and refuse to save. */
            if (!wo) {
                showWoField(reasonName, category);
                OEE.utils.toast('Enter the CMMS work order for the breakdown (e.g. WO-0001).', 'warn');
                return false;
            }
        } else {
            hideWoField();
        }

        /* Bank the running time BEFORE flipping the state, otherwise this
           interval is never recorded anywhere. */
        OEE.log.bankRunSegment(m, reasonName);

        m.status = category;
        m.stopReason = reasonName;
        m.stopWo = wo;
        m.stateStartTime = Date.now();

        hideWoField();
        OEE.storage.save();
        OEE.utils.closeModal('modalStop');
        render();
        return true;
    }

    function resumeMachineFromStop() {
        var m = OEE.machines.getActiveMachine();
        if (!m || m.status === 'RUNNING') return;

        var now = Date.now();
        var evType = m.status === 'UNPLANNED' ? 'STOP_UNPLANNED' : 'STOP_PLANNED';

        OEE.log.bankStopSegment(m, evType, m.stopReason || m.status);

        m.status = 'RUNNING';
        m.stopReason = '';
        m.stopWo = '';
        m.stateStartTime = now;
        m.stepStartTime = now;

        OEE.storage.save();
        render();
    }

    /* ==================================================================
       REWORK
       ================================================================== */
    function openReworkModal() {
        if (!OEE.auth.requireLogin()) return;

        var m = OEE.machines.getActiveMachine();

        if (!m || !m.transformer || m.transformer.phase !== 'LAYER') {
            OEE.utils.toast('Rework / Return Layer is only available while winding layers.', 'warn');
            return;
        }

        $('rwCurrentLayer').value = 'Layer ' + m.transformer.currentLayer +
                                    ' of ' + m.transformer.totalLayers;
        $('rwTargetLayer').value = m.transformer.currentLayer;
        $('rwTargetLayer').max = m.transformer.currentLayer;
        $('rwReason').value = '';

        OEE.utils.openModal('modalRework');
    }

    function confirmReworkLayer() {
        var m = OEE.machines.getActiveMachine();
        if (!m || !m.transformer) return;

        var t = m.transformer;
        var target = parseInt($('rwTargetLayer').value, 10);
        var reason = $('rwReason').value.trim() || 'Layer rework';

        if (!isFinite(target) || target < 1 || target > t.currentLayer) {
            OEE.utils.toast('Enter a valid layer between 1 and ' + t.currentLayer + '.', 'warn');
            return;
        }

        /* Layers that are physically undone. The original used
           (current - target) + 1, which charged the operator for the layer
           they are standing on even when nothing was unwound. */
        var layersLost = t.currentLayer - target;
        var rewindingCurrent = target === t.currentLayer;

        if (rewindingCurrent) {
            /* Redo the current layer from scratch: no finished layer is lost,
               but the layer in progress is restarted and still counts as a
               defect for Quality. */
            layersLost = 1;
        }

        /* Drop the LAYER_DONE records of the layers being redone, otherwise
           those layers keep counting as "good" AND as reworked - a double
           penalty that made Quality never recover. */
        if (layersLost > 0) {
            removeLayerEventsAbove(m.code, t.sn, target);
        }

        t.reworkedLayers = (t.reworkedLayers || 0) + layersLost;
        t.currentLayer = target;
        m.stepStartTime = Date.now();

        /* Price the lost work in seconds: layersLost x the model's effective
           layer standard ("in use" in Setup, AUTO or explicit). Logging 0 here
           made the CSV report show a 0-second rework and hid the cost. */
        var stdLayerSec = OEE.metrics.standardsForModel({ id: t.modelId, name: t.modelName }).layerSec;
        var reworkSec = layersLost * stdLayerSec;

        OEE.log.logEvent(m.code, 'REWORK',
            'Returned to Layer ' + target + ' (' + layersLost +
            (layersLost === 1 ? ' layer' : ' layers') + ' reworked) - ' + reason,
            reworkSec,
            {
                layersLost: layersLost,
                sn: t.sn,
                targetLayer: target,
                /* needed so the shift engine can price the quality loss in
                   seconds against this model's own standard */
                modelId: t.modelId,
                modelName: t.modelName
            }
        );

        OEE.storage.save();
        OEE.utils.closeModal('modalRework');
        render();
        OEE.utils.toast('Rework recorded: ' + layersLost + ' layer(s) affected.', 'warn');
    }

    /* Remove LAYER_DONE events for layers > target of the same transformer */
    function removeLayerEventsAbove(machineCode, sn, target) {
        var events = OEE.db.events || [];
        var kept = [];

        for (var i = 0; i < events.length; i++) {
            var e = events[i];
            var matches = e.type === 'LAYER_DONE' &&
                          e.machineCode === machineCode &&
                          e.sn === sn &&
                          OEE.utils.isFiniteNumber(e.layer) &&
                          e.layer > target;

            if (!matches) kept.push(e);
        }

        OEE.db.events = kept;
    }

    /* ==================================================================
       SHIFT NOTES / HANDOVER
       ================================================================== */
    function openNoteModal(isHandover) {
        if (!OEE.auth.requireLogin()) return;

        OEE.utils.setText('noteModalTitle', isHandover
            ? '🔄 SHIFT HANDOVER (PASSAGEM DE TURNO)'
            : '📝 ADD SHIFT NOTE');

        OEE.utils.setText('noteConfirmBtn', isHandover
            ? '⏸ Pause Machine (Shift Handover) & Sign Out'
            : 'Save Shift Note');

        $('noteText').value = '';
        OEE.utils.openModal('modalNote');

        OEE.isHandoverMode = !!isHandover;
    }

    function confirmSaveNote() {
        if (!OEE.auth.requireLogin()) return;

        var m = OEE.machines.getActiveMachine();
        var subStep = $('noteSubStep').value;
        var text = $('noteText').value.trim();
        var handover = !!OEE.isHandoverMode;

        var stepLabel = m.transformer
            ? (m.transformer.phase === 'LAYER'
                ? 'Layer ' + m.transformer.currentLayer + '/' + m.transformer.totalLayers
                : m.transformer.phase)
            : 'Standby/Setup';

        if (!OEE.storage.isArray(OEE.db.notes)) OEE.db.notes = [];

        OEE.db.notes.unshift({
            id: Date.now(),
            machineCode: m.code,
            sn: m.transformer ? m.transformer.sn : 'Standby',
            operator: OEE.currentUser.username,
            shift: OEE.currentUser.shift,
            timeStr: new Date().toLocaleString('pt-BR'),
            stepLabel: stepLabel,
            subStep: subStep,
            text: text || (handover ? 'Standard shift handover.' : 'Shift note.')
        });

        OEE.log.logEvent(m.code, 'NOTE', '[' + stepLabel + ' - ' + subStep + '] ' + text);

        if (handover) {
            if (m.status === 'RUNNING') {
                OEE.log.bankRunSegment(m, 'Shift Handover');
                m.status = 'PLANNED';
                m.stopReason = 'Shift Handover';
                m.stateStartTime = Date.now();
            }

            OEE.storage.save();
            OEE.utils.closeModal('modalNote');
            OEE.utils.toast('Handover recorded. Signing out.', 'success');
            OEE.auth.logout();
            return;
        }

        OEE.storage.save();
        OEE.utils.closeModal('modalNote');
        OEE.nav.switchRightSubTab('notes');
        renderNotes(m.code);
        OEE.utils.toast('Shift note saved.', 'success');
    }

    /* ==================================================================
       EXPORTS
       ================================================================== */
    OEE.views = OEE.views || {};
    OEE.views.station = {
        render: render,
        renderMainPad: renderMainPad,
        renderStatusBadge: renderStatusBadge,
        renderTransformerCard: renderTransformerCard,
        renderStationOEE: renderStationOEE,
        renderLayerHistory: renderLayerHistory,
        renderNotes: renderNotes,

        handleMainPadPress: handleMainPadPress,
        undoLastPress: undoLastPress,
        isCoolingDown: isCoolingDown,

        openNewTransformerModal: openNewTransformerModal,
        autoFillModelSpecs: autoFillModelSpecs,
        confirmStartTransformer: confirmStartTransformer,

        openStopModal: openStopModal,
        confirmStopMachine: confirmStopMachine,
        resumeMachineFromStop: resumeMachineFromStop,

        openReworkModal: openReworkModal,
        confirmReworkLayer: confirmReworkLayer,

        openNoteModal: openNoteModal,
        confirmSaveNote: confirmSaveNote
    };

}(window.OEE = window.OEE || {}));
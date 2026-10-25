/* ==========================================================================
   views/dashboard.js — KPIs, downtime Pareto, learned times, live machines
   --------------------------------------------------------------------------
   Split into two entry points on purpose:
     render()      full render, called when the view opens, a filter changes
                   or the data changes
     renderLive()  the machines table only, called every second

   The original called the full renderDashboard() every second, which
   rewrote six KPI nodes, the Pareto, the learned-times table and every
   machine row, each machine row recomputing metrics from scratch.
   ========================================================================== */

(function (OEE) {
    'use strict';

    var $ = OEE.utils.$;
    var fmt = OEE.utils.formatTimer;

    function selectedMachine() {
        var sel = $('dashMachineFilter');
        return sel ? sel.value : 'ALL';
    }

    function selectedDays() {
        var sel = $('dashPeriodFilter');
        var d = sel ? parseInt(sel.value, 10) : NaN;
        return isFinite(d) && d > 0 ? d : OEE.config.tech.defaultPeriodDays;
    }

    /* 'shift' -> the fixed-denominator shift window (never heals).
       a number -> a multi-day trend window (classic ratio). */
    function selectedWindowSpec() {
        var sel = $('dashPeriodFilter');
        if (sel && sel.value === 'shift') return 'shift';
        return selectedDays();
    }

    /* Events newer than the selected window. */
    function windowStartMs(spec) {
        if (spec === 'shift') return OEE.metrics.currentShiftWindow(Date.now()).start;
        return Date.now() - (spec * 86400000);
    }

    /* ==================================================================
       FULL RENDER
       ================================================================== */
    function render() {
        if (!OEE.currentUser) return;

        var machine = selectedMachine();
        var spec = selectedWindowSpec();

        var m = spec === 'shift'
            ? OEE.metrics.computeShiftMetrics(machine)
            : OEE.metrics.computeMetrics(machine, spec);

        renderKpis(m);
        renderPareto(machine, windowStartMs(spec));
        renderStopsTable(machine, windowStartMs(spec));
        renderLearned();
        renderLive();
    }

    /* --- KPI cards ------------------------------------------------------ */
    function renderKpis(m) {
        OEE.utils.setMetric('kpiOEE', m.oee + '%', m.oeeTarget);
        OEE.utils.setText('kpiAvail', m.avail + '%');
        OEE.utils.setText('kpiQual', m.qual + '%');

        OEE.utils.setText('kpiPerf',
            (m.performanceMode === 'LEARNED' && !m.perfHasData) ? '—' : m.perf + '%');

        /* No failures recorded -> MTBF/MTTR are undefined, not zero. */
        OEE.utils.setText('kpiMTBF', m.hasFailures ? m.mtbfLabel : '—');
        OEE.utils.setText('kpiMTTR', m.hasFailures ? m.mttrLabel : '—');

        OEE.utils.setText('kpiPerfHint', perfHint(m));
    }

    function perfHint(m) {
        if (m.performanceMode !== 'LEARNED') return 'Fixed 100% (never penalizes)';
        if (!m.perfHasData) return 'No finished step to measure yet';
        if (m.perfCapped) return 'Beating the standard - raise it in Setup';
        return 'Actual pace vs. model standard';
    }

    /* --- Unplanned downtime Pareto -------------------------------------- */
    function renderPareto(machine, fromMs) {
        var host = $('dashParetoList');
        if (!host) return;

        var totals = Object.create(null);
        var total = 0;

        (OEE.db.events || []).forEach(function (e) {
            if (e.type !== 'STOP_UNPLANNED') return;
            if (e.timestamp < fromMs) return;
            if (machine !== 'ALL' && e.machineCode !== machine) return;

            var reason = e.reason || e.detail || 'Unspecified';
            totals[reason] = (totals[reason] || 0) + (e.durationSec || 0);
            total += (e.durationSec || 0);
        });

        host.textContent = '';

        var rows = Object.keys(totals).map(function (reason) {
            return { reason: reason, sec: totals[reason] };
        }).sort(function (a, b) { return b.sec - a.sec; });

        if (!rows.length) {
            host.appendChild(emptyNote('No unplanned downtime recorded (Availability 100%).'));
            return;
        }

        rows.forEach(function (row) {
            var pct = total > 0 ? Math.round((row.sec / total) * 100) : 0;

            var wrap = document.createElement('div');
            wrap.className = 'pareto-row';

            var top = document.createElement('div');
            top.className = 'pareto-top';

            var name = document.createElement('strong');
            name.textContent = row.reason;

            var value = document.createElement('span');
            value.textContent = fmt(row.sec) + ' (' + pct + '%)';

            top.appendChild(name);
            top.appendChild(value);

            var bar = document.createElement('div');
            bar.className = 'pareto-bar';

            var fill = document.createElement('div');
            fill.className = 'pareto-fill';
            fill.style.width = pct + '%';

            bar.appendChild(fill);
            wrap.appendChild(top);
            wrap.appendChild(bar);
            host.appendChild(wrap);
        });
    }

    /* --- Downtime tracking table ----------------------------------------
       Every stop on record: machine, reason, PLANNED/UNPLANNED, window and
       duration. Planned stops stay visible for traceability even though
       they do not count against Availability.                            */
    function collectStops(machine, fromMs) {
        var out = [];

        (OEE.db.events || []).forEach(function (e) {
            if (e.type !== 'STOP_UNPLANNED' && e.type !== 'STOP_PLANNED') return;
            if (e.timestamp < fromMs) return;
            if (machine !== 'ALL' && e.machineCode !== machine) return;
            out.push(e);
        });

        /* newest first */
        out.sort(function (a, b) {
            return (b.startTime || b.timestamp) - (a.startTime || a.timestamp);
        });

        return out;
    }

    function renderStopsTable(machine, fromMs) {
        var body = $('dashStopsTable');
        var summary = $('dashStopSummary');
        if (!body) return;

        var stops = collectStops(machine, fromMs);

        var plannedCount = 0;
        var unplannedCount = 0;
        var plannedSec = 0;
        var unplannedSec = 0;

        stops.forEach(function (e) {
            if (e.type === 'STOP_UNPLANNED') { unplannedCount++; unplannedSec += e.durationSec || 0; }
            else { plannedCount++; plannedSec += e.durationSec || 0; }
        });

        /* summary chips */
        if (summary) {
            summary.textContent = '';
            summary.appendChild(summaryChip('Total stops', stops.length, ''));
            summary.appendChild(summaryChip('Unplanned', unplannedCount, 'chip-unplanned'));
            summary.appendChild(summaryChip('Planned', plannedCount, 'chip-planned'));
            summary.appendChild(summaryChip('Unplanned time', fmt(unplannedSec), 'chip-unplanned'));
            summary.appendChild(summaryChip('Planned time', fmt(plannedSec), 'chip-planned'));
        }

        body.textContent = '';

        if (!stops.length) {
            var tr = document.createElement('tr');
            var td = document.createElement('td');
            td.colSpan = 8;
            td.className = 'empty-hint';
            td.textContent = 'No downtime recorded in this period.';
            tr.appendChild(td);
            body.appendChild(tr);
            return;
        }

        stops.forEach(function (e) {
            var planned = e.type === 'STOP_PLANNED';
            var machineName = machineLabel(e.machineCode);

            var tr = document.createElement('tr');

            appendCell(tr, machineName, 'fw-700');
            appendCell(tr, e.reason || stripPrefix(e.detail, 'Stopped: '), '');
            appendCell(tr, e.wo || '—', 'mono');

            var tdType = document.createElement('td');
            var pill = document.createElement('span');
            pill.className = 'stop-badge ' + (planned ? 'badge-planned' : 'badge-unplanned');
            pill.textContent = planned ? 'PLANNED' : 'UNPLANNED';
            tdType.appendChild(pill);
            tr.appendChild(tdType);

            appendCell(tr, hhmm(e.startTime), 'mono');
            appendCell(tr, hhmm(e.endTime || e.timestamp), 'mono');
            appendCell(tr, fmt(e.durationSec), 'mono fw-800 ' + (planned ? 'am' : 'rd'));
            appendCell(tr, e.operator || '—', 'text-muted');

            body.appendChild(tr);
        });
    }

    function machineLabel(code) {
        var m = OEE.machines.getByCode(code);
        return m ? m.name + ' (' + m.code + ')' : code;
    }

    function appendCell(tr, text, className) {
        var td = document.createElement('td');
        if (className) td.className = className;
        td.textContent = text;
        tr.appendChild(td);
    }

    function summaryChip(label, value, className) {
        var chip = document.createElement('span');
        chip.className = 'stop-chip ' + (className || '');

        var l = document.createElement('em');
        l.textContent = label;

        var v = document.createElement('strong');
        v.textContent = value;

        chip.appendChild(l);
        chip.appendChild(v);
        return chip;
    }

    function hhmm(ts) {
        if (!OEE.utils.isFiniteNumber(ts)) return '--:--';
        return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    }

    function stripPrefix(text, prefix) {
        var s = String(text || '');
        return s.indexOf(prefix) === 0 ? s.slice(prefix.length) : s;
    }

    /* --- Auto-learned average times ------------------------------------- */
    function renderLearned() {
        var body = $('dashLearnedTable');
        if (!body) return;

        body.textContent = '';

        var rows = OEE.metrics.learnedTimes();

        rows.forEach(function (row) {
            var tr = document.createElement('tr');

            var model = document.createElement('td');
            var strong = document.createElement('strong');
            strong.textContent = row.model.name;
            model.appendChild(strong);

            var box = document.createElement('td');
            box.textContent = row.avgBox === null ? '—' : fmt(row.avgBox);

            var layer = document.createElement('td');
            layer.className = 'cy fw-700';
            layer.textContent = row.avgLayer === null ? '—' : fmt(row.avgLayer) + ' / layer';

            var done = document.createElement('td');
            done.textContent = row.doneCount + ' units';

            tr.appendChild(model);
            tr.appendChild(box);
            tr.appendChild(layer);
            tr.appendChild(done);
            body.appendChild(tr);
        });
    }

    /* --- Live machines table (called every second) ---------------------- */
    function renderLive() {
        var body = $('dashMachinesTable');
        if (!body) return;

        body.textContent = '';
        var now = Date.now();

        OEE.machines.getAll().forEach(function (m) {
            var t = m.transformer;
            /* live view -> current shift, so the number matches the station card */
            var perMachine = OEE.metrics.computeShiftMetrics(m.code);

            var refTime = m.status === 'RUNNING' ? m.stepStartTime : m.stateStartTime;
            var timerStr = m.status === 'IDLE'
                ? '—'
                : fmt(Math.max(0, (now - refTime) / 1000));

            var statusLabel = m.status === 'IDLE'
                ? 'STANDBY / IDLE'
                : m.status + (m.stopReason ? ' (' + m.stopReason + ')' : '');

            var tr = document.createElement('tr');

            /* machine */
            var tdName = document.createElement('td');
            var b = document.createElement('strong');
            b.textContent = m.name + ' (' + m.code + ')';
            tdName.appendChild(b);

            /* status pill */
            var tdStatus = document.createElement('td');
            var pill = document.createElement('span');
            pill.className = 'status-pill status-' + m.status + ' status-pill-compact';
            pill.textContent = '● ' + statusLabel;
            tdStatus.appendChild(pill);

            /* CMMS work order of the CURRENT stop, only while UNPLANNED.
               Other statuses never carry a WO badge. */
            if (m.status === 'UNPLANNED' && m.stopWo) {
                var woPill = document.createElement('span');
                woPill.className = 'wo-pill';
                woPill.textContent = m.stopWo;
                tdStatus.appendChild(woPill);
            }

            /* transformer */
            var tdSn = document.createElement('td');
            if (t) {
                var sn = document.createElement('strong');
                sn.textContent = t.sn;
                tdSn.appendChild(sn);
                tdSn.appendChild(document.createTextNode(' - ' + t.modelName));
            } else {
                tdSn.appendChild(dash('Standby'));
            }

            /* batch */
            var tdBatch = document.createElement('td');
            tdBatch.textContent = t ? t.batch : '—';

            /* current step */
            var tdStep = document.createElement('td');
            tdStep.className = 'cy fw-700';
            tdStep.textContent = t
                ? (t.phase === 'LAYER' ? 'Layer ' + t.currentLayer + '/' + t.totalLayers : t.phase)
                : '—';

            /* timer */
            var tdTimer = document.createElement('td');
            tdTimer.className = 'mono fw-700';
            tdTimer.textContent = timerStr;

            /* reworks */
            var tdRework = document.createElement('td');
            tdRework.className = 'am fw-700';
            tdRework.textContent = t ? (t.reworkedLayers || 0) : 0;

            /* oee */
            var tdOee = document.createElement('td');
            var oee = document.createElement('strong');
            oee.className = 'gr';
            oee.textContent = perMachine.oee + '%';
            tdOee.appendChild(oee);

            [tdName, tdStatus, tdSn, tdBatch, tdStep, tdTimer, tdRework, tdOee]
                .forEach(function (td) { tr.appendChild(td); });

            body.appendChild(tr);
        });
    }

    function dash(text) {
        var el = document.createElement('span');
        el.className = 'text-muted';
        el.textContent = text;
        return el;
    }

    function emptyNote(text) {
        var el = document.createElement('div');
        el.className = 'empty-hint';
        el.textContent = text;
        return el;
    }

    OEE.views = OEE.views || {};
    OEE.views.dashboard = {
        render: render,
        renderLive: renderLive,
        selectedMachine: selectedMachine,
        selectedDays: selectedDays
    };

}(window.OEE = window.OEE || {}));
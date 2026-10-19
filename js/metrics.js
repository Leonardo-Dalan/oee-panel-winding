/* ==========================================================================
   metrics.js — OEE engine
   ==========================================================================
   OEE = Availability x Performance x Quality

   --------------------------------------------------------------------------
   WHY THE SHIFT OEE NEVER HEALS  (the core of the model)
   --------------------------------------------------------------------------
   Two formulas let a recorded loss wash itself away:

       availability = running / (running + unplanned)      <- growing denominator
       quality      = good    / (good    + reworked)        <- growing denominator

   In both, the denominator grows every second production continues, so an
   availability of 97% drifts back to a rounded "100.0%" on its own, with the
   loss still sitting in the log. Continuing to produce HEALED the shift.

   The shift OEE is now measured against a FIXED denominator - the shift
   length - with losses accumulated as permanent debits:

       availability = 1 - unplannedSeconds / shiftLength
       performance  = 1 - slowStepSeconds  / shiftLength
       quality      = 1 - reworkSeconds    / shiftLength

   Every loss only grows within the shift, so every KPI is monotonic: it can
   fall or hold, never climb back toward 100% just because production
   continued. A loss recorded at 08:00 is still fully visible at 17:00.

   The classic ratio `computeMetrics(days)` is kept for the multi-day trend
   views: over a window far larger than the worked time the ratio reading is
   the meaningful one, and dilution across days is expected in a trend.

   --------------------------------------------------------------------------
   WHY PERFORMANCE COULD SIT AT 100%
   --------------------------------------------------------------------------
   Two separate reasons:

   1. The default mode was FIXED_100, so the formula was never evaluated.
      The default is now LEARNED.

   2. The standards shipped as 900 s (box) / 600 s (layer). A line that
      actually winds a layer in 10 s was beating its standard 60x over, and
      performance is capped at 100% - so it looked permanently stuck.

      Each model can now carry a standard of 0 meaning AUTO: the engine takes
      the standard from that model's own measured average. Set 0 on a model
      and it calibrates to the real line within a few steps.
   ========================================================================== */

(function (OEE) {
    'use strict';

    var cfg = OEE.config;

    /* Fallbacks used only when a model has neither an explicit standard nor
       enough history to auto-calibrate one. */
    var DEFAULT_STD_LAYER = 600;
    var DEFAULT_STD_BOX = 900;

    /* Minimum finished steps before a model is considered calibrated. */
    var AUTO_MIN_SAMPLES = 5;

    /* ==================================================================
       SHIFT WINDOW — the unit of accountability.

       Shifts are a fixed-length grid anchored at shiftStartHour, so the
       current shift has a start, a fixed duration and a hard end. The shift
       OEE divides losses by that fixed duration, never by elapsed time.
       ================================================================== */
    function intSetting(value, min, max, fallback) {
        var n = parseInt(value, 10);
        if (!isFinite(n) || n < min || n > max) return fallback;
        return n;
    }

    /* fractional lengths are valid (8.5 = 08h30), so this must not truncate */
    function numSetting(value, min, max, fallback) {
        var n = parseFloat(value);
        if (!isFinite(n) || n < min || n > max) return fallback;
        return n;
    }

    function currentShiftWindow(atMs) {
        var now = isFinite(atMs) ? atMs : Date.now();
        var startHour = intSetting(OEE.settings.shiftStartHour, 0, 23, 6);
        var lengthH = numSetting(OEE.settings.shiftLengthHours, 0.5, 24, 8);
        var gridMs = lengthH * 3600000;

        var ref = new Date(now);
        ref.setHours(startHour, 0, 0, 0);
        var anchorToday = ref.getTime();

        /* Walk the fixed grid back from today's anchor to the shift that
           contains `now`. k is negative before the anchor (late-night shift). */
        var k = Math.floor((now - anchorToday) / gridMs);
        var start = anchorToday + (k * gridMs);

        return {
            start: start,
            end: start + gridMs,
            durationSec: gridMs / 1000,
            lengthHours: lengthH,
            startHour: startHour
        };
    }

    /* Cache of the closed-event aggregate.
       Key: machineFilter | days | revision (monotonic, not a timestamp). */
    var aggCache = Object.create(null);
    var CACHE_LIMIT = 24;

    function invalidateCache() {
        aggCache = Object.create(null);
        stdLearnCache = null;
    }

    function blankAcc() {
        return {
            runSec: 0,          // banked running time (RUN_SEGMENT only)
            unplannedSec: 0,    // unexpected downtime
            plannedSec: 0,      // scheduled downtime
            failureCount: 0,
            goodLayers: 0,
            reworkedLayers: 0,
            finishedUnits: 0,
            boxCount: 0,
            layerCount: 0,
            idealStepSec: 0,    // standard time the work should have taken
            actualStepSec: 0,   // time the work actually took
            boxSecSum: 0,
            layerSecSum: 0,
            firstEventTs: 0,    // earliest timestamp seen -> period anchor
            boxByStdSum: 0,     // bookkeeping for per-model learned standards
            layerByStdSum: 0,

            /* Loss quanta, in seconds. These only ever grow within a window,
               which is what makes the shift OEE monotonic: no amount of later
               production can shrink a loss that already happened. */
            perfLossSec: 0,     // sum of (actual - standard) on slow steps
            qualLossSec: 0      // standard time of the layers that were reworked
        };
    }

    function cloneAcc(a) {
        var out = {};
        for (var k in a) {
            if (Object.prototype.hasOwnProperty.call(a, k)) out[k] = a[k];
        }
        return out;
    }

    /* ==================================================================
       AUTO-STANDARD: learn each model's real average step time
       ================================================================== */
    var stdLearnCache = null;

    function learnStandards() {
        if (stdLearnCache) return stdLearnCache;

        var table = Object.create(null);
        var events = OEE.db.events || [];

        for (var i = 0; i < events.length; i++) {
            var e = events[i];
            if (e.type !== 'BOX_DONE' && e.type !== 'LAYER_DONE') continue;

            var key = e.modelId || ('n:' + e.modelName);
            if (!table[key]) {
                table[key] = { boxSum: 0, boxN: 0, layerSum: 0, layerN: 0 };
            }

            if (e.type === 'BOX_DONE') {
                table[key].boxSum += e.durationSec || 0;
                table[key].boxN += 1;
            } else {
                table[key].layerSum += e.durationSec || 0;
                table[key].layerN += 1;
            }
        }

        stdLearnCache = table;
        return table;
    }

    /* Resolve the effective standard for a model.
       Explicit value wins; 0/undefined means AUTO. */
    function stdTimes(modelId, modelName) {
        var key = modelId || ('n:' + modelName);
        var models = OEE.db.models || [];
        var found = null;

        if (modelId) {
            for (var i = 0; i < models.length; i++) {
                if (models[i].id === modelId) { found = models[i]; break; }
            }
        }
        if (!found && modelName) {
            for (var j = 0; j < models.length; j++) {
                if (models[j].name === modelName) { found = models[j]; break; }
            }
        }

        var explicitBox = found && found.stdBoxSec > 0 ? found.stdBoxSec : 0;
        var explicitLayer = found && found.stdLayerSec > 0 ? found.stdLayerSec : 0;

        var learnedBox = 0;
        var learnedLayer = 0;
        var autoBox = false;
        var autoLayer = false;

        if (!explicitBox || !explicitLayer) {
            var row = learnStandards()[key];
            if (row) {
                if (!explicitBox && row.boxN >= AUTO_MIN_SAMPLES) {
                    learnedBox = row.boxSum / row.boxN;
                    autoBox = true;
                }
                if (!explicitLayer && row.layerN >= AUTO_MIN_SAMPLES) {
                    learnedLayer = row.layerSum / row.layerN;
                    autoLayer = true;
                }
            }
        }

        return {
            stdBoxSec: explicitBox || (autoBox ? learnedBox : (found && found.stdBoxSec > 0 ? found.stdBoxSec : DEFAULT_STD_BOX)),
            stdLayerSec: explicitLayer || (autoLayer ? learnedLayer : (found && found.stdLayerSec > 0 ? found.stdLayerSec : DEFAULT_STD_LAYER)),
            boxSec: explicitBox || (autoBox ? learnedBox : DEFAULT_STD_BOX),
            layerSec: explicitLayer || (autoLayer ? learnedLayer : DEFAULT_STD_LAYER),
            boxAuto: autoBox,
            layerAuto: autoLayer,
            hasModel: !!found
        };
    }

    /* Effective standards for a model, for the Setup screen to display. */
    function standardsForModel(mod) {
        return stdTimes(mod.id, mod.name);
    }

    /* ==================================================================
       One pass over the log, bucketed per machine (plus an ALL bucket)
       ================================================================== */
    /* Every window is just "events newer than X". The cache is keyed by the
       window IDENTITY (not the moving cutoff) plus the data revision, so it
       survives the per-second refresh instead of being rebuilt every tick. */
    function aggregateFrom(machineFilter, fromMs, windowKey) {
        var key = machineFilter + '|' + windowKey + '|' + OEE.revision();

        if (Object.prototype.hasOwnProperty.call(aggCache, key)) {
            return aggCache[key];
        }

        var all = blankAcc();
        var perMachine = Object.create(null);
        var events = OEE.db.events || [];

        for (var i = 0; i < events.length; i++) {
            var e = events[i];
            if (e.timestamp < fromMs) continue;

            accumulate(all, e);

            var code = e.machineCode;
            if (!perMachine[code]) perMachine[code] = blankAcc();
            accumulate(perMachine[code], e);
        }

        var result = { all: all, perMachine: perMachine };
        aggCache[key] = result;

        var keys = Object.keys(aggCache);
        if (keys.length > CACHE_LIMIT) delete aggCache[keys[0]];

        return result;
    }

    function bucketFor(buckets, filter) {
        return filter === 'ALL'
            ? cloneAcc(buckets.all)
            : cloneAcc(buckets.perMachine[filter] || blankAcc());
    }

    function accumulate(acc, e) {
        if (!acc.firstEventTs || e.timestamp < acc.firstEventTs) {
            acc.firstEventTs = e.timestamp;
        }

        switch (e.type) {
            case 'RUN_SEGMENT':
                acc.runSec += e.durationSec || 0;
                break;

            case 'STOP_UNPLANNED':
                acc.unplannedSec += e.durationSec || 0;
                acc.failureCount += 1;
                break;

            case 'STOP_PLANNED':
                acc.plannedSec += e.durationSec || 0;
                break;

            case 'LAYER_DONE': {
                var lstd = stdTimes(e.modelId, e.modelName).layerSec;
                var ldur = e.durationSec || 0;
                acc.goodLayers += 1;
                acc.layerCount += 1;
                acc.layerSecSum += ldur;
                acc.actualStepSec += ldur;
                acc.idealStepSec += lstd;
                acc.perfLossSec += Math.max(0, ldur - lstd);
                break;
            }

            case 'BOX_DONE': {
                var bstd = stdTimes(e.modelId, e.modelName).boxSec;
                var bdur = e.durationSec || 0;
                acc.boxCount += 1;
                acc.boxSecSum += bdur;
                acc.actualStepSec += bdur;
                acc.idealStepSec += bstd;
                acc.perfLossSec += Math.max(0, bdur - bstd);
                break;
            }

            case 'TRANSF_FINISHED':
                acc.finishedUnits += 1;
                break;

            case 'REWORK': {
                var lost = e.layersLost || 0;
                acc.reworkedLayers += lost;

                /* A reworked layer costs the standard time of one layer, and
                   the debit is one-way: it never shrinks. Prefer the seconds
                   recorded on the event itself (the real lost work, and what
                   the CSV exports); fall back to lost x standard so legacy
                   REWORK rows written before this fix still count. */
                acc.qualLossSec += e.durationSec > 0
                    ? e.durationSec
                    : lost * stdTimes(e.modelId, e.modelName).layerSec;
                break;
            }

            default:
                break;
        }
    }

    /* ==================================================================
       Live time of machines that have not closed their segment yet
       ================================================================== */
    function addLiveTime(acc, machines, now, sinceMs) {
        var floor = sinceMs || 0;

        for (var i = 0; i < machines.length; i++) {
            var m = machines[i];

            /* Only the part of the current open segment that falls inside the
               window counts; a segment that began before the window started
               is clipped at the window edge, not counted whole. */
            var stateStart = Math.max(m.stateStartTime || now, floor);

            /* A machine already producing has a period that starts no later
               than its current state, so pull the anchor forward. */
            if (m.status !== 'IDLE' && (!acc.firstEventTs || stateStart < acc.firstEventTs)) {
                acc.firstEventTs = stateStart;
            }

            var open = Math.max(0, (now - stateStart) / 1000);

            if (m.status === 'RUNNING') {
                acc.runSec += open;
            } else if (m.status === 'UNPLANNED') {
                acc.unplannedSec += open;
            } else if (m.status === 'PLANNED') {
                acc.plannedSec += open;
            }
            /* IDLE (standby) is not downtime - it is the reason the plant
               reads 100% available. */
        }
    }

    function targetMachines(machineFilter) {
        var machines = OEE.db.machines || [];
        if (machineFilter === 'ALL') return machines;
        return machines.filter(function (m) { return m.code === machineFilter; });
    }

    /* ==================================================================
       The three ratios
       ================================================================== */

    /* Availability = 1 - unplanned / period.
       Period = elapsed time since the period anchor, but never smaller than
       the accounted time, so a freshly started period cannot read above 100%. */
    function availabilityOf(acc, periodSec) {
        if (acc.unplannedSec <= 0) return 1.0;

        var denom = Math.max(periodSec || 0, acc.runSec + acc.unplannedSec + acc.plannedSec);

        if (denom <= 0) return 1.0;

        return OEE.utils.clamp(1 - (acc.unplannedSec / denom), 0, 1);
    }

    /* LEARNED  : ideal standard time / actual time, capped at 1.0
       FIXED_100: always 1.0 */
    function performanceOf(acc) {
        var hasData = acc.boxCount + acc.layerCount > 0 && acc.actualStepSec > 0;

        if (OEE.settings.performanceMode !== 'LEARNED') {
            return { value: 1.0, hasData: hasData, capped: false };
        }
        if (!hasData) {
            return { value: 1.0, hasData: false, capped: false };
        }

        var raw = acc.idealStepSec / acc.actualStepSec;

        return {
            value: OEE.utils.clamp(raw, 0, 1),
            hasData: true,
            capped: raw >= 1
        };
    }

    /* Performance for the shift window: the seconds spent ABOVE the standard
       are a permanent debit against the fixed shift length. A step that
       merely matches the standard costs nothing; beating it is never a
       credit (capped at 100%). */
    function shiftPerformance(acc, durationSec) {
        var hasData = (acc.boxCount + acc.layerCount) > 0;

        if (OEE.settings.performanceMode !== 'LEARNED') {
            return { value: 1.0, hasData: hasData, capped: false };
        }
        if (!hasData) {
            return { value: 1.0, hasData: false, capped: false };
        }

        return {
            value: OEE.utils.clamp(1 - (acc.perfLossSec / durationSec), 0, 1),
            hasData: true,
            capped: acc.perfLossSec <= 0
        };
    }

    /* Quality = good layers / (good + reworked). Drops on rework and recovers
       as the layers are re-produced. */
    function qualityOf(acc) {
        if (acc.reworkedLayers <= 0) return 1.0;
        var base = Math.max(acc.goodLayers, cfg.tech.qualityMinBase);
        return OEE.utils.clamp(base / (base + acc.reworkedLayers), 0, 1);
    }

    /* ==================================================================
       Formatting that never rounds a real loss away
       ================================================================== */
    function formatPercent(ratio, hasLoss) {
        var pct = ratio * 100;
        var text = pct.toFixed(1);

        /* 99.97% of a shift with a 3 minute stop would print "100.0%".
           That reads as "no loss at all", which is a lie. Floor it. */
        if (hasLoss && parseFloat(text) >= 100) text = '99.9';

        return text;
    }

    /* ==================================================================
       Shared result shape
       ================================================================== */
    function present(acc, availability, perf, quality, oee, periodSec, hasAvailLoss) {
        var mtbfSec = acc.failureCount > 0 ? acc.runSec / acc.failureCount : null;
        var mttrSec = acc.failureCount > 0 ? acc.unplannedSec / acc.failureCount : null;

        return {
            oee: formatPercent(oee, hasAvailLoss || acc.reworkedLayers > 0),
            avail: formatPercent(availability, hasAvailLoss),
            perf: formatPercent(perf.value, false),
            qual: formatPercent(quality, acc.reworkedLayers > 0),

            /* Unrounded values. The displayed strings are floored so a loss
               can never read as a clean 100. */
            rawOee: oee,
            rawAvail: availability,
            rawPerf: perf.value,
            rawQual: quality,

            perfHasData: perf.hasData,
            perfCapped: perf.capped,
            performanceMode: OEE.settings.performanceMode,
            oeeTarget: OEE.settings.oeeTarget,

            hasFailures: acc.failureCount > 0,
            mtbfSec: mtbfSec,
            mttrSec: mttrSec,
            mtbfLabel: mtbfSec === null ? '—' : OEE.utils.formatMinutes(mtbfSec),
            mttrLabel: mttrSec === null ? '—' : OEE.utils.formatMinutes(mttrSec),

            periodSec: periodSec,
            isShift: false,

            counts: {
                runSec: acc.runSec,
                unplannedSec: acc.unplannedSec,
                plannedSec: acc.plannedSec,
                failureCount: acc.failureCount,
                goodLayers: acc.goodLayers,
                reworkedLayers: acc.reworkedLayers,
                finishedUnits: acc.finishedUnits,
                perfLossSec: acc.perfLossSec,
                qualLossSec: acc.qualLossSec
            },

            acc: acc
        };
    }

    /* ==================================================================
       PERIOD window (dashboard trend views) — classic ratio model.

       A multi-day trend is not a shift. Over a window far larger than the
       worked time, the ratio reading is the meaningful one; dilution across
       days is expected in a trend and is not the bug the shift model fixes.
       ================================================================== */
    function computeMetrics(machineFilter, days) {
        var filter = machineFilter || 'ALL';
        var windowDays = days || cfg.tech.defaultPeriodDays;
        var now = Date.now();

        var cutoff = now - (windowDays * 86400000);
        var buckets = aggregateFrom(filter, cutoff, 'd' + windowDays);
        var acc = bucketFor(buckets, filter);

        addLiveTime(acc, targetMachines(filter), now, cutoff);

        /* The window can never reach further back than the first thing
           recorded, and never earlier than the window edge. */
        var anchor = Math.max(cutoff, acc.firstEventTs || 0);
        var periodSec = anchor > 0 ? Math.max(0, (now - anchor) / 1000) : 0;

        var availability = availabilityOf(acc, periodSec);
        var perf = performanceOf(acc);
        var quality = qualityOf(acc);

        return present(acc, availability, perf, quality,
                       availability * perf.value * quality, periodSec,
                       acc.unplannedSec > 0);
    }

    /* ==================================================================
       SHIFT window — the unit of accountability.

       The denominator is the FIXED shift length, never the elapsed time:

           Availability = 1 - unplannedSeconds / shiftLength
           Performance  = 1 - slowStepSeconds  / shiftLength
           Quality      = 1 - reworkSeconds    / shiftLength

       Each loss quantum only ever grows inside the shift, so every KPI is
       monotonic: it can fall or hold, never climb back toward 100% just
       because production continued. A loss recorded at 08:00 is still fully
       visible at 17:00. In a shift where production fills the window these
       converge on the classic ratios (reworkSeconds/shiftLength ~= defects/units).
       ================================================================== */
    function computeShiftMetrics(machineFilter, atMs) {
        var filter = machineFilter || 'ALL';
        var now = isFinite(atMs) ? atMs : Date.now();
        var win = currentShiftWindow(now);

        var buckets = aggregateFrom(filter, win.start, 's' + win.start);
        var acc = bucketFor(buckets, filter);

        addLiveTime(acc, targetMachines(filter), now, win.start);

        var d = win.durationSec;
        var availability = OEE.utils.clamp(1 - (acc.unplannedSec / d), 0, 1);
        var perf = shiftPerformance(acc, d);
        var quality = OEE.utils.clamp(1 - (acc.qualLossSec / d), 0, 1);

        var out = present(acc, availability, perf, quality,
                          availability * perf.value * quality, d,
                          acc.unplannedSec > 0);

        out.isShift = true;
        out.shiftStart = win.start;
        out.shiftEnd = win.end;
        out.shiftLengthHours = win.lengthHours;
        return out;
    }

    /* ==================================================================
       Learned averages for the dashboard table
       ================================================================== */
    function filterEvents(type, modelName) {
        var cutoff = Date.now() - (cfg.tech.defaultPeriodDays * 86400000);
        var events = OEE.db.events || [];
        var out = [];
        for (var i = 0; i < events.length; i++) {
            if (events[i].type === type && events[i].timestamp >= cutoff &&
                events[i].modelName === modelName) {
                out.push(events[i]);
            }
        }
        return out;
    }

    function averageDuration(events) {
        if (!events.length) return null;
        var total = 0;
        for (var i = 0; i < events.length; i++) total += events[i].durationSec || 0;
        return total / events.length;
    }

    function learnedTimes() {
        var rows = [];
        var models = OEE.db.models || [];

        for (var i = 0; i < models.length; i++) {
            var mod = models[i];
            var name = mod.name;

            rows.push({
                model: mod,
                avgBox: averageDuration(filterEvents('BOX_DONE', name)),
                avgLayer: averageDuration(filterEvents('LAYER_DONE', name)),
                doneCount: filterEvents('TRANSF_FINISHED', name).length,
                standards: stdTimes(mod.id, mod.name)
            });
        }

        return rows;
    }

    OEE.metrics = {
        computeMetrics: computeMetrics,
        computeShiftMetrics: computeShiftMetrics,
        currentShiftWindow: currentShiftWindow,
        learnedTimes: learnedTimes,
        invalidateCache: invalidateCache,
        standardsForModel: standardsForModel,
        availabilityOf: availabilityOf,
        performanceOf: performanceOf,
        shiftPerformance: shiftPerformance,
        qualityOf: qualityOf,
        formatPercent: formatPercent,
        AUTO_MIN_SAMPLES: AUTO_MIN_SAMPLES
    };

}(window.OEE = window.OEE || {}));
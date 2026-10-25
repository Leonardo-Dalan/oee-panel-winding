/* ==========================================================================
   storage.js — localStorage persistence, schema migration, event pruning
   --------------------------------------------------------------------------
   Owns the single `db` object. Everything else reads OEE.db and mutates it,
   then calls OEE.storage.save().

   Fixes applied here vs. the original single-file version:
   - QuotaExceededError is caught instead of silently killing the app
   - db.events is pruned by age + hard cap so localStorage can't fill up
   - schema is validated/migrated, so a restored old backup can't crash render
   - legacy plaintext user passwords are upgraded to salted hashes on load
   ========================================================================== */

(function (OEE) {
    'use strict';

    var cfg = OEE.config;

    OEE.db = null;
    OEE.lastSyncedUpdatedAt = 0;

    /* Timestamp of the most recent write made by THIS tab.
       sync.js refuses to adopt a cloud copy while this is recent, so two
       active PCs don't wipe each other's in-progress work. */
    var localWriteAt = 0;

    /* Monotonic revision counter. The metrics cache is keyed on this instead
       of db.updatedAt: a timestamp has millisecond resolution, so two saves
       in the same millisecond would produce the same key and serve stale
       aggregates for up to a second. */
    var revision = 0;

    OEE.lastLocalWriteAt = function () {
        return localWriteAt;
    };

    OEE.revision = function () {
        return revision;
    };

    /* ------------------------------------------------------------------
       Safe localStorage access (throws in some private-browse modes)
       ------------------------------------------------------------------ */
    function rawGet(key) {
        try {
            return window.localStorage.getItem(key);
        } catch (e) {
            return null;
        }
    }

    function rawSet(key, value) {
        try {
            window.localStorage.setItem(key, value);
            return true;
        } catch (e) {
            return false;
        }
    }

    /* ------------------------------------------------------------------
       Schema validation / migration
       ------------------------------------------------------------------ */
    function isArray(v) {
        return Object.prototype.toString.call(v) === '[object Array]';
    }

    function migrateDB(candidate) {
        if (!candidate || typeof candidate !== 'object' || isArray(candidate)) {
            return null;
        }

        var fresh = OEE.createDefaultDB();

        /* Keep the existing updatedAt if present: cloud conflict resolution
           relies on it. */
        var db = {
            updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : fresh.updatedAt,
            settings: OEE.normalizeSettings(candidate.settings),
            users: [],
            models: [],
            stopReasons: [],
            machines: [],
            events: [],
            notes: []
        };

        /* users ------------------------------------------------------------ */
        if (isArray(candidate.users) && candidate.users.length) {
            candidate.users.forEach(function (u) {
                if (!u || typeof u.username !== 'string') return;

                /* Upgrade legacy plaintext credentials on read. */
                if (OEE.crypto.hasPlaintextPassword(u)) {
                    var rehashed = OEE.crypto.hashPassword(u.username, u.pass);
                    rehashed.role = typeof u.role === 'string' ? u.role : 'OPERATOR';
                    db.users.push(rehashed);
                    return;
                }

                if (typeof u.salt === 'string' && typeof u.hash === 'string') {
                    db.users.push({
                        username: u.username,
                        salt: u.salt,
                        hash: u.hash,
                        role: typeof u.role === 'string' ? u.role : 'OPERATOR'
                    });
                }
            });
        }
        if (!db.users.length) db.users = OEE.buildSeedUsers();

        /* models ----------------------------------------------------------- */
        if (isArray(candidate.models)) {
            candidate.models.forEach(function (m, i) {
                if (!m || typeof m.name !== 'string') return;
                db.models.push({
                    id: typeof m.id === 'string' ? m.id : 'm' + i,
                    name: m.name,
                    layers: OEE.utils.isFiniteNumber(m.layers) && m.layers > 0 ? m.layers : 80,
                    rating: typeof m.rating === 'string' ? m.rating : '—',
                    voltage: typeof m.voltage === 'string' ? m.voltage : '—',
                    /* 0 = AUTO standard, calibrated from the model's own history */
                    stdLayerSec: OEE.utils.isFiniteNumber(m.stdLayerSec) && m.stdLayerSec > 0 ? m.stdLayerSec : 0,
                    stdBoxSec: OEE.utils.isFiniteNumber(m.stdBoxSec) && m.stdBoxSec > 0 ? m.stdBoxSec : 0
                });
            });
        }
        if (!db.models.length) db.models = fresh.models;

        /* stopReasons ------------------------------------------------------ */
        if (isArray(candidate.stopReasons)) {
            candidate.stopReasons.forEach(function (s, i) {
                if (!s || typeof s.name !== 'string') return;
                db.stopReasons.push({
                    id: typeof s.id === 'string' ? s.id : 's' + i,
                    name: s.name,
                    category: s.category === 'PLANNED' ? 'PLANNED' : 'UNPLANNED'
                });
            });
        }
        if (!db.stopReasons.length) db.stopReasons = fresh.stopReasons;

        /* machines --------------------------------------------------------- */
        if (isArray(candidate.machines)) {
            candidate.machines.forEach(function (m) {
                if (!m || typeof m.code !== 'string') return;

                var base = OEE.createDefaultMachine(m.code, m.name || m.code);
                var status = ['IDLE', 'RUNNING', 'PLANNED', 'UNPLANNED'].indexOf(m.status) !== -1
                    ? m.status : 'IDLE';

                base.name = m.name || m.code;
                base.status = status;
                base.stopReason = typeof m.stopReason === 'string' ? m.stopReason : '';
                base.stopWo = typeof m.stopWo === 'string' ? m.stopWo : '';
                base.stateStartTime = OEE.utils.isFiniteNumber(m.stateStartTime) ? m.stateStartTime : Date.now();
                base.stepStartTime = OEE.utils.isFiniteNumber(m.stepStartTime) ? m.stepStartTime : base.stateStartTime;
                base.transformer = sanitizeTransformer(m.transformer);
                base.undoSnapshot = m.undoSnapshot && typeof m.undoSnapshot === 'object'
                    ? OEE.utils.deepClone(m.undoSnapshot) : null;

                db.machines.push(base);
            });
        }
        if (!db.machines.length) db.machines = fresh.machines;

        /* events / notes ---------------------------------------------------- */
        if (isArray(candidate.events)) {
            candidate.events.forEach(function (e) {
                if (!e || typeof e !== 'object') return;
                if (typeof e.timestamp !== 'number') e.timestamp = Date.now();
                if (typeof e.machineCode !== 'string') e.machineCode = '';
                db.events.push(e);
            });
            /* newest first, as logEvent() unshifts */
            db.events.sort(function (a, b) { return b.timestamp - a.timestamp; });
        }

        if (isArray(candidate.notes)) {
            candidate.notes.forEach(function (n) {
                if (!n || typeof n !== 'object') return;
                db.notes.push(n);
            });
        }

        return db;
    }

    function sanitizeTransformer(t) {
        if (!t || typeof t !== 'object') return null;

        var phase = ['BOX', 'LAYER', 'FINALIZE'].indexOf(t.phase) !== -1 ? t.phase : 'BOX';
        var total = OEE.utils.isFiniteNumber(t.totalLayers) && t.totalLayers > 0 ? Math.floor(t.totalLayers) : 80;
        var current = OEE.utils.isFiniteNumber(t.currentLayer) ? Math.max(1, Math.floor(t.currentLayer)) : 1;

        if (phase !== 'BOX') current = Math.min(current, total);

        return {
            sn: typeof t.sn === 'string' ? t.sn : 'SN-001',
            wo: typeof t.wo === 'string' ? t.wo : 'WO-001',
            batch: typeof t.batch === 'string' ? t.batch : '1 of 1',
            modelName: typeof t.modelName === 'string' ? t.modelName : 'Custom Model',
            modelId: typeof t.modelId === 'string' ? t.modelId : '',
            rating: typeof t.rating === 'string' ? t.rating : '—',
            voltage: typeof t.voltage === 'string' ? t.voltage : '—',
            totalLayers: total,
            phase: phase,
            currentLayer: current,
            goodLayersCompleted: OEE.utils.isFiniteNumber(t.goodLayersCompleted) ? t.goodLayersCompleted : 0,
            reworkedLayers: OEE.utils.isFiniteNumber(t.reworkedLayers) ? t.reworkedLayers : 0
        };
    }

    /* ------------------------------------------------------------------
       Event pruning (fixes the unbounded db.events growth)
       ------------------------------------------------------------------ */
    function pruneEvents() {
        var db = OEE.db;
        if (!db || !isArray(db.events) || !db.events.length) return 0;

        var before = db.events.length;

        var retentionMs = OEE.settings.retentionDays * 86400000;
        var cutoff = Date.now() - retentionMs;
        var maxEvents = cfg.tech.maxEvents;

        /* Drop by age first (events are newest-first, so we can stop early) */
        if (db.events.length > maxEvents) {
            db.events.length = maxEvents;
        }

        var keep = [];
        for (var i = 0; i < db.events.length; i++) {
            if (db.events[i].timestamp >= cutoff) keep.push(db.events[i]);
        }
        db.events = keep;

        return before - db.events.length;
    }

    /* ------------------------------------------------------------------
       Load / Save
       ------------------------------------------------------------------ */
    function load() {
        var raw = rawGet(cfg.STORAGE_KEY);
        var parsed = null;

        if (raw) {
            try {
                parsed = JSON.parse(raw);
            } catch (e) {
                console.warn('[OEE] Stored data was unreadable, starting fresh.', e);
                parsed = null;
            }
        }

        var db = migrateDB(parsed);

        if (!db) {
            db = OEE.createDefaultDB();
            rawSet(cfg.STORAGE_KEY, JSON.stringify(db));
        }

        adopt(db);
        return db;
    }

    /* Put a db object into the app (applies settings + sync bookkeeping) */
    function adopt(db) {
        OEE.db = db;
        OEE.settings = OEE.normalizeSettings(db.settings);
        db.settings = OEE.settings;
        OEE.lastSyncedUpdatedAt = typeof db.updatedAt === 'number' ? db.updatedAt : 0;
        revision++;
    }

    function save(options) {
        var opts = options || {};
        var db = OEE.db;
        if (!db) return false;

        db.updatedAt = Date.now();
        OEE.lastSyncedUpdatedAt = db.updatedAt;
        db.settings = OEE.settings;
        localWriteAt = Date.now();
        revision++;

        pruneEvents();

        var serialized = JSON.stringify(db);

        if (rawSet(cfg.STORAGE_KEY, serialized)) {
            if (OEE.sync) OEE.sync.notifyLocalChange();
            if (opts.pushToCloud !== false && OEE.sync) OEE.sync.schedulePush();
            return true;
        }

        /* Quota exceeded: prune harder and retry once. */
        console.warn('[OEE] localStorage quota exceeded, pruning aggressively.');
        db.events = db.events.slice(0, Math.min(500, db.events.length));

        serialized = JSON.stringify(db);

        if (rawSet(cfg.STORAGE_KEY, serialized)) {
            OEE.utils.toast(
                'Storage was almost full. Old history was trimmed to keep the system running.',
                'warn', 6000
            );
            if (OEE.sync) OEE.sync.notifyLocalChange();
            if (opts.pushToCloud !== false && OEE.sync) OEE.sync.schedulePush();
            return true;
        }

        OEE.utils.toast(
            'Could not save: this browser blocked local storage or it is full.',
            'error', 8000
        );
        return false;
    }

    OEE.storage = {
        load: load,
        save: save,
        adopt: adopt,
        migrateDB: migrateDB,
        pruneEvents: pruneEvents,
        isArray: isArray
    };

}(window.OEE = window.OEE || {}));
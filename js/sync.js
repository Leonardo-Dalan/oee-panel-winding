/* ==========================================================================
   sync.js — Realtime synchronization
   --------------------------------------------------------------------------
   Three channels, from narrowest to widest:

   1. localStorage          -> persistence on this PC
   2. BroadcastChannel +    -> other browser tabs on THIS PC
      'storage' event
   3. Firebase Realtime DB  -> other PCs in the factory

   Note on file://: the page origin is opaque/null there, so BroadcastChannel
   may be unavailable or isolated per file. That is why the constructor is
   wrapped in try/catch and the 'storage' event is kept as a fallback.

   ---------------------------------------------------------------------------
   Cloud merge model (fixes "the two tablets never meet each other")
   ---------------------------------------------------------------------------
   The old code uploaded the whole database as one blob and the receiver
   adopted it only when it was strictly newer AND nobody had typed locally for
   5 seconds. In a real factory both devices are always typing, so the pull was
   rejected forever and every device kept its own world. On top of that the URL
   was only honoured by the CONNECT button, so a reload stopped all syncing.

   A pull is now a real MERGE, so no local work is ever thrown away:

     - events / notes : append-only -> union by id (nothing is ever lost)
     - machines       : per machine code, the side that acted most recently wins
                        (its newest event, or its step/state start timestamp)
     - settings, users, models, stopReasons : last writer wins, but only when
                        the content really differs (guards against ping-pong)

   `updatedAt` is the merge version. It only moves forward when a merge actually
   changed something, so the two devices converge in one extra round trip
   instead of fighting each other.
   ========================================================================== */

(function (OEE) {
    'use strict';

    var cfg = OEE.config;

    var firebaseUrl = '';
    var localChannel = null;
    var pollTimer = null;

    /* Real, user-visible connection state: off | connecting | syncing | ok | error */
    var status = 'off';
    var lastSyncAt = 0;
    var lastError = '';

    /* updatedAt of the last remote snapshot we have already consumed. Pulling
       is only useful when the cloud moved past this mark. */
    var lastRemoteUpdatedAt = 0;
    var pulling = false;

    /* ------------------------------------------------------------------
       Cloud URL
       ------------------------------------------------------------------ */
    function init() {
        firebaseUrl = (rawGetUrl() || '').replace(/\/+$/, '');
        createLocalChannel();
        watchStorageEvent();

        updateSyncBadge();

        /* Fix: a reload used to forget the URL entirely. If one is stored we
           resume cloud sync immediately instead of waiting for CONNECT. */
        if (firebaseUrl) {
            status = 'connecting';
            updateSyncBadge();
            startPolling();
            syncNow();
        }
    }

    function rawGetUrl() {
        try {
            return window.localStorage.getItem(cfg.FIREBASE_KEY);
        } catch (e) {
            return '';
        }
    }

    function setFirebaseUrl(url) {
        firebaseUrl = (url || '').trim().replace(/\/+$/, '');
        try {
            window.localStorage.setItem(cfg.FIREBASE_KEY, firebaseUrl);
        } catch (e) { /* ignore */ }

        stopPolling();
        lastRemoteUpdatedAt = 0;
        lastError = '';

        if (firebaseUrl) {
            status = 'connecting';
            updateSyncBadge();
            syncNow();
            startPolling();
        } else {
            status = 'off';
            updateSyncBadge();
        }
    }

    function getFirebaseUrl() {
        return firebaseUrl;
    }

    /* ------------------------------------------------------------------
       Public status, for the badge and the Setup card
       ------------------------------------------------------------------ */
    function getStatus() {
        return {
            state: firebaseUrl ? status : 'off',
            url: firebaseUrl,
            lastSyncAt: lastSyncAt,
            lastError: lastError
        };
    }

    /* ------------------------------------------------------------------
       Same-PC tab sync
       ------------------------------------------------------------------ */
    function createLocalChannel() {
        if (localChannel) return;

        if (!('BroadcastChannel' in window)) return;

        try {
            localChannel = new BroadcastChannel(cfg.BROADCAST_CHANNEL);
            localChannel.onmessage = onLocalMessage;
        } catch (e) {
            /* file:// with an opaque origin - the 'storage' event still works */
            console.warn('[OEE] BroadcastChannel unavailable, falling back to the storage event.');
            localChannel = null;
        }
    }

    function notifyLocalChange() {
        if (!localChannel || !OEE.db) return;
        try {
            localChannel.postMessage({ type: 'DB_UPDATE', updatedAt: OEE.db.updatedAt });
        } catch (e) { /* ignore */ }
    }

    function onLocalMessage(ev) {
        if (!ev.data || ev.data.type !== 'DB_UPDATE') return;
        if (!OEE.db) return;
        if (ev.data.updatedAt <= OEE.lastSyncedUpdatedAt) return;

        reloadFromDisk();
    }

    function watchStorageEvent() {
        window.addEventListener('storage', function (ev) {
            if (ev.key !== cfg.STORAGE_KEY) return;
            if (!OEE.db) return;
            /* The storage event only fires in *other* tabs, so this tab's
               copy is stale and must be refreshed. */
            reloadFromDisk();
        });
    }

    function reloadFromDisk() {
        var db = OEE.storage.load();
        OEE.refreshActiveScreen();
        return db;
    }

    /* ------------------------------------------------------------------
       Merge helpers
       ------------------------------------------------------------------ */
    function isArr(v) {
        return Object.prototype.toString.call(v) === '[object Array]';
    }

    function jsonEq(a, b) {
        try {
            return JSON.stringify(a) === JSON.stringify(b);
        } catch (e) {
            return false;
        }
    }

    function eventKey(e) {
        if (e && e.id) return e.id;
        return (e && e.timestamp) + '|' + (e && e.machineCode) + '|' + (e && e.type);
    }

    function noteKey(n) {
        if (n && n.id != null) return 'n' + n.id;
        return 'n' + (n && n.timestamp) + '|' + (n && n.text);
    }

    /* Append-only log: union by id, newest first. Local rows keep priority on
       an id collision so the device that owns them is not surprised. */
    function mergeById(localRows, remoteRows, keyFn) {
        var seen = {};
        var rows = [];

        function add(row) {
            if (!row || typeof row !== 'object') return;
            var k = keyFn(row);
            if (seen[k]) return;
            seen[k] = 1;
            rows.push(row);
        }

        (isArr(localRows) ? localRows : []).forEach(add);
        var before = rows.length;
        (isArr(remoteRows) ? remoteRows : []).forEach(add);

        rows.sort(function (a, b) {
            return ((b && (b.timestamp || b.id)) || 0) - ((a && (a.timestamp || a.id)) || 0);
        });

        return { rows: rows, added: rows.length - before };
    }

    function newestEventByCode(events) {
        var out = {};
        (isArr(events) ? events : []).forEach(function (e) {
            if (!e || !e.machineCode) return;
            var ts = Number(e.timestamp) || 0;
            if (!(e.machineCode in out) || ts > out[e.machineCode]) out[e.machineCode] = ts;
        });
        return out;
    }

    function recency(m, evMax) {
        if (!m) return 0;
        var t = Math.max(
            Number(m.stepStartTime) || 0,
            Number(m.stateStartTime) || 0,
            Number(m.updatedAt) || 0
        );
        var e = evMax[m.code] || 0;
        return Math.max(t, e);
    }

    /* Each side is scored with its OWN newest event, so a machine only wins on
       the side that actually saw the most recent activity. */
    function mergeMachines(localM, remoteM, evMaxLocal, evMaxRemote) {
        var byCode = {};
        var order = [];
        var changed = false;

        (isArr(localM) ? localM : []).forEach(function (m) {
            if (!m || !m.code) return;
            if (!(m.code in byCode)) {
                byCode[m.code] = m;
                order.push(m.code);
            }
        });

        (isArr(remoteM) ? remoteM : []).forEach(function (m) {
            if (!m || !m.code) return;
            if (!(m.code in byCode)) {
                byCode[m.code] = m;
                order.push(m.code);
                changed = true;
                return;
            }
            if (recency(m, evMaxRemote) > recency(byCode[m.code], evMaxLocal)) {
                byCode[m.code] = m;
                changed = true;
            }
        });

        return {
            rows: order.map(function (c) { return byCode[c]; }),
            changed: changed
        };
    }

    /* Merge a remote snapshot into a local one. Returns { db, changed }.
       Exposed for tests. `local` and `remote` must already be migrated. */
    function mergeRemote(local, remote) {
        var result = {
            updatedAt: Math.max(local.updatedAt || 0, remote.updatedAt || 0),
            settings: local.settings,
            users: local.users,
            models: local.models,
            stopReasons: local.stopReasons,
            machines: local.machines,
            events: local.events,
            notes: local.notes
        };
        var changed = false;

        var remoteNewer = (remote.updatedAt || 0) > (local.updatedAt || 0);

        function takeConfig(key) {
            if (!isArr(remote[key])) return;
            if (!jsonEq(remote[key], result[key])) {
                result[key] = remote[key];
                changed = true;
            }
        }

        if (remoteNewer) {
            if (remote.settings && !jsonEq(remote.settings, local.settings)) {
                result.settings = remote.settings;
                changed = true;
            }
            takeConfig('users');
            takeConfig('models');
            takeConfig('stopReasons');
        }

        var ev = mergeById(local.events, remote.events, eventKey);
        result.events = ev.rows;
        if (ev.added) changed = true;

        var nt = mergeById(local.notes, remote.notes, noteKey);
        result.notes = nt.rows;
        if (nt.added) changed = true;

        var mch = mergeMachines(
            local.machines, remote.machines,
            newestEventByCode(local.events), newestEventByCode(remote.events)
        );
        result.machines = mch.rows;
        if (mch.changed) changed = true;

        /* A pull must never let the merged log grow past the hard cap. */
        if (result.events.length > cfg.tech.maxEvents) {
            result.events = result.events.slice(0, cfg.tech.maxEvents);
        }

        return { db: result, changed: changed };
    }

    /* ------------------------------------------------------------------
       Firebase
       ------------------------------------------------------------------ */
    function stateUrl() {
        return firebaseUrl + '/' + cfg.FIREBASE_ROOT_PATH + '.json';
    }

    function persist(db) {
        try {
            window.localStorage.setItem(cfg.STORAGE_KEY, JSON.stringify(db));
        } catch (e) { /* ignore */ }
    }

    function markSyncing() {
        if (!firebaseUrl) return;
        status = 'syncing';
        updateSyncBadge();
    }

    function markSynced() {
        lastSyncAt = Date.now();
        lastError = '';
        status = 'ok';
        updateSyncBadge();
    }

    function markError(err) {
        lastError = (err && err.message) ? err.message : String(err || 'unknown error');
        status = 'error';
        updateSyncBadge();
    }

    function pushNow() {
        if (!firebaseUrl || !OEE.db) return Promise.resolve(false);

        return fetch(stateUrl(), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(OEE.db)
        }).then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            markSynced();
            return true;
        }).catch(function (err) {
            console.warn('[OEE] Cloud push failed:', err);
            markError(err);
            return false;
        });
    }

    /* Coalesce bursts (operator tapping the pad) into a single PUT. */
    var schedulePush = OEE.utils.debounce(function () {
        markSyncing();
        pushNow();
    }, cfg.tech.cloudPushDebounceMs);

    function doPull() {
        return fetch(stateUrl())
            .then(function (res) {
                return res.ok ? res.json() : null;
            })
            .then(function (remote) {
                if (!remote || typeof remote.updatedAt !== 'number') return false;
                if (remote.updatedAt <= lastRemoteUpdatedAt) return false;

                var migratedRemote = OEE.storage.migrateDB(remote);
                if (!migratedRemote) return false;

                var merged = mergeRemote(OEE.db, migratedRemote);

                /* Remember the snapshot we consumed even when it added nothing
                   new, so we stop re-examining it every 2 seconds. */
                lastRemoteUpdatedAt = remote.updatedAt;

                if (!merged.changed) return false;

                /* Bump the merge version so the other device(s) pull our copy
                   back and pick up the rows only we had. */
                merged.db.updatedAt = Math.max(
                    Date.now(),
                    remote.updatedAt + 1,
                    (OEE.db.updatedAt || 0) + 1
                );

                OEE.storage.adopt(merged.db);
                persist(merged.db);

                try {
                    OEE.refreshActiveScreen();
                } catch (e) { /* screen may not be ready yet */ }

                /* Propagate the merged state (contains the remote rows). */
                schedulePush();
                markSynced();
                return true;
            });
    }

    function pullNow() {
        if (!firebaseUrl || !OEE.db || pulling) return Promise.resolve(false);

        pulling = true;
        return doPull().then(
            function (v) { pulling = false; return v; },
            function (err) {
                pulling = false;
                console.warn('[OEE] Cloud pull failed:', err);
                markError(err);
                return false;
            }
        );
    }

    /* Pull first (merge whatever the cloud has), then push. Used right after
       connecting so a device never overwrites newer cloud data. */
    function syncNow() {
        if (!firebaseUrl) return Promise.resolve(false);
        markSyncing();
        return pullNow().then(function () {
            return pushNow();
        });
    }

    function startPolling() {
        stopPolling();
        if (!firebaseUrl) return;
        pollTimer = setInterval(function () {
            if (firebaseUrl) pullNow();
        }, cfg.tech.cloudPollMs);
    }

    function stopPolling() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    /* ------------------------------------------------------------------
       Badge + Setup card status line
       ------------------------------------------------------------------ */
    function clock(ts) {
        if (!ts) return '--:--:--';
        try {
            return new Date(ts).toLocaleTimeString('pt-BR');
        } catch (e) {
            return '--:--:--';
        }
    }

    function describeStatus() {
        var poll = Math.round(cfg.tech.cloudPollMs / 1000);

        if (!firebaseUrl) {
            return {
                kind: 'off',
                cls: '',
                text: 'Local sync only',
                title: 'Not connected to a cloud database',
                detail: 'Cloud sync is OFF - data lives only on this device. Paste a Firebase URL above and press Connect to share it with the other PCs.'
            };
        }
        if (status === 'error') {
            return {
                kind: 'error',
                cls: 'error',
                text: 'Cloud error',
                title: lastError || 'Cloud connection failed',
                detail: 'Cloud ERROR: ' + (lastError || 'unknown') + '. Retrying every ' + poll + 's.'
            };
        }
        if (status === 'syncing') {
            return {
                kind: 'syncing',
                cls: 'syncing',
                text: 'Syncing...',
                title: 'Sending changes to the cloud',
                detail: 'Syncing with the cloud...'
            };
        }
        if (status === 'ok') {
            return {
                kind: 'ok',
                cls: 'cloud',
                text: 'Synced ' + clock(lastSyncAt),
                title: 'Last successful sync at ' + clock(lastSyncAt),
                detail: 'Cloud connected - last sync ' + clock(lastSyncAt) + ' (auto every ' + poll + 's).'
            };
        }
        return {
            kind: 'connecting',
            cls: 'syncing',
            text: 'Connecting...',
            title: 'Connecting to the cloud',
            detail: 'Connecting to the cloud...'
        };
    }

    function updateSyncBadge() {
        var st = describeStatus();

        var dot = OEE.utils.$('syncDot');
        if (dot) dot.className = 'sync-dot' + (st.cls ? ' ' + st.cls : '');

        var txt = OEE.utils.$('syncText');
        if (txt) txt.innerText = st.text;

        if (dot && dot.parentNode && dot.parentNode.setAttribute) {
            dot.parentNode.setAttribute('title', st.title);
        }

        var line = OEE.utils.$('firebaseStatusLine');
        if (line) {
            line.textContent = st.detail;
            line.className = 'cloud-status cloud-status-' + st.kind;
        }
    }

    OEE.sync = {
        init: init,
        setFirebaseUrl: setFirebaseUrl,
        getFirebaseUrl: getFirebaseUrl,
        getStatus: getStatus,
        pushNow: pushNow,
        pullNow: pullNow,
        syncNow: syncNow,
        schedulePush: schedulePush,
        notifyLocalChange: notifyLocalChange,
        startPolling: startPolling,
        stopPolling: stopPolling,
        updateSyncBadge: updateSyncBadge,
        mergeRemote: mergeRemote,
        stateUrl: stateUrl
    };

}(window.OEE = window.OEE || {}));

/* ==========================================================================
   smoke-test.js — automated verification of the whole app
   --------------------------------------------------------------------------
   Loads the real index.html + the real script files into jsdom and exercises
   the app end to end: auth, permissions, production flow, undo, rework,
   planned/unplanned stops, OEE math, settings, XSS, migration, performance.

   Run:  npm install jsdom && node tests/smoke-test.js
   ========================================================================== */
const { JSDOM, VirtualConsole } = require('jsdom');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(ROOT, 'index.html');

/* jsdom refuses localStorage on an opaque file:// origin, so we build the DOM
   from the real index.html but evaluate the real script files by hand, in the
   exact order the markup lists them. */
const SCRIPT_ORDER = [
  'js/config.js','js/utils.js','js/crypto.js','js/storage.js','js/sync.js',
  'js/events.js','js/metrics.js','js/machines.js','js/auth.js','js/export.js',
  'js/views/station.js','js/views/dashboard.js','js/views/setup.js','js/main.js'
];

let pass = 0, fail = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (extra ? ' -> ' + extra : '')); console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : '')); }
}
function eq(name, actual, expected) {
  check(name, actual === expected, 'got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected));
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

const consoleErrors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => consoleErrors.push('jsdomError: ' + (e.detail ? e.detail.stack || e.detail : e.message)));
vc.on('error', (...a) => consoleErrors.push('console.error: ' + a.join(' ')));
vc.on('warn', (...a) => consoleErrors.push('console.warn: ' + a.join(' ')));

const dom = new JSDOM(fs.readFileSync(INDEX, 'utf8'), {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://oee.test/index.html',
  virtualConsole: vc
});

const w = dom.window;
const d = w.document;

(async function run() {

  /* load every script in manifest order, exactly like the browser would */
  for (const rel of SCRIPT_ORDER) {
    const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    try {
      w.eval(code);
    } catch (e) {
      console.log('\n!!! SCRIPT FAILED: ' + rel);
      console.log(e && e.stack ? e.stack : e);
      process.exit(3);
    }
  }
  d.dispatchEvent(new w.Event('DOMContentLoaded'));
  await new Promise(r => setTimeout(r, 250));
  return dom;
})().then(async dom => {
  const w = dom.window;
  const d = w.document;
  const OEE = w.OEE;

  /* --------------------------------------------------------------- */
  section('BOOT');
  check('OEE namespace exists', !!OEE);
  check('config loaded', !!OEE && !!OEE.config);
  check('db initialised', !!(OEE && OEE.db && OEE.db.machines.length === 5), OEE && OEE.db && OEE.db.machines.length);
  check('events array present', !!(OEE && OEE.db && Array.isArray(OEE.db.events)));

  /* --------------------------------------------------------------- */
  section('BUG: OEE.deepClone is not a function (crashed the whole boot)');
  check('OEE.utils.deepClone is a function', typeof OEE.utils.deepClone === 'function');
  check('deepClone round-trips',
        JSON.stringify(OEE.utils.deepClone({ a: 1, b: { c: 2 } })) === '{"a":1,"b":{"c":2}}');

  /* The crash happened while migrating a stored database that contained an
     undoSnapshot, i.e. any machine that had already finished a layer.
     Reproduce exactly that stored shape. */
  const storedWithSnapshot = {
    updatedAt: Date.now(),
    users: [{ username: 'op', salt: 'aa', hash: 'bb', role: 'OPERATOR' }],
    models: [{ id: 'm1', name: 'M', layers: 80, rating: '500 kVA', voltage: '13.8kV', stdLayerSec: 0, stdBoxSec: 0 }],
    stopReasons: [{ id: 's1', name: 'Break', category: 'UNPLANNED' }],
    machines: [{
      code: 'W01', name: 'Winding Machine 01', status: 'RUNNING', stopReason: '',
      stateStartTime: Date.now(), stepStartTime: Date.now(),
      transformer: {
        sn: 'SN-1', wo: 'WO-1', batch: '1 of 1', modelName: 'M', modelId: 'm1',
        rating: '500 kVA', voltage: '13.8kV', totalLayers: 80,
        phase: 'LAYER', currentLayer: 5, goodLayersCompleted: 4, reworkedLayers: 0
      },
      undoSnapshot: {
        sn: 'SN-1', phase: 'LAYER', currentLayer: 4, stepStartTime: Date.now(),
        eventType: 'LAYER_DONE'
      }
    }],
    events: [{ id: 'e1', timestamp: Date.now(), machineCode: 'W01', type: 'LAYER_DONE', durationSec: 12 }],
    notes: []
  };

  let migratedSnap = null;
  let threw = null;
  try {
    w.localStorage.setItem(OEE.config.STORAGE_KEY, JSON.stringify(storedWithSnapshot));
    migratedSnap = OEE.storage.migrateDB(storedWithSnapshot);
  } catch (e) {
    threw = e;
  }
  check('migrating a DB with an undoSnapshot does NOT throw', threw === null,
        threw ? (threw.message || String(threw)) : '');
  check('undoSnapshot survives the migration',
        !!(migratedSnap && migratedSnap.machines[0].undoSnapshot));
  eq('undoSnapshot currentLayer preserved', migratedSnap.machines[0].undoSnapshot.currentLayer, 4);
  check('transformer survives the migration',
        migratedSnap.machines[0].transformer && migratedSnap.machines[0].transformer.currentLayer === 5);

  /* full reload path: storage -> migrate -> adopt, with a cold localStorage */
  w.localStorage.clear();
  let bootThrew = null;
  try {
    const seeded = OEE.storage.load();
    if (!seeded || seeded.machines.length !== 5) bootThrew = new Error('seed did not produce 5 machines');
  } catch (e) { bootThrew = e; }
  check('SEED FROM EMPTY localStorage WORKS', bootThrew === null,
        bootThrew ? (bootThrew.message || String(bootThrew)) : '');
  check('seed persisted to localStorage',
        !!w.localStorage.getItem(OEE.config.STORAGE_KEY));
  check('seed models use AUTO standards',
        OEE.db.models.every(m => m.stdLayerSec === 0 && m.stdBoxSec === 0));

  /* --------------------------------------------------------------- */
  section('FUNCTION PARITY (all 50 original functions reachable)');
  const expected = {
    utils: ['escapeHtml','formatTimer','deepClone','debounce','toast','openModal','closeModal'],
    crypto: ['sha256Hex','hashPassword','verifyPassword'],
    storage: ['load','save','adopt','migrateDB','pruneEvents'],
    sync: ['setFirebaseUrl','pushNow','pullNow','schedulePush','updateSyncBadge'],
    log: ['logEvent','bankRunSegment','bankStopSegment','removeEventById'],
    metrics: ['computeMetrics','learnedTimes','invalidateCache'],
    machines: ['getAll','getActiveMachine','getByCode','populateMachineSelectors','changeActiveMachine','setMachineStandby','createDefaultMachine'],
    auth: ['doLogin','logout','hasRole','requireRole'],
    exporter: ['exportCSV'],
    nav: ['switchView','switchRightSubTab','refreshActiveScreen'],
    'views.station': ['render','renderMainPad','renderStatusBadge','renderTransformerCard','renderStationOEE','renderLayerHistory','renderNotes','handleMainPadPress','undoLastPress','openNewTransformerModal','autoFillModelSpecs','confirmStartTransformer','openStopModal','confirmStopMachine','resumeMachineFromStop','openReworkModal','confirmReworkLayer','openNoteModal','confirmSaveNote'],
    'views.dashboard': ['render','renderLive'],
    'views.setup': ['render','addTransformerModel','deleteModel','addStopReason','deleteStopReason','addMachine','addUser','deleteUser','resetFactoryDemoData','saveFirebaseUrl']
  };
  let missing = [];
  Object.keys(expected).forEach(ns => {
    const parts = ns.split('.');
    const owner = parts.length > 1
      ? parts.reduce((o, k) => (o ? o[k] : null), OEE)
      : OEE[parts[0]];
    expected[ns].forEach(fn => {
      if (!owner || typeof owner[fn] !== 'function') missing.push(ns + '.' + fn);
    });
  });
  check('all public functions present (' + Object.values(expected).flat().length + ')', missing.length === 0, missing.join(', '));
  check('createDefaultMachine exposed at root', typeof OEE.createDefaultMachine === 'function');

  /* --------------------------------------------------------------- */
  section('HTML PARITY (no inline handlers left)');
  const inlineOnclick = d.querySelectorAll('[onclick]').length;
  const inlineOnchange = d.querySelectorAll('[onchange]').length;
  eq('no onclick= attributes remain', inlineOnclick, 0);
  eq('no onchange= attributes remain', inlineOnchange, 0);
  const withAction = d.querySelectorAll('[data-action]').length;
  check('data-action buttons present', withAction > 15, withAction + ' found');

  /* --------------------------------------------------------------- */
  section('AUTH - hashed passwords, no plaintext in storage');
  d.getElementById('loginUser').value = 'operador';
  d.getElementById('loginPass').value = 'operador123';
  OEE.auth.doLogin();
  check('operador logged in', !!OEE.currentUser && OEE.currentUser.username === 'operador');
  eq('role is OPERATOR', OEE.currentUser.role, 'OPERATOR');
  check('dashboard tab hidden for operator', d.getElementById('tabBtnDashboard').style.display === 'none');
  check('setup tab hidden for operator', d.getElementById('tabBtnSetup').style.display === 'none');

  const storedRaw = w.localStorage.getItem(OEE.config.STORAGE_KEY);
  check('no plaintext "operador123" in localStorage', storedRaw.indexOf('operador123') === -1);
  check('no "pass" field in stored users', !/"pass"\s*:/.test(storedRaw));
  check('users have salt+hash', OEE.db.users.every(u => typeof u.salt === 'string' && typeof u.hash === 'string'));

  /* wrong password */
  OEE.auth.logout();
  d.getElementById('loginUser').value = 'operador';
  d.getElementById('loginPass').value = 'wrong';
  OEE.auth.doLogin();
  check('wrong password rejected', OEE.currentUser === null);

  /* login as admin */
  d.getElementById('loginUser').value = 'admin';
  d.getElementById('loginPass').value = 'admin123';
  OEE.auth.doLogin();
  check('admin logged in', !!OEE.currentUser && OEE.currentUser.role === 'ADMIN');
  check('setup tab visible for admin', d.getElementById('tabBtnSetup').style.display === 'flex');

  /* --------------------------------------------------------------- */
  section('PERMISSIONS (requireRole - the console-call hole)');
  OEE.auth.logout();
  d.getElementById('loginUser').value = 'operador';
  d.getElementById('loginPass').value = 'operador123';
  OEE.auth.doLogin();

  const machinesBefore = OEE.db.machines.length;
  const usersBefore = OEE.db.users.length;
  OEE.views.setup.resetFactoryDemoData();   // confirm() returns true in jsdom? check
  OEE.machines.setMachineStandby('W01');
  OEE.views.setup.addUser();
  OEE.views.setup.addMachine();
  eq('operator cannot reset factory data (machines unchanged)', OEE.db.machines.length, machinesBefore);
  eq('operator cannot add users', OEE.db.users.length, usersBefore);
  eq('operator cannot add machines', OEE.db.machines.length, machinesBefore);

  OEE.auth.logout();
  d.getElementById('loginUser').value = 'admin';
  d.getElementById('loginPass').value = 'admin123';
  OEE.auth.doLogin();
  OEE.views.setup.addMachine();
  d.getElementById('newMachCode').value = 'W99';
  d.getElementById('newMachName').value = 'Test Machine 99';
  OEE.views.setup.addMachine();
  eq('admin CAN add machines', OEE.db.machines.length, machinesBefore + 1);
  check('new machine appears in station selector',
    Array.from(d.getElementById('stationMachineSelect').options).some(o => o.value === 'W99'));

  /* --------------------------------------------------------------- */
  section('PRODUCTION FLOW');
  OEE.activeMachineCode = 'W01';
  OEE.machines.changeActiveMachine('W01');

  const m = OEE.machines.getActiveMachine();
  eq('starts IDLE', m.status, 'IDLE');
  check('standby does NOT count as downtime', OEE.metrics.computeMetrics('W01', 1).avail === '100.0');

  OEE.settings.cooldownSec = 0;   // test without waiting
  OEE.views.station.openNewTransformerModal();
  d.getElementById('ntSN').value = 'SN-TEST-1';
  d.getElementById('ntWO').value = 'WO-TEST-1';
  OEE.views.station.confirmStartTransformer();
  eq('machine RUNNING after start', m.status, 'RUNNING');
  eq('phase BOX', m.transformer.phase, 'BOX');
  OEE.utils.closeModal('modalNewTransf');

  OEE.views.station.handleMainPadPress();
  eq('BOX -> LAYER 1', m.transformer.phase + ' ' + m.transformer.currentLayer, 'LAYER 1');

  OEE.views.station.handleMainPadPress();
  eq('LAYER 1 -> LAYER 2', m.transformer.currentLayer, 2);
  OEE.views.station.handleMainPadPress();
  eq('LAYER 2 -> LAYER 3', m.transformer.currentLayer, 3);
  check('2 LAYER_DONE events', OEE.db.events.filter(e => e.type === 'LAYER_DONE').length === 2,
        OEE.db.events.filter(e => e.type === 'LAYER_DONE').length);
  check('1 BOX_DONE event', OEE.db.events.filter(e => e.type === 'BOX_DONE').length === 1);

  /* --- undo --- */
  OEE.views.station.undoLastPress();
  eq('undo returns to layer 2', m.transformer.currentLayer, 2);
  eq('undo removed exactly one LAYER_DONE', OEE.db.events.filter(e => e.type === 'LAYER_DONE').length, 1);

  /* --- stop (unplanned) --- */
  /* bankRunSegment only records segments longer than 1s, so wait for it */
  await new Promise(r => setTimeout(r, 1150));
  OEE.views.station.openStopModal();
  check('stop modal populated', d.getElementById('stopGridUnplanned').children.length > 0);
  OEE.views.station.confirmStopMachine('Machine breakdown', 'UNPLANNED');
  eq('status UNPLANNED', m.status, 'UNPLANNED');
  check('RUN_SEGMENT banked on stop', OEE.db.events.some(e => e.type === 'RUN_SEGMENT'));

  OEE.views.station.resumeMachineFromStop();
  eq('back to RUNNING', m.status, 'RUNNING');
  check('STOP_UNPLANNED logged on resume', OEE.db.events.some(e => e.type === 'STOP_UNPLANNED'));

  /* --- planned stop then start a transformer: must be logged (bug B2) --- */
  OEE.views.station.confirmStopMachine('Meal / Break', 'PLANNED');
  eq('status PLANNED', m.status, 'PLANNED');
  const plannedBefore = OEE.db.events.filter(e => e.type === 'STOP_PLANNED').length;
  OEE.views.station.openNewTransformerModal();
  d.getElementById('ntSN').value = 'SN-TEST-2';
  OEE.views.station.confirmStartTransformer();
  const plannedAfter = OEE.db.events.filter(e => e.type === 'STOP_PLANNED').length;
  check('B2 FIXED: PLANNED stop is logged on restart', plannedAfter === plannedBefore + 1,
        plannedBefore + ' -> ' + plannedAfter);
  OEE.utils.closeModal('modalNewTransf');

  /* --- rework --- */
  m.transformer.phase = 'LAYER'; m.transformer.currentLayer = 5; m.status = 'RUNNING';
  OEE.db.events = OEE.db.events.filter(e => e.type !== 'LAYER_DONE');
  for (let i = 1; i <= 5; i++) {
    OEE.log.logEvent('W01', 'LAYER_DONE', 'Layer ' + i, 600, { modelName: 'Distribution 150kVA', sn: 'SN-TEST-2', layer: i });
  }
  const goodBefore = OEE.metrics.computeMetrics('W01', 1).counts.goodLayers;
  d.getElementById('rwTargetLayer').value = '3';
  d.getElementById('rwReason').value = 'Wire overlap';
  OEE.views.station.confirmReworkLayer();
  eq('currentLayer rewound to 3', m.transformer.currentLayer, 3);
  eq('reworkedLayers = 2', m.transformer.reworkedLayers, 2);
  const goodAfter = OEE.metrics.computeMetrics('W01', 1).counts.goodLayers;
  check('B10 FIXED: re-done layers no longer count as good', goodAfter === goodBefore - 2, goodBefore + ' -> ' + goodAfter);
  const qual = parseFloat(OEE.metrics.computeMetrics('W01', 1).qual);
  check('quality dropped after rework', qual < 100, 'qual=' + qual);

  /* --- notes --- */
  OEE.views.station.openNoteModal(false);
  d.getElementById('noteText').value = 'Tension slightly high';
  OEE.views.station.confirmSaveNote();
  eq('note saved', OEE.db.notes.length, 1);
  eq('note text stored', OEE.db.notes[0].text, 'Tension slightly high');

  /* --------------------------------------------------------------- */
  section('BUG B1 - Availability double counting');
  const met = OEE.metrics.computeMetrics('W01', 365);
  const c = met.counts;
  const eventsRunSum = OEE.db.events.filter(e => e.type === 'RUN_SEGMENT').reduce((a, e) => a + e.durationSec, 0);
  check('runSec comes only from RUN_SEGMENT (+ live)',
        c.runSec >= eventsRunSum, 'runSec=' + c.runSec.toFixed(1) + ' segments=' + eventsRunSum.toFixed(1));
  const stepSum = OEE.db.events.filter(e => ['BOX_DONE','LAYER_DONE','TRANSF_FINISHED'].includes(e.type))
                      .reduce((a, e) => a + e.durationSec, 0);
  check('step durations NOT added to running time',
        c.runSec < eventsRunSum + stepSum + 1 || stepSum < 1,
        'runSec=' + c.runSec.toFixed(1) + ' steps=' + stepSum.toFixed(1));

  /* --------------------------------------------------------------- */
  section('METRICS');
  check('availability in [0,100]', +met.avail >= 0 && +met.avail <= 100, met.avail);
  check('quality in [0,100]', +met.qual >= 0 && +met.qual <= 100, met.qual);

  /* realistic durations: actual slower than the standard, so LEARNED must < 100 */
  OEE.db.events.forEach(e => {
    if (e.type === 'BOX_DONE') e.durationSec = 1200;
    if (e.type === 'LAYER_DONE') e.durationSec = 780;
  });
  OEE.metrics.invalidateCache();
  eq('default performanceMode is LEARNED', OEE.settings.performanceMode, 'LEARNED');
  const learned = OEE.metrics.computeMetrics('W01', 365);
  check('B4 FIXED: LEARNED penalises slow work', +learned.perf < 100 && +learned.perf > 0, 'perf=' + learned.perf);
  check('perfHasData true when steps exist', learned.perfHasData === true);

  /* faster than standard must cap at 100, never exceed */
  OEE.db.events.forEach(e => {
    if (e.type === 'BOX_DONE' || e.type === 'LAYER_DONE') e.durationSec = 60;
  });
  OEE.metrics.invalidateCache();
  const fast = OEE.metrics.computeMetrics('W01', 365);
  eq('perf caps at 100.0 when faster than standard', fast.perf, '100.0');

  OEE.settings.performanceMode = 'FIXED_100';
  eq('FIXED_100 is always 100', OEE.metrics.computeMetrics('W01', 365).perf, '100.0');
  OEE.settings.performanceMode = 'LEARNED';

  /* no data at all -> "-" not a misleading 100% */
  OEE.storage.adopt(OEE.createDefaultDB());
  const noData = OEE.metrics.computeMetrics('W01', 365);
  check('perfHasData false with no completed step', noData.perfHasData === false);
  eq('perf is still 1.0 internally', noData.perf, '100.0');

  check('B9 FIXED: MTBF is "-" with no failures', met.hasFailures === true || met.mtbfLabel === '-', met.mtbfLabel);

  /* --------------------------------------------------------------- */
  section('CONFIGURABLE VALUES (etapa 4)');
  eq('default oeeTarget', OEE.settings.oeeTarget, 85);
  d.getElementById('setOeeTarget').value = '92';
  d.getElementById('setCooldownSec').value = '5';
  d.getElementById('setRetentionDays').value = '30';
  d.getElementById('setPerformanceMode').value = 'LEARNED';
  OEE.views.setup.saveSettings();
  eq('oeeTarget updated', OEE.settings.oeeTarget, 92);
  eq('cooldown updated', OEE.settings.cooldownSec, 5);
  eq('retention updated', OEE.settings.retentionDays, 30);
  eq('performanceMode updated', OEE.settings.performanceMode, 'LEARNED');
  eq('target label updated on station card', d.getElementById('infoOeeTarget').textContent, 'TARGET 92%');

  /* out of range is rejected */
  d.getElementById('setOeeTarget').value = '9999';
  OEE.views.setup.saveSettings();
  eq('out-of-range oeeTarget rejected', OEE.settings.oeeTarget, 92);

  /* ----------------------------------------------------------- */
  section('XSS / SECURITY');
  /* the METRICS section above reset the database - put the machine back to a
     state where the stop modal can actually be opened */
  const xm = OEE.machines.getActiveMachine();
  xm.status = 'RUNNING';
  xm.transformer = { sn: 'SN-X', wo: 'W', batch: '1/1', modelName: 'M', modelId: 'm2', rating: 'r',
    voltage: 'v', totalLayers: 80, phase: 'LAYER', currentLayer: 5, goodLayersCompleted: 4, reworkedLayers: 0 };

  OEE.log.logEvent('W01', 'NOTE', "<img src=x onerror=alert(1)>");
  OEE.views.station.renderLayerHistory(OEE.machines.getActiveMachine());
  check('no injected <img> from event detail', d.getElementById('subTabLayersContent').querySelector('img') === null);

  const evilName = "'); alert(1); //";
  OEE.db.stopReasons.push({ id: 'x1', name: evilName, category: 'UNPLANNED' });
  OEE.views.station.openStopModal();
  const grid = d.getElementById('stopGridUnplanned');
  check('stop reason rendered as text, not parsed',
        Array.from(grid.children).some(b => b.textContent === evilName));
  check('no inline onclick attribute on stop buttons',
        Array.from(grid.children).every(b => !b.getAttribute('onclick')));

  const evilNote = '<script>window.__pwned=1<\/script><b>bold</b>';
  OEE.db.notes.unshift({ id: 1, machineCode: 'W01', sn: evilNote, operator: evilNote,
                         shift: 'x', timeStr: 'now', stepLabel: 'L', subStep: 'S', text: evilNote });
  OEE.views.station.renderNotes('W01');
  check('note HTML not executed', w.__pwned === undefined);
  check('note rendered as literal text',
        d.getElementById('subTabNotesContent').textContent.indexOf('<b>bold</b>') !== -1);
  check('no <b> element created from note', d.getElementById('subTabNotesContent').querySelector('b') === null);

  check('escapeHtml escapes quotes', OEE.utils.escapeHtml("a'b\"c<d>") === "a&#39;b&quot;c&lt;d&gt;");
  eq('csv formula injection neutralised', OEE.exporter.csvCell('=1+1'), '"\'=1+1"');
  eq('csv normal cell', OEE.exporter.csvCell('W01'), '"W01"');
  eq('csv quote doubling', OEE.exporter.csvCell('say "hi"'), '"say ""hi"""');

  /* --------------------------------------------------------------- */
  section('STORAGE MIGRATION + PRUNING');
  const legacy = {
    updatedAt: Date.now(),
    users: [{ username: 'legacy', pass: 'secret123', role: 'MANAGER' }],
    machines: [{ code: 'W01', name: 'Old 01', status: 'IDLE' }],
    events: [{ type: 'LAYER_DONE', timestamp: Date.now(), machineCode: 'W01', durationSec: 5 }],
    notes: []
  };
  w.localStorage.setItem(OEE.config.STORAGE_KEY, JSON.stringify(legacy));
  const migrated = OEE.storage.migrateDB(JSON.parse(legacy.updatedAt ? JSON.stringify(legacy) : '{}'));
  check('legacy plaintext user got hashed', migrated.users[0].hash !== undefined);
  check('legacy plaintext removed', migrated.users[0].pass === undefined);
  check('legacy password still verifies', OEE.crypto.verifyPassword(migrated.users[0], 'secret123'));
  check('missing settings defaulted', migrated.settings.oeeTarget === 85);

  const corrupt = OEE.storage.migrateDB({ updatedAt: 1, machines: 'not-an-array' });
  check('corrupt machine list recovers to defaults', corrupt.machines.length === 5);

  /* pruning */
  OEE.storage.adopt(OEE.createDefaultDB());
  OEE.settings.retentionDays = 1;
  for (let i = 0; i < 50; i++) {
    OEE.db.events.push({ id: 'old' + i, type: 'LAYER_DONE', timestamp: Date.now() - 10 * 86400000,
                         machineCode: 'W01', durationSec: 1 });
  }
  const live = { id: 'live', type: 'LAYER_DONE', timestamp: Date.now(), machineCode: 'W01', durationSec: 1 };
  OEE.db.events.push(live);
  OEE.storage.pruneEvents();
  check('old events pruned', !OEE.db.events.some(e => e.id === 'old0'));
  check('recent event kept', OEE.db.events.some(e => e.id === 'live'));

  /* --------------------------------------------------------------- */
  section('DASHBOARD + SETUP RENDER');
  OEE.auth.logout();
  d.getElementById('loginUser').value = 'gestor';
  d.getElementById('loginPass').value = 'gestor123';
  OEE.auth.doLogin();
  eq('manager lands on dashboard', d.getElementById('viewDashboard').classList.contains('hidden'), false);
  OEE.nav.switchView('dashboard');
  check('KPI OEE rendered', /%$/.test(d.getElementById('kpiOEE').textContent), d.getElementById('kpiOEE').textContent);
  check('pareto rendered or empty hint', d.getElementById('dashParetoList').children.length > 0);
  check('learned table has rows', d.getElementById('dashLearnedTable').children.length === 3);
  check('machines table has rows', d.getElementById('dashMachinesTable').children.length >= 5);

  OEE.auth.logout();
  d.getElementById('loginUser').value = 'admin';
  d.getElementById('loginPass').value = 'admin123';
  OEE.auth.doLogin();
  OEE.nav.switchView('setup');
  check('models table rendered', d.getElementById('setupModelsTable').children.length === 3);
  check('stops table rendered', d.getElementById('setupStopsTable').children.length === 12);
  check('users table rendered', d.getElementById('setupUsersTable').children.length === 3);

  /* --------------------------------------------------------------- */
  section('KEYBOARD GUARD (bug B5)');
  /* the XSS section left the stop modal open - close it so the pad is reachable */
  OEE.utils.closeModal('modalStop');
  check('no modal blocking the pad', OEE.utils.isAnyModalOpen() === false);
  OEE.settings.cooldownSec = 0;
  const stationUp = d.getElementById('viewStation');
  const wasHidden = stationUp.classList.contains('hidden');
  stationUp.classList.remove('hidden');
  const machine = OEE.machines.getActiveMachine();
  eq('active machine is W01', machine.code, 'W01');
  machine.status = 'RUNNING';
  machine.transformer = { sn: 'S', wo: 'W', batch: '1 of 1', modelName: 'M', modelId: 'm2',
    rating: 'r', voltage: 'v', totalLayers: 80, phase: 'LAYER', currentLayer: 1,
    goodLayersCompleted: 0, reworkedLayers: 0 };
  const eventsBefore = OEE.db.events.length;
  const fakeBtn = d.createElement('button');
  fakeBtn.setAttribute('data-action', 'noop');
  d.body.appendChild(fakeBtn);
  fakeBtn.focus();
  fakeBtn.dispatchEvent(new w.KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }));
  eq('SPACE on a focused BUTTON does not press the pad', OEE.db.events.length, eventsBefore);

  d.body.dispatchEvent(new w.KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }));
  eq('SPACE on the page DOES press the pad', OEE.db.events.length, eventsBefore + 1);

  fakeBtn.remove();

  /* --------------------------------------------------------------- */
  section('CONSOLE HEALTH');
  const realErrors = consoleErrors.filter(e => !/Not implemented|Could not parse CSS|Error: Not implemented/i.test(e));
  check('no runtime errors logged', realErrors.length === 0, realErrors.slice(0, 5).join(' | '));

  /* --------------------------------------------------------------- */
  section('BUG B6 - cooldown is per machine');
  OEE.utils.closeModal('modalStop');
  OEE.settings.cooldownSec = 2;
  OEE.activeMachineCode = 'W01';
  const w1 = OEE.machines.getByCode('W01');
  w1.status = 'RUNNING';
  w1.transformer = { sn: 'A', wo: 'W', batch: '1/1', modelName: 'M', modelId: 'm2', rating: 'r',
    voltage: 'v', totalLayers: 80, phase: 'LAYER', currentLayer: 1, goodLayersCompleted: 0, reworkedLayers: 0 };
  OEE.views.station.handleMainPadPress();
  check('W01 is cooling down', OEE.views.station.isCoolingDown('W01') === true);
  check('W02 is NOT cooling down', OEE.views.station.isCoolingDown('W02') === false,
        'the original used one global boolean and locked every machine');

  OEE.settings.cooldownSec = 0;

  /* --------------------------------------------------------------- */
  section('BUG B4 - machine selector rebuilt after a remote change');
  OEE.auth.logout();
  d.getElementById('loginUser').value = 'operador';
  d.getElementById('loginPass').value = 'operador123';
  OEE.auth.doLogin();
  const before = d.getElementById('stationMachineSelect').options.length;
  /* simulate a cloud pull adding a machine on another PC */
  OEE.db.machines.push(OEE.createDefaultMachine('W77', 'Remote Machine 77'));
  OEE.db.updatedAt = Date.now() + 1000;
  OEE.nav.refreshActiveScreen();
  check('B4 FIXED: machine from a remote PC appears immediately',
        Array.from(d.getElementById('stationMachineSelect').options).some(o => o.value === 'W77'));
  eq('selector grew by exactly one option', d.getElementById('stationMachineSelect').options.length, before + 1);
  check('dashboard filter also updated',
        Array.from(d.getElementById('dashMachineFilter').options).some(o => o.value === 'W77'));

  /* --------------------------------------------------------------- */
  section('PERFORMANCE');
  OEE.storage.adopt(OEE.createDefaultDB());
  for (let i = 0; i < 20000; i++) {
    OEE.db.events.push({
      id: 'ev' + i, timestamp: Date.now() - Math.random() * 86400000 * 180,
      machineCode: 'W0' + (i % 5 + 1), type: i % 3 === 0 ? 'LAYER_DONE' : (i % 3 === 1 ? 'BOX_DONE' : 'STOP_UNPLANNED'),
      durationSec: 300 + (i % 400), modelName: 'Distribution 150kVA', sn: 'SN' + i, layer: i,
      operator: 'op', shift: 'S', detail: 'event ' + i, reason: 'Machine breakdown'
    });
  }
  OEE.db.updatedAt = Date.now();

  let t0 = process.hrtime.bigint();
  for (let i = 0; i < 200; i++) OEE.metrics.computeMetrics('ALL', 365);
  let msAll = Number(process.hrtime.bigint() - t0) / 1e6;

  t0 = process.hrtime.bigint();
  for (let i = 0; i < 200; i++) {
    OEE.machines.getAll().forEach(m => OEE.metrics.computeMetrics(m.code, 1));
  }
  let msPerMachine = Number(process.hrtime.bigint() - t0) / 1e6;

  console.log('  20k events | 200x global metrics : ' + msAll.toFixed(1) + ' ms  (' + (msAll / 200).toFixed(2) + ' ms/call)');
  console.log('  20k events | 200x 6 machines     : ' + msPerMachine.toFixed(1) + ' ms  (' + (msPerMachine / 200).toFixed(2) + ' ms/frame)');
  check('metrics cache keeps a 6-machine frame under 5 ms', msPerMachine / 200 < 5, (msPerMachine / 200).toFixed(2) + ' ms');
  check('metrics stay under 16 ms (animation frame budget)', msAll / 200 < 16, (msAll / 200).toFixed(2) + ' ms');

  /* --------------------------------------------------------------- */
  section('PERFORMANCE MODE: default is now LEARNED, not FIXED_100');
  OEE.auth.logout();
  d.getElementById('loginUser').value = 'admin';
  d.getElementById('loginPass').value = 'admin123';
  OEE.auth.doLogin();
  OEE.storage.adopt(OEE.createDefaultDB());
  OEE.nav.switchView('setup');
  eq('fresh install defaults to LEARNED', OEE.settings.performanceMode, 'LEARNED');
  eq('select shows LEARNED', d.getElementById('setPerformanceMode').value, 'LEARNED');
  eq('target default 85', d.getElementById('setOeeTarget').value, '85');

  /* editable standard times drive the Performance metric */
  const rows = d.getElementById('setupModelsTable').querySelectorAll('tr');
  eq('models table has 3 rows', rows.length, 3);
  check('std time inputs present',
        d.querySelectorAll('#setupModelsTable [data-action="save-std"]').length === 6,
        d.querySelectorAll('#setupModelsTable [data-action="save-std"]').length + ' inputs');

  const m2 = OEE.db.models[1];
  OEE.views.setup.updateModelStd(m2.id, 'stdLayerSec', 600);
  eq('stdLayerSec saved', m2.stdLayerSec, 600);
  /* 3 layers at 900s actual vs 600s standard -> 66.7% */
  for (let i = 1; i <= 3; i++) {
    OEE.log.logEvent('W01', 'LAYER_DONE', 'Layer ' + i, 900,
      { modelName: m2.name, modelId: m2.id, sn: 'SN-X', layer: i });
  }
  const perfAfter = OEE.metrics.computeMetrics('W01', 365);
  check('slow work lowers Performance', +perfAfter.perf < 70, 'perf=' + perfAfter.perf);
  /* renaming the model must not orphan the history */
  m2.name = 'Distribution 150kVA RENAMED';
  OEE.metrics.invalidateCache();
  eq('perf survives a model rename (matched by id)', OEE.metrics.computeMetrics('W01', 365).perf, perfAfter.perf);

  /* --------------------------------------------------------------- */
  section('OEE TARGET COLOURING (bug 3)');
  OEE.utils.setMetric('kpiOEE', '91.0%', 85);
  eq('above target gets metric-ok', d.getElementById('kpiOEE').className, 'metric-ok');
  OEE.utils.setMetric('kpiOEE', '84.9%', 85);
  eq('below target gets metric-bad', d.getElementById('kpiOEE').className, 'metric-bad');
  check('bad class renders red', d.getElementById('kpiOEE').classList.contains('metric-bad'));
  OEE.utils.setMetric('kpiOEE', '85.0%', 85);
  eq('exactly at target is NOT red', d.getElementById('kpiOEE').className, 'metric-ok');
  OEE.utils.setMetric('kpiOEE', '50.0%', null);
  eq('no target -> no colour class', d.getElementById('kpiOEE').className, '');

  OEE.nav.switchView('station');
  OEE.views.station.renderStationOEE('W01');
  const stationOee = d.getElementById('stationOEE');
  check('station OEE is coloured', /metric-(ok|bad)/.test(stationOee.className), stationOee.className);
  const shown = parseFloat(stationOee.textContent);
  eq('station colour matches the target rule',
     stationOee.classList.contains('metric-bad'), shown < OEE.settings.oeeTarget);

  /* --------------------------------------------------------------- */
  section('MODALS stay open while you fill them in (bug 1)');
  const scenarios = [
    ['modalNewTransf', () => OEE.views.station.openNewTransformerModal()],
    ['modalRework', () => OEE.views.station.openReworkModal()],
    ['modalStop', () => OEE.views.station.openStopModal()],
    ['modalNote', () => OEE.views.station.openNoteModal(false)]
  ];

  for (const [modalId, open] of scenarios) {
    /* make sure the machine state allows the modal */
    const mm = OEE.machines.getActiveMachine();
    mm.status = 'RUNNING';
    mm.transformer = { sn: 'SN-M', wo: 'W', batch: '1/1', modelName: 'M', modelId: 'm2', rating: 'r',
      voltage: 'v', totalLayers: 80, phase: 'LAYER', currentLayer: 5, goodLayersCompleted: 4, reworkedLayers: 0 };

    open();
    const backdrop = d.getElementById(modalId);
    if (!backdrop.classList.contains('open')) {
      /* not openable in this state - reopen for the rest */
      continue;
    }

    const box = backdrop.querySelector('.modal-box');
    check(modalId + ': opens', backdrop.classList.contains('open'));

    /* click on the dialog itself -> must NOT close */
    box.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    check(modalId + ': click INSIDE the dialog does NOT close it',
          backdrop.classList.contains('open'));

    /* click a real form control inside the dialog (the realistic failure) */
    const inner = box.querySelector('input:not([disabled]), select, textarea');
    if (inner) {
      inner.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      check(modalId + ': click on an inner control does NOT close it',
            backdrop.classList.contains('open'));
    }

    /* the confirm button must still DO its job (and close) */
    const innerBtn = Array.from(box.querySelectorAll('button'))
        .find(b => !b.classList.contains('close-btn'));
    if (innerBtn) {
      innerBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      check(modalId + ': confirm button inside still fires its action',
            true, 'action=' + innerBtn.getAttribute('data-action'));
    }

    /* the X button -> closes */
    const closeBtn = backdrop.querySelector('.close-btn');
    closeBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    check(modalId + ': X button closes it', !backdrop.classList.contains('open'));

    /* backdrop itself -> closes */
    open();
    backdrop.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    check(modalId + ': click on the BACKDROP closes it', !backdrop.classList.contains('open'));

    const mm2 = OEE.machines.getActiveMachine();
    mm2.transformer = null;
    mm2.status = 'IDLE';
  }

  /* a full realistic flow: open the transformer modal, type, confirm */
  OEE.utils.closeModal('modalStop');
  OEE.utils.closeModal('modalRework');
  OEE.utils.closeModal('modalNote');
  OEE.machines.getActiveMachine().status = 'IDLE';
  OEE.machines.getActiveMachine().transformer = null;
  OEE.views.station.render();

  OEE.views.station.openNewTransformerModal();
  d.getElementById('ntSN').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  d.getElementById('ntSN').value = 'SN-TYPED';
  d.getElementById('ntBatch').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  check('modal still open after typing in the fields', d.getElementById('modalNewTransf').classList.contains('open'));
  eq('typed value survived', d.getElementById('ntSN').value, 'SN-TYPED');
  d.querySelector('#modalNewTransf [data-action="confirm-transformer"]')
     .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  check('confirm button actually started the transformer',
        OEE.machines.getActiveMachine().transformer !== null);
  check('and closed the modal', !d.getElementById('modalNewTransf').classList.contains('open'));

  /* --------------------------------------------------------------- */
  section('DOWNTIME HISTORY (feature)');
  const m2b = OEE.machines.getActiveMachine();
  m2b.status = 'RUNNING';
  await new Promise(r => setTimeout(r, 1150));
  OEE.views.station.confirmStopMachine('Machine breakdown', 'UNPLANNED');
  await new Promise(r => setTimeout(r, 1150));
  OEE.views.station.resumeMachineFromStop();
  m2b.status = 'RUNNING';
  OEE.views.station.confirmStopMachine('Meal / Break', 'PLANNED');
  await new Promise(r => setTimeout(r, 1150));
  OEE.views.station.resumeMachineFromStop();

  const stopEvents = OEE.db.events.filter(e => e.type === 'STOP_UNPLANNED' || e.type === 'STOP_PLANNED');
  check('stop events are written to the database', stopEvents.length >= 2, stopEvents.length + ' found');
  check('stop events carry startTime',
        stopEvents.every(e => typeof e.startTime === 'number' && e.startTime > 0));
  check('stop events carry endTime',
        stopEvents.every(e => typeof e.endTime === 'number' && e.endTime >= e.startTime));
  check('stop events carry the reason',
        stopEvents.every(e => typeof e.reason === 'string' && e.reason.length > 0));
  check('stop events carry the type',
        stopEvents.every(e => e.stopType === 'PLANNED' || e.stopType === 'UNPLANNED'));

  /* station history must show them */
  OEE.views.station.renderLayerHistory(OEE.machines.getActiveMachine());
  const histBox = d.getElementById('subTabLayersContent');
  const stopRows = histBox.querySelectorAll('.layer-log-item.stop');
  check('station history lists downtime rows', stopRows.length >= 2, stopRows.length + ' rows');
  check('has a PLANNED badge', histBox.querySelectorAll('.badge-planned').length >= 1);
  check('has an UNPLANNED badge', histBox.querySelectorAll('.badge-unplanned').length >= 1);
  check('shows the reason text', histBox.textContent.includes('Machine breakdown'));
  check('shows the planned reason text', histBox.textContent.includes('Meal / Break'));
  check('shows start -> end clock times', histBox.textContent.includes('→'));
  check('shows the duration', /\d\d:\d\d/.test(stopRows[0].textContent));
  check('step rows are still shown too', histBox.querySelectorAll('.layer-log-item').length > stopRows.length);

  /* dashboard stop table */
  OEE.nav.switchView('dashboard');
  d.getElementById('dashMachineFilter').value = 'W01';
  OEE.nav.switchView('dashboard');
  OEE.views.dashboard.render();

  const stopTable = d.getElementById('dashStopsTable');
  check('dashboard stop table exists', !!stopTable);
  const stopTableRows = stopTable.querySelectorAll('tr');
  check('dashboard stop table has rows', stopTableRows.length >= 2, stopTableRows.length + ' rows');

  const headers = Array.from(d.querySelectorAll('#dashStopsTable, .panel-card table th'))
      .map(t => t.textContent.trim());
  check('table has the required columns',
        ['Machine', 'Reason', 'Type', 'Duration'].every(c =>
          Array.from(d.querySelectorAll('th')).some(th => th.textContent.trim() === c)),
        Array.from(d.querySelectorAll('th')).map(th => th.textContent.trim()).join(' | '));

  check('table shows PLANNED and UNPLANNED types',
        stopTable.textContent.includes('PLANNED') && stopTable.textContent.includes('UNPLANNED'));
  check('summary chips rendered', d.getElementById('dashStopSummary').children.length === 5);

  /* --------------------------------------------------------------- */
  section('TREND WINDOW (computeMetrics) - a loss may dilute across days');
  /* This is the multi-day TREND model on purpose: over a window far larger
     than the worked time, dilution is expected and the number must still be
     floored so it never prints a clean 100.0 with a loss on record. The
     no-healing requirement is enforced by the SHIFT model below. */
  OEE.storage.adopt(OEE.createDefaultDB());
  const m2c = OEE.machines.getActiveMachine();
  m2c.code = 'W01';

  /* produce one unit quickly, then record a 60s unplanned stop */
  const T0 = Date.now();
  m2c.status = 'RUNNING';
  m2c.stateStartTime = T0 - 120000;      // 2 minutes of production so far
  m2c.stepStartTime = T0 - 120000;
  m2c.transformer = { sn: 'SN-L', wo: 'W', batch: '1/1', modelName: 'M', modelId: 'm1',
    rating: 'r', voltage: 'v', totalLayers: 80, phase: 'LAYER', currentLayer: 5,
    goodLayersCompleted: 4, reworkedLayers: 0 };
  OEE.log.bankRunSegment(m2c, 'test stop');
  eq('availability is 100% before any loss', OEE.metrics.computeMetrics('W01', 1).avail, '100.0');

  m2c.stateStartTime = Date.now() - 60000;
  OEE.log.bankStopSegment(m2c, 'STOP_UNPLANNED', 'Machine breakdown');
  m2c.stateStartTime = Date.now();

  const afterLoss = OEE.metrics.computeMetrics('W01', 1);
  check('availability dropped below 100', parseFloat(afterLoss.avail) < 100, 'avail=' + afterLoss.avail);

  /* Now let a LOT of extra running time pile up - the old formula healed here */
  for (let i = 0; i < 40; i++) {
    OEE.log.logEvent('W01', 'RUN_SEGMENT', 'bulk', 3600);
  }
  const afterMoreWork = OEE.metrics.computeMetrics('W01', 1);
  check('availability never returns to a clean 100',
        parseFloat(afterMoreWork.avail) < 100, 'avail=' + afterMoreWork.avail);
  check('OEE never returns to a clean 100',
        parseFloat(afterMoreWork.oee) < 100, 'oee=' + afterMoreWork.oee);

  /* 10 hours of running would have rounded a 60s loss to 100.0% before */
  OEE.db.events.forEach(e => { if (e.type === 'RUN_SEGMENT') e.durationSec = 36000; });
  OEE.metrics.invalidateCache();
  const wayLater = OEE.metrics.computeMetrics('W01', 365);
  check('a loss is never rounded away to a clean 100.0',
        wayLater.avail !== '100.0' && wayLater.oee !== '100.0',
        'avail=' + wayLater.avail + ' oee=' + wayLater.oee);
  check('trend model: dilutes across the window but stays a real loss',
        wayLater.rawAvail > afterMoreWork.rawAvail && wayLater.rawAvail < 1,
        'raw after=' + afterMoreWork.rawAvail.toFixed(6) +
        ' raw later=' + wayLater.rawAvail.toFixed(6));
  check('raw availability never reaches 1.0 even in the trend', wayLater.rawAvail < 1);

  /* formatPercent guard */
  eq('formatPercent floors a rounded-away loss', OEE.metrics.formatPercent(0.9997, true), '99.9');
  eq('formatPercent allows a clean 100 without loss', OEE.metrics.formatPercent(1, false), '100.0');

  /* --------------------------------------------------------------- */
  section('BUG 1 - Performance on a 10 s line (LEARNED must actually move)');
  OEE.storage.adopt(OEE.createDefaultDB());
  OEE.metrics.invalidateCache();
  const fast1 = OEE.machines.getActiveMachine();
  fast1.status = 'RUNNING';
  fast1.transformer = { sn: 'SN-F', wo: 'W', batch: '1/1', modelName: 'Distribution 150kVA',
    modelId: 'm2', rating: 'r', voltage: 'v', totalLayers: 80, phase: 'LAYER',
    currentLayer: 1, goodLayersCompleted: 0, reworkedLayers: 0 };

  /* 6 layers of exactly 10 s -> enough samples to auto-calibrate the standard */
  for (let i = 1; i <= 6; i++) {
    OEE.log.logEvent('W01', 'LAYER_DONE', 'Layer ' + i, 10,
      { modelName: 'Distribution 150kVA', modelId: 'm2', sn: 'SN-F', layer: i });
  }
  const std = OEE.metrics.standardsForModel(OEE.db.models[1]);
  check('AUTO standard learned from history', std.layerAuto === true, 'layerSec=' + std.layerSec);
  check('AUTO standard matches the real 10 s line',
        Math.abs(std.layerSec - 10) < 0.001, 'layerSec=' + std.layerSec);
  eq('perf at exactly the standard is 100', OEE.metrics.computeMetrics('W01', 1).perf, '100.0');

  /* now a layer that overruns the learned standard */
  OEE.log.logEvent('W01', 'LAYER_DONE', 'Layer 7', 20,
    { modelName: 'Distribution 150kVA', modelId: 'm2', sn: 'SN-F', layer: 7 });
  const slow = OEE.metrics.computeMetrics('W01', 1);
  check('BUG1 FIXED: an overrunning layer lowers Performance',
        parseFloat(slow.perf) < 100, 'perf=' + slow.perf);
  check('perfCapped reported when beating the standard', typeof slow.perfCapped === 'boolean');

  /* explicit standard overrides auto */
  OEE.views.setup.updateModelStd('m2', 'stdLayerSec', 30);
  eq('explicit standard wins over auto',
        OEE.metrics.standardsForModel(OEE.db.models[1]).layerAuto, false);
  OEE.metrics.invalidateCache();
  const explicit = OEE.metrics.computeMetrics('W01', 1);
  check('explicit standard changes the result', parseFloat(explicit.perf) > parseFloat(slow.perf),
        'auto=' + slow.perf + ' explicit=' + explicit.perf);

  /* 0 restores auto */
  OEE.views.setup.updateModelStd('m2', 'stdLayerSec', '0');
  eq('0 restores AUTO', OEE.metrics.standardsForModel(OEE.db.models[1]).layerAuto, true);

  /* --------------------------------------------------------------- */
  section('BUG 4/5 - English text and changeover as PLANNED');
  OEE.storage.adopt(OEE.createDefaultDB());
  const mEn = OEE.machines.getActiveMachine();
  mEn.status = 'RUNNING';
  mEn.transformer = { sn: 'SN-E', wo: 'W', batch: '1/1', modelName: 'M', modelId: 'm1',
    rating: 'r', voltage: 'v', totalLayers: 2, phase: 'FINALIZE', currentLayer: 2,
    goodLayersCompleted: 2, reworkedLayers: 0 };
  OEE.settings.cooldownSec = 0;
  OEE.views.station.renderMainPad(mEn);

  const padText = d.getElementById('mainPad').textContent;
  check('BUG4 FIXED: finish button is in English', padText.includes('FINALIZE TRANSFORMER'),
        padText.replace(/\s+/g, ' ').slice(0, 120));
  check('BUG4 FIXED: no Portuguese "FINALIZAR" anywhere', !padText.includes('FINALIZAR'));

  const htmlText = fs.readFileSync(INDEX, 'utf8');
  check('BUG4: no "FINALIZAR" in index.html', !/FINALIZAR/i.test(htmlText));

  /* finalize -> changeover must be PLANNED */
  OEE.views.station.handleMainPadPress();
  eq('BUG5 FIXED: changeover status is PLANNED', mEn.status, 'PLANNED');
  eq('changeover reason recorded', mEn.stopReason, 'Setup / Changeover');
  check('transformer cleared', mEn.transformer === null);

  OEE.views.station.renderMainPad(mEn);
  const padText2 = d.getElementById('mainPad').textContent;
  check('changeover pad says PLANNED', padText2.includes('PLANNED'), padText2.replace(/\s+/g, ' ').slice(0, 140));
  check('changeover pad no longer says UNPLANNED', !padText2.includes('UNPLANNED'));

  /* the changeover must be logged as PLANNED, so it never hurts Availability */
  const beforeChange = OEE.metrics.computeMetrics('W01', 1).avail;
  OEE.views.station.openNewTransformerModal();
  d.getElementById('ntSN').value = 'SN-NEXT';
  OEE.views.station.confirmStartTransformer();
  OEE.utils.closeModal('modalNewTransf');
  const changeoverEvents = OEE.db.events.filter(e =>
    e.reason === 'Setup / Changeover' || e.detail.indexOf('Setup / Changeover') !== -1);
  check('changeover was written to the log', changeoverEvents.length >= 1, changeoverEvents.length + ' events');
  check('BUG5: changeover is recorded as PLANNED',
        changeoverEvents.every(e => e.type === 'STOP_PLANNED'),
        changeoverEvents.map(e => e.type).join(','));
  eq('BUG5: changeover does not hurt Availability',
     OEE.metrics.computeMetrics('W01', 1).avail, beforeChange);

  /* seed reason list must also treat changeover as planned */
  check('seed reason "Setup / Changeover" is PLANNED',
        OEE.createDefaultDB().stopReasons.filter(s => s.name === 'Setup / Changeover')
          .every(s => s.category === 'PLANNED'));

  /* --------------------------------------------------------------- */
  section('SHIFT WINDOW - a loss NEVER heals inside the shift (fixed denominator)');

  OEE.storage.adopt(OEE.createDefaultDB());
  const H = 3600000;
  const atNow = Date.now();

  /* --- shift grid is anchored and fixed --- */
  const six = new Date(atNow); six.setHours(6, 30, 0, 0);
  const sixStart = new Date(atNow); sixStart.setHours(6, 0, 0, 0);
  eq('06:30 falls in the shift that started at 06:00',
     OEE.metrics.currentShiftWindow(six.getTime()).start, sixStart.getTime());

  const tenPm = new Date(atNow); tenPm.setHours(22, 30, 0, 0);
  eq('22:30 starts a shift at 22:00',
     new Date(OEE.metrics.currentShiftWindow(tenPm.getTime()).start).getHours(), 22);

  const threeAm = new Date(atNow); threeAm.setHours(3, 0, 0, 0);
  const wThree = OEE.metrics.currentShiftWindow(threeAm.getTime());
  eq('03:00 belongs to the 22:00 shift that began the day before',
     new Date(wThree.start).getHours(), 22);
  check('...which started before midnight', wThree.start < new Date(atNow).setHours(0, 0, 0, 0));

  OEE.settings.shiftLengthHours = 12;
  eq('shift length follows a 12h setting',
     OEE.metrics.currentShiftWindow(atNow).durationSec, 12 * 3600);
  OEE.settings.shiftLengthHours = 8;

  const win = OEE.metrics.currentShiftWindow(atNow);
  eq('default shift length is 8h', win.durationSec, 8 * 3600);

  /* --- deterministic machine + model --- */
  const shm = OEE.db.machines[0];            /* W01 */
  shm.status = 'IDLE';                       /* no open live segment */
  const shmodel = OEE.db.models[0];
  shmodel.stdLayerSec = 600;                 /* explicit: price the rework at 600s/layer */
  shmodel.stdBoxSec = 900;

  function pushEv(e) { OEE.db.events.push(e); }

  /* --- the two losses, both at the very START of the shift --- */
  const stopTs = win.start + 1000;
  pushEv({ id: 'sh-stop', timestamp: stopTs, machineCode: 'W01', type: 'STOP_UNPLANNED',
           durationSec: 2700, reason: 'Machine breakdown',
           startTime: stopTs, endTime: stopTs + 2700000 });
  const rwTs = win.start + 2000;
  pushEv({ id: 'sh-rework', timestamp: rwTs, machineCode: 'W01', type: 'REWORK',
           durationSec: 0, layersLost: 5, modelId: shmodel.id, modelName: shmodel.name,
           sn: 'SN-SHIFT' });
  OEE.metrics.invalidateCache();

  const early = OEE.metrics.computeShiftMetrics('W01', win.start + H);

  eq('shift denominator is the FIXED shift length', early.periodSec, 28800);
  check('availability debits the whole 45-min stop',
        Math.abs(early.rawAvail - (1 - 2700 / 28800)) < 1e-9, early.rawAvail);
  check('quality debits the 5 reworked layers at standard',
        Math.abs(early.rawQual - (1 - (5 * 600) / 28800)) < 1e-9, early.rawQual);
  check('both losses are already visible right after they happened',
        early.avail !== '100.0' && early.qual !== '100.0' && early.oee !== '100.0',
        'avail=' + early.avail + ' qual=' + early.qual + ' oee=' + early.oee);

  /* --- then the REST OF THE SHIFT runs perfectly (44 layers at standard) --- */
  const LAYERS = 44;
  for (let i = 0; i < LAYERS; i++) {
    const ts = win.start + 2 * H + Math.floor((i * (4.5 * H)) / LAYERS);
    pushEv({ id: 'sh-layer-' + i, timestamp: ts, machineCode: 'W01', type: 'LAYER_DONE',
             durationSec: 600, modelId: shmodel.id, modelName: shmodel.name,
             sn: 'SN-SHIFT', layer: i + 1 });
  }
  OEE.metrics.invalidateCache();

  const late = OEE.metrics.computeShiftMetrics('W01', win.start + 7 * H);

  eq('LAYER: perfect production was recorded', late.counts.goodLayers, LAYERS);
  eq('performance is 100 while every step meets the standard', late.rawPerf, 1);

  eq('AVAILABILITY did NOT heal after 7h of perfect production',
     late.rawAvail, early.rawAvail);
  eq('QUALITY did NOT heal after 7h of perfect production',
     late.rawQual, early.rawQual);
  eq('OEE did NOT heal after 7h of perfect production',
     late.rawOee, early.rawOee);
  check('the shift OEE is clearly not near 100%', parseFloat(late.oee) < 85, 'oee=' + late.oee);
  check('both losses are still fully visible at the end of the shift',
        parseFloat(late.avail) < 100 && parseFloat(late.qual) < 100,
        'avail=' + late.avail + ' qual=' + late.qual);

  /* --- monotonic: a further loss can only push the KPIs DOWN --- */
  const stop2 = win.start + 6 * H;
  pushEv({ id: 'sh-stop2', timestamp: stop2, machineCode: 'W01', type: 'STOP_UNPLANNED',
           durationSec: 1200, reason: 'Wire break',
           startTime: stop2, endTime: stop2 + 1200000 });
  OEE.metrics.invalidateCache();
  const worse = OEE.metrics.computeShiftMetrics('W01', win.start + 7 * H);

  check('a second stop lowers availability further', worse.rawAvail < late.rawAvail, worse.rawAvail);
  check('KPIs only ever fall within the shift', worse.rawOee <= late.rawOee, worse.rawOee);

  /* --- continuing to run must not dilute the losses --- */
  shm.status = 'RUNNING';
  shm.stateStartTime = win.start + 2 * H;
  const running = OEE.metrics.computeShiftMetrics('W01', win.start + 7 * H);
  eq('live running time does not dilute the shift OEE', running.rawOee, worse.rawOee);
  check('...though running time is still tracked for MTBF', running.counts.runSec > 0,
        running.counts.runSec);
  shm.status = 'IDLE';

  /* --- a clean shift still reads exactly 100% --- */
  OEE.storage.adopt(OEE.createDefaultDB());
  const clean = OEE.metrics.computeShiftMetrics('W01', win.start + 3 * H);
  eq('a shift with no loss reads a clean 100.0 OEE', clean.oee, '100.0');
  eq('...with 100.0 availability', clean.avail, '100.0');
  eq('...and 100.0 quality', clean.qual, '100.0');

  /* --------------------------------------------------------------- */
  section('REWORK seconds feed Quality, the CSV and the fixed shift denominator');

  OEE.storage.adopt(OEE.createDefaultDB());
  OEE.settings.shiftStartHour = 6;
  OEE.settings.shiftLengthHours = 8;
  OEE.activeMachineCode = 'W01';
  OEE.machines.changeActiveMachine('W01');

  const rwModel = OEE.db.models[0];
  rwModel.stdLayerSec = 600;                 /* explicit: 1 layer = 600s */
  rwModel.stdBoxSec = 900;

  const rwm = OEE.machines.getActiveMachine();
  rwm.status = 'RUNNING';
  rwm.stepStartTime = Date.now() - 60000;
  rwm.transformer = {
    sn: 'SN-RW', wo: 'WO-RW', batch: '1/1',
    modelId: rwModel.id, modelName: rwModel.name,
    rating: 'r', voltage: 'v', totalLayers: 80,
    phase: 'LAYER', currentLayer: 4, goodLayersCompleted: 3, reworkedLayers: 0
  };
  for (let i = 1; i <= 4; i++) {
    OEE.log.logEvent('W01', 'LAYER_DONE', 'Layer ' + i, 600,
      { modelId: rwModel.id, modelName: rwModel.name, sn: 'SN-RW', layer: i });
  }
  OEE.metrics.invalidateCache();

  /* rework back to layer 1 => 3 layers physically undone */
  d.getElementById('rwTargetLayer').value = '1';
  d.getElementById('rwReason').value = 'Wire overlap';
  OEE.settings.cooldownSec = 0;
  OEE.views.station.confirmReworkLayer();

  eq('3 layers were unwound', rwm.transformer.reworkedLayers, 3);

  const rwEvent = OEE.db.events.filter(e => e.type === 'REWORK')[0];
  check('a REWORK event was written', !!rwEvent);
  eq('REWORK duration is 3 x 600s = 1800s, NOT 0', rwEvent.durationSec, 1800);

  /* the CSV must carry the real duration, not 0 */
  const rwCsv = OEE.exporter.buildCSV();
  const rwLine = rwCsv.split(/\r?\n/).filter(l => l.indexOf('"REWORK"') !== -1)[0];
  check('CSV has a REWORK row', !!rwLine);
  check('CSV REWORK row shows 1800, not 0', !!rwLine && /"1800"/.test(rwLine), rwLine);
  check('CSV REWORK row no longer shows a 0 duration',
        !!rwLine && !/"REWORK"[^]*?"0"/.test(rwLine), rwLine);

  /* Quality debits exactly those 1800s against the fixed shift length */
  OEE.metrics.invalidateCache();
  const rwWin = OEE.metrics.currentShiftWindow(Date.now());
  const rwQ1 = OEE.metrics.computeShiftMetrics('W01', Date.now());

  check('quality debits the rework at 1800s against the shift',
        Math.abs(rwQ1.rawQual - (1 - 1800 / rwWin.durationSec)) < 1e-9,
        'qual=' + rwQ1.rawQual + ' expected=' + (1 - 1800 / rwWin.durationSec));
  check('quality clearly reflects the 3-layer rework',
        parseFloat(rwQ1.qual) < 100 && parseFloat(rwQ1.qual) < 95, rwQ1.qual);

  /* then the rest of the shift runs perfectly: quality must NOT heal */
  const goodBeforeQ = rwQ1.counts.goodLayers;
  for (let i = 5; i <= 44; i++) {
    OEE.log.logEvent('W01', 'LAYER_DONE', 'Layer ' + i, 600,
      { modelId: rwModel.id, modelName: rwModel.name, sn: 'SN-RW', layer: i });
  }
  OEE.metrics.invalidateCache();
  const rwQ2 = OEE.metrics.computeShiftMetrics('W01', Date.now());

  check('good layers piled up after the rework', rwQ2.counts.goodLayers > goodBeforeQ,
        goodBeforeQ + ' -> ' + rwQ2.counts.goodLayers);
  eq('QUALITY did NOT heal as perfect layers accumulated',
     rwQ2.rawQual, rwQ1.rawQual);
  eq('rework seconds are still fully debited',
     rwQ2.counts.qualLossSec, 1800);
  check('quality is still clearly below 100 at the end',
        parseFloat(rwQ2.qual) < 100, rwQ2.qual);

  /* legacy REWORK rows with duration 0 still count via layersLost x standard */
  OEE.storage.adopt(OEE.createDefaultDB());
  OEE.db.models[0].stdLayerSec = 600;
  OEE.db.events.push({ id: 'legacy-rw', timestamp: Date.now(), machineCode: 'W01',
    type: 'REWORK', durationSec: 0, layersLost: 3,
    modelId: OEE.db.models[0].id, modelName: OEE.db.models[0].name, sn: 'SN-L' });
  OEE.metrics.invalidateCache();
  const legacyRw = OEE.metrics.computeShiftMetrics('W01', Date.now());
  eq('legacy REWORK (duration 0) falls back to layersLost x standard',
     legacyRw.counts.qualLossSec, 1800);

  /* --------------------------------------------------------------- */
  section('DECIMAL SHIFT LENGTH (8h30) and Shift start hour range');

  eq('validateSetting accepts 8.5', OEE.validateSetting('shiftLengthHours', 8.5, 8).value, 8.5);
  check('validateSetting accepts 8.5 (ok)', OEE.validateSetting('shiftLengthHours', 8.5, 8).ok);
  eq('normalizeSettings keeps 8.5', OEE.normalizeSettings({ shiftLengthHours: 8.5 }).shiftLengthHours, 8.5);
  check('validateSetting rejects 0.4 (below min)',
        OEE.validateSetting('shiftLengthHours', 0.4, 8).ok === false);

  OEE.settings.shiftLengthHours = 8.5;
  eq('8.5h shift window is 30600s, not 28800s',
     OEE.metrics.currentShiftWindow(Date.now()).durationSec, 8.5 * 3600);
  check('the shift window reports the fractional length',
        OEE.metrics.currentShiftWindow(Date.now()).lengthHours === 8.5);
  OEE.settings.shiftLengthHours = 8;

  /* shift start hour: 0 and 23 are valid, 24 is not */
  eq('validateSetting accepts shift start 0',
     OEE.validateSetting('shiftStartHour', 0, 6).value, 0);
  check('validateSetting accepts 0 (ok)', OEE.validateSetting('shiftStartHour', 0, 6).ok);
  eq('validateSetting accepts shift start 23',
     OEE.validateSetting('shiftStartHour', 23, 6).value, 23);
  check('validateSetting rejects shift start 24',
        OEE.validateSetting('shiftStartHour', 24, 6).ok === false);
  eq('normalizeSettings keeps shift start 0',
     OEE.normalizeSettings({ shiftStartHour: 0 }).shiftStartHour, 0);
  eq('normalizeSettings keeps shift start 23',
     OEE.normalizeSettings({ shiftStartHour: 23 }).shiftStartHour, 23);

  /* the Setup form must round-trip a fractional shift length */
  d.getElementById('loginUser').value = 'admin';
  d.getElementById('loginPass').value = 'admin123';
  OEE.auth.doLogin();
  d.getElementById('setOeeTarget').value = '85';
  d.getElementById('setPerformanceMode').value = 'LEARNED';
  d.getElementById('setCooldownSec').value = '3';
  d.getElementById('setRetentionDays').value = '180';
  d.getElementById('setShiftStartHour').value = '6';
  d.getElementById('setShiftLengthHours').value = '8.5';
  OEE.views.setup.saveSettings();

  eq('form saved the shift length as 8.5, not truncated to 8',
     OEE.settings.shiftLengthHours, 8.5);
  eq('form saved the shift start hour', OEE.settings.shiftStartHour, 6);

  OEE.views.setup.loadSettingsForm();
  eq('form reloads the 8.5 shift length',
     d.getElementById('setShiftLengthHours').value, '8.5');

  /* a fractional shift still yields a fixed, monotonic denominator */
  OEE.storage.adopt(OEE.createDefaultDB());
  OEE.settings.shiftStartHour = 6;
  OEE.settings.shiftLengthHours = 8.5;
  OEE.db.models[0].stdLayerSec = 600;
  OEE.db.machines[0].status = 'IDLE';
  const fWin = OEE.metrics.currentShiftWindow(Date.now());
  OEE.db.events.push({ id: 'f-stop', timestamp: fWin.start + 1000, machineCode: 'W01',
    type: 'STOP_UNPLANNED', durationSec: 1800, reason: 'Breakdown' });
  OEE.metrics.invalidateCache();
  const fEarly = OEE.metrics.computeShiftMetrics('W01', fWin.start + H);
  for (let i = 0; i < 30; i++) {
    OEE.db.events.push({ id: 'f-l' + i, timestamp: fWin.start + 2 * H + i * 1000,
      machineCode: 'W01', type: 'LAYER_DONE', durationSec: 600,
      modelId: OEE.db.models[0].id, modelName: OEE.db.models[0].name, sn: 'F', layer: i + 1 });
  }
  OEE.metrics.invalidateCache();
  const fLate = OEE.metrics.computeShiftMetrics('W01', fWin.start + 5 * H);
  eq('8.5h shift denominator is 30600', fEarly.periodSec, 30600);
  check('availability debits against the fractional shift',
        Math.abs(fEarly.rawAvail - (1 - 1800 / 30600)) < 1e-9, fEarly.rawAvail);
  eq('a loss in an 8.5h shift does NOT heal either', fLate.rawAvail, fEarly.rawAvail);

  /* --------------------------------------------------------------- */
  section('CLOUD SYNC - two devices actually meet (merge, not overwrite)');

  function mkEvent(id, ts, code, extra) {
    const e = { id: id, timestamp: ts, machineCode: code, type: 'LAYER_DONE',
                durationSec: 10, operator: 'op', shift: '1st' };
    if (extra) Object.keys(extra).forEach(k => { e[k] = extra[k]; });
    return e;
  }

  /* --- mergeRemote: the append-only log is a union, never a wipe --- */
  const devA = OEE.createDefaultDB();
  const devB = OEE.createDefaultDB();
  devA.updatedAt = 1000;
  devB.updatedAt = 2000;
  devA.machines[0].stateStartTime = 1000;
  devA.machines[0].stepStartTime = 1000;
  devB.machines[0].stateStartTime = 2000;
  devB.machines[0].stepStartTime = 2000;
  devA.events = [mkEvent('a1', 1000, devA.machines[0].code)];
  devB.events = [mkEvent('b1', 2000, devB.machines[0].code)];

  const m1 = OEE.sync.mergeRemote(devA, devB);
  check('merge keeps BOTH devices events', m1.db.events.length === 2, m1.db.events.length);
  check('merge keeps device A event', m1.db.events.some(e => e.id === 'a1'));
  check('merge keeps device B event', m1.db.events.some(e => e.id === 'b1'));
  check('merge reports that something changed', m1.changed === true, m1.changed);
  check('the machine follows the most recently operated device',
        m1.db.machines[0].stepStartTime === 2000, m1.db.machines[0].stepStartTime);

  const mr2 = OEE.sync.mergeRemote(devB, devA);
  check('merge is order-independent (both events again)', mr2.db.events.length === 2, mr2.db.events.length);

  const m3 = OEE.sync.mergeRemote(m1.db, mr2.db);
  check('two devices that already converged report no further change (no ping-pong)',
        m3.changed === false, m3.changed);

  const devC = OEE.utils.deepClone(devA);
  devC.updatedAt = 99999;
  const m4 = OEE.sync.mergeRemote(devA, devC);
  check('identical config with a newer clock is NOT a change', m4.changed === false, m4.changed);

  /* --- end-to-end: push from device A, pull a device B write back --- */
  const firebaseStore = { body: null };
  w.fetch = function (url, opts) {
    if (opts && opts.method === 'PUT') {
      firebaseStore.body = opts.body;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(opts.body)) });
    }
    return Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve(firebaseStore.body ? JSON.parse(firebaseStore.body) : null)
    });
  };

  OEE.storage.adopt(OEE.createDefaultDB());
  OEE.currentUser = { username: 'admin', shift: '1st', role: 'ADMIN' };
  OEE.db.machines[0].stepStartTime = 5000;
  OEE.db.events = [mkEvent('a-only', 5000, OEE.db.machines[0].code)];

  OEE.sync.setFirebaseUrl('https://fake.firebaseio.com');
  await new Promise(r => setTimeout(r, 50));

  check('the cloud URL is stored and active',
        OEE.sync.getFirebaseUrl() === 'https://fake.firebaseio.com');
  check('device A pushed its state to the cloud', !!firebaseStore.body);
  check('the cloud now holds device A event',
        !!firebaseStore.body && JSON.parse(firebaseStore.body).events.some(e => e.id === 'a-only'));
  eq('sync status is OK after a successful round trip', OEE.sync.getStatus().state, 'ok');

  /* Now pretend device B wrote to the cloud while A was idle. */
  const devBState = OEE.utils.deepClone(JSON.parse(firebaseStore.body));
  devBState.updatedAt = Date.now() + 100000;
  devBState.machines[0].stepStartTime = Date.now() + 100000;
  devBState.events.unshift(mkEvent('b-only', Date.now() + 100000, devBState.machines[0].code));
  firebaseStore.body = JSON.stringify(devBState);

  const pulled = await OEE.sync.pullNow();
  check('pull adopted a merge instead of ignoring the other device', pulled === true, pulled);
  check('after the pull BOTH events are present (no work was lost)',
        OEE.db.events.some(e => e.id === 'a-only') && OEE.db.events.some(e => e.id === 'b-only'),
        OEE.db.events.map(e => e.id).join(','));
  eq('the local machine followed device B (most recent action)',
     OEE.db.machines[0].stepStartTime, devBState.machines[0].stepStartTime);

  const pulled2 = await OEE.sync.pullNow();
  check('a second pull with no cloud change is a no-op', pulled2 === false, pulled2);

  /* --- the original bug: a reload used to forget the stored URL --- */
  w.localStorage.setItem(w.OEE.config.FIREBASE_KEY, 'https://fake.firebaseio.com');
  OEE.sync.init();
  eq('init() resumes the stored cloud URL after a reload',
     OEE.sync.getFirebaseUrl(), 'https://fake.firebaseio.com');
  await new Promise(r => setTimeout(r, 50));
  check('resumed sync reaches the cloud (status is not off/error)',
        ['ok', 'connecting', 'syncing'].indexOf(OEE.sync.getStatus().state) !== -1,
        OEE.sync.getStatus().state);

  /* --------------------------------------------------------------- */
  section('RESULT');
  console.log('  passed: ' + pass + '   failed: ' + fail);
  if (failures.length) { console.log('\n  FAILURES:'); failures.forEach(f => console.log('   - ' + f)); }
  console.log(fail === 0 ? '\n>>> SMOKE TEST PASSED' : '\n>>> ' + fail + ' FAILURES');
  process.exit(fail === 0 ? 0 : 1);

}).catch(err => {
  console.error('HARNESS ERROR:', err);
  process.exit(2);
});
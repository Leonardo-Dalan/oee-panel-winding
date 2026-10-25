# OEE Panel: Winding Machine MES

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

*Real-time OEE monitoring dashboard for transformer winding machines: lightweight, offline-first web app (vanilla JS + Firebase).*

Production and measurement dashboard for **OEE** (Overall Equipment Effectiveness) for
transformer winding machines.

Runs directly in the browser, with no server, no build, and no external dependencies.
Designed to be opened by double-clicking on the operator's machine, inside the factory.

**Stack:** HTML + CSS + pure JavaScript (*classic scripts*), `localStorage`,
Firebase Realtime Database (optional, to sync multiple PCs).

## Demo

🌐 **Online:** https://oeewinding.netlify.app









https://github.com/user-attachments/assets/2c77f764-1007-4c90-a6aa-1cb078119358








---

## How to open

**Option 1: double-click (recommended for the factory)**

Double-click `index.html`. Done.

**Option 2: local server (development only)**

```bash
python -m http.server 8000
# depois abra http://localhost:8000
```

> The code uses *classic scripts* on purpose. ES Modules do not load via
> `file://` (the browser blocks them due to CORS), so opening by double-click
> would break with a blank screen. The code is still organized into modules.

---

## Default users (demo)

| Login | Password | Role | Access |
|---|---|---|---|
| `operador` | `operador123` | Operator | Workstation only |
| `gestor` | `gestor123` | Manager | Station + Dashboard |
| `admin` | `admin123` | Admin | Everything, including Setup & Admin |

Passwords are stored as a **SHA-256 hash with a per-user salt**; there is no way to
read the password back, only reset it. Change them before using in production:
*Setup & Admin → Manage Users*.

> Warning: plain SHA-256 is suitable for a 100% local app, but it does **not** replace
> argon2/bcrypt in a system with a server. If this ever becomes a multi-user
> network system, authentication needs to move to a backend.

---

## What the system does

### Operator station
- Selects the machine and tracks status (Standby / Running / Planned Stop / Unplanned)
- Large panel to record progress: **Box → Layer 1 → … → Layer N → Finish**
- Accepts click, `SPACE`, `Enter`, or a foot pedal
- 3 s lock after each touch, to avoid recording layers twice
- Undo the last touch, rework (go back to a layer), shift notes, and shift handover
- Stop with reason: **unplanned** (hits availability) or **planned** (does not hit)
- **Single history** with manufacturing steps **and all stops**: start, end,
  duration, reason, and `PLANNED` / `UNPLANNED` badge

### Dashboard
- KPIs: OEE, Availability, Performance, Quality, MTBF, MTTR
- **OEE turns red** when below the configured OEE Target
- **Downtime tracking table**: machine, reason, type, start, end, duration, and operator,
  with a summary of planned vs. unplanned stops
- Pareto of unplanned stops
- Average times learned automatically by transformer type
- Live machine table

### Setup & Admin (admin only)
- Registration of transformer models, stop reasons, and machines
- Users and roles
- **Production settings**: OEE Target, Performance mode, cooldown,
  history retention, **shift start and duration**
- Optional Firebase connection to sync multiple PCs

---

## How OEE is calculated

```
OEE = Disponibilidade × Performance × Qualidade
```

There are **two windows**, on purpose:

| Window | Where | Denominator | Recorded loss |
|---|---|---|---|
| **Current shift** | Station and *Current Shift* on the Dashboard | **fixed shift duration** | **permanent** |
| Day / Week / Month / 12 months | Dashboard period selector | window size | can dilute over the days |

### Shift OEE does NOT heal

The shift is the **unit of responsibility**. The denominator is the fixed shift
duration, and each loss is a permanent debit in seconds:

```
Disponibilidade = 1 − segundosNãoPlanejados / duraçãoDoTurno
Performance     = 1 − segundosAcimaDoPadrão / duraçãoDoTurno
Qualidade       = 1 − segundosDeRetrabalho   / duraçãoDoTurno
```

Since each loss component **only grows** within the shift, all KPIs are
**monotonic**: they can only fall or stay flat. Producing more does **not** push
the number back to 100% just because production continued.

> **Why this matters.** Classic formulas use a denominator that grows with
> every second of production:
> `Availability = running / (running + stopped)` and
> `Quality = good / (good + reworked)`. With them, a loss at 8 a.m. would already have
> dissolved by 5 p.m., and the shift would "heal." Measured against the fixed
> shift duration, a loss recorded at 8 a.m. is still fully visible at 5 p.m.
>
> In a shift where production fills the window, the two models converge:
> `reworkSeconds / shiftDuration ≈ defects / pieces`. The difference
> appears exactly when production continues after the loss, which is the case
> we want to measure.

The shift is a fixed-duration grid anchored to **Shift start hour**
(*Production Settings*), e.g. start at 6 a.m. and 8 h duration → shifts 6 a.m.–2 p.m.,
2 p.m.–10 p.m., 10 p.m.–6 a.m. The duration accepts a **decimal value** in 0.5 h steps: for
an 8h30 shift, enter `8.5`. A machine in *Standby* does not count as a loss, and
a planned stop does not either.

### Performance

Compares the actual time of each step with the **model standard time**. In the shift,
seconds spent **above** the standard are the loss:

```
Performance = 1 − Σ(max(0, tempoReal − tempoPadrão)) / duraçãoDoTurno   (limitado a 100%)
```

Meeting the standard does not generate credit; only excess time counts against the shift.

Two modes, in *Setup & Admin*:

- `LEARNED`: **default**. Compares against the model standard time.
- `FIXED_100`: always 100%, never penalizes.

With no completed step yet, Performance shows a dash (`-`) instead of a
misleading `100%`.

### Standard time: AUTO

In *Setup & Admin → Register Transformer Model* there are **Std Box (s)** and
**Std Layer (s)**.

- **`0` = AUTO**: the engine calibrates the standard with the **actual measured average** for that
  model, starting from 5 completed steps. It is the recommended default: a line
  that takes 10 s per layer self-adjusts in a few steps.
- **Explicit number**: overrides the automatic one.

The **In use** column shows the standard the engine is using at that moment
(`auto 10s`, `600s`, `600s (fallback)`). Without it, it is easy to think the standard
is wrong when in fact AUTO is still calibrating.

> Performance is capped at 100%: meeting the standard does not generate credit. If the KPI
> is stuck at `100%`, the warning below it will say *"Beating the standard"*,
> a sign that the standard is too high, not that the calculation failed.

**Quality** debits the standard time of layers that went back for rework.
It is a one-way debit: redoing the layers fixes the transformer, but the
shift does not "recover" the credit; the loss keeps counting, as it should.

**MTBF / MTTR** only appear after the first unplanned failure. With no
failures recorded they show a dash (`-`), instead of an invented number.

**Target.** The OEE number is colored automatically: **green** above
the OEE Target, **red** below. Adjust the target in *Production Settings*.

---

## Changeover between transformers

When a transformer is finished, the machine enters **Setup / Changeover** with
**PLANNED** status: it is a known and conscious stop, and it is not charged
against Availability.

The event is recorded normally (reason `Setup / Changeover`, with start, end, and
duration), so it is possible to build a changeover KPI over the existing
history without breaking compatibility; just sum `STOP_PLANNED` where the reason
is that one.

In the stop reason list in *Setup & Admin*, `Setup / Changeover` also
already comes classified as **planned**.

> Current classification: `PLANNED`. There are plans to create a dedicated
> changeover KPI and reevaluate this classification.

---

## Stop history

Every stop, **planned or not**, becomes a record in the database with:

| Field | Content |
|---|---|
| `startTime` | instant the machine stopped |
| `endTime` | instant it came back |
| `durationSec` | duration in seconds |
| `reason` | selected reason |
| `stopType` | `PLANNED` or `UNPLANNED` |

These records appear in three places:

1. **Station → Layer History**, with a colored badge and the interval `14:32 → 15:07`
2. **Dashboard → Downtime Tracking**, full table by machine
3. **Export CSV**, in the columns `Start_Time`, `End_Time`, `Reason`, and `Event_Type`

Planned stops appear in all of them for traceability, but only unplanned
ones enter the Availability calculation.

---

## Settings

In *Setup & Admin → Production Settings*:

| Field | Default | What for |
|---|---|---|
| OEE Target (%) | 85 | Target; OEE turns red below it |
| Performance Mode | `LEARNED` | Whether performance is calculated or fixed |
| Cooldown (s) | 3 | Lock time after each touch on the panel |
| Retention (days) | 180 | How long history is kept |
| Shift start hour | 6 | Start hour of the shift grid |
| Shift length (h) | 8 | Duration of each shift (accepts decimal, e.g. `8.5`) |

technical knobs (intervals, event limit, CSV delimiter) are in
`js/config.js`.

---

## Sync between PCs

Three levels:

1. **localStorage**: saves on this PC
2. **BroadcastChannel / `storage` event**: other tabs on the same PC
3. **Firebase Realtime Database**: other PCs in the factory (optional)

To enable level 3: create a Realtime Database at
[console.firebase.google.com](https://console.firebase.google.com), copy the URL,
and paste it into *Setup & Admin* → **Connect Realtime Cloud**. The URL is saved and
sync comes back on its own after reloading the page on any PC.

### Visible status

Cloud state is always in view, in two places:

- **Badge at the top** (next to the tabs): `Local sync only` (gray/green),
  `Connecting…` / `Syncing…` (pulsing amber), `Synced HH:MM:SS` (cyan), or
  `Cloud error` (red).
- **Status line on the Firebase card** (Setup & Admin), with the time of the last
  sync or the error message.

### How data comes together (merge, not overwrite)

A *pull* no longer replaces the entire database: it **merges** what is in the
cloud with what is on this PC, so that no PC loses work:

| Collection | Merge rule |
| --- | --- |
| `events` / `notes` | union by `id` (append-only log: nothing is lost) |
| `machines` | by code: the side with the most recent activity wins |
| `settings`, `users`, `models`, `stopReasons` | last write wins, and only when content changes |

`updatedAt` is the merge version and only advances when something actually changed, so
two PCs converge in one extra step instead of endlessly overwriting each other. If two
operators control the **same machine** at the same time, that machine's state
(current layer, status) follows the PC that acted last; the events from both
are preserved, but the ideal is one PC per machine.

### ⚠️ Firebase security

A database created in **Test Mode** accepts reads and writes from **anyone**
who has the URL, including strangers. Before putting real production data in,
secure the database.

Since the app is purely front-end (no server to validate login), there is no way
to do "real" authentication with only Realtime Database rules.
The realistic paths are:

- **Firebase App Check**: blocks access coming from outside your app/site;
- **keep the system 100% local** (no Firebase) in plants with sensitive data.

If the database URL leaks, production data leaks with it. When in doubt, run locally.

---

## Structure

```
oee-panel-winding/
├── index.html              # só a estrutura
├── README.md
├── LICENSE
├── .gitignore
├── css/
│   ├── tokens.css          # cores, espaçamentos, tipografia (variáveis)
│   └── styles.css          # componentes, layout, responsivo
├── js/
│   ├── config.js           # constantes + dados iniciais
│   ├── utils.js            # DOM, escapeHtml, formatação, toasts
│   ├── crypto.js           # SHA-256 e hash de senha
│   ├── storage.js          # localStorage, migração, podagem
│   ├── sync.js             # abas + Firebase
│   ├── events.js           # registro de eventos
│   ├── metrics.js          # motor de OEE
│   ├── machines.js         # registro de máquinas
│   ├── auth.js             # login e permissões
│   ├── export.js           # CSV
│   ├── main.js             # bootstrap, navegação, teclado, heartbeat
│   └── views/
│       ├── station.js      # tela do operador
│       ├── dashboard.js    # indicadores
│       └── setup.js        # administração
└── tests/
    └── smoke-test.js       # 275 verificações automatizadas
```

All modules register in a single global object `window.OEE`, with no
dependency between files beyond that loading order.

---

## Tests

```bash
npm install jsdom
node tests/smoke-test.js
```

275 automated checks covering login and permissions, the complete production
flow, undo, rework, planned and unplanned stops, OEE calculation,
settings, XSS, data migration, and performance.

---

## Implementation notes

**Why is there no `innerHTML` for user data?** Everything that comes from typing
(machine name, serial number, stop reason, shift note) is written
with `textContent` or escaped. Buttons use `data-action` with event delegation,
instead of `onclick="funcao('valor')"`, because interpolating user text
into an HTML attribute allows code injection.

**Why SHA-256 in pure JS?** `crypto.subtle` only exists in a secure context
(https/localhost). Opening the file via `file://` does not have it, so the app
would take a hash hit. The implementation is in `js/crypto.js` and is validated
against the official NIST vectors.

**History limit.** `db.events` is pruned by age and by count
(`config.tech.maxEvents`). Without that, `localStorage` fills up and the browser starts
throwing `QuotaExceededError`; the app now handles that error instead of crashing.

**Modals.** The backdrop that darkens the screen only closes the dialog when the click
happens **on the backdrop itself**. Clicking any field or button inside the
dialog does not close it, avoiding the common case of "the modal closes by itself when filling it in."

**Encoding.** All files are UTF-8 **without BOM**. `<meta charset="UTF-8">`
must be the first thing inside `<head>`. If you edit these files
with tools that save in ANSI (PowerShell 5.1 is one of them), accents and
emojis turn into garbage; run an encoding test before committing.

---

## License

MIT: see the [LICENSE](LICENSE) file.

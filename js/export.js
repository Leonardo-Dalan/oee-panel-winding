/* ==========================================================================
   export.js — CSV report
   --------------------------------------------------------------------------
   Two safety measures added to the original:

   1. CSV / formula injection. A cell starting with = + - @ TAB or CR is
      executed as a formula by Excel and LibreOffice. Since operator names,
      transformer SNs and free-text notes all come from users, any of them
      could become `=HYPERLINK("http://evil","click")`. Those fields are
      now prefixed with an apostrophe.

   2. Delimiter comes from config, and every field is quoted defensively.
   ========================================================================== */

(function (OEE) {
    'use strict';

    var FORMULA_TRIGGERS = ['=', '+', '-', '@', '\t', '\r'];

    function csvCell(value) {
        var str = value == null ? '' : String(value);

        if (str.length && FORMULA_TRIGGERS.indexOf(str.charAt(0)) !== -1) {
            str = "'" + str;
        }

        if (str.indexOf('"') !== -1) {
            str = str.replace(/"/g, '""');
        }

        return '"' + str + '"';
    }

    /* Build the whole report as a string. Kept separate from the download so
       it can be unit-tested without a Blob/URL/DOM. */
    function buildCSV() {
        var db = OEE.db;
        if (!db || !db.events || !db.events.length) return '';

        var d = OEE.config.tech.csvDelimiter;
        var header = ['Date', 'Time', 'Machine', 'Operator', 'Shift', 'Event_Type',
                      'Start_Time', 'End_Time', 'Duration_Seconds', 'Reason', 'Details'];

        var lines = [header.join(d)];

        db.events.forEach(function (e) {
            var isStop = e.type === 'STOP_UNPLANNED' || e.type === 'STOP_PLANNED';

            lines.push([
                csvCell(e.dateStr),
                csvCell(e.timeStr),
                csvCell(e.machineCode),
                csvCell(e.operator),
                csvCell(e.shift),
                csvCell(e.type),
                csvCell(e.startTime ? new Date(e.startTime).toLocaleTimeString('pt-BR') : ''),
                csvCell(e.endTime ? new Date(e.endTime).toLocaleTimeString('pt-BR') : ''),
                csvCell(e.durationSec),
                csvCell(isStop ? (e.stopType || '') : ''),
                csvCell(e.detail)
            ].join(d));
        });

        /* BOM so Excel detects UTF-8 and renders accents correctly */
        return '\uFEFF' + lines.join('\r\n');
    }

    function exportCSV() {
        if (!OEE.auth.requireLogin()) return;

        var db = OEE.db;
        if (!db.events || !db.events.length) {
            OEE.utils.toast('No events recorded yet.', 'warn');
            return;
        }

        var content = buildCSV();

        try {
            var blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
            var url = URL.createObjectURL(blob);

            var a = document.createElement('a');
            a.href = url;
            a.download = 'OEE_Winding_Report_' +
                new Date().toLocaleDateString('pt-BR').replace(/\//g, '-') + '.csv';

            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);

            /* release the object URL */
            setTimeout(function () { URL.revokeObjectURL(url); }, 1000);

            OEE.utils.toast('Report exported (' + db.events.length + ' events).', 'success');
        } catch (err) {
            console.error('[OEE] CSV export failed:', err);
            OEE.utils.toast('Could not generate the CSV report.', 'error');
        }
    }

    OEE.exporter = {
        exportCSV: exportCSV,
        buildCSV: buildCSV,
        csvCell: csvCell
    };

}(window.OEE = window.OEE || {}));
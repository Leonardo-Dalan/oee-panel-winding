/* ==========================================================================
   auth.js — Login, logout and (real) permission checks
   --------------------------------------------------------------------------
   The original only hid tabs with style.display='none'. Any logged-in
   operator could call resetFactoryDemoData() or deleteUser('admin') from the
   console. Every mutating function here and in views/setup.js now goes
   through requireRole().
   ========================================================================== */

(function (OEE) {
    'use strict';

    OEE.currentUser = null;

    var RANK = { OPERATOR: 1, MANAGER: 2, ADMIN: 3 };

    function doLogin() {
        var $ = OEE.utils.$;

        var username = $('loginUser').value.trim();
        var password = $('loginPass').value;
        var shift = $('loginShift').value;

        if (!username || !password) {
            OEE.utils.toast('Enter your username and password.', 'warn');
            return;
        }

        var users = OEE.db.users || [];
        var found = null;

        for (var i = 0; i < users.length; i++) {
            var candidate = users[i];
            if (String(candidate.username).toLowerCase() !== username.toLowerCase()) continue;
            if (OEE.crypto.verifyPassword(candidate, password)) {
                found = candidate;
                break;
            }
        }

        if (!found) {
            OEE.utils.toast('Invalid username or password!', 'error');
            $('loginPass').value = '';
            return;
        }

        /* verifyPassword may have upgraded a legacy plaintext record */
        OEE.storage.save();

        OEE.currentUser = {
            username: found.username,
            role: found.role || 'OPERATOR',
            shift: shift
        };

        OEE.utils.setText('topUserName', found.username + ' (' + (found.role || 'OPERATOR') + ')');
        OEE.utils.setText('topUserShift', shift);

        $('viewLogin').classList.add('hidden');
        $('mainTopbar').classList.remove('hidden');

        applyRoleVisibility();

        OEE.sync.updateSyncBadge();
        OEE.machines.populateMachineSelectors();
        OEE.views.setup.loadSettingsForm();

        /* Managers land on the dashboard, everyone else on their station. */
        if (OEE.currentUser.role === 'MANAGER') {
            OEE.nav.switchView('dashboard');
        } else {
            OEE.nav.switchView('station');
        }

        OEE.utils.toast('Welcome, ' + found.username + '.', 'success');
    }

    function logout() {
        OEE.currentUser = null;

        var $ = OEE.utils.$;
        $('loginPass').value = '';
        $('mainTopbar').classList.add('hidden');
        $('viewStation').classList.add('hidden');
        $('viewDashboard').classList.add('hidden');
        $('viewSetup').classList.add('hidden');
        $('viewLogin').classList.remove('hidden');
    }

    /* Tab visibility - convenience only, NOT security */
    function applyRoleVisibility() {
        var $ = OEE.utils.$;
        var role = OEE.currentUser ? OEE.currentUser.role : 'OPERATOR';

        $('tabBtnDashboard').style.display = (role === 'OPERATOR') ? 'none' : 'flex';
        $('tabBtnSetup').style.display = (role === 'ADMIN') ? 'flex' : 'none';
    }

    /* ------------------------------------------------------------------
       Real access control
       requireRole() returns false and shows why, so callers can simply
       `if (!OEE.auth.requireRole('ADMIN')) return;`
       ------------------------------------------------------------------ */
    function hasRole(minimum) {
        if (!OEE.currentUser) return false;
        var mine = RANK[OEE.currentUser.role] || 0;
        var need = RANK[minimum] || 99;
        return mine >= need;
    }

    function requireRole(minimum) {
        if (hasRole(minimum)) return true;

        OEE.utils.toast(
            OEE.currentUser
                ? 'Your role (' + OEE.currentUser.role + ') cannot do this.'
                : 'Please sign in first.',
            'error'
        );
        return false;
    }

    function requireLogin() {
        if (OEE.currentUser) return true;
        OEE.utils.toast('Please sign in first.', 'error');
        return false;
    }

    OEE.auth = {
        doLogin: doLogin,
        logout: logout,
        hasRole: hasRole,
        requireRole: requireRole,
        requireLogin: requireLogin,
        applyRoleVisibility: applyRoleVisibility,
        RANK: RANK
    };

}(window.OEE = window.OEE || {}));
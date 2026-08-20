'use strict';
// Admin: maintenance mode.
//
// The flag lives HERE rather than in server/index.js, which is the one change
// this split makes beyond moving code. It was a module-level `let` written by
// these two routes and read by the login gate — passing it in would have handed
// the module a snapshot and quietly broken the toggle. Owning it and answering
// isMaintenanceOn() for the gate gives it a single writer instead.
const REQUIRED_DEPS = ['adminAuth', '_kickAllForMaintenance'];

// Owned here, not passed in: see the header. One writer, two readers.
let _maintenanceMode = false;

module.exports = function register(app, deps) {
  const missing = REQUIRED_DEPS.filter(k => !deps || deps[k] == null);
  if (missing.length) throw new Error(`maintenance: missing deps: ${missing.join(', ')}`);
  const { adminAuth, _kickAllForMaintenance } = deps;

  app.get('/admin/maintenance', adminAuth, (req, res) => {
    res.json({ on: _maintenanceMode });
  });

  app.post('/admin/maintenance/on', adminAuth, (req, res) => {
    if (_maintenanceMode) return res.status(409).json({ error: 'Уже включено' });
    _maintenanceMode = true;
    _kickAllForMaintenance();
    res.json({ ok: true });
  });

  app.post('/admin/maintenance/off', adminAuth, (req, res) => {
    if (!_maintenanceMode) return res.status(409).json({ error: 'Уже выключено' });
    _maintenanceMode = false;
    res.json({ ok: true });
  });

  // The login gate in server/index.js asks through this rather than reading the
  // flag, so the two routes above stay its only writers.
  return { isMaintenanceOn: () => _maintenanceMode };
};

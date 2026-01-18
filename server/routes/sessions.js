const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getDatabase } = require('../lib/database');
const axios = require('axios');

const parseJsonOr = (raw, fallback) => {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

const getActiveAccountId = (db) => {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'activeAccountId'").get();
  const id = row?.value ? Number(row.value) : null;
  return Number.isFinite(id) ? id : null;
};

const setActiveAccountId = (db, accountId) => {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('activeAccountId', String(accountId));
};

const BASE = process.env.CONTROL_PLANE_URL || 'https://turbonox.oriko.lk';
const CONTROL_PLANE_BASE = BASE;

const getSetting = (db, key) => {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  } catch {
    return null;
  }
};

const getControlPlaneSessionId = (db) => {
  const sessionId = String(getSetting(db, 'controlPlaneSessionId') || '').trim();
  return sessionId || null;
};

const tryProxyToControlPlane = async (db, req, res) => {
  const sessionId = getControlPlaneSessionId(db);
  if (!sessionId) return false;

  const method = String(req.method || 'GET').toUpperCase();
  const rawPath = String(req.path || '');
  // Ensure we don't end up with double slashes or trailing slash issues
  const subPath = rawPath.startsWith('/') ? rawPath.slice(1) : rawPath;
  const url = `${CONTROL_PLANE_BASE}/api/app/sessions${subPath ? '/' + subPath : ''}`;

  console.log(`[Sessions] Proxying ${method} ${req.originalUrl} -> ${url}`);

  try {
    const resp = await axios({
      method,
      url,
      headers: {
        Authorization: `Bearer ${sessionId}`,
        'content-type': 'application/json',
      },
      data: req.body,
      timeout: 20000,
      validateStatus: () => true,
    });

    if (resp.status >= 400) {
      res.status(resp.status).json({
        source: 'cloud',
        error: resp.data?.error || 'Control plane request failed',
        details: resp.data,
      });
      return true;
    }

    const payload = resp.data && typeof resp.data === 'object' ? resp.data : { data: resp.data };
    if (!payload.source) payload.source = 'cloud';
    res.json(payload);
    return true;
  } catch (e) {
    res.status(502).json({ source: 'cloud', error: e?.message || 'Control plane request failed' });
    return true;
  }
};

const randomJoinCode = () => {
  // Human-friendly join code: XXXX-XXXX
  const buf = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `${buf.slice(0, 4)}-${buf.slice(4, 8)}`;
};

const ensureUniqueJoinCode = (db) => {
  for (let i = 0; i < 8; i += 1) {
    const code = randomJoinCode();
    const exists = db.prepare('SELECT 1 FROM sessions WHERE join_code = ? LIMIT 1').get(code);
    if (!exists) return code;
  }
  // fallback
  return `${crypto.randomBytes(6).toString('hex').toUpperCase().slice(0, 4)}-${crypto.randomBytes(6).toString('hex').toUpperCase().slice(0, 4)}`;
};

const requireActiveAccount = (db, res) => {
  const current = getActiveAccountId(db);
  if (current) {
    const exists = db.prepare('SELECT id FROM accounts WHERE id = ?').get(current);
    if (exists) return current;
  }

  // Auto-heal: if there is at least one account, set it as active.
  try {
    const fallback = db.prepare('SELECT id FROM accounts ORDER BY id ASC LIMIT 1').get();
    if (fallback?.id) {
      setActiveAccountId(db, fallback.id);
      return Number(fallback.id);
    }
  } catch {
    // ignore
  }

  res.status(400).json({ error: 'No active account set' });
  return null;
};

const requireOwner = (db, res, sessionId, activeAccountId) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return null;
  }
  if (session.status !== 'active') {
    res.status(400).json({ error: 'Session is not active' });
    return null;
  }
  if (Number(session.owner_account_id) !== Number(activeAccountId)) {
    res.status(403).json({ error: 'Only the owner can perform this action' });
    return null;
  }
  return session;
};

router.get('/', (req, res) => {
  try {
    const db = getDatabase();

    // Cloud mode: if logged into control-plane, sessions sync across devices.
    // NOTE: Local mode remains available when not logged in.
    const maybe = getControlPlaneSessionId(db);
    if (maybe) {
      return void tryProxyToControlPlane(db, req, res);
    }

    const activeAccountId = requireActiveAccount(db, res);
    if (!activeAccountId) return;

    const owned = db.prepare(
      `SELECT * FROM sessions WHERE owner_account_id = ? AND status = 'active' ORDER BY created_at DESC`
    ).all(activeAccountId);

    const joined = db.prepare(
      `SELECT s.*
       FROM sessions s
       JOIN session_members sm ON sm.session_id = s.id
       WHERE sm.account_id = ? AND s.status = 'active'
       ORDER BY s.created_at DESC`
    ).all(activeAccountId);

    const withMembership = (sessions) => sessions.map((s) => ({
      ...s,
      isOwner: Number(s.owner_account_id) === Number(activeAccountId),
    }));

    res.json({
      source: 'local',
      owned: withMembership(owned),
      joined: withMembership(joined),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', (req, res) => {
  const db = getDatabase();

  const maybe = getControlPlaneSessionId(db);
  if (maybe) {
    return void tryProxyToControlPlane(db, req, res);
  }

  const activeAccountId = requireActiveAccount(db, res);
  if (!activeAccountId) return;

  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';

  try {
    const joinCode = ensureUniqueJoinCode(db);
    const stmt = db.prepare(
      `INSERT INTO sessions (owner_account_id, name, join_code, status)
       VALUES (?, ?, ?, 'active')`
    );
    const result = stmt.run(activeAccountId, name || null, joinCode);
    const sessionId = result.lastInsertRowid;

    // Owner is automatically a member with full permissions.
    const permissions = {
      servers: { view: true, control: true, edit: true, delete: true },
      backups: { view: true, create: true, restore: true, delete: true },
      nodes: { view: true, control: true },
      ai: { analyze: true },
    };

    db.prepare(
      `INSERT OR IGNORE INTO session_members (session_id, account_id, role, permissions_json)
       VALUES (?, ?, 'owner', ?)`
    ).run(sessionId, activeAccountId, JSON.stringify(permissions));

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    res.json({ source: 'local', message: 'Session created', session, joinCode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/join', (req, res) => {
  const db = getDatabase();

  const maybe = getControlPlaneSessionId(db);
  if (maybe) {
    return void tryProxyToControlPlane(db, req, res);
  }

  const activeAccountId = requireActiveAccount(db, res);
  if (!activeAccountId) return;

  const joinCode = String(req.body?.joinCode || '').trim().toUpperCase();
  if (!joinCode) {
    return res.status(400).json({ error: 'joinCode is required' });
  }

  try {
    const session = db.prepare('SELECT * FROM sessions WHERE join_code = ? AND status = ?').get(joinCode, 'active');
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (Number(session.owner_account_id) === Number(activeAccountId)) {
      return res.status(400).json({ error: 'You already own this session' });
    }

    const isAlreadyMember = db.prepare(
      'SELECT 1 FROM session_members WHERE session_id = ? AND account_id = ? LIMIT 1'
    ).get(session.id, activeAccountId);
    if (isAlreadyMember) {
      return res.status(400).json({ error: 'Already joined' });
    }

    const pending = db.prepare(
      `SELECT * FROM session_join_requests
       WHERE session_id = ? AND requester_account_id = ? AND status = 'pending'
       LIMIT 1`
    ).get(session.id, activeAccountId);

    if (pending) {
      return res.json({ message: 'Join request already pending', request: pending });
    }

    const result = db.prepare(
      `INSERT INTO session_join_requests (session_id, requester_account_id, status)
       VALUES (?, ?, 'pending')`
    ).run(session.id, activeAccountId);

    const request = db.prepare('SELECT * FROM session_join_requests WHERE id = ?').get(result.lastInsertRowid);

    res.json({ message: 'Join request submitted', request });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/requests/pending', (req, res) => {
  try {
    const db = getDatabase();

    const maybe = getControlPlaneSessionId(db);
    if (maybe) {
      return void tryProxyToControlPlane(db, req, res);
    }

    const activeAccountId = requireActiveAccount(db, res);
    if (!activeAccountId) return;

    const rows = db.prepare(
      `SELECT r.*, s.join_code, s.name as session_name, s.owner_account_id,
              a.display_name as requester_display_name, a.type as requester_type
       FROM session_join_requests r
       JOIN sessions s ON s.id = r.session_id
       JOIN accounts a ON a.id = r.requester_account_id
       WHERE s.owner_account_id = ? AND r.status = 'pending' AND s.status = 'active'
       ORDER BY r.requested_at ASC`
    ).all(activeAccountId);

    res.json({ source: 'local', requests: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/requests/:id/decide', (req, res) => {
  const db = getDatabase();

  const maybe = getControlPlaneSessionId(db);
  if (maybe) {
    return void tryProxyToControlPlane(db, req, res);
  }

  const activeAccountId = requireActiveAccount(db, res);
  if (!activeAccountId) return;

  const requestId = Number(req.params.id);
  if (!Number.isFinite(requestId)) {
    return res.status(400).json({ error: 'Invalid request id' });
  }

  const decision = String(req.body?.decision || '').trim().toLowerCase();
  if (!['accept', 'reject'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be accept or reject' });
  }

  const permissions = typeof req.body?.permissions === 'object' && req.body.permissions
    ? req.body.permissions
    : null;

  try {
    const reqRow = db.prepare('SELECT * FROM session_join_requests WHERE id = ?').get(requestId);
    if (!reqRow) {
      return res.status(404).json({ error: 'Join request not found' });
    }

    if (reqRow.status !== 'pending') {
      return res.status(400).json({ error: 'Request already decided' });
    }

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(reqRow.session_id);
    if (!session || session.status !== 'active') {
      return res.status(400).json({ error: 'Session is not active' });
    }

    if (Number(session.owner_account_id) !== Number(activeAccountId)) {
      return res.status(403).json({ error: 'Only the session owner can decide join requests' });
    }

    const tx = db.transaction(() => {
      if (decision === 'reject') {
        db.prepare(
          `UPDATE session_join_requests
           SET status = 'rejected', decided_at = CURRENT_TIMESTAMP, decided_by_account_id = ?, permissions_json = NULL
           WHERE id = ?`
        ).run(activeAccountId, requestId);
        return;
      }

      const finalPerms = permissions || {
        servers: { view: true, control: false, edit: false, delete: false },
        backups: { view: true, create: false, restore: false, delete: false },
        nodes: { view: true, control: false },
        ai: { analyze: false },
      };

      db.prepare(
        `INSERT OR REPLACE INTO session_members (session_id, account_id, role, permissions_json)
         VALUES (?, ?, 'member', ?)`
      ).run(session.id, reqRow.requester_account_id, JSON.stringify(finalPerms));

      db.prepare(
        `UPDATE session_join_requests
         SET status = 'accepted', decided_at = CURRENT_TIMESTAMP, decided_by_account_id = ?, permissions_json = ?
         WHERE id = ?`
      ).run(activeAccountId, JSON.stringify(finalPerms), requestId);
    });

    tx();

    const updated = db.prepare('SELECT * FROM session_join_requests WHERE id = ?').get(requestId);
    res.json({ message: 'Decision saved', request: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/members', (req, res) => {
  try {
    const db = getDatabase();

    const maybe = getControlPlaneSessionId(db);
    if (maybe) {
      return void tryProxyToControlPlane(db, req, res);
    }

    const activeAccountId = requireActiveAccount(db, res);
    if (!activeAccountId) return;

    const sessionId = Number(req.params.id);
    if (!Number.isFinite(sessionId)) {
      return res.status(400).json({ error: 'Invalid session id' });
    }

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const isOwner = Number(session.owner_account_id) === Number(activeAccountId);
    const isMember = db.prepare(
      'SELECT 1 FROM session_members WHERE session_id = ? AND account_id = ? LIMIT 1'
    ).get(sessionId, activeAccountId);

    if (!isOwner && !isMember) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const members = db.prepare(
      `SELECT sm.*, a.display_name, a.type, a.color, a.avatar
       FROM session_members sm
       JOIN accounts a ON a.id = sm.account_id
       WHERE sm.session_id = ?
       ORDER BY CASE sm.role WHEN 'owner' THEN 0 ELSE 1 END, sm.created_at ASC`
    ).all(sessionId).map((m) => ({
      ...m,
      permissions: parseJsonOr(m.permissions_json, {}),
    }));

    res.json({ source: 'local', session, members });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/leave', (req, res) => {
  const db = getDatabase();

  const maybe = getControlPlaneSessionId(db);
  if (maybe) {
    return void tryProxyToControlPlane(db, req, res);
  }

  const activeAccountId = requireActiveAccount(db, res);
  if (!activeAccountId) return;

  const sessionId = Number(req.params.id);
  if (!Number.isFinite(sessionId)) {
    return res.status(400).json({ error: 'Invalid session id' });
  }

  try {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (Number(session.owner_account_id) === Number(activeAccountId)) {
      return res.status(400).json({ error: 'Owner cannot leave their own session. End it instead.' });
    }

    db.prepare('DELETE FROM session_members WHERE session_id = ? AND account_id = ?').run(sessionId, activeAccountId);
    res.json({ source: 'local', message: 'Left session' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/end', (req, res) => {
  const db = getDatabase();

  const maybe = getControlPlaneSessionId(db);
  if (maybe) {
    return void tryProxyToControlPlane(db, req, res);
  }

  const activeAccountId = requireActiveAccount(db, res);
  if (!activeAccountId) return;

  const sessionId = Number(req.params.id);
  if (!Number.isFinite(sessionId)) {
    return res.status(400).json({ error: 'Invalid session id' });
  }

  try {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (Number(session.owner_account_id) !== Number(activeAccountId)) {
      return res.status(403).json({ error: 'Only the owner can end a session' });
    }

    db.prepare(
      `UPDATE sessions SET status = 'ended', ended_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(sessionId);

    res.json({ source: 'local', message: 'Session ended' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', (req, res) => {
  const db = getDatabase();

  const maybe = getControlPlaneSessionId(db);
  if (maybe) {
    return void tryProxyToControlPlane(db, req, res);
  }

  const activeAccountId = requireActiveAccount(db, res);
  if (!activeAccountId) return;

  const sessionId = Number(req.params.id);
  if (!Number.isFinite(sessionId)) {
    return res.status(400).json({ error: 'Invalid session id' });
  }

  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }

  try {
    const session = requireOwner(db, res, sessionId, activeAccountId);
    if (!session) return;

    db.prepare('UPDATE sessions SET name = ? WHERE id = ?').run(name, sessionId);
    const updated = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    res.json({ source: 'local', message: 'Session updated', session: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/join-code/regenerate', (req, res) => {
  const db = getDatabase();

  const maybe = getControlPlaneSessionId(db);
  if (maybe) {
    return void tryProxyToControlPlane(db, req, res);
  }

  const activeAccountId = requireActiveAccount(db, res);
  if (!activeAccountId) return;

  const sessionId = Number(req.params.id);
  if (!Number.isFinite(sessionId)) {
    return res.status(400).json({ error: 'Invalid session id' });
  }

  try {
    const session = requireOwner(db, res, sessionId, activeAccountId);
    if (!session) return;

    const joinCode = ensureUniqueJoinCode(db);
    db.prepare('UPDATE sessions SET join_code = ? WHERE id = ?').run(joinCode, sessionId);
    const updated = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    res.json({ source: 'local', message: 'Join code regenerated', session: updated, joinCode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id/members/:accountId', (req, res) => {
  const db = getDatabase();

  const maybe = getControlPlaneSessionId(db);
  if (maybe) {
    return void tryProxyToControlPlane(db, req, res);
  }

  const activeAccountId = requireActiveAccount(db, res);
  if (!activeAccountId) return;

  const sessionId = Number(req.params.id);
  const memberAccountId = Number(req.params.accountId);
  if (!Number.isFinite(sessionId) || !Number.isFinite(memberAccountId)) {
    return res.status(400).json({ error: 'Invalid id' });
  }

  const permissions = typeof req.body?.permissions === 'object' && req.body.permissions
    ? req.body.permissions
    : null;

  if (!permissions) {
    return res.status(400).json({ error: 'permissions is required' });
  }

  try {
    const session = requireOwner(db, res, sessionId, activeAccountId);
    if (!session) return;

    if (Number(memberAccountId) === Number(session.owner_account_id)) {
      return res.status(400).json({ error: 'Cannot modify owner permissions' });
    }

    const existing = db.prepare(
      'SELECT * FROM session_members WHERE session_id = ? AND account_id = ?'
    ).get(sessionId, memberAccountId);

    if (!existing) {
      return res.status(404).json({ error: 'Member not found' });
    }

    db.prepare(
      `UPDATE session_members SET permissions_json = ? WHERE session_id = ? AND account_id = ?`
    ).run(JSON.stringify(permissions), sessionId, memberAccountId);

    const updated = db.prepare(
      'SELECT * FROM session_members WHERE session_id = ? AND account_id = ?'
    ).get(sessionId, memberAccountId);

    res.json({ message: 'Member permissions updated', member: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id/members/:accountId', (req, res) => {
  const db = getDatabase();

  const maybe = getControlPlaneSessionId(db);
  if (maybe) {
    return void tryProxyToControlPlane(db, req, res);
  }

  const activeAccountId = requireActiveAccount(db, res);
  if (!activeAccountId) return;

  const sessionId = Number(req.params.id);
  const memberAccountId = Number(req.params.accountId);
  if (!Number.isFinite(sessionId) || !Number.isFinite(memberAccountId)) {
    return res.status(400).json({ error: 'Invalid id' });
  }

  try {
    const session = requireOwner(db, res, sessionId, activeAccountId);
    if (!session) return;

    if (Number(memberAccountId) === Number(session.owner_account_id)) {
      return res.status(400).json({ error: 'Owner cannot be removed' });
    }

    const result = db.prepare(
      'DELETE FROM session_members WHERE session_id = ? AND account_id = ?'
    ).run(sessionId, memberAccountId);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }

    res.json({ message: 'Member removed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

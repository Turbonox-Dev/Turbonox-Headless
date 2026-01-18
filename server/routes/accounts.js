const express = require('express');
const router = express.Router();
const { getDatabase } = require('../lib/database');
const { authenticator } = require('otplib');
const qrcode = require('qrcode');
const { cloudDriveService } = require('../services/cloud-drive');

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

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

const sanitizeColor = (c) => {
  const s = String(c || '').trim();
  if (!s) return null;
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
  return null;
};

const normalizeEmail = (email) => {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return null;
  return e;
};

const isValidEmail = (email) => {
  const e = String(email || '').trim();
  if (!e) return false;
  // pragmatic validation
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
};

router.get('/', (req, res) => {
  try {
    // Local accounts are disabled - returning empty list
    res.json({ accounts: [], activeAccountId: null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', (req, res) => {
  // Local account creation is disabled.
  return res.status(403).json({ error: 'Local account creation is disabled. Use Google OAuth to authenticate.' });
});

router.put('/:id', (req, res) => {
  // Local account management is disabled.
  return res.status(403).json({ error: 'Local account management is disabled.' });
});

router.post('/:id/heartbeat', (req, res) => {
  // Local account management is disabled.
  return res.status(403).json({ error: 'Local account management is disabled.' });
});

router.post('/active', (req, res) => {
  // Local account management is disabled.
  return res.status(403).json({ error: 'Local account management is disabled.' });
});

router.delete('/:id', (req, res) => {
  // Local account management is disabled.
  return res.status(403).json({ error: 'Local account management is disabled.' });
});

// 2FA: Setup (generate secret + QR code)
router.get('/:id/2fa/setup', async (req, res) => {
  return res.status(403).json({ error: '2FA is not available for Google OAuth authentication.' });
});

// 2FA: Enable (verify code and activate)
router.post('/:id/2fa/enable', (req, res) => {
  return res.status(403).json({ error: '2FA is not available for Google OAuth authentication.' });
});

// 2FA: Disable
router.post('/:id/2fa/disable', (req, res) => {
  return res.status(403).json({ error: '2FA is not available for Google OAuth authentication.' });
});

// 2FA: Verify (check during login/switch)
router.post('/:id/2fa/verify', (req, res) => {
  return res.status(403).json({ error: '2FA is not available for Google OAuth authentication.' });
});

// Cloud Drive routes
router.get('/cloud/drives', async (req, res) => {
  try {
    const drives = await cloudDriveService.getAvailableDrives();
    res.json({ drives });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/cloud/mount', async (req, res) => {
  const { provider, options } = req.body;
  const driveId = req.body.driveId; // if provided, otherwise derived

  if (!driveId) return res.status(400).json({ error: 'driveId is required' });

  try {
    const result = await cloudDriveService.mount(driveId, provider, options);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/cloud/unmount', async (req, res) => {
  const { driveId } = req.body;

  if (!driveId) return res.status(400).json({ error: 'driveId is required' });

  try {
    const result = await cloudDriveService.unmount(driveId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

const express = require('express');
const { getDatabase } = require('../lib/database');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const router = express.Router();

const JWT_SECRET = process.env.EXTENSION_JWT_SECRET || 'turbonox-extension-secret';
const JWT_EXPIRY = '30d';

function generateApiKey() {
  return crypto.randomBytes(32).toString('hex');
}

function generateToken(apiKey) {
  return jwt.sign(
    { apiKey, type: 'extension' },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  const token = authHeader.substring(7);
  const decoded = verifyToken(token);

  if (!decoded) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.apiKey = decoded.apiKey;
  next();
}

function canAccessServer(db, apiKey, serverRow) {
  const keyRow = db.prepare('SELECT * FROM api_keys WHERE api_key = ?').get(apiKey);
  if (!keyRow) return false;

  if (keyRow.account_id === null) {
    return true;
  }

  return Number(serverRow.owner_account_id) === Number(keyRow.account_id);
}

router.post('/keys/generate', (req, res) => {
  try {
    const db = getDatabase();
    const { accountId, name } = req.body;

    const apiKey = generateApiKey();
    const token = generateToken(apiKey);

    db.prepare(`
      INSERT INTO api_keys (api_key, account_id, name, created_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    `).run(apiKey, accountId || null, name || 'Chrome Extension');

    res.json({
      apiKey,
      token,
      message: 'API key generated successfully',
      expiresIn: '30 days'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/keys', (req, res) => {
  try {
    const db = getDatabase();
    const keys = db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all();

    res.json({
      keys: keys.map(k => ({
        id: k.id,
        name: k.name,
        accountId: k.account_id,
        createdAt: k.created_at,
        lastUsed: k.last_used_at
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/keys/:id', (req, res) => {
  try {
    const db = getDatabase();
    const keyId = req.params.id;

    db.prepare('DELETE FROM api_keys WHERE id = ?').run(keyId);

    res.json({ message: 'API key deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/auth/verify', (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    const decoded = verifyToken(token);
    if (!decoded) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const db = getDatabase();
    const keyRow = db.prepare('SELECT * FROM api_keys WHERE api_key = ?').get(decoded.apiKey);

    if (!keyRow) {
      return res.status(404).json({ error: 'API key not found' });
    }

    db.prepare('UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(keyRow.id);

    res.json({
      valid: true,
      keyId: keyRow.id,
      name: keyRow.name,
      accountId: keyRow.account_id
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = { router, authMiddleware, canAccessServer };

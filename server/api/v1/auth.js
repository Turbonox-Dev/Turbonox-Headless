const express = require('express');
const { getDatabase } = require('../../lib/database');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { google } = require('googleapis');

const router = express.Router();

const JWT_SECRET = process.env.TURBONOX_API_SECRET || 'turbonox-dev-api-secret';
const JWT_EXPIRY = '90d';

function generateJWT(accountId, deviceId = null) {
  return jwt.sign(
    { 
      accountId: Number(accountId),
      deviceId,
      type: 'chrome-extension',
      version: '1.0.0'
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

function verifyJWT(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

function canAccessServer(db, accountId, serverRow) {
  return Number(serverRow.owner_account_id) === Number(accountId);
}

function getSessionPermissions(db, accountId) {
  const rows = db.prepare(`
    SELECT sm.session_id, sm.permissions_json, s.owner_account_id
    FROM session_members sm
    JOIN sessions s ON s.id = sm.session_id
    WHERE sm.account_id = ? AND s.status = 'active'
  `).all(accountId);

  return rows.map(r => ({
    sessionId: r.session_id,
    ownerAccountId: r.owner_account_id,
    permissions: r.permissions_json ? JSON.parse(r.permissions_json) : {},
  }));
}

router.get('/auth/providers', (req, res) => {
  try {
    const db = getDatabase();
    const googleCreds = db.prepare("SELECT value FROM settings WHERE key = 'gdrive.credentials'").get();
    
    const providers = [];
    
    if (googleCreds?.value) {
      const creds = JSON.parse(googleCreds.value);
      const port = process.env.VOID_BACKEND_PORT || 3456;
      const baseUrl = `${req.protocol}://${req.get('host')}/v1`;
      
      providers.push({
        id: 'google',
        name: 'Google',
        type: 'oauth2',
        displayName: 'Sign in with Google',
        icon: 'https://www.google.com/favicon.ico',
        authUrl: `${baseUrl}/auth/google`,
        enabled: true,
      });
    }
    
    res.json({ providers });
  } catch (error) {
    console.error('[DEV-API] Auth providers error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/auth/google', (req, res) => {
  try {
    const db = getDatabase();
    const credRow = db.prepare("SELECT value FROM settings WHERE key = 'gdrive.credentials'").get();
    
    if (!credRow?.value) {
      return res.status(503).json({ 
        error: 'Google OAuth not configured',
        message: 'This Turbonox instance does not have Google OAuth configured'
      });
    }

    const creds = JSON.parse(credRow.value);
    const port = process.env.VOID_BACKEND_PORT || 3456;
    const baseUrl = `${req.protocol}://${req.get('host')}/v1`;
    const redirectUri = `${baseUrl}/auth/google/callback`;

    const oAuth2Client = new google.auth.OAuth2(
      creds.client_id,
      creds.client_secret,
      redirectUri
    );

    const state = crypto.randomBytes(32).toString('hex');
    
    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      state,
      scope: [
        'openid',
        'email',
        'profile',
      ],
    });

    res.json({ 
      authUrl,
      state,
      provider: 'google',
      redirectUri,
    });
  } catch (error) {
    console.error('[DEV-API] Google auth error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/auth/google/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    
    if (!code) {
      return res.status(400).json({ error: 'Missing authorization code' });
    }

    const db = getDatabase();
    const credRow = db.prepare("SELECT value FROM settings WHERE key = 'gdrive.credentials'").get();
    
    if (!credRow?.value) {
      return res.status(503).json({ error: 'Google OAuth not configured' });
    }

    const creds = JSON.parse(credRow.value);
    const port = process.env.VOID_BACKEND_PORT || 3456;
    const baseUrl = `${req.protocol}://${req.get('host')}/v1`;
    const redirectUri = `${baseUrl}/auth/google/callback`;

    const oAuth2Client = new google.auth.OAuth2(
      creds.client_id,
      creds.client_secret,
      redirectUri
    );

    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);

    const userInfo = await oAuth2Client.getTokenInfo(tokens.id_token);
    const googleEmail = userInfo.email;
    const googleSub = userInfo.sub;

    let account = db.prepare('SELECT * FROM accounts WHERE email = ?').get(googleEmail);

    if (!account) {
      const result = db.prepare(`
        INSERT INTO accounts (type, email, display_name, description, presence_mode, settings_json, google_sub)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('normal', googleEmail, googleEmail.split('@')[0], 'Chrome Extension User', 'online', '{}', googleSub);

      const newAccountId = result.lastInsertRowid;
      account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(newAccountId);
    } else {
      if (!account.google_sub) {
        db.prepare('UPDATE accounts SET google_sub = ? WHERE id = ?').run(googleSub, account.id);
      }
    }

    const token = generateJWT(account.id);

    res.json({
      token,
      tokenType: 'Bearer',
      expiresIn: JWT_EXPIRY,
      user: {
        id: account.id,
        email: account.email,
        displayName: account.display_name,
        type: account.type,
      },
      isNew: !account.google_sub,
    });
  } catch (error) {
    console.error('[DEV-API] Google callback error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/auth/verify', (req, res) => {
  try {
    const { token } = req.body;
    
    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    const decoded = verifyJWT(token);
    
    if (!decoded) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const db = getDatabase();
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(decoded.accountId);

    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    res.json({
      valid: true,
      user: {
        id: account.id,
        email: account.email,
        displayName: account.display_name,
        type: account.type,
      },
      expiresAt: decoded.exp * 1000,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/auth/refresh', (req, res) => {
  try {
    const { token } = req.body;
    
    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    const decoded = verifyJWT(token);
    
    if (!decoded) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const db = getDatabase();
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(decoded.accountId);

    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const newToken = generateJWT(account.id, decoded.deviceId);

    res.json({
      token: newToken,
      tokenType: 'Bearer',
      expiresIn: JWT_EXPIRY,
      expiresAt: decoded.exp * 1000,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/auth/logout', (req, res) => {
  res.json({ message: 'Logged out successfully' });
});

module.exports = { router, verifyJWT, canAccessServer, getSessionPermissions };

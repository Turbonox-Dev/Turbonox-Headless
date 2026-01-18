const express = require('express');
const { google } = require('googleapis');
const { getDatabase } = require('../lib/database');
const jwt = require('jsonwebtoken');

const router = express.Router();

const JWT_SECRET = process.env.EXTENSION_JWT_SECRET || 'turbonox-extension-secret-change-in-production';
const JWT_EXPIRY = '7d';

function generateExtensionToken(accountId, googleEmail) {
  return jwt.sign(
    {
      accountId,
      googleEmail,
      type: 'extension',
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

function verifyExtensionToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

router.get('/auth/url', (req, res) => {
  try {
    const db = getDatabase();
    const credRow = db.prepare("SELECT value FROM settings WHERE key = 'gdrive.credentials'").get();
    if (!credRow?.value) {
      return res.status(400).json({ error: 'Google OAuth not configured on this Turbonox instance' });
    }

    const creds = JSON.parse(credRow.value);
    const port = process.env.VOID_BACKEND_PORT || 3456;
    const redirectUri = `http://localhost:${port}/api/extension/auth/callback`;

    const oAuth2Client = new google.auth.OAuth2(
      creds.client_id,
      creds.client_secret,
      redirectUri
    );

    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [
        'openid',
        'email',
        'profile',
      ],
    });

    res.json({ authUrl });
  } catch (error) {
    console.error('[EXTENSION-AUTH] Error generating auth URL:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/auth/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) {
      return res.status(400).send('Missing authorization code');
    }

    const db = getDatabase();
    const credRow = db.prepare("SELECT value FROM settings WHERE key = 'gdrive.credentials'").get();
    if (!credRow?.value) {
      return res.status(400).send('Google OAuth not configured');
    }

    const creds = JSON.parse(credRow.value);
    const port = process.env.VOID_BACKEND_PORT || 3456;
    const redirectUri = `http://localhost:${port}/api/extension/auth/callback`;

    const oAuth2Client = new google.auth.OAuth2(
      creds.client_id,
      creds.client_secret,
      redirectUri
    );

    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);

    const userInfo = await oAuth2Client.getTokenInfo(tokens.id_token);
    const googleEmail = userInfo.email;

    let account = db.prepare('SELECT * FROM accounts WHERE email = ?').get(googleEmail);

    if (!account) {
      const result = db.prepare(`
        INSERT INTO accounts (type, email, display_name, description, presence_mode, settings_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('normal', googleEmail, googleEmail.split('@')[0], 'Chrome Extension User', 'online', '{}');

      const newAccountId = result.lastInsertRowid;
      account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(newAccountId);
    }

    const extensionToken = generateExtensionToken(account.id, googleEmail);

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Turbonox Extension Auth</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #0f172a;
            color: #f8fafc;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
          }
          .container {
            text-align: center;
            padding: 2rem;
          }
          h1 { color: #38bdf8; }
          .token-box {
            background: #1e293b;
            padding: 1rem;
            border-radius: 0.5rem;
            margin: 1rem 0;
            word-break: break-all;
            font-family: monospace;
            font-size: 0.875rem;
            max-width: 500px;
          }
          button {
            background: #38bdf8;
            color: #0f172a;
            border: none;
            padding: 0.75rem 1.5rem;
            border-radius: 0.375rem;
            cursor: pointer;
            font-size: 1rem;
          }
          button:hover { background: #0ea5e9; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>✓ Successfully Connected!</h1>
          <p>Your Chrome extension can now access your Turbonox instance.</p>
          <p>Copy this token and paste it in the extension settings:</p>
          <div class="token-box" id="token">${extensionToken}</div>
          <button onclick="copyToken()">Copy Token</button>
          <p style="margin-top: 2rem; font-size: 0.875rem; color: #94a3b8;">
            You can close this window now.
          </p>
        </div>
        <script>
          function copyToken() {
            const token = document.getElementById('token').textContent;
            navigator.clipboard.writeText(token).then(() => {
              alert('Token copied to clipboard!');
            });
          }
        </script>
      </body>
      </html>
    `);
  } catch (error) {
    console.error('[EXTENSION-AUTH] Callback error:', error);
    res.status(500).send('Authentication failed: ' + error.message);
  }
});

router.post('/auth/verify', (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    const decoded = verifyExtensionToken(token);
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
      account: {
        id: account.id,
        email: account.email,
        displayName: account.display_name,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = { router, verifyExtensionToken };

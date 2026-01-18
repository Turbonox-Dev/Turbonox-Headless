const express = require('express');
const router = express.Router();
const { getDatabase } = require('../lib/database');
const archiver = require('archiver');
const unzipper = require('unzipper');
const fs = require('fs');
const path = require('path');
const { getBackupsDir, getServersDir } = require('../lib/paths');
const crypto = require('crypto');
const { google } = require('googleapis');
const AuditService = require('../services/AuditService');
const { restrictionMiddleware } = require('../utils/restrictions');

function getUserIdentity(db, accountId) {
  try {
    const row = db.prepare('SELECT display_name, email FROM accounts WHERE id = ?').get(accountId);
    if (!row) return String(accountId);
    return row.email ? `${row.display_name} (${row.email})` : row.display_name;
  } catch {
    return String(accountId);
  }
}

function getActiveAccountId(db) {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'activeAccountId'").get();
    const id = row?.value ? Number(row.value) : null;
    return Number.isFinite(id) ? id : null;
  } catch {
    return null;
  }
}

function getAccountSessionPermissions(db, accountId) {
  if (!accountId) return [];
  try {
    const rows = db.prepare(
      `SELECT sm.session_id, sm.permissions_json, s.owner_account_id
       FROM session_members sm
       JOIN sessions s ON s.id = sm.session_id
       WHERE sm.account_id = ? AND s.status = 'active'`
    ).all(accountId);

    return (rows || []).map((r) => {
      let perms = {};
      try {
        perms = r.permissions_json ? JSON.parse(r.permissions_json) : {};
      } catch {
        perms = {};
      }
      return {
        ownerAccountId: r.owner_account_id,
        permissions: perms,
      };
    });
  } catch {
    return [];
  }
}

function canFromSession(perms, category, action) {
  if (!perms || typeof perms !== 'object') return false;
  const cat = perms[category];
  if (!cat || typeof cat !== 'object') return false;
  return Boolean(cat[action]);
}

function canAccessServerForBackup(db, activeAccountId, serverRow, action) {
  if (!activeAccountId || !serverRow) return false;
  if (Number(serverRow.owner_account_id) === Number(activeAccountId)) return true;
  const memberships = getAccountSessionPermissions(db, activeAccountId);
  return memberships.some(
    (m) => Number(m.ownerAccountId) === Number(serverRow.owner_account_id) && canFromSession(m.permissions, 'backups', action)
  );
}

const getBackupDir = () => getBackupsDir();

const ensureDir = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};

const sanitizeName = (name) => {
  const safe = String(name || '').trim();
  if (!safe) return 'restored-server';
  return safe.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
};

const uniqueServerPath = (baseName) => {
  const serversDir = getServersDir();
  ensureDir(serversDir);

  const base = sanitizeName(baseName);
  let candidate = path.join(serversDir, base);
  let i = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(serversDir, `${base} (${i})`);
    i += 1;
  }
  return candidate;
};

const extractZipToDirectory = async (zipPath, destinationDir) => {
  ensureDir(destinationDir);
  await fs.createReadStream(zipPath)
    .pipe(unzipper.Extract({ path: destinationDir }))
    .promise();
};

// Upload placeholder: supports FTP basic upload and Google Drive placeholder
router.post('/:id/upload', async (req, res) => {
  const db = getDatabase();
  const backup = db.prepare('SELECT * FROM backups WHERE id = ?').get(req.params.id);
  if (!backup) return res.status(404).json({ error: 'Backup not found' });

  const provider = String(req.body?.provider || '').toLowerCase();
  const options = req.body?.options || {};

  const backupPath = path.join(getBackupDir(), backup.filename);
  if (!fs.existsSync(backupPath)) return res.status(404).json({ error: 'Backup file missing' });

  try {
    if (provider === 'ftp') {
      // lightweight FTP upload using basic ftp module if available
      let FtpClient;
      try { FtpClient = require('basic-ftp'); } catch { FtpClient = null; }
      if (!FtpClient) return res.status(500).json({ error: 'FTP client not available' });

      const client = new FtpClient.Client();
      client.ftp.verbose = false;
      await client.access({ host: options.host, port: options.port || 21, user: options.user, password: options.password, secure: !!options.secure });
      await client.uploadFrom(backupPath, path.basename(backupPath));
      client.close();

      AuditService.log(backup.server_id, 'BACKUP_UPLOAD', getUserIdentity(db, getActiveAccountId(db)), `Backup ${backup.filename} uploaded via FTP`);
      return res.json({ ok: true, message: 'Uploaded via FTP' });
    }
    if (provider === 'gdrive') {
      // If OAuth tokens available, attempt immediate upload, otherwise queue request
      const tokenRow = db.prepare("SELECT value FROM settings WHERE key = 'gdrive.tokens'").get();
      const credRow = db.prepare("SELECT value FROM settings WHERE key = 'gdrive.credentials'").get();
      if (tokenRow?.value && credRow?.value) {
        try {
          const tokens = JSON.parse(tokenRow.value);
          const rawCreds = JSON.parse(credRow.value);
          // Handle nested 'web' or 'installed' structures from Google Cloud Console
          const creds = rawCreds.web || rawCreds.installed || rawCreds;
          const oAuth2Client = new google.auth.OAuth2(creds.client_id, creds.client_secret);
          oAuth2Client.setCredentials(tokens);
          const drive = google.drive({ version: 'v3', auth: oAuth2Client });

          const fileMetadata = { name: path.basename(backupPath) };
          const media = { mimeType: 'application/zip', body: fs.createReadStream(backupPath) };
          const response = await drive.files.create({ resource: fileMetadata, media, fields: 'id' });
          AuditService.log(backup.server_id, 'BACKUP_UPLOAD', getUserIdentity(db, getActiveAccountId(db)), `Backup ${backup.filename} uploaded to Google Drive`);
          return res.json({ ok: true, message: 'Uploaded to Google Drive', fileId: response.data.id });
        } catch (err) {
          console.warn('[BACKUPS] GDrive immediate upload failed, queuing instead:', err.message);
        }
      }

      // Queue upload request
      const uploadsKey = 'backup.upload_requests';
      const existing = db.prepare("SELECT value FROM settings WHERE key = ?").get(uploadsKey);
      const arr = existing?.value ? JSON.parse(existing.value) : [];
      arr.push({ id: backup.id, provider: 'gdrive', options, created_at: new Date().toISOString() });
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(uploadsKey, JSON.stringify(arr));
      return res.json({ ok: true, message: 'Google Drive upload queued' });
    }

    return res.status(400).json({ error: 'Unsupported provider' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Google Drive OAuth helpers
router.get('/gdrive/connect', (req, res) => {
  try {
    const db = getDatabase();
    const credRow = db.prepare("SELECT value FROM settings WHERE key = 'gdrive.credentials'").get();
    if (!credRow?.value) return res.status(400).json({ error: 'No Google Drive client credentials configured. Set gdrive.credentials in settings.' });
    const rawCreds = JSON.parse(credRow.value);
    // Handle nested 'web' or 'installed' structures from Google Cloud Console
    const creds = rawCreds.web || rawCreds.installed || rawCreds;
    if (!creds.client_id || !creds.client_secret) {
      return res.status(400).json({ error: 'Invalid credentials format - missing client_id or client_secret' });
    }
    const redirectPort = process.env.VOID_BACKEND_PORT || process.env.VOID_PORT || 3456;
    const redirectUri = `http://localhost:${redirectPort}/api/backups/gdrive/callback`;
    const oAuth2Client = new google.auth.OAuth2(creds.client_id, creds.client_secret, redirectUri);
    const authUrl = oAuth2Client.generateAuthUrl({ access_type: 'offline', scope: ['https://www.googleapis.com/auth/drive.file'] });
    res.json({ url: authUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/gdrive/callback', async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send('Missing code');
    const db = getDatabase();
    const credRow = db.prepare("SELECT value FROM settings WHERE key = 'gdrive.credentials'").get();
    if (!credRow?.value) return res.status(400).send('No Google Drive client credentials configured');
    const rawCreds = JSON.parse(credRow.value);
    // Handle nested 'web' or 'installed' structures from Google Cloud Console
    const creds = rawCreds.web || rawCreds.installed || rawCreds;
    const redirectPort = process.env.VOID_BACKEND_PORT || process.env.VOID_PORT || 3456;
    const redirectUri = `http://localhost:${redirectPort}/api/backups/gdrive/callback`;
    const oAuth2Client = new google.auth.OAuth2(creds.client_id, creds.client_secret, redirectUri);
    const { tokens } = await oAuth2Client.getToken(String(code));
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run('gdrive.tokens', JSON.stringify(tokens));
    // Auto-close the browser tab immediately
    res.send(`<!DOCTYPE html><html><head><script>window.close();</script></head><body></body></html>`);
  } catch (e) {
    console.error('GDrive callback error', e);
    res.status(500).send('OAuth error');
  }
});

router.get('/', (req, res) => {
  try {
    const db = getDatabase();
    const activeAccountId = getActiveAccountId(db);
    if (!activeAccountId) {
      return res.status(400).json({ error: 'No active account set' });
    }

    const memberships = getAccountSessionPermissions(db, activeAccountId);
    const allowedOwnerIds = new Set([activeAccountId]);
    for (const m of memberships) {
      if (canFromSession(m.permissions, 'backups', 'view')) {
        allowedOwnerIds.add(Number(m.ownerAccountId));
      }
    }
    const ownerIds = Array.from(allowedOwnerIds).filter((n) => Number.isFinite(n));
    const placeholders = ownerIds.map(() => '?').join(',');

    // Return backups for servers the account can see, plus orphaned backups.
    const rows = db.prepare(
      `SELECT b.*
       FROM backups b
       LEFT JOIN servers s ON s.id = b.server_id
       WHERE b.server_id IS NULL OR s.owner_account_id IN (${placeholders})
       ORDER BY b.created_at DESC`
    ).all(...ownerIds);

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/restore', restrictionMiddleware(), async (req, res) => {
  const db = getDatabase();

  const activeAccountId = getActiveAccountId(db);
  if (!activeAccountId) {
    return res.status(400).json({ error: 'No active account set' });
  }

  try {
    const backup = db.prepare('SELECT * FROM backups WHERE id = ?').get(req.params.id);
    if (!backup) {
      return res.status(404).json({ error: 'Backup not found' });
    }

    // Authorization: if it is attached to a server, require restore permission to that server.
    if (backup.server_id) {
      const attached = db.prepare('SELECT * FROM servers WHERE id = ?').get(backup.server_id);
      if (attached && !canAccessServerForBackup(db, activeAccountId, attached, 'restore')) {
        return res.status(403).json({ error: 'Not allowed' });
      }
    }

    const backupPath = path.join(getBackupDir(), backup.filename);
    if (!fs.existsSync(backupPath)) {
      return res.status(404).json({ error: 'Backup file not found on disk' });
    }

    let backupMetadata = null;
    try {
      backupMetadata = backup.metadata ? JSON.parse(backup.metadata) : null;
    } catch {
      backupMetadata = null;
    }

    const existingServer = backup.server_id
      ? db.prepare('SELECT * FROM servers WHERE id = ?').get(backup.server_id)
      : null;

    if (existingServer) {
      return res.status(400).json({ error: 'Server already exists for this backup. Restore for existing servers is not implemented yet.' });
    }

    const snap = backupMetadata?.server || {};

    const desiredName = sanitizeName(snap.name || `Restored ${backup.filename}`);
    const desiredType = snap.type || 'static';
    const desiredCommand = snap.command || 'npm start';
    const desiredPort = typeof snap.port === 'number' ? snap.port : (snap.port ? Number(snap.port) : null);
    const desiredPublicAccess = Boolean(snap.public_access);
    const desiredSubdomain = snap.subdomain ? String(snap.subdomain).trim().toLowerCase() : null;
    const desiredRuntime = snap.runtime || null;
    const desiredNotes = snap.notes || null;
    const desiredAutoPort = snap.auto_port ? 1 : 0;
    const desiredLaunchScript = snap.launch_script || null;
    const desiredEnvVars = snap.env_vars || null;
    const desiredRepo = snap.repo || null;
    const desiredMetadata = snap.metadata || null;
    const desiredNodeId = snap.node_id || null;

    const serverPath = uniqueServerPath(desiredName);
    ensureDir(serverPath);

    await extractZipToDirectory(backupPath, serverPath);

    const insertStmt = db.prepare(`
      INSERT INTO servers (
        owner_account_id,
        name,
        type,
        path,
        command,
        port,
        public_access,
        subdomain,
        env_vars,
        repo,
        runtime,
        notes,
        auto_port,
        launch_script,
        metadata,
        node_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = insertStmt.run([
      activeAccountId,
      desiredName,
      desiredType,
      serverPath,
      desiredCommand,
      desiredPort,
      desiredPublicAccess ? 1 : 0,
      desiredSubdomain,
      desiredEnvVars ? (typeof desiredEnvVars === 'string' ? desiredEnvVars : JSON.stringify(desiredEnvVars)) : null,
      desiredRepo ? (typeof desiredRepo === 'string' ? desiredRepo : JSON.stringify(desiredRepo)) : null,
      desiredRuntime,
      desiredNotes,
      desiredAutoPort,
      desiredLaunchScript,
      desiredMetadata ? (typeof desiredMetadata === 'string' ? desiredMetadata : JSON.stringify(desiredMetadata)) : null,
      desiredNodeId,
    ]);

    const newServerId = result.lastInsertRowid;

    try {
      db.prepare('UPDATE backups SET server_id = ? WHERE id = ?').run(newServerId, backup.id);
    } catch {
      // ignore
    }

    res.json({
      message: 'Backup restored and server recreated successfully',
      serverId: newServerId,
      serverPath,
    });
    AuditService.log(newServerId, 'BACKUP_RESTORE', getUserIdentity(db, activeAccountId), `Restored from backup ${backup.filename}`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve raw backup file for download
router.get('/:id/file', (req, res) => {
  try {
    const db = getDatabase();
    const backup = db.prepare('SELECT * FROM backups WHERE id = ?').get(req.params.id);
    if (!backup) return res.status(404).send('Not found');
    const backupPath = path.join(getBackupDir(), backup.filename);
    if (!fs.existsSync(backupPath)) return res.status(404).send('Not found');
    res.setHeader('Content-Disposition', `attachment; filename="${backup.filename}"`);
    res.setHeader('Content-Type', 'application/zip');
    const stream = fs.createReadStream(backupPath);
    stream.pipe(res);
  } catch (e) {
    res.status(500).send('Error');
  }
});

router.post('/:serverId', restrictionMiddleware('create_backup'), async (req, res) => {
  const serverId = req.params.serverId;
  const db = getDatabase();

  const activeAccountId = getActiveAccountId(db);
  if (!activeAccountId) {
    return res.status(400).json({ error: 'No active account set' });
  }

  try {
    const stmt = db.prepare('SELECT * FROM servers WHERE id = ?');
    const server = stmt.get(serverId);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    if (!canAccessServerForBackup(db, activeAccountId, server, 'create')) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const backupDir = getBackupDir();
    ensureDir(backupDir);


    // Options: compression_level (0-9), incremental (boolean)
    const compressionLevel = Math.min(9, Math.max(0, Number(req.body?.compression_level ?? 6)));
    const incremental = Boolean(req.body?.incremental);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${server.name}-${timestamp}.zip`;
    const backupPath = path.join(backupDir, filename);

    const output = fs.createWriteStream(backupPath);
    const archive = archiver('zip', { zlib: { level: compressionLevel } });

    output.on('close', () => {
      const size = archive.pointer();

      try {
        const metadata = {
          server: {
            name: server.name,
            type: server.type,
            command: server.command,
            port: server.port,
            public_access: server.public_access,
            subdomain: server.subdomain,
            env_vars: server.env_vars,
            repo: server.repo,
            runtime: server.runtime,
            notes: server.notes,
            auto_port: server.auto_port,
            launch_script: server.launch_script,
            metadata: server.metadata,
            node_id: server.node_id,
          },
          createdAt: new Date().toISOString(),
          sourcePath: server.path,
        };

        // If incremental manifest was generated, include it in metadata
        try {
          if (archive && archive._generatedManifest) {
            metadata.manifest = archive._generatedManifest;
          }
        } catch { }

        const insertStmt = db.prepare('INSERT INTO backups (server_id, filename, size, metadata) VALUES (?, ?, ?, ?)');
        res.json({
          id: result.lastInsertRowid,
          filename,
          size,
          message: 'Backup created successfully'
        });
        AuditService.log(serverId, 'BACKUP_CREATE', getUserIdentity(db, activeAccountId), `Backup ${filename} created`); // removed formatBytes as it's not available
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    archive.on('error', (err) => {
      res.status(500).json({ error: err.message });
    });

    archive.pipe(output);
    if (!incremental) {
      archive.directory(server.path, false);
      archive.finalize();
    } else {
      // Basic incremental: include files modified since last backup for this server
      // More robust incremental: compute manifest and include changed/new files based on SHA1 checksum
      let lastManifest = null;
      try {
        const lastRow = db.prepare('SELECT metadata FROM backups WHERE server_id = ? ORDER BY created_at DESC LIMIT 1').get(serverId);
        if (lastRow && lastRow.metadata) {
          const meta = JSON.parse(lastRow.metadata);
          lastManifest = meta.manifest || null;
        }
      } catch (e) {
        lastManifest = null;
      }

      const fileList = [];

      const walk = (dir) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const ent of entries) {
          const full = path.join(dir, ent.name);
          const rel = path.relative(server.path, full).replace(/\\/g, '/');
          try {
            if (ent.isDirectory()) {
              walk(full);
            } else if (ent.isFile()) {
              const st = fs.statSync(full);
              fileList.push({ full, rel, mtimeMs: st.mtimeMs, size: st.size });
            }
          } catch (e) {
            // ignore
          }
        }
      };

      walk(server.path);

      const needHash = (file, lastMap) => {
        if (!lastMap) return true;
        const last = lastMap[file.rel];
        if (!last) return true;
        if (last.size !== file.size) return true;
        if (last.mtimeMs !== file.mtimeMs) return true;
        return false;
      };

      const lastMap = (lastManifest || []).reduce((acc, it) => { acc[it.path] = it; return acc; }, {});
      const newManifest = [];

      for (const f of fileList) {
        let sha1 = null;
        if (needHash(f, lastMap)) {
          try {
            const hash = crypto.createHash('sha1');
            const s = fs.createReadStream(f.full);
            await new Promise((resolve, reject) => {
              s.on('data', (chunk) => hash.update(chunk));
              s.on('end', () => { sha1 = hash.digest('hex'); resolve(); });
              s.on('error', reject);
            });
          } catch (e) {
            continue;
          }
        } else {
          sha1 = lastMap[f.rel].sha1;
        }
        newManifest.push({ path: f.rel, mtimeMs: f.mtimeMs, size: f.size, sha1 });
      }

      // Determine changed files
      const changed = newManifest.filter((m) => {
        const last = lastMap[m.path];
        if (!last) return true;
        return last.sha1 !== m.sha1;
      });

      for (const c of changed) {
        const fullPath = path.join(server.path, c.path);
        if (fs.existsSync(fullPath)) {
          archive.file(fullPath, { name: c.path });
        }
      }

      // attach manifest into metadata after finalize via output close handler
      archive.finalize();
      // store manifest by listening to output close — we will attach manifest in the output 'close' handler above
      // to ensure metadata.manifest is saved; to facilitate that, we'll push the manifest into a temporary variable on archive
      archive._generatedManifest = newManifest;
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  const db = getDatabase();

  const activeAccountId = getActiveAccountId(db);
  if (!activeAccountId) {
    return res.status(400).json({ error: 'No active account set' });
  }

  try {
    const stmt = db.prepare('SELECT * FROM backups WHERE id = ?');
    const backup = stmt.get(req.params.id);
    if (!backup) {
      return res.status(404).json({ error: 'Backup not found' });
    }

    if (backup.server_id) {
      const attached = db.prepare('SELECT * FROM servers WHERE id = ?').get(backup.server_id);
      if (attached && !canAccessServerForBackup(db, activeAccountId, attached, 'delete')) {
        return res.status(403).json({ error: 'Not allowed' });
      }
    }

    const backupPath = path.join(getBackupDir(), backup.filename);

    if (fs.existsSync(backupPath)) {
      fs.unlinkSync(backupPath);
    }

    const deleteStmt = db.prepare('DELETE FROM backups WHERE id = ?');
    deleteStmt.run(req.params.id);
    res.json({ message: 'Backup deleted successfully' });
    if (backup.server_id) {
      AuditService.log(backup.server_id, 'BACKUP_DELETE', getUserIdentity(db, activeAccountId), `Backup ${backup.filename} deleted`);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Backup schedule management
router.get('/schedules', (req, res) => {
  try {
    const db = getDatabase();
    const rows = db.prepare('SELECT * FROM backup_schedules ORDER BY created_at DESC').all();
    // Add next run time calculation
    const schedule = require('node-schedule');
    const enhanced = rows.map(s => {
      let nextRun = null;
      try {
        const job = schedule.scheduleJob(s.cron_expr, () => { });
        if (job) {
          nextRun = job.nextInvocation()?.toISOString() || null;
          job.cancel();
        }
      } catch { }
      return { ...s, next_run: nextRun };
    });
    res.json(enhanced);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/schedules', restrictionMiddleware('create_backup'), (req, res) => {
  try {
    const db = getDatabase();
    const { server_id, cron_expr, incremental = 0, compression_level = 6, retention_days = 7, enabled = 1 } = req.body || {};
    if (!server_id || !cron_expr) return res.status(400).json({ error: 'server_id and cron_expr required' });
    const stmt = db.prepare(`INSERT INTO backup_schedules (server_id, cron_expr, incremental, compression_level, retention_days, enabled) VALUES (?, ?, ?, ?, ?, ?)`);
    const result = stmt.run(server_id, cron_expr, incremental ? 1 : 0, Number(compression_level) || 6, Number(retention_days) || 7, enabled ? 1 : 0);
    res.json({ id: result.lastInsertRowid, message: 'Schedule created' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH schedule - enable/disable and update settings
router.patch('/schedules/:id', (req, res) => {
  try {
    const db = getDatabase();
    const existing = db.prepare('SELECT * FROM backup_schedules WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Schedule not found' });

    const updates = [];
    const values = [];
    const allowedFields = ['enabled', 'cron_expr', 'incremental', 'compression_level', 'retention_days'];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`);
        if (field === 'enabled' || field === 'incremental') {
          values.push(req.body[field] ? 1 : 0);
        } else {
          values.push(req.body[field]);
        }
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    values.push(req.params.id);
    db.prepare(`UPDATE backup_schedules SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const updated = db.prepare('SELECT * FROM backup_schedules WHERE id = ?').get(req.params.id);
    res.json({ message: 'Schedule updated', schedule: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/schedules/:id', (req, res) => {
  try {
    const db = getDatabase();
    db.prepare('DELETE FROM backup_schedules WHERE id = ?').run(req.params.id);
    res.json({ message: 'Schedule deleted' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/schedules/:id/run', async (req, res) => {
  const db = getDatabase();
  try {
    const s = db.prepare('SELECT * FROM backup_schedules WHERE id = ?').get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Schedule not found' });

    // Update last_run timestamp
    db.prepare('UPDATE backup_schedules SET last_run = ? WHERE id = ?').run(new Date().toISOString(), req.params.id);

    // Trigger via scheduler service by POSTing to /api/backups/:serverId
    const axios = require('axios');
    const backendPort = process.env.VOID_BACKEND_PORT || process.env.VOID_PORT || 3456;

    try {
      await axios.post(`http://localhost:${backendPort}/api/backups/${s.server_id}`, { incremental: s.incremental, compression_level: s.compression_level }, { timeout: 120000 });
      // Mark success
      db.prepare('UPDATE backup_schedules SET last_success = 1, last_error = NULL WHERE id = ?').run(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      // Mark failure with error message
      db.prepare('UPDATE backup_schedules SET last_success = 0, last_error = ? WHERE id = ?').run(err.message || 'Unknown error', req.params.id);
      res.status(500).json({ error: err.message });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Google Drive status check
router.get('/gdrive/status', (req, res) => {
  try {
    const db = getDatabase();
    const tokenRow = db.prepare("SELECT value FROM settings WHERE key = 'gdrive.tokens'").get();
    const credRow = db.prepare("SELECT value FROM settings WHERE key = 'gdrive.credentials'").get();

    const hasCredentials = Boolean(credRow?.value);
    const hasTokens = Boolean(tokenRow?.value);
    let connected = false;
    let expiresAt = null;

    if (hasTokens) {
      try {
        const tokens = JSON.parse(tokenRow.value);
        connected = true;
        expiresAt = tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null;
      } catch { }
    }

    res.json({
      configured: hasCredentials,
      connected,
      expires_at: expiresAt
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Disconnect Google Drive
router.post('/gdrive/disconnect', (req, res) => {
  try {
    const db = getDatabase();
    db.prepare("DELETE FROM settings WHERE key = 'gdrive.tokens'").run();
    res.json({ ok: true, message: 'Google Drive disconnected' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// FTP credentials management with simple encryption
const FTP_SETTINGS_KEY = 'ftp.credentials';

function encryptFtpCredentials(data) {
  // Simple XOR encryption with base64 - not cryptographically secure but obscures stored passwords
  const key = 'turbonox-ftp-key-2025';
  const json = JSON.stringify(data);
  let encrypted = '';
  for (let i = 0; i < json.length; i++) {
    encrypted += String.fromCharCode(json.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return Buffer.from(encrypted, 'binary').toString('base64');
}

function decryptFtpCredentials(encrypted) {
  try {
    const key = 'turbonox-ftp-key-2025';
    const decoded = Buffer.from(encrypted, 'base64').toString('binary');
    let decrypted = '';
    for (let i = 0; i < decoded.length; i++) {
      decrypted += String.fromCharCode(decoded.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return JSON.parse(decrypted);
  } catch {
    return null;
  }
}

router.get('/ftp/credentials', (req, res) => {
  try {
    const db = getDatabase();
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(FTP_SETTINGS_KEY);
    if (!row?.value) {
      return res.json({ configured: false });
    }
    const creds = decryptFtpCredentials(row.value);
    if (!creds) {
      return res.json({ configured: false });
    }
    // Return credentials but mask password
    res.json({
      configured: true,
      host: creds.host,
      port: creds.port || 21,
      user: creds.user,
      password: '••••••••', // Masked
      path: creds.path || '/',
      secure: creds.secure || false
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/ftp/credentials', (req, res) => {
  try {
    const db = getDatabase();
    const { host, port, user, password, path, secure } = req.body || {};
    if (!host || !user) {
      return res.status(400).json({ error: 'Host and user are required' });
    }
    const encrypted = encryptFtpCredentials({ host, port: port || 21, user, password, path: path || '/', secure: Boolean(secure) });
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(FTP_SETTINGS_KEY, encrypted);
    res.json({ ok: true, message: 'FTP credentials saved' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/ftp/credentials', (req, res) => {
  try {
    const db = getDatabase();
    db.prepare("DELETE FROM settings WHERE key = ?").run(FTP_SETTINGS_KEY);
    res.json({ ok: true, message: 'FTP credentials removed' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/ftp/test', async (req, res) => {
  try {
    let FtpClient;
    try { FtpClient = require('basic-ftp'); } catch { FtpClient = null; }
    if (!FtpClient) return res.status(500).json({ error: 'FTP client not available' });

    const { host, port, user, password, secure } = req.body || {};
    if (!host || !user) {
      return res.status(400).json({ error: 'Host and user are required' });
    }

    const client = new FtpClient.Client();
    client.ftp.verbose = false;

    try {
      await client.access({ host, port: port || 21, user, password, secure: Boolean(secure) });
      const list = await client.list();
      client.close();
      res.json({ ok: true, message: 'Connection successful', files: list.length });
    } catch (err) {
      client.close();
      res.status(400).json({ error: `Connection failed: ${err.message}` });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Backup preview/metadata
router.get('/:id/preview', (req, res) => {
  try {
    const db = getDatabase();
    const backup = db.prepare('SELECT * FROM backups WHERE id = ?').get(req.params.id);
    if (!backup) return res.status(404).json({ error: 'Backup not found' });

    let metadata = null;
    try {
      metadata = backup.metadata ? JSON.parse(backup.metadata) : null;
    } catch { }

    const server = backup.server_id
      ? db.prepare('SELECT * FROM servers WHERE id = ?').get(backup.server_id)
      : null;

    // Calculate expiry based on schedule retention
    let expiresAt = null;
    if (backup.server_id) {
      const schedule = db.prepare('SELECT retention_days FROM backup_schedules WHERE server_id = ? LIMIT 1').get(backup.server_id);
      if (schedule?.retention_days) {
        const created = new Date(backup.created_at);
        expiresAt = new Date(created.getTime() + schedule.retention_days * 24 * 60 * 60 * 1000).toISOString();
      }
    }

    res.json({
      id: backup.id,
      filename: backup.filename,
      size: backup.size,
      created_at: backup.created_at,
      expires_at: expiresAt,
      server_exists: Boolean(server),
      server_name: server?.name || metadata?.server?.name || 'Unknown',
      server_type: server?.type || metadata?.server?.type || 'unknown',
      original_path: metadata?.sourcePath || null,
      backup_type: metadata?.manifest ? 'incremental' : 'full',
      files_count: metadata?.manifest?.length || null,
      metadata: metadata?.server || null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manual retention cleanup
router.post('/cleanup', async (req, res) => {
  try {
    const db = getDatabase();
    const schedules = db.prepare('SELECT * FROM backup_schedules').all();
    let deletedCount = 0;

    for (const s of schedules) {
      const days = Number(s.retention_days || 7);
      if (!Number.isFinite(days) || days <= 0) continue;

      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const oldBackups = db.prepare('SELECT * FROM backups WHERE server_id = ? AND created_at < ?').all(s.server_id, cutoff);

      for (const b of oldBackups) {
        try {
          const backupPath = path.join(getBackupDir(), b.filename);
          if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
          db.prepare('DELETE FROM backups WHERE id = ?').run(b.id);
          deletedCount++;
        } catch { }
      }
    }

    res.json({ ok: true, deleted: deletedCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
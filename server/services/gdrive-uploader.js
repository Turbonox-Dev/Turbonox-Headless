const { getDatabase } = require('../lib/database');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { getBackupsDir } = require('../lib/paths');

class GDriveUploader {
  constructor() {
    this.interval = null;
    this.running = false;
  }

  async processQueueOnce() {
    if (this.running) return;
    this.running = true;
    try {
      const db = getDatabase();
      const row = db.prepare("SELECT value FROM settings WHERE key = 'backup.upload_requests'").get();
      const queue = row?.value ? JSON.parse(row.value) : [];
      if (!queue.length) return;

      const credRow = db.prepare("SELECT value FROM settings WHERE key = 'gdrive.credentials'").get();
      const tokenRow = db.prepare("SELECT value FROM settings WHERE key = 'gdrive.tokens'").get();
      if (!credRow?.value || !tokenRow?.value) return;

      const creds = JSON.parse(credRow.value);
      const tokens = JSON.parse(tokenRow.value);
      const oAuth2Client = new google.auth.OAuth2(creds.client_id, creds.client_secret);
      oAuth2Client.setCredentials(tokens);
      const drive = google.drive({ version: 'v3', auth: oAuth2Client });

      const remaining = [];
      for (const item of queue) {
        try {
          if (item.provider !== 'gdrive') {
            remaining.push(item);
            continue;
          }
          const backupRow = db.prepare('SELECT * FROM backups WHERE id = ?').get(item.id);
          if (!backupRow) continue;
          const backupPath = path.join(getBackupsDir(), backupRow.filename);
          if (!fs.existsSync(backupPath)) continue;
          const fileMetadata = { name: backupRow.filename };
          const media = { mimeType: 'application/zip', body: fs.createReadStream(backupPath) };
          const resp = await drive.files.create({ resource: fileMetadata, media, fields: 'id' });
          // record history
          const histKey = 'backup.upload_history';
          const histRow = db.prepare('SELECT value FROM settings WHERE key = ?').get(histKey);
          const hist = histRow?.value ? JSON.parse(histRow.value) : [];
          hist.push({ backupId: backupRow.id, fileId: resp.data.id, created_at: new Date().toISOString() });
          db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(histKey, JSON.stringify(hist));
        } catch (e) {
          console.warn('[GDRIVE-UPLOAD] Failed to upload item, keeping in queue:', item.id, e.message);
          remaining.push(item);
        }
      }

      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('backup.upload_requests', JSON.stringify(remaining));
    } catch (e) {
      console.error('[GDRIVE-UPLOAD] processQueueOnce error:', e.message);
    } finally {
      this.running = false;
    }
  }

  start(intervalMs = 5 * 60 * 1000) {
    if (this.interval) return;
    this.interval = setInterval(() => this.processQueueOnce().catch(() => {}), intervalMs);
    // run once immediately
    this.processQueueOnce().catch(() => {});
    console.log('[GDRIVE-UPLOAD] Started background uploader');
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }
}

module.exports = { GDriveUploader };

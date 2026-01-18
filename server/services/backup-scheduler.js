const schedule = require('node-schedule');
const { getDatabase } = require('../lib/database');

class BackupScheduler {
  constructor() {
    this.jobs = new Map();
  }

  async loadSchedules() {
    const db = getDatabase();
    try {
      const rows = db.prepare('SELECT * FROM backup_schedules WHERE enabled = 1').all();
      return rows || [];
    } catch (e) {
      console.error('[BACKUP-SCHED] Failed to load schedules:', e.message);
      return [];
    }
  }

  async scheduleAll() {
    const schedules = await this.loadSchedules();
    for (const s of schedules) {
      this.scheduleEntry(s);
    }
    console.log('[BACKUP-SCHED] Scheduled', schedules.length, 'jobs');
    // Start periodic retention cleanup (once per hour)
    if (!this.cleanupInterval) {
      this.cleanupInterval = setInterval(() => this.enforceRetentionPolicies().catch(() => {}), 60 * 60 * 1000);
    }
  }

  scheduleEntry(s) {
    try {
      if (!s || !s.cron_expr) return;
      if (this.jobs.has(s.id)) {
        try { this.jobs.get(s.id).cancel(); } catch {}
      }
      const job = schedule.scheduleJob(s.cron_expr, async () => {
        try {
          await this.runBackupNow(s.server_id, { incremental: Boolean(s.incremental), compression_level: Number(s.compression_level || 6) });
        } catch (err) {
          console.error('[BACKUP-SCHED] Job failed for schedule', s.id, err.message);
        }
      });
      this.jobs.set(s.id, job);
    } catch (e) {
      console.error('[BACKUP-SCHED] Failed to schedule entry:', e.message);
    }
  }

  async runBackupNow(serverId, options = {}) {
    const db = getDatabase();
    try {
      const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
      if (!server) throw new Error('Server not found');

      // call internal backup creation logic by issuing an internal request by invoking the route handler
      // For simplicity, require the backups route module to handle create; here we simulate by inserting a job row and calling archive logic is complex
      // As a pragmatic approach, we'll send a POST to localhost backend via axios
      const axios = require('axios');
      const backendPort = process.env.VOID_BACKEND_PORT || process.env.VOID_PORT || 3456;
      const url = `http://localhost:${backendPort}/api/backups/${serverId}`;
      await axios.post(url, options, { timeout: 120000 });
      console.log(`[BACKUP-SCHED] Triggered backup for server ${serverId}`);
      return { ok: true };
    } catch (err) {
      console.error('[BACKUP-SCHED] runBackupNow error:', err.message);
      throw err;
    }
  }

  async enforceRetentionPolicies() {
    const db = getDatabase();
    try {
      const schedules = db.prepare('SELECT * FROM backup_schedules').all();
      for (const s of schedules) {
        const days = Number(s.retention_days || 7);
        if (!Number.isFinite(days) || days <= 0) continue;
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const oldBackups = db.prepare('SELECT * FROM backups WHERE server_id = ? AND created_at < ?').all(s.server_id, cutoff);
        for (const b of oldBackups) {
          try {
            const backupPath = require('path').join(require('../lib/paths').getBackupsDir(), b.filename);
            if (require('fs').existsSync(backupPath)) require('fs').unlinkSync(backupPath);
            db.prepare('DELETE FROM backups WHERE id = ?').run(b.id);
            console.log('[BACKUP-SCHED] Deleted old backup', b.filename);
          } catch (e) {
            console.warn('[BACKUP-SCHED] Failed to delete old backup', b.id, e.message);
          }
        }
      }
    } catch (e) {
      console.error('[BACKUP-SCHED] Retention enforcement failed:', e.message);
    }
  }

  cancelAll() {
    for (const job of this.jobs.values()) {
      try { job.cancel(); } catch {}
    }
    this.jobs.clear();
  }
}

module.exports = { BackupScheduler };

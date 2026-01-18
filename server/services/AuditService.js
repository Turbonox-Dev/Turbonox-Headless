const { getDatabase } = require('../lib/database');

class AuditService {
    static log(serverId, action, user, details, metadata = {}) {
        const db = getDatabase();
        try {
            const stmt = db.prepare(`
        INSERT INTO audit_logs (server_id, action, user, details, metadata)
        VALUES (?, ?, ?, ?, ?)
      `);
            stmt.run(serverId, action, user, details, JSON.stringify(metadata));
        } catch (error) {
            console.error('[AUDIT] Failed to write log:', error);
        }
    }

    static getLogs(serverId, limit = 100, offset = 0) {
        const db = getDatabase();
        try {
            const stmt = db.prepare(`
        SELECT * FROM audit_logs 
        WHERE server_id = ? 
        ORDER BY created_at DESC 
        LIMIT ? OFFSET ?
      `);
            return stmt.all(serverId, limit, offset);
        } catch (error) {
            console.error('[AUDIT] Failed to fetch logs:', error);
            return [];
        }
    }
}

module.exports = AuditService;

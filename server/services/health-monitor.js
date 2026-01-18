const axios = require('axios');
const { getDatabase } = require('../lib/database');

class NodeHealthMonitor {
  constructor() {
    this.checkInterval = 30000; // 30 seconds
    this.timeout = 5000; // 5 seconds
    this.maxRetries = 3;
    this.monitoringInterval = null;
  }

  /**
   * Check health of a single node
   */
  async checkNodeHealth(node) {
    const db = getDatabase();
    let retries = 0;
    let lastError = null;

    console.log(`[HEALTH] Checking node ${node.name} (id=${node.id}, connection_type=${node.connection_type || 'http'})`);

    // Determine if this node should use SSH
    const shouldUseSsh = node.connection_type === 'ssh' || (node.ssh_user && (node.ssh_password || node.ssh_key));

    // For SSH nodes, use SSH connectivity check instead of HTTP
    if (shouldUseSsh) {
      console.log(`[HEALTH] Using SSH health check for node ${node.name}`);
      try {
        const { SshService } = require('./SshService');
        const stats = await SshService.getSystemStats(node);

        const now = new Date().toISOString();
        await new Promise((resolve, reject) => {
          db.run(
            `UPDATE nodes SET status = ?, last_seen = ?, resources = ?, connection_type = ? WHERE id = ?`,
            ['online', now, JSON.stringify(stats), 'ssh', node.id],
            (err) => {
              if (err) reject(err);
              else resolve();
            }
          );
        });

        console.log(`[HEALTH] Node ${node.name} is ONLINE via SSH`);
        return {
          status: 'online',
          last_seen: now,
          stats: stats
        };
      } catch (error) {
        console.error(`[HEALTH] SSH health check failed for node ${node.name}:`, error.message);
        const now = new Date().toISOString();
        await new Promise((resolve, reject) => {
          db.run(
            'UPDATE nodes SET status = ?, last_seen = ? WHERE id = ?',
            ['offline', now, node.id],
            (err) => {
              if (err) reject(err);
              else resolve();
            }
          );
        });

        return {
          status: 'offline',
          last_seen: now,
          error: error.message
        };
      }
    }

    // HTTP agent health check
    console.log(`[HEALTH] Using HTTP health check for node ${node.name}`);
    while (retries < this.maxRetries) {
      try {
        const healthUrl = `http://${node.ip_address}:${node.port || 3001}/api/health`;
        const statsUrl = `http://${node.ip_address}:${node.port || 3001}/api/system/stats`;

        // Check basic health
        const healthResponse = await axios.get(healthUrl, {
          timeout: this.timeout,
          headers: { 'User-Agent': 'Turbonox-HealthMonitor/1.0' }
        });

        // Get system stats
        let stats = null;
        try {
          const statsResponse = await axios.get(statsUrl, {
            timeout: this.timeout,
            headers: { 'User-Agent': 'Turbonox-HealthMonitor/1.0' }
          });
          stats = statsResponse.data;
        } catch (statsError) {
          console.warn(`[HEALTH] Could not get stats for node ${node.ip_address}:`, statsError.message);
        }

        const now = new Date().toISOString();
        const healthData = {
          status: 'online',
          last_seen: now,
          response_time: Date.now() - Date.parse(healthResponse.headers.date || now),
          metadata: healthResponse.data,
          stats: stats
        };

        // Update node in database
        await new Promise((resolve, reject) => {
          db.run(
            `UPDATE nodes SET
              status = ?,
              last_seen = ?,
              resources = ?,
              capabilities = ?
            WHERE id = ?`,
            [
              'online',
              now,
              stats ? JSON.stringify(stats) : node.resources,
              JSON.stringify({
                response_time: healthData.response_time,
                last_check: now,
                version: healthResponse.data.version || 'unknown'
              }),
              node.id
            ],
            (err) => {
              if (err) reject(err);
              else resolve();
            }
          );
        });

        console.log(`[HEALTH] Node ${node.name} is ONLINE via HTTP`);
        return healthData;

      } catch (error) {
        lastError = error;
        retries++;
        console.warn(`[HEALTH] HTTP check attempt ${retries}/${this.maxRetries} failed for ${node.name}:`, error.message);

        if (retries < this.maxRetries) {
          // Wait before retry
          await new Promise(resolve => setTimeout(resolve, 1000 * retries));
        }
      }
    }

    // HTTP failed - try SSH as fallback if credentials are available
    if (node.ssh_user && (node.ssh_password || node.ssh_key)) {
      console.log(`[HEALTH] HTTP failed for ${node.name}, trying SSH fallback...`);
      try {
        const { SshService } = require('./SshService');
        const stats = await SshService.getSystemStats(node);

        const now = new Date().toISOString();
        await new Promise((resolve, reject) => {
          db.run(
            `UPDATE nodes SET status = ?, last_seen = ?, resources = ?, connection_type = ? WHERE id = ?`,
            ['online', now, JSON.stringify(stats), 'ssh', node.id],
            (err) => {
              if (err) reject(err);
              else resolve();
            }
          );
        });

        console.log(`[HEALTH] Node ${node.name} is ONLINE via SSH fallback`);
        return {
          status: 'online',
          last_seen: now,
          stats: stats,
          fallback_used: true
        };
      } catch (sshError) {
        console.error(`[HEALTH] SSH fallback also failed for ${node.name}:`, sshError.message);
      }
    }

    // Node is offline after all retries
    console.log(`[HEALTH] Node ${node.name} is OFFLINE`);
    const now = new Date().toISOString();
    await new Promise((resolve, reject) => {
      db.run(
        'UPDATE nodes SET status = ?, last_seen = ? WHERE id = ?',
        ['offline', now, node.id],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    return {
      status: 'offline',
      last_seen: now,
      error: lastError?.message || 'All connection attempts failed',
      retries_attempted: retries
    };
  }

  /**
   * Check health of all nodes
   */
  async checkAllNodesHealth() {
    const db = getDatabase();

    try {
      const nodes = await new Promise((resolve, reject) => {
        db.all('SELECT * FROM nodes', [], (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });

      if (nodes.length === 0) {
        return { checked: 0, online: 0, offline: 0, results: [] };
      }

      console.log(`[HEALTH] Checking health of ${nodes.length} nodes...`);

      const results = [];
      let onlineCount = 0;
      let offlineCount = 0;

      // Check nodes in parallel with concurrency limit
      const concurrencyLimit = 5;
      for (let i = 0; i < nodes.length; i += concurrencyLimit) {
        const batch = nodes.slice(i, i + concurrencyLimit);
        const promises = batch.map(node => this.checkNodeHealth(node));

        const batchResults = await Promise.all(promises);
        results.push(...batchResults);

        batchResults.forEach(result => {
          if (result.status === 'online') onlineCount++;
          else offlineCount++;
        });
      }

      console.log(`[HEALTH] Health check complete: ${onlineCount} online, ${offlineCount} offline`);

      return {
        checked: nodes.length,
        online: onlineCount,
        offline: offlineCount,
        results: results
      };

    } catch (error) {
      console.error('[HEALTH] Failed to check nodes health:', error.message);
      throw error;
    }
  }

  /**
   * Get health summary for all nodes
   */
  async getHealthSummary() {
    const db = getDatabase();

    try {
      const summary = await new Promise((resolve, reject) => {
        db.get(`
          SELECT
            COUNT(*) as total,
            SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) as online,
            SUM(CASE WHEN status = 'offline' THEN 1 ELSE 0 END) as offline
          FROM nodes
        `, [], (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });

      // Get detailed node status
      const nodes = await new Promise((resolve, reject) => {
        db.all(`
          SELECT id, name, ip_address, status, last_seen, resources, capabilities
          FROM nodes
          ORDER BY last_seen DESC
        `, [], (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });

      return {
        summary: {
          total: summary.total || 0,
          online: summary.online || 0,
          offline: summary.offline || 0
        },
        nodes: nodes.map(node => ({
          ...node,
          resources: node.resources ? JSON.parse(node.resources) : null,
          capabilities: node.capabilities ? JSON.parse(node.capabilities) : null
        }))
      };

    } catch (error) {
      console.error('[HEALTH] Failed to get health summary:', error.message);
      throw error;
    }
  }

  /**
   * Start periodic health monitoring
   */
  startMonitoring() {
    console.log(`[HEALTH] Starting health monitoring every ${this.checkInterval / 1000} seconds`);

    // Perform initial health check
    this.checkAllNodesHealth().catch(error => {
      console.error('[HEALTH] Initial health check failed:', error.message);
    });

    // Set up periodic monitoring
    this.monitoringInterval = setInterval(() => {
      this.checkAllNodesHealth().catch(error => {
        console.error('[HEALTH] Periodic health check failed:', error.message);
      });
    }, this.checkInterval);

    return this.monitoringInterval;
  }

  /**
   * Stop periodic health monitoring
   */
  stopMonitoring() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
      console.log('[HEALTH] Stopped health monitoring');
    }
  }

  /**
   * Force health check for specific node
   */
  async forceHealthCheck(nodeId) {
    const db = getDatabase();

    try {
      const node = await new Promise((resolve, reject) => {
        db.get('SELECT * FROM nodes WHERE id = ?', [nodeId], (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });

      if (!node) {
        throw new Error('Node not found');
      }

      return await this.checkNodeHealth(node);
    } catch (error) {
      console.error(`[HEALTH] Failed to force health check for node ${nodeId}:`, error.message);
      throw error;
    }
  }
}

module.exports = { NodeHealthMonitor };
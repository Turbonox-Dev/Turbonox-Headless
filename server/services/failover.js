const { getDatabase } = require('../lib/database');
const { LoadBalancerService } = require('./load-balancer');

class FailoverService {
  constructor() {
    this.failoverThreshold = 3; // 3 failed health checks
    this.failoverCooldown = 5 * 60 * 1000; // 5 minutes cooldown
    this.maxMigrationAttempts = 3;
    this.loadBalancer = new LoadBalancerService();
  }

  /**
   * Monitor nodes for failures and trigger failover
   */
  async monitorAndFailover() {
    const db = getDatabase();

    try {
      // Get nodes that might need failover
      const nodes = await new Promise((resolve, reject) => {
        db.all(`
          SELECT n.*,
                 COUNT(s.id) as server_count,
                 COUNT(CASE WHEN s.status = 'running' THEN 1 END) as running_servers
          FROM nodes n
          LEFT JOIN servers s ON n.id = s.node_id
          WHERE n.status = 'offline' OR n.status = 'failing'
          GROUP BY n.id
        `, [], (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });

      if (nodes.length === 0) {
        return { monitored: 0, failed_over: 0, message: 'No nodes requiring failover' };
      }

      console.log(`[FAILOVER] Monitoring ${nodes.length} potentially failing nodes`);

      let failedOver = 0;

      for (const node of nodes) {
        try {
          const shouldFailover = await this.shouldTriggerFailover(node);

          if (shouldFailover) {
            console.log(`[FAILOVER] Triggering failover for node ${node.name} (${node.ip_address})`);
            const result = await this.executeFailover(node);
            if (result.migrated > 0) {
              failedOver++;
            }
          }
        } catch (error) {
          console.error(`[FAILOVER] Failed to process failover for node ${node.name}:`, error.message);
        }
      }

      return {
        monitored: nodes.length,
        failed_over: failedOver,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      console.error('[FAILOVER] Failed to monitor and failover:', error.message);
      throw error;
    }
  }

  /**
   * Determine if a node should trigger failover
   */
  async shouldTriggerFailover(node) {
    const db = getDatabase();

    try {
      // Check recent health check history (simplified - using last_seen as proxy)
      const now = Date.now();
      const lastSeen = node.last_seen ? new Date(node.last_seen).getTime() : 0;
      const timeSinceLastSeen = now - lastSeen;

      // If node hasn't been seen for more than 5 minutes, consider it failed
      if (timeSinceLastSeen > 5 * 60 * 1000) {
        return true;
      }

      // Check if node has been marked as failing for too long
      if (node.status === 'failing') {
        // Get failover history
        const failoverHistory = await new Promise((resolve, reject) => {
          db.all(
            'SELECT * FROM failover_history WHERE node_id = ? ORDER BY created_at DESC LIMIT 5',
            [node.id],
            (err, rows) => {
              if (err) reject(err);
              else resolve(rows);
            }
          );
        });

        // If failed more than threshold times recently, trigger failover
        const recentFailures = failoverHistory.filter(f => {
          const failureTime = new Date(f.created_at).getTime();
          return (now - failureTime) < (24 * 60 * 60 * 1000); // Last 24 hours
        });

        if (recentFailures.length >= this.failoverThreshold) {
          return true;
        }
      }

      return false;

    } catch (error) {
      console.error(`[FAILOVER] Failed to check failover condition for node ${node.id}:`, error.message);
      return false;
    }
  }

  /**
   * Execute failover for a failed node
   */
  async executeFailover(failedNode) {
    const db = getDatabase();

    try {
      // Get all servers assigned to the failed node
      const serversToMigrate = await new Promise((resolve, reject) => {
        db.all('SELECT * FROM servers WHERE node_id = ?', [failedNode.id], (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });

      if (serversToMigrate.length === 0) {
        console.log(`[FAILOVER] No servers to migrate for node ${failedNode.name}`);
        return { migrated: 0, message: 'No servers to migrate' };
      }

      console.log(`[FAILOVER] Migrating ${serversToMigrate.length} servers from failed node ${failedNode.name}`);

      // Get available nodes for failover (excluding the failed one)
      const availableNodes = await new Promise((resolve, reject) => {
        db.all(
          'SELECT * FROM nodes WHERE status = ? AND id != ?',
          ['online', failedNode.id],
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
          }
        );
      });

      if (availableNodes.length === 0) {
        console.error(`[FAILOVER] No available nodes for failover of ${failedNode.name}`);
        await this.logFailoverEvent(failedNode.id, 'failed', 'No available nodes for failover', serversToMigrate.length);
        return { migrated: 0, message: 'No available nodes for failover' };
      }

      // Stop servers on the failed node first
      await this.stopServersOnNode(failedNode, serversToMigrate);

      // Distribute servers to available nodes using load balancing
      const assignments = this.distributeServersToNodes(serversToMigrate, availableNodes);

      let migrated = 0;
      let failed = 0;

      for (const assignment of assignments) {
        try {
          // Update server assignment
          await new Promise((resolve, reject) => {
            db.run(
              'UPDATE servers SET node_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
              [assignment.node_id, assignment.server_id],
              function(err) {
                if (err) reject(err);
                else resolve();
              }
            );
          });

          // Try to start server on new node (this would require remote API call in full implementation)
          // For now, just mark as migrated
          console.log(`[FAILOVER] Migrated server ${assignment.server_name} to node ${assignment.node_name}`);
          migrated++;

        } catch (error) {
          console.error(`[FAILOVER] Failed to migrate server ${assignment.server_name}:`, error.message);
          failed++;
        }
      }

      // Log failover event
      await this.logFailoverEvent(failedNode.id, migrated > 0 ? 'completed' : 'partial', {
        migrated,
        failed,
        total: serversToMigrate.length,
        target_nodes: availableNodes.length
      });

      // Mark failed node for manual recovery
      await new Promise((resolve, reject) => {
        db.run(
          'UPDATE nodes SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          ['failed', failedNode.id],
          (err) => {
            if (err) reject(err);
          }
        );
      });

      return {
        migrated,
        failed,
        total: serversToMigrate.length,
        available_nodes: availableNodes.length
      };

    } catch (error) {
      console.error(`[FAILOVER] Failed to execute failover for node ${failedNode.id}:`, error.message);
      await this.logFailoverEvent(failedNode.id, 'error', error.message);
      throw error;
    }
  }

  /**
   * Stop servers running on a failed node
   */
  async stopServersOnNode(node, servers) {
    try {
      // In a full implementation, this would make API calls to the failed node
      // For now, we'll just update the database status
      const db = getDatabase();

      for (const server of servers) {
        if (server.status === 'running') {
          await new Promise((resolve, reject) => {
            db.run(
              'UPDATE servers SET status = ?, pid = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
              ['stopped', server.id],
              (err) => {
                if (err) reject(err);
              }
            );
          });
          console.log(`[FAILOVER] Marked server ${server.name} as stopped on failed node`);
        }
      }
    } catch (error) {
      console.warn(`[FAILOVER] Failed to stop servers on node ${node.name}:`, error.message);
    }
  }

  /**
   * Distribute servers to available nodes
   */
  distributeServersToNodes(servers, availableNodes) {
    const assignments = [];
    let nodeIndex = 0;

    // Simple round-robin distribution for failover
    for (const server of servers) {
      const targetNode = availableNodes[nodeIndex % availableNodes.length];
      assignments.push({
        server_id: server.id,
        server_name: server.name,
        node_id: targetNode.id,
        node_name: targetNode.name
      });
      nodeIndex++;
    }

    return assignments;
  }

  /**
   * Log failover events
   */
  async logFailoverEvent(nodeId, status, details, serverCount = null) {
    const db = getDatabase();

    try {
      const detailsStr = typeof details === 'object' ? JSON.stringify(details) : details;

      await new Promise((resolve, reject) => {
        db.run(
          'INSERT INTO failover_history (node_id, status, details, server_count, created_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)',
          [nodeId, status, detailsStr, serverCount],
          function(err) {
            if (err) reject(err);
          }
        );
      });
    } catch (error) {
      console.error('[FAILOVER] Failed to log failover event:', error.message);
    }
  }

  /**
   * Recover a failed node
   */
  async recoverNode(nodeId) {
    const db = getDatabase();

    try {
      // Check if node is responding
      const node = await new Promise((resolve, reject) => {
        db.get('SELECT * FROM nodes WHERE id = ?', [nodeId], (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });

      if (!node) {
        throw new Error('Node not found');
      }

      // Test connectivity
      try {
        const axios = require('axios');
        const healthUrl = `http://${node.ip_address}:${node.port || 3001}/api/health`;
        await axios.get(healthUrl, { timeout: 5000 });

        // Node is back online
        await new Promise((resolve, reject) => {
          db.run(
            'UPDATE nodes SET status = ?, last_seen = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            ['online', new Date().toISOString(), nodeId],
            (err) => {
              if (err) reject(err);
            }
          );
        });

        console.log(`[FAILOVER] Node ${node.name} recovered successfully`);

        // Optionally trigger rebalancing to move servers back
        // This could be configured based on user preference

        return { recovered: true, node_name: node.name };

      } catch (connectError) {
        throw new Error(`Node is still unreachable: ${connectError.message}`);
      }

    } catch (error) {
      console.error(`[FAILOVER] Failed to recover node ${nodeId}:`, error.message);
      throw error;
    }
  }

  /**
   * Get failover history and status
   */
  async getFailoverStatus() {
    const db = getDatabase();

    try {
      // Get recent failover events
      const recentEvents = await new Promise((resolve, reject) => {
        db.all(`
          SELECT fh.*, n.name as node_name, n.ip_address
          FROM failover_history fh
          JOIN nodes n ON fh.node_id = n.id
          ORDER BY fh.created_at DESC
          LIMIT 20
        `, [], (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });

      // Get nodes currently in failed state
      const failedNodes = await new Promise((resolve, reject) => {
        db.all(
          'SELECT * FROM nodes WHERE status = ?',
          ['failed'],
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
          }
        );
      });

      // Calculate failover statistics
      const stats = {
        total_events: recentEvents.length,
        successful_failovers: recentEvents.filter(e => e.status === 'completed').length,
        failed_failovers: recentEvents.filter(e => e.status === 'failed' || e.status === 'error').length,
        partial_failovers: recentEvents.filter(e => e.status === 'partial').length,
        failed_nodes_count: failedNodes.length
      };

      return {
        stats,
        recent_events: recentEvents.map(event => ({
          ...event,
          details: event.details ? JSON.parse(event.details) : null
        })),
        failed_nodes: failedNodes
      };

    } catch (error) {
      console.error('[FAILOVER] Failed to get failover status:', error.message);
      throw error;
    }
  }

  /**
   * Initialize failover monitoring (to be called periodically)
   */
  async initializeMonitoring() {
    console.log('[FAILOVER] Initializing failover monitoring');

    // Run initial failover check
    await this.monitorAndFailover();

    // Set up periodic monitoring
    this.monitoringInterval = setInterval(async () => {
      try {
        await this.monitorAndFailover();
      } catch (error) {
        console.error('[FAILOVER] Periodic monitoring failed:', error.message);
      }
    }, 60000); // Check every minute

    return this.monitoringInterval;
  }

  /**
   * Stop failover monitoring
   */
  stopMonitoring() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
      console.log('[FAILOVER] Stopped failover monitoring');
    }
  }
}

module.exports = { FailoverService };
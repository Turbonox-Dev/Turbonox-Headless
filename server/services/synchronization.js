const axios = require('axios');
const { getDatabase } = require('../lib/database');

class NodeSynchronizationService {
  constructor() {
    this.syncTimeout = 10000; // 10 seconds
    this.maxRetries = 3;
  }

  /**
   * Sync server configurations from master node to target node
   */
  async syncServersToNode(targetNodeId, serverIds = null) {
    const db = getDatabase();

    try {
      // Get target node info
      const targetNode = await new Promise((resolve, reject) => {
        db.get('SELECT * FROM nodes WHERE id = ?', [targetNodeId], (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });

      if (!targetNode) {
        throw new Error('Target node not found');
      }

      if (targetNode.status !== 'online') {
        throw new Error('Target node is not online');
      }

      // Get servers to sync
      let servers;
      if (serverIds) {
        // Sync specific servers
        const placeholders = serverIds.map(() => '?').join(',');
        servers = await new Promise((resolve, reject) => {
          db.all(`SELECT * FROM servers WHERE id IN (${placeholders})`, serverIds, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
          });
        });
      } else {
        // Sync all servers assigned to this node
        servers = await new Promise((resolve, reject) => {
          db.all('SELECT * FROM servers WHERE node_id = ?', [targetNodeId], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
          });
        });
      }

      if (servers.length === 0) {
        return { synced: 0, message: 'No servers to sync' };
      }

      console.log(`[SYNC] Syncing ${servers.length} servers to node ${targetNode.name} (${targetNode.ip_address})`);

      // Send servers to target node
      const syncUrl = `http://${targetNode.ip_address}:${targetNode.port || 3001}/api/sync/servers`;
      const response = await axios.post(syncUrl, {
        servers: servers,
        source: 'master',
        timestamp: new Date().toISOString()
      }, {
        timeout: this.syncTimeout,
        headers: { 'Content-Type': 'application/json' }
      });

      return {
        synced: servers.length,
        target_node: targetNode.name,
        response: response.data
      };

    } catch (error) {
      console.error(`[SYNC] Failed to sync servers to node ${targetNodeId}:`, error.message);
      throw error;
    }
  }

  /**
   * Sync server states (running/stopped) across nodes
   */
  async syncServerStates(targetNodeId) {
    const db = getDatabase();

    try {
      const targetNode = await new Promise((resolve, reject) => {
        db.get('SELECT * FROM nodes WHERE id = ?', [targetNodeId], (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });

      if (!targetNode || targetNode.status !== 'online') {
        throw new Error('Target node is not available');
      }

      // Get all servers assigned to this node with their current states
      const servers = await new Promise((resolve, reject) => {
        db.all('SELECT id, name, status, pid FROM servers WHERE node_id = ?', [targetNodeId], (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });

      if (servers.length === 0) {
        return { synced: 0, message: 'No servers assigned to this node' };
      }

      // Send state sync to target node
      const syncUrl = `http://${targetNode.ip_address}:${targetNode.port || 3001}/api/sync/states`;
      const response = await axios.post(syncUrl, {
        server_states: servers.map(s => ({
          id: s.id,
          name: s.name,
          status: s.status,
          pid: s.pid
        })),
        timestamp: new Date().toISOString()
      }, {
        timeout: this.syncTimeout,
        headers: { 'Content-Type': 'application/json' }
      });

      return {
        synced: servers.length,
        target_node: targetNode.name,
        response: response.data
      };

    } catch (error) {
      console.error(`[SYNC] Failed to sync server states to node ${targetNodeId}:`, error.message);
      throw error;
    }
  }

  /**
   * Pull server configurations from a remote node
   */
  async pullServersFromNode(sourceNodeId) {
    const db = getDatabase();

    try {
      const sourceNode = await new Promise((resolve, reject) => {
        db.get('SELECT * FROM nodes WHERE id = ?', [sourceNodeId], (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });

      if (!sourceNode || sourceNode.status !== 'online') {
        throw new Error('Source node is not available');
      }

      // Pull servers from source node
      const pullUrl = `http://${sourceNode.ip_address}:${sourceNode.port || 3001}/api/servers`;
      const response = await axios.get(pullUrl, {
        timeout: this.syncTimeout
      });

      const remoteServers = response.data;

      if (!Array.isArray(remoteServers)) {
        throw new Error('Invalid response from source node');
      }

      console.log(`[SYNC] Pulled ${remoteServers.length} servers from node ${sourceNode.name}`);

      // Update local database with remote servers
      let updated = 0;
      let created = 0;

      for (const remoteServer of remoteServers) {
        // Check if server exists locally
        const existingServer = await new Promise((resolve, reject) => {
          db.get('SELECT * FROM servers WHERE id = ?', [remoteServer.id], (err, row) => {
            if (err) reject(err);
            else resolve(row);
          });
        });

        if (existingServer) {
          // Update existing server
          await new Promise((resolve, reject) => {
            db.run(
              `UPDATE servers SET
                name = ?, type = ?, path = ?, command = ?, port = ?, status = ?,
                public_access = ?, subdomain = ?, node_id = ?, updated_at = CURRENT_TIMESTAMP
              WHERE id = ?`,
              [
                remoteServer.name,
                remoteServer.type,
                remoteServer.path,
                remoteServer.command,
                remoteServer.port,
                remoteServer.status,
                remoteServer.public_access,
                remoteServer.subdomain,
                sourceNodeId, // Assign to source node
                remoteServer.id
              ],
              (err) => {
                if (err) reject(err);
              }
            );
          });
          updated++;
        } else {
          // Create new server
          await new Promise((resolve, reject) => {
            db.run(
              `INSERT INTO servers (
                id, name, type, path, command, port, status, public_access, subdomain, node_id, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
              [
                remoteServer.id,
                remoteServer.name,
                remoteServer.type,
                remoteServer.path,
                remoteServer.command,
                remoteServer.port,
                remoteServer.status,
                remoteServer.public_access,
                remoteServer.subdomain,
                sourceNodeId
              ],
              (err) => {
                if (err) reject(err);
              }
            );
          });
          created++;
        }
      }

      return {
        pulled: remoteServers.length,
        created: created,
        updated: updated,
        source_node: sourceNode.name
      };

    } catch (error) {
      console.error(`[SYNC] Failed to pull servers from node ${sourceNodeId}:`, error.message);
      throw error;
    }
  }

  /**
   * Sync all nodes with their assigned servers
   */
  async syncAllNodes() {
    const db = getDatabase();

    try {
      // Get all online nodes
      const nodes = await new Promise((resolve, reject) => {
        db.all('SELECT * FROM nodes WHERE status = ?', ['online'], (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });

      if (nodes.length === 0) {
        return { nodes_synced: 0, message: 'No online nodes to sync' };
      }

      console.log(`[SYNC] Starting sync for ${nodes.length} online nodes`);

      const results = [];

      for (const node of nodes) {
        try {
          // Sync servers to this node
          const serverSync = await this.syncServersToNode(node.id);

          // Sync server states
          const stateSync = await this.syncServerStates(node.id);

          results.push({
            node_id: node.id,
            node_name: node.name,
            servers_synced: serverSync.synced,
            states_synced: stateSync.synced,
            success: true
          });

        } catch (error) {
          console.error(`[SYNC] Failed to sync node ${node.name}:`, error.message);
          results.push({
            node_id: node.id,
            node_name: node.name,
            error: error.message,
            success: false
          });
        }
      }

      const successful = results.filter(r => r.success).length;

      return {
        nodes_synced: successful,
        total_nodes: nodes.length,
        results: results
      };

    } catch (error) {
      console.error('[SYNC] Failed to sync all nodes:', error.message);
      throw error;
    }
  }

  /**
   * Get synchronization status for all nodes
   */
  async getSyncStatus() {
    const db = getDatabase();

    try {
      // Get node and server counts
      const stats = await new Promise((resolve, reject) => {
        db.get(`
          SELECT
            (SELECT COUNT(*) FROM nodes WHERE status = 'online') as online_nodes,
            (SELECT COUNT(*) FROM nodes) as total_nodes,
            (SELECT COUNT(*) FROM servers WHERE node_id IS NOT NULL) as assigned_servers,
            (SELECT COUNT(*) FROM servers) as total_servers
        `, [], (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });

      // Get per-node sync status
      const nodes = await new Promise((resolve, reject) => {
        db.all(`
          SELECT
            n.id, n.name, n.ip_address, n.status, n.last_seen,
            COUNT(s.id) as server_count,
            COUNT(CASE WHEN s.status = 'running' THEN 1 END) as running_servers
          FROM nodes n
          LEFT JOIN servers s ON n.id = s.node_id
          GROUP BY n.id
          ORDER BY n.last_seen DESC
        `, [], (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });

      return {
        summary: {
          online_nodes: stats.online_nodes || 0,
          total_nodes: stats.total_nodes || 0,
          assigned_servers: stats.assigned_servers || 0,
          total_servers: stats.total_servers || 0,
          sync_percentage: stats.total_nodes > 0 ? Math.round((stats.online_nodes / stats.total_nodes) * 100) : 0
        },
        nodes: nodes.map(node => ({
          ...node,
          last_sync: node.last_seen, // Using last_seen as proxy for last sync
          needs_sync: node.status === 'online' && node.server_count > 0
        }))
      };

    } catch (error) {
      console.error('[SYNC] Failed to get sync status:', error.message);
      throw error;
    }
  }

  /**
   * Rebalance servers across nodes (load balancing)
   */
  async rebalanceServers() {
    const db = getDatabase();

    try {
      // Get all online nodes
      const nodes = await new Promise((resolve, reject) => {
        db.all('SELECT * FROM nodes WHERE status = ?', ['online'], (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });

      if (nodes.length === 1) {
        return { rebalanced: false, message: 'Only one online node available' };
      }

      // Get all servers not assigned to any node
      const unassignedServers = await new Promise((resolve, reject) => {
        db.all('SELECT * FROM servers WHERE node_id IS NULL', [], (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });

      if (unassignedServers.length === 0) {
        return { rebalanced: false, message: 'No unassigned servers to rebalance' };
      }

      console.log(`[SYNC] Rebalancing ${unassignedServers.length} servers across ${nodes.length} nodes`);

      // Simple round-robin assignment
      let nodeIndex = 0;
      let assigned = 0;

      for (const server of unassignedServers) {
        const targetNode = nodes[nodeIndex % nodes.length];

        await new Promise((resolve, reject) => {
          db.run(
            'UPDATE servers SET node_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [targetNode.id, server.id],
            (err) => {
              if (err) reject(err);
              else resolve();
            }
          );
        });

        assigned++;
        nodeIndex++;
      }

      return {
        rebalanced: true,
        servers_assigned: assigned,
        nodes_used: Math.min(nodes.length, unassignedServers.length)
      };

    } catch (error) {
      console.error('[SYNC] Failed to rebalance servers:', error.message);
      throw error;
    }
  }
}

module.exports = { NodeSynchronizationService };
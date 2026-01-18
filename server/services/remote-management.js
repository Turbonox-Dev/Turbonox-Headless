const axios = require('axios');
const { getDatabase } = require('../lib/database');

const { SshService } = require('./SshService');

class RemoteNodeManager {
  constructor() {
    this.timeout = 10000; // 10 seconds
    this.maxRetries = 2;
    this.sshService = SshService;
  }

  /**
   * Execute a command on a remote node
   */
  async executeRemoteCommand(nodeId, endpoint, method = 'GET', data = null) {
    const db = getDatabase();

    try {
      // Get node info
      const node = await new Promise((resolve, reject) => {
        db.get('SELECT * FROM nodes WHERE id = ?', [nodeId], (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });

      if (!node) {
        throw new Error('Node not found');
      }

      if (node.status !== 'online') {
        throw new Error('Node is not online');
      }

      const url = `http://${node.ip_address}:${node.port || 3001}/api/${endpoint}`;

      const config = {
        method: method,
        timeout: this.timeout,
        headers: {
          'Content-Type': 'application/json',
          'X-Remote-Management': 'true'
        }
      };

      // Include node auth token if available
      if (node.auth_token) {
        config.headers['X-Node-Auth'] = node.auth_token;
      }

      if (data && (method === 'POST' || method === 'PUT')) {
        config.data = data;
      }

      console.log(`[REMOTE] Executing ${method} ${url} on node ${node.name}`);

      const response = await axios(url, config);

      return {
        node_id: nodeId,
        node_name: node.name,
        endpoint: endpoint,
        method: method,
        status: response.status,
        data: response.data
      };

    } catch (error) {
      console.error(`[REMOTE] Failed to execute command on node ${nodeId}:`, error.message);
      throw error;
    }
  }

  /**
   * Get remote node system stats
   */
  async getRemoteSystemStats(nodeId) {
    const db = getDatabase();
    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);

    if (node?.connection_type === 'ssh') {
      return { data: await this.sshService.getSystemStats(node) };
    }

    return await this.executeRemoteCommand(nodeId, 'system/stats');
  }

  /**
   * Get remote node servers
   */
  async getRemoteServers(nodeId) {
    const db = getDatabase();
    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);

    if (node?.connection_type === 'ssh') {
      return { data: await this.sshService.getRemoteServers(node) };
    }

    return await this.executeRemoteCommand(nodeId, 'servers');
  }

  /**
   * Start a server on a remote node
   */
  async startRemoteServer(nodeId, serverId) {
    return await this.executeRemoteCommand(nodeId, `servers/${serverId}/start`, 'POST');
  }

  /**
   * Stop a server on a remote node
   */
  async stopRemoteServer(nodeId, serverId) {
    return await this.executeRemoteCommand(nodeId, `servers/${serverId}/stop`, 'POST');
  }

  /**
   * Restart a server on a remote node
   */
  async restartRemoteServer(nodeId, serverId) {
    return await this.executeRemoteCommand(nodeId, `servers/${serverId}/restart`, 'POST');
  }

  /**
   * Create a server on a remote node
   */
  async createRemoteServer(nodeId, serverData) {
    return await this.executeRemoteCommand(nodeId, 'servers', 'POST', serverData);
  }

  /**
   * Update a server on a remote node
   */
  async updateRemoteServer(nodeId, serverId, serverData) {
    return await this.executeRemoteCommand(nodeId, `servers/${serverId}`, 'PUT', serverData);
  }

  /**
   * Delete a server on a remote node
   */
  async deleteRemoteServer(nodeId, serverId) {
    return await this.executeRemoteCommand(nodeId, `servers/${serverId}`, 'DELETE');
  }

  /**
   * Get server logs from a remote node
   */
  async getRemoteServerLogs(nodeId, serverId) {
    return await this.executeRemoteCommand(nodeId, `servers/${serverId}/logs`);
  }

  /**
   * Get backups from a remote node
   */
  async getRemoteBackups(nodeId) {
    return await this.executeRemoteCommand(nodeId, 'backups');
  }

  /**
   * Create backup on a remote node
   */
  async createRemoteBackup(nodeId, serverId) {
    return await this.executeRemoteCommand(nodeId, `backups/${serverId}`, 'POST');
  }

  /**
   * Get network status from a remote node
   */
  async getRemoteNetworkStatus(nodeId) {
    return await this.executeRemoteCommand(nodeId, 'network/status');
  }

  /**
   * Execute custom command on remote node
   */
  async executeCustomCommand(nodeId, command, cwd = null) {
    const commandData = { command, cwd };
    return await this.executeRemoteCommand(nodeId, 'system/execute', 'POST', commandData);
  }

  /**
   * Bulk operations across multiple nodes
   */
  async executeBulkOperation(nodeIds, operation, params = {}) {
    const results = [];
    const errors = [];

    for (const nodeId of nodeIds) {
      try {
        let result;

        switch (operation) {
          case 'get_stats':
            result = await this.getRemoteSystemStats(nodeId);
            break;
          case 'get_servers':
            result = await this.getRemoteServers(nodeId);
            break;
          case 'start_all_servers':
            // Get servers first, then start them
            const serversResult = await this.getRemoteServers(nodeId);
            const startPromises = serversResult.data
              .filter(server => server.status === 'stopped')
              .map(server => this.startRemoteServer(nodeId, server.id));
            result = await Promise.all(startPromises);
            break;
          case 'stop_all_servers':
            const serversResult2 = await this.getRemoteServers(nodeId);
            const stopPromises = serversResult2.data
              .filter(server => server.status === 'running')
              .map(server => this.stopRemoteServer(nodeId, server.id));
            result = await Promise.all(stopPromises);
            break;
          case 'restart_all_servers':
            const serversResult3 = await this.getRemoteServers(nodeId);
            const restartPromises = serversResult3.data
              .filter(server => server.status === 'running')
              .map(server => this.restartRemoteServer(nodeId, server.id));
            result = await Promise.all(restartPromises);
            break;
          default:
            throw new Error(`Unknown bulk operation: ${operation}`);
        }

        results.push({
          node_id: nodeId,
          operation: operation,
          success: true,
          result: result
        });

      } catch (error) {
        console.error(`[REMOTE] Bulk operation ${operation} failed on node ${nodeId}:`, error.message);
        errors.push({
          node_id: nodeId,
          operation: operation,
          error: error.message
        });
        results.push({
          node_id: nodeId,
          operation: operation,
          success: false,
          error: error.message
        });
      }
    }

    return {
      operation: operation,
      total_nodes: nodeIds.length,
      successful: results.filter(r => r.success).length,
      failed: errors.length,
      results: results,
      errors: errors
    };
  }

  /**
   * Get comprehensive remote node status
   */
  async getRemoteNodeStatus(nodeId) {
    try {
      const [systemStats, servers, networkStatus] = await Promise.all([
        this.getRemoteSystemStats(nodeId),
        this.getRemoteServers(nodeId),
        this.getRemoteNetworkStatus(nodeId).catch(() => null) // Network status might not be available
      ]);

      return {
        node_id: nodeId,
        system_stats: systemStats.data,
        servers: servers.data,
        network_status: networkStatus ? networkStatus.data : null,
        last_updated: new Date().toISOString()
      };

    } catch (error) {
      console.error(`[REMOTE] Failed to get comprehensive status for node ${nodeId}:`, error.message);
      throw error;
    }
  }

  /**
   * Synchronize server configurations across nodes
   */
  async syncServerConfigurations(masterNodeId, targetNodeIds) {
    const db = getDatabase();

    try {
      // Get all servers from master node
      const masterServers = await new Promise((resolve, reject) => {
        db.all('SELECT * FROM servers WHERE node_id = ? OR node_id IS NULL', [masterNodeId], (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });

      const results = [];

      for (const targetNodeId of targetNodeIds) {
        try {
          // Send server configurations to target node
          const result = await this.executeRemoteCommand(
            targetNodeId,
            'sync/servers',
            'POST',
            {
              servers: masterServers,
              source: 'master_sync',
              timestamp: new Date().toISOString()
            }
          );

          results.push({
            target_node_id: targetNodeId,
            success: true,
            servers_synced: masterServers.length,
            result: result
          });

        } catch (error) {
          console.error(`[REMOTE] Failed to sync servers to node ${targetNodeId}:`, error.message);
          results.push({
            target_node_id: targetNodeId,
            success: false,
            error: error.message
          });
        }
      }

      return {
        master_node_id: masterNodeId,
        target_nodes: targetNodeIds.length,
        successful_syncs: results.filter(r => r.success).length,
        results: results
      };

    } catch (error) {
      console.error('[REMOTE] Failed to sync server configurations:', error.message);
      throw error;
    }
  }

  /**
   * Monitor remote nodes and collect metrics
   */
  async collectNodeMetrics(nodeIds) {
    const metrics = [];

    for (const nodeId of nodeIds) {
      try {
        const status = await this.getRemoteNodeStatus(nodeId);

        metrics.push({
          node_id: nodeId,
          collected_at: new Date().toISOString(),
          system_load: status.system_stats?.cpu || 0,
          memory_usage: status.system_stats?.memory || 0,
          active_servers: status.servers?.filter(s => s.status === 'running').length || 0,
          total_servers: status.servers?.length || 0,
          network_status: status.network_status,
          success: true
        });

      } catch (error) {
        console.error(`[REMOTE] Failed to collect metrics for node ${nodeId}:`, error.message);
        metrics.push({
          node_id: nodeId,
          collected_at: new Date().toISOString(),
          error: error.message,
          success: false
        });
      }
    }

    return {
      collected_at: new Date().toISOString(),
      nodes_monitored: nodeIds.length,
      successful_collections: metrics.filter(m => m.success).length,
      metrics: metrics
    };
  }
}

module.exports = { RemoteNodeManager };
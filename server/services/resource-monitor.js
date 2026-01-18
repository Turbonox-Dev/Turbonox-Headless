const { getDatabase } = require('../lib/database');
const axios = require('axios');

class ResourceMonitorService {
  constructor() {
    this.monitoringInterval = null;
    const low = String(process.env.TURBONOX_LOW_FOOTPRINT || '').toLowerCase();
    const lowFootprint = low === '1' || low === 'true';
    this.collectionInterval = lowFootprint ? 60000 : 30000;
    this.retentionDays = lowFootprint ? 2 : 7;
    this.maxDataPoints = lowFootprint ? 200 : 1000;
  }

  async startMonitoring() {
    console.log('[RESOURCE_MONITOR] Starting comprehensive resource monitoring');

    await this.collectAllNodeResources();

    this.monitoringInterval = setInterval(async () => {
      try {
        await this.collectAllNodeResources();
        await this.cleanupOldData();
      } catch (error) {
        console.error('[RESOURCE_MONITOR] Periodic collection failed:', error.message);
      }
    }, this.collectionInterval);

    return this.monitoringInterval;
  }

  stopMonitoring() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
      console.log('[RESOURCE_MONITOR] Stopped resource monitoring');
    }
  }

  async collectAllNodeResources() {
    const db = getDatabase();

    try {

      const nodes = await new Promise((resolve, reject) => {
        db.all('SELECT * FROM nodes WHERE status = ?', ['online'], (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });

      if (nodes.length === 0) {
        return { collected: 0, message: 'No online nodes to monitor' };
      }

      console.log(`[RESOURCE_MONITOR] Collecting resources from ${nodes.length} nodes`);

      const results = [];

      for (const node of nodes) {
        try {
          const resources = await this.collectNodeResources(node);
          if (resources) {
            await this.storeResourceData(node.id, resources);
            results.push({
              node_id: node.id,
              node_name: node.name,
              success: true,
              metrics_collected: Object.keys(resources).length
            });
          }
        } catch (error) {
          console.error(`[RESOURCE_MONITOR] Failed to collect from node ${node.name}:`, error.message);
          results.push({
            node_id: node.id,
            node_name: node.name,
            success: false,
            error: error.message
          });
        }
      }

      return {
        collected: results.filter(r => r.success).length,
        total_nodes: nodes.length,
        results: results
      };

    } catch (error) {
      console.error('[RESOURCE_MONITOR] Failed to collect all node resources:', error.message);
      throw error;
    }
  }

  async collectNodeResources(node) {
    try {
      const systemUrl = `http://${node.ip_address}:${node.port || 3001}/api/system/stats`;
      const response = await axios.get(systemUrl, {
        timeout: 10000,
        headers: { 'User-Agent': 'Turbonox-ResourceMonitor/1.0' }
      });

      const systemStats = response.data;

      const enhancedStats = {
        ...systemStats,
        timestamp: new Date().toISOString(),
        node_id: node.id,

        cpu: {
          usage: systemStats.cpu || 0,
          cores: systemStats.cpuCount || 1,
          load_average: systemStats.loadavg || [0, 0, 0],
          model: systemStats.cpuModel || 'Unknown'
        },

        memory: {
          total: systemStats.totalmem || 0,
          free: systemStats.freemem || 0,
          used: (systemStats.totalmem || 0) - (systemStats.freemem || 0),
          usage_percent: systemStats.totalmem ?
            (((systemStats.totalmem - systemStats.freemem) / systemStats.totalmem) * 100) : 0,
          swap_total: systemStats.swapTotal || 0,
          swap_free: systemStats.swapFree || 0,
          swap_used: (systemStats.swapTotal || 0) - (systemStats.swapFree || 0)
        },

        disk: systemStats.fsSize ? systemStats.fsSize.map(fs => ({
          filesystem: fs.fs,
          mount: fs.mount,
          type: fs.type,
          size: fs.size,
          used: fs.used,
          available: fs.available,
          usage_percent: fs.use || 0
        })) : [],

        network: systemStats.networkInterfaces ? Object.entries(systemStats.networkInterfaces)
          .filter(([name, interfaces]) => !name.includes('lo') && interfaces && interfaces.length > 0)
          .map(([name, interfaces]) => ({
            interface: name,
            addresses: interfaces.filter(iface => iface.family === 'IPv4').map(iface => iface.address)
          })) : [],

        system: {
          platform: systemStats.platform || 'unknown',
          distro: systemStats.distro || 'unknown',
          release: systemStats.release || 'unknown',
          arch: systemStats.arch || 'unknown',
          hostname: systemStats.hostname || 'unknown',
          uptime: systemStats.uptime || 0
        },

        processes: systemStats.processes || [],

        temperature: systemStats.temperature || {}
      };

      return enhancedStats;

    } catch (error) {
      console.error(`[RESOURCE_MONITOR] Failed to collect resources from node ${node.ip_address}:`, error.message);
      throw error;
    }
  }

  async storeResourceData(nodeId, resourceData) {
    const db = getDatabase();

    try {

      await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO node_resources (
            node_id, timestamp, cpu_usage, cpu_cores, memory_total, memory_used, memory_free,
            disk_usage, network_interfaces, system_info, raw_data
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            nodeId,
            resourceData.timestamp,
            resourceData.cpu.usage,
            resourceData.cpu.cores,
            resourceData.memory.total,
            resourceData.memory.used,
            resourceData.memory.free,
            JSON.stringify(resourceData.disk),
            JSON.stringify(resourceData.network),
            JSON.stringify(resourceData.system),
            JSON.stringify(resourceData)
          ],
          function(err) {
            if (err) reject(err);
            else resolve(this.lastID);
          }
        );
      });

      await new Promise((resolve, reject) => {
        db.run(
          'UPDATE nodes SET resources = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [JSON.stringify(resourceData), nodeId],
          (err) => {
            if (err) reject(err);
          }
        );
      });

    } catch (error) {
      console.error(`[RESOURCE_MONITOR] Failed to store resource data for node ${nodeId}:`, error.message);
      throw error;
    }
  }

  async getResourceHistory(nodeId, hours = 24, metrics = ['cpu', 'memory', 'disk']) {
    const db = getDatabase();

    try {
      const cutoffTime = new Date(Date.now() - (hours * 60 * 60 * 1000)).toISOString();

      const history = await new Promise((resolve, reject) => {
        db.all(
          `SELECT timestamp, cpu_usage, memory_total, memory_used, memory_free, disk_usage, raw_data
           FROM node_resources
           WHERE node_id = ? AND timestamp >= ?
           ORDER BY timestamp ASC`,
          [nodeId, cutoffTime],
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
          }
        );
      });

      const processedData = history.map(row => {
        const rawData = JSON.parse(row.raw_data || '{}');
        return {
          timestamp: row.timestamp,
          cpu: {
            usage: row.cpu_usage || 0,
            cores: rawData.cpu?.cores || 1
          },
          memory: {
            total: row.memory_total || 0,
            used: row.memory_used || 0,
            free: row.memory_free || 0,
            usage_percent: row.memory_total ?
              ((row.memory_used / row.memory_total) * 100) : 0
          },
          disk: row.disk_usage ? JSON.parse(row.disk_usage) : [],
          raw: rawData
        };
      });

      return {
        node_id: nodeId,
        hours: hours,
        data_points: processedData.length,
        history: processedData
      };

    } catch (error) {
      console.error(`[RESOURCE_MONITOR] Failed to get resource history for node ${nodeId}:`, error.message);
      throw error;
    }
  }

  async getCurrentResourceStatus() {
    const db = getDatabase();

    try {
      const nodes = await new Promise((resolve, reject) => {
        db.all(
          `SELECT n.*, nr.timestamp as last_update, nr.cpu_usage, nr.memory_total, nr.memory_used,
                  nr.memory_free, nr.disk_usage, nr.raw_data
           FROM nodes n
           LEFT JOIN node_resources nr ON n.id = nr.node_id
           WHERE nr.timestamp = (
             SELECT MAX(timestamp) FROM node_resources WHERE node_id = n.id
           ) OR nr.timestamp IS NULL
           ORDER BY n.created_at`,
          [],
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
          }
        );
      });

      const status = nodes.map(node => {
        let resources = null;
        if (node.raw_data) {
          try {
            resources = JSON.parse(node.raw_data);
          } catch (e) {
            console.warn(`[RESOURCE_MONITOR] Failed to parse resource data for node ${node.id}`);
          }
        }

        return {
          node: {
            id: node.id,
            name: node.name,
            ip_address: node.ip_address,
            status: node.status
          },
          resources: resources,
          last_update: node.last_update,
          alerts: this.generateResourceAlerts(resources)
        };
      });

      return {
        timestamp: new Date().toISOString(),
        nodes: status,
        summary: this.generateResourceSummary(status)
      };

    } catch (error) {
      console.error('[RESOURCE_MONITOR] Failed to get current resource status:', error.message);
      throw error;
    }
  }

  generateResourceAlerts(resources) {
    const alerts = [];

    if (!resources) return alerts;

    if (resources.cpu?.usage > 90) {
      alerts.push({
        type: 'critical',
        metric: 'cpu',
        message: `CPU usage is critically high: ${resources.cpu.usage.toFixed(1)}%`,
        value: resources.cpu.usage
      });
    } else if (resources.cpu?.usage > 75) {
      alerts.push({
        type: 'warning',
        metric: 'cpu',
        message: `CPU usage is high: ${resources.cpu.usage.toFixed(1)}%`,
        value: resources.cpu.usage
      });
    }

    if (resources.memory?.usage_percent > 90) {
      alerts.push({
        type: 'critical',
        metric: 'memory',
        message: `Memory usage is critically high: ${resources.memory.usage_percent.toFixed(1)}%`,
        value: resources.memory.usage_percent
      });
    } else if (resources.memory?.usage_percent > 80) {
      alerts.push({
        type: 'warning',
        metric: 'memory',
        message: `Memory usage is high: ${resources.memory.usage_percent.toFixed(1)}%`,
        value: resources.memory.usage_percent
      });
    }

    if (resources.disk && Array.isArray(resources.disk)) {
      resources.disk.forEach((disk, index) => {
        if (disk.usage_percent > 95) {
          alerts.push({
            type: 'critical',
            metric: 'disk',
            message: `Disk ${disk.mount} is critically full: ${disk.usage_percent.toFixed(1)}%`,
            value: disk.usage_percent,
            mount: disk.mount
          });
        } else if (disk.usage_percent > 85) {
          alerts.push({
            type: 'warning',
            metric: 'disk',
            message: `Disk ${disk.mount} is almost full: ${disk.usage_percent.toFixed(1)}%`,
            value: disk.usage_percent,
            mount: disk.mount
          });
        }
      });
    }

    return alerts;
  }

  generateResourceSummary(nodeStatuses) {
    const summary = {
      total_nodes: nodeStatuses.length,
      online_nodes: nodeStatuses.filter(n => n.node.status === 'online').length,
      offline_nodes: nodeStatuses.filter(n => n.node.status === 'offline').length,
      alerts: {
        critical: 0,
        warning: 0,
        total: 0
      },
      averages: {
        cpu_usage: 0,
        memory_usage: 0
      }
    };

    let totalCpu = 0;
    let totalMemory = 0;
    let nodesWithData = 0;

    nodeStatuses.forEach(status => {

      status.alerts.forEach(alert => {
        if (alert.type === 'critical') summary.alerts.critical++;
        else if (alert.type === 'warning') summary.alerts.warning++;
        summary.alerts.total++;
      });

      if (status.resources) {
        if (status.resources.cpu?.usage !== undefined) {
          totalCpu += status.resources.cpu.usage;
        }
        if (status.resources.memory?.usage_percent !== undefined) {
          totalMemory += status.resources.memory.usage_percent;
        }
        nodesWithData++;
      }
    });

    if (nodesWithData > 0) {
      summary.averages.cpu_usage = totalCpu / nodesWithData;
      summary.averages.memory_usage = totalMemory / nodesWithData;
    }

    return summary;
  }

  async cleanupOldData() {
    const db = getDatabase();

    try {
      const cutoffDate = new Date(Date.now() - (this.retentionDays * 24 * 60 * 60 * 1000)).toISOString();

      const deleted = await new Promise((resolve, reject) => {
        db.run(
          'DELETE FROM node_resources WHERE timestamp < ?',
          [cutoffDate],
          function(err) {
            if (err) reject(err);
            else resolve(this.changes);
          }
        );
      });

      if (deleted > 0) {
        console.log(`[RESOURCE_MONITOR] Cleaned up ${deleted} old resource data points`);
      }

    } catch (error) {
      console.error('[RESOURCE_MONITOR] Failed to cleanup old data:', error.message);
    }
  }

  async getResourceReport(timeRange = '24h') {
    const hours = timeRange === '24h' ? 24 : timeRange === '7d' ? 168 : 1;

    try {
      const currentStatus = await this.getCurrentResourceStatus();
      const reports = [];

      for (const nodeStatus of currentStatus.nodes) {
        if (nodeStatus.node.status === 'online') {
          try {
            const history = await this.getResourceHistory(nodeStatus.node.id, hours);
            reports.push({
              node: nodeStatus.node,
              current: nodeStatus.resources,
              history: history.history,
              alerts: nodeStatus.alerts,
              utilization_trends: this.calculateUtilizationTrends(history.history)
            });
          } catch (error) {
            console.warn(`[RESOURCE_MONITOR] Could not get history for node ${nodeStatus.node.id}:`, error.message);
            reports.push({
              node: nodeStatus.node,
              current: nodeStatus.resources,
              history: [],
              alerts: nodeStatus.alerts,
              error: 'Could not retrieve historical data'
            });
          }
        }
      }

      return {
        generated_at: new Date().toISOString(),
        time_range: timeRange,
        summary: currentStatus.summary,
        node_reports: reports
      };

    } catch (error) {
      console.error('[RESOURCE_MONITOR] Failed to generate resource report:', error.message);
      throw error;
    }
  }

  calculateUtilizationTrends(history) {
    if (history.length < 2) {
      return { trend: 'insufficient_data' };
    }

    const recent = history.slice(-10); 

    const older = history.slice(-20, -10); 

    const avgRecentCpu = recent.reduce((sum, h) => sum + (h.cpu?.usage || 0), 0) / recent.length;
    const avgOlderCpu = older.length > 0 ? older.reduce((sum, h) => sum + (h.cpu?.usage || 0), 0) / older.length : avgRecentCpu;

    const avgRecentMemory = recent.reduce((sum, h) => sum + (h.memory?.usage_percent || 0), 0) / recent.length;
    const avgOlderMemory = older.length > 0 ? older.reduce((sum, h) => sum + (h.memory?.usage_percent || 0), 0) / older.length : avgRecentMemory;

    const cpuTrend = avgRecentCpu > avgOlderCpu ? 'increasing' : avgRecentCpu < avgOlderCpu ? 'decreasing' : 'stable';
    const memoryTrend = avgRecentMemory > avgOlderMemory ? 'increasing' : avgRecentMemory < avgOlderMemory ? 'decreasing' : 'stable';

    return {
      cpu: {
        current_average: avgRecentCpu,
        previous_average: avgOlderCpu,
        trend: cpuTrend,
        change_percent: avgOlderCpu !== 0 ? ((avgRecentCpu - avgOlderCpu) / avgOlderCpu) * 100 : 0
      },
      memory: {
        current_average: avgRecentMemory,
        previous_average: avgOlderMemory,
        trend: memoryTrend,
        change_percent: avgOlderMemory !== 0 ? ((avgRecentMemory - avgOlderMemory) / avgOlderMemory) * 100 : 0
      }
    };
  }
}

module.exports = { ResourceMonitorService };

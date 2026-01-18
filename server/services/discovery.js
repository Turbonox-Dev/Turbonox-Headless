const axios = require('axios');
const os = require('os');
const { getDatabase } = require('../lib/database');

class NodeDiscoveryService {
  constructor() {
    this.discoveryPort = 3001;
    this.discoveryTimeout = 2000; 

    this.scanRange = 10; 

  }

  getLocalNetworks() {
    const interfaces = os.networkInterfaces();
    const networks = [];

    for (const [name, addresses] of Object.entries(interfaces)) {
      for (const addr of addresses) {
        if (addr.family === 'IPv4' && !addr.internal) {
          networks.push({
            interface: name,
            ip: addr.address,
            netmask: addr.netmask
          });
        }
      }
    }

    return networks;
  }

  calculateNetworkRange(ip, netmask) {
    const ipParts = ip.split('.').map(Number);
    const maskParts = netmask.split('.').map(Number);

    const network = ipParts.map((part, i) => part & maskParts[i]);
    const broadcast = ipParts.map((part, i) => (part & maskParts[i]) | (~maskParts[i] & 255));

    return { network, broadcast };
  }

  generateScanIPs(baseIP, range = this.scanRange) {
    const parts = baseIP.split('.').map(Number);
    const ips = [];

    for (let i = -range; i <= range; i++) {
      for (let j = -range; j <= range; j++) {
        const newParts = [...parts];
        newParts[2] = Math.max(0, Math.min(255, parts[2] + i));
        newParts[3] = Math.max(1, Math.min(254, parts[3] + j)); 

        if (newParts[2] !== parts[2] || newParts[3] !== parts[3]) {
          ips.push(newParts.join('.'));
        }
      }
    }

    return [...new Set(ips)]; 

  }

  async testNode(ip, port = this.discoveryPort) {
    try {
      const url = `http://${ip}:${port}/api/health`;
      const response = await axios.get(url, {
        timeout: this.discoveryTimeout,
        headers: {
          'User-Agent': 'Turbonox-Discovery/1.0'
        }
      });

      if (response.data && response.data.status === 'ok') {
        return {
          ip,
          port,
          status: 'online',
          discovered_at: new Date().toISOString(),
          metadata: response.data
        };
      }
    } catch (error) {

    }

    return null;
  }

  async discoverNodes() {
    const discoveredNodes = [];
    const networks = this.getLocalNetworks();

    console.log('[DISCOVERY] Starting node discovery on networks:', networks.map(n => n.ip));

    for (const network of networks) {
      const scanIPs = this.generateScanIPs(network.ip);

      console.log(`[DISCOVERY] Scanning ${scanIPs.length} IPs around ${network.ip}`);

      const batchSize = 10;
      for (let i = 0; i < scanIPs.length; i += batchSize) {
        const batch = scanIPs.slice(i, i + batchSize);
        const promises = batch.map(ip => this.testNode(ip));

        try {
          const results = await Promise.all(promises);
          const validNodes = results.filter(node => node !== null);
          discoveredNodes.push(...validNodes);

          if (validNodes.length > 0) {
            console.log(`[DISCOVERY] Found ${validNodes.length} nodes in batch:`, validNodes.map(n => n.ip));
          }
        } catch (error) {
          console.warn('[DISCOVERY] Error in batch scan:', error.message);
        }

        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    console.log(`[DISCOVERY] Discovery complete. Found ${discoveredNodes.length} nodes.`);
    return discoveredNodes;
  }

  async registerDiscoveredNodes(discoveredNodes) {
    const db = getDatabase();
    const registeredCount = 0;

    for (const node of discoveredNodes) {
      try {

        const existingNode = await new Promise((resolve, reject) => {
          db.get('SELECT id FROM nodes WHERE ip_address = ?', [node.ip], (err, row) => {
            if (err) reject(err);
            else resolve(row);
          });
        });

        if (!existingNode) {

          const nodeName = `Discovered Node (${node.ip})`;
          await new Promise((resolve, reject) => {
            db.run(
              'INSERT INTO nodes (name, ip_address, port, status, last_seen) VALUES (?, ?, ?, ?, ?)',
              [nodeName, node.ip, node.port, 'online', node.discovered_at],
              function(err) {
                if (err) reject(err);
                else resolve(this.lastID);
              }
            );
          });

          console.log(`[DISCOVERY] Registered new node: ${nodeName} at ${node.ip}:${node.port}`);
          registeredCount++;
        } else {

          await new Promise((resolve, reject) => {
            db.run(
              'UPDATE nodes SET status = ?, last_seen = ?, port = ? WHERE ip_address = ?',
              ['online', node.discovered_at, node.port, node.ip],
              (err) => {
                if (err) reject(err);
              }
            );
          });
        }
      } catch (error) {
        console.error(`[DISCOVERY] Failed to register node ${node.ip}:`, error.message);
      }
    }

    return registeredCount;
  }

  async updateNodeStatuses() {
    const db = getDatabase();
    const offlineThreshold = 5 * 60 * 1000; 

    const thresholdDate = new Date(Date.now() - offlineThreshold).toISOString();

    try {
      await new Promise((resolve, reject) => {
        db.run(
          'UPDATE nodes SET status = ? WHERE status = ? AND last_seen < ?',
          ['offline', 'online', thresholdDate],
          function(err) {
            if (err) reject(err);
            else {
              console.log(`[DISCOVERY] Marked ${this.changes} nodes as offline`);
              resolve(this.changes);
            }
          }
        );
      });
    } catch (error) {
      console.error('[DISCOVERY] Failed to update node statuses:', error.message);
    }
  }

  async performDiscoveryCycle() {
    try {
      console.log('[DISCOVERY] Starting discovery cycle...');

      const discoveredNodes = await this.discoverNodes();

      const registeredCount = await this.registerDiscoveredNodes(discoveredNodes);

      await this.updateNodeStatuses();

      console.log(`[DISCOVERY] Discovery cycle complete. Registered ${registeredCount} new nodes.`);

      return {
        discovered: discoveredNodes.length,
        registered: registeredCount
      };
    } catch (error) {
      console.error('[DISCOVERY] Discovery cycle failed:', error.message);
      throw error;
    }
  }

  startPeriodicDiscovery(intervalMinutes = 5) {
    const intervalMs = intervalMinutes * 60 * 1000;

    console.log(`[DISCOVERY] Starting periodic discovery every ${intervalMinutes} minutes`);

    this.performDiscoveryCycle().catch(error => {
      console.error('[DISCOVERY] Initial discovery failed:', error.message);
    });

    this.discoveryInterval = setInterval(() => {
      this.performDiscoveryCycle().catch(error => {
        console.error('[DISCOVERY] Periodic discovery failed:', error.message);
      });
    }, intervalMs);

    return this.discoveryInterval;
  }

  stopPeriodicDiscovery() {
    if (this.discoveryInterval) {
      clearInterval(this.discoveryInterval);
      this.discoveryInterval = null;
      console.log('[DISCOVERY] Stopped periodic discovery');
    }
  }
}

module.exports = { NodeDiscoveryService };
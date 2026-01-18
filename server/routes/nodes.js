const express = require('express');
const router = express.Router();
const { getDatabase } = require('../lib/database');
const { restrictionMiddleware } = require('../utils/restrictions');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { NodeDiscoveryService } = require('../services/discovery');
const { NodeHealthMonitor } = require('../services/health-monitor');
const { NodeSynchronizationService } = require('../services/synchronization');
const { LoadBalancerService } = require('../services/load-balancer');
const { FailoverService } = require('../services/failover');
const { RemoteNodeManager } = require('../services/remote-management');
const { ResourceMonitorService } = require('../services/resource-monitor');

function safeJsonParse(value, fallback) {
  try {
    if (value === undefined || value === null || value === '') return fallback;
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function getRequestIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const ip = (raw || req.ip || req.connection?.remoteAddress || '').toString();
  return ip.replace(/^::ffff:/, '').replace(/^::1$/, '127.0.0.1');
}

// Get all nodes
router.get('/', (req, res) => {
  try {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM nodes ORDER BY created_at DESC');
    const rows = stmt.all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bootstrap script endpoints (Mode B)
router.get('/bootstrap/linux', (req, res) => {
  try {
    const scriptPath = path.join(process.cwd(), 'scripts', 'bootstrap-node-agent.sh');
    const content = fs.readFileSync(scriptPath, 'utf8');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(content);
  } catch {
    res.status(500).send('Failed to load bootstrap script');
  }
});

// Set active node context
router.post('/active', (req, res) => {
  const { nodeId } = req.body;
  if (!nodeId) return res.status(400).json({ error: 'nodeId is required' });

  try {
    const db = getDatabase();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('activeNodeId', ?)").run(String(nodeId));
    res.json({ ok: true, activeNodeId: nodeId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get active node context
router.get('/active', (req, res) => {
  try {
    const db = getDatabase();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'activeNodeId'").get();
    res.json({ activeNodeId: row?.value || 'local' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/bootstrap/windows', (req, res) => {
  try {
    const scriptPath = path.join(process.cwd(), 'scripts', 'bootstrap-node-agent.ps1');
    const content = fs.readFileSync(scriptPath, 'utf8');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(content);
  } catch {
    res.status(500).send('Failed to load bootstrap script');
  }
});

router.get('/bootstrap/agent.js', (req, res) => {
  try {
    const scriptPath = path.join(process.cwd(), 'scripts', 'node-agent.js');
    const content = fs.readFileSync(scriptPath, 'utf8');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(content);
  } catch {
    res.status(500).send('Failed to load node agent');
  }
});

// Test connection to a node agent endpoint (used by UI)
router.post('/test-connection', async (req, res) => {
  const { ipAddress, port = 3001, connectionType = 'http' } = req.body || {};

  if (!ipAddress) {
    return res.status(400).json({ error: 'ipAddress is required' });
  }

  if (connectionType === 'ssh') {
    const { sshUser, sshPassword, sshKey, sshPort = 22, trustHost = false } = req.body;
    try {
      const { SshService } = require('../services/SshService');
      const start = Date.now();
      // We pass a dummy node object to SshService
      const dummyNode = {
        id: 'test-temp',
        ip_address: ipAddress,
        ssh_user: sshUser,
        ssh_password: sshPassword,
        ssh_key: sshKey,
        ssh_port: sshPort,
        host_key: req.body.hostKey // If the UI already has one and wants to re-verify
      };

      await SshService.getConnection(dummyNode, { trustHost, forceNew: true });
      const latency_ms = Date.now() - start;

      return res.json({ ok: true, latency_ms });
    } catch (error) {
      if (error.code === 'SSH_HOST_KEY_UNVERIFIED') {
        return res.json({
          ok: false,
          error: 'SSH_HOST_KEY_UNVERIFIED',
          fingerprint: error.fingerprint,
          message: error.message
        });
      }
      return res.json({ ok: false, error: error.message });
    }
  }

  const targetPort = Number(port) || 3001;
  const url = `http://${ipAddress}:${targetPort}/api/health`;

  try {
    const start = Date.now();
    const response = await axios.get(url, { timeout: 8000 });
    const latency_ms = Date.now() - start;
    res.json({ ok: true, url, latency_ms, health: response.data });
  } catch (error) {
    res.status(200).json({
      ok: false,
      url,
      error: error?.response?.data?.error || error.message,
    });
  }
});

// Generate a short-lived join code for bootstrapping a VPS node agent
router.post('/join-code', restrictionMiddleware('manage_nodes'), (req, res) => {
  const db = getDatabase();
  const ttlMs = 15 * 60 * 1000;
  const now = Date.now();
  const code = crypto.randomBytes(16).toString('hex');

  try {
    const existing = db.prepare("SELECT value FROM settings WHERE key = 'nodeJoinCodes'").get();
    const map = safeJsonParse(existing?.value, {});
    for (const [k, v] of Object.entries(map)) {
      if (!v || typeof v !== 'object') {
        delete map[k];
        continue;
      }
      if (!v.created_at || now - Number(v.created_at) > ttlMs) delete map[k];
    }
    map[code] = { created_at: now, ttl_ms: ttlMs };

    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('nodeJoinCodes', ?)")
      .run(JSON.stringify(map));

    res.json({ join_code: code, expires_in_ms: ttlMs });
  } catch (error) {
    console.error('[NODE] Failed to generate join code:', error);
    res.status(500).json({ error: 'Failed to generate join code' });
  }
});

// Enrollment endpoint used by node-agent bootstrap scripts
router.post('/enroll', async (req, res) => {
  const db = getDatabase();
  const ttlMs = 15 * 60 * 1000;
  const now = Date.now();
  const joinCode = String(req.body?.join_code || '').trim();
  const node = req.body?.node || {};
  const nodeName = String(node?.name || '').trim();
  const nodePort = Number(node?.port) || 3001;
  const nodeCaps = node?.capabilities ?? null;
  const nodeAuth = String(node?.auth_token || '').trim() || null;
  const ipAddress = String(node?.ip_address || getRequestIp(req)).trim();

  if (!joinCode) return res.status(400).json({ error: 'join_code is required' });
  if (!nodeName) return res.status(400).json({ error: 'node.name is required' });

  try {
    const existing = db.prepare("SELECT value FROM settings WHERE key = 'nodeJoinCodes'").get();
    const map = safeJsonParse(existing?.value, {});
    const entry = map[joinCode];
    if (!entry || !entry.created_at || now - Number(entry.created_at) > ttlMs) {
      return res.status(403).json({ error: 'Invalid or expired join code' });
    }

    delete map[joinCode];
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('nodeJoinCodes', ?)")
      .run(JSON.stringify(map));

    const existingNode = db.prepare('SELECT * FROM nodes WHERE ip_address = ?').get(ipAddress);

    if (existingNode) {
      db.prepare(
        'UPDATE nodes SET name = ?, port = ?, status = ?, last_seen = ?, capabilities = ?, auth_token = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(
        nodeName,
        nodePort,
        'online',
        new Date().toISOString(),
        nodeCaps ? JSON.stringify(nodeCaps) : existingNode.capabilities,
        nodeAuth,
        existingNode.id
      );

      return res.json({
        ok: true,
        message: 'Node updated via enrollment',
        node_id: existingNode.id,
        ip_address: ipAddress,
        port: nodePort,
      });
    }

    const stmt = db.prepare(
      'INSERT INTO nodes (name, ip_address, port, status, last_seen, capabilities, auth_token) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const result = stmt.run(
      nodeName,
      ipAddress,
      nodePort,
      'online',
      new Date().toISOString(),
      nodeCaps ? JSON.stringify(nodeCaps) : null,
      nodeAuth
    );

    res.json({
      ok: true,
      message: 'Node enrolled successfully',
      node_id: result.lastID,
      ip_address: ipAddress,
      port: nodePort,
    });
  } catch (error) {
    console.error('[NODE] Enrollment failed:', error);
    res.status(500).json({ error: error.message || 'Enrollment failed' });
  }
});

// Get single node
router.get('/:id(\\d+)', (req, res) => {
  try {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM nodes WHERE id = ?');
    const row = stmt.get(req.params.id);
    if (!row) {
      return res.status(404).json({ error: 'Node not found' });
    }
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Register new node
router.post('/', restrictionMiddleware('manage_nodes'), async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const ipAddress = String(req.body?.ipAddress || '').trim();
  const port = Number(req.body?.port) || 3001;
  const connectionType = req.body?.connectionType || 'http';
  const authToken = String(req.body?.auth_token || '').trim() || null;

  // SSH fields
  const sshUser = req.body?.sshUser || null;
  const sshPassword = req.body?.sshPassword || null;
  const sshKey = req.body?.sshKey || null;
  const sshPort = req.body?.sshPort || 22;

  if (!name || !ipAddress) {
    return res.status(400).json({ error: 'Name and IP address are required' });
  }

  // Validate IP address format (loosened to allow hostnames)
  const hostRegex = /^(?:[a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+\.[a-zA-Z]{2,}|(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$|localhost$/;
  if (!hostRegex.test(ipAddress)) {
    return res.status(400).json({ error: 'Invalid IP address or hostname format' });
  }

  const db = getDatabase();

  try {
    // Check if node with this IP already exists
    const existingNode = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM nodes WHERE ip_address = ?', [ipAddress], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (existingNode) {
      return res.status(409).json({ error: 'Node with this IP address already exists' });
    }

    // Test connectivity to the node
    let status = 'online';
    try {
      if (connectionType === 'ssh') {
        const { SshService } = require('../services/SshService');
        await SshService.getConnection({
          id: 'temp-reg',
          ip_address: ipAddress,
          ssh_user: sshUser,
          ssh_password: sshPassword,
          ssh_key: sshKey,
          ssh_port: sshPort,
          host_key: req.body.hostKey
        }, { forceNew: true });
      } else {
        const testUrl = `http://${ipAddress}:${port}/api/health`;
        await axios.get(testUrl, { timeout: 5000 });
      }
    } catch (connectError) {
      console.warn(`[NODE] Could not connect to node during registration:`, connectError.message);
      status = 'offline';
    }

    const stmt = db.prepare(`
      INSERT INTO nodes (name, ip_address, port, status, last_seen, auth_token, connection_type, ssh_user, ssh_password, ssh_key, ssh_port, host_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      name.trim(),
      ipAddress,
      Number(port) || 3001,
      status,
      new Date().toISOString(),
      authToken,
      connectionType,
      sshUser,
      sshPassword,
      sshKey,
      sshPort,
      req.body.hostKey || null
    );

    res.json({
      id: result.lastID,
      message: 'Node registered successfully',
      node: {
        id: result.lastID,
        name: name.trim(),
        ip_address: ipAddress,
        port: Number(port) || 3001,
        status: 'online',
        last_seen: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('[NODE] Failed to register node:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update node
router.put('/:id(\\d+)', async (req, res) => {
  const { name, ipAddress, port = 3001 } = req.body;
  const nodeId = req.params.id;

  const db = getDatabase();

  try {
    // Check if node exists
    const existingNode = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM nodes WHERE id = ?', [nodeId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!existingNode) {
      return res.status(404).json({ error: 'Node not found' });
    }

    // Validate IP if provided
    if (ipAddress) {
      const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
      if (!ipRegex.test(ipAddress)) {
        return res.status(400).json({ error: 'Invalid IP address format' });
      }
    }

    // Test connectivity if IP changed
    let newStatus = existingNode.status;
    const desiredIp = ipAddress ?? existingNode.ip_address;
    const desiredPort = Number(port) || Number(existingNode.port) || 3001;
    if ((ipAddress && ipAddress !== existingNode.ip_address) || (port && Number(port) !== Number(existingNode.port))) {
      try {
        const testUrl = `http://${desiredIp}:${desiredPort}/api/health`;
        await axios.get(testUrl, { timeout: 5000 });
        newStatus = 'online';
      } catch (connectError) {
        console.warn(`[NODE] Could not connect to updated node at ${ipAddress}:${port}:`, connectError.message);
        newStatus = 'offline';
      }
    }

    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE nodes SET
          name = ?,
          ip_address = ?,
          port = ?,
          status = ?,
          last_seen = ?
        WHERE id = ?`,
        [
          name?.trim() ?? existingNode.name,
          ipAddress ?? existingNode.ip_address,
          desiredPort,
          newStatus,
          new Date().toISOString(),
          nodeId
        ],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    res.json({ message: 'Node updated successfully' });
  } catch (error) {
    console.error('[NODE] Failed to update node:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete node
router.delete('/:id(\\d+)', (req, res) => {
  const nodeId = req.params.id;
  const db = getDatabase();

  // Check if node has any servers assigned
  db.get('SELECT COUNT(*) as serverCount FROM servers WHERE node_id = ?', [nodeId], (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    if (row.serverCount > 0) {
      return res.status(400).json({
        error: 'Cannot delete node with assigned servers. Please reassign or delete servers first.'
      });
    }

    db.run('DELETE FROM nodes WHERE id = ?', [nodeId], (err) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ message: 'Node deleted successfully' });
    });
  });
});

// Get node health status
router.get('/:id(\\d+)/health', async (req, res) => {
  const nodeId = req.params.id;
  const db = getDatabase();

  try {
    const node = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM nodes WHERE id = ?', [nodeId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!node) {
      return res.status(404).json({ error: 'Node not found' });
    }

    try {
      const healthUrl = `http://${node.ip_address}:${node.port || 3001}/api/health`;
      const response = await axios.get(healthUrl, { timeout: 5000 });

      // Update node status in database
      db.run(
        'UPDATE nodes SET status = ?, last_seen = ? WHERE id = ?',
        ['online', new Date().toISOString(), nodeId]
      );

      res.json({
        status: 'online',
        details: response.data,
        last_seen: new Date().toISOString()
      });
    } catch (connectError) {
      // Update node status to offline
      db.run(
        'UPDATE nodes SET status = ?, last_seen = ? WHERE id = ?',
        ['offline', new Date().toISOString(), nodeId]
      );

      res.json({
        status: 'offline',
        error: connectError.message,
        last_seen: node.last_seen
      });
    }
  } catch (error) {
    console.error('[NODE] Failed to check node health:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get node resource stats
router.get('/:id(\\d+)/stats', async (req, res) => {
  const nodeId = req.params.id;
  const db = getDatabase();

  try {
    const node = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM nodes WHERE id = ?', [nodeId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!node) {
      return res.status(404).json({ error: 'Node not found' });
    }

    try {
      const statsUrl = `http://${node.ip_address}:${node.port || 3001}/api/system/stats`;
      const response = await axios.get(statsUrl, { timeout: 5000 });

      res.json({
        node_id: nodeId,
        node_name: node.name,
        stats: response.data,
        fetched_at: new Date().toISOString()
      });
    } catch (connectError) {
      res.status(503).json({
        error: 'Node is offline or unreachable',
        details: connectError.message
      });
    }
  } catch (error) {
    console.error('[NODE] Failed to get node stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get servers on a specific node
router.get('/:id(\\d+)/servers', (req, res) => {
  const nodeId = req.params.id;
  const db = getDatabase();

  db.all('SELECT * FROM servers WHERE node_id = ? ORDER BY created_at DESC', [nodeId], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// Discover nodes on the network
router.post('/discover', restrictionMiddleware('manage_nodes'), async (req, res) => {
  try {
    const discoveryService = new NodeDiscoveryService();
    const result = await discoveryService.performDiscoveryCycle();

    res.json({
      message: 'Node discovery completed',
      discovered: result.discovered,
      registered: result.registered
    });
  } catch (error) {
    console.error('[DISCOVERY] API discovery failed:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get network interfaces for discovery
router.get('/network/interfaces', (req, res) => {
  try {
    const interfaces = os.networkInterfaces();
    const networkInfo = [];

    for (const [name, addresses] of Object.entries(interfaces)) {
      for (const addr of addresses) {
        if (addr.family === 'IPv4' && !addr.internal) {
          networkInfo.push({
            interface: name,
            ip: addr.address,
            netmask: addr.netmask,
            mac: addr.mac
          });
        }
      }
    }

    res.json(networkInfo);
  } catch (error) {
    console.error('[NETWORK] Failed to get network interfaces:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get health summary for all nodes
router.get('/health/summary', async (req, res) => {
  try {
    const healthMonitor = new NodeHealthMonitor();
    const summary = await healthMonitor.getHealthSummary();
    res.json(summary);
  } catch (error) {
    console.error('[HEALTH] Failed to get health summary:', error);
    res.status(500).json({ error: error.message });
  }
});

// Check health of all nodes
router.post('/health/check', async (req, res) => {
  try {
    const healthMonitor = new NodeHealthMonitor();
    const result = await healthMonitor.checkAllNodesHealth();
    res.json(result);
  } catch (error) {
    console.error('[HEALTH] Failed to check all nodes health:', error);
    res.status(500).json({ error: error.message });
  }
});

// Force health check for specific node
router.post('/:id(\\d+)/health/check', async (req, res) => {
  const nodeId = req.params.id;

  try {
    const healthMonitor = new NodeHealthMonitor();
    const result = await healthMonitor.forceHealthCheck(nodeId);
    res.json(result);
  } catch (error) {
    console.error(`[HEALTH] Failed to force health check for node ${nodeId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Get synchronization status
router.get('/sync/status', async (req, res) => {
  try {
    const syncService = new NodeSynchronizationService();
    const status = await syncService.getSyncStatus();
    res.json(status);
  } catch (error) {
    console.error('[SYNC] Failed to get sync status:', error);
    res.status(500).json({ error: error.message });
  }
});

// Sync all nodes
router.post('/sync/all', restrictionMiddleware('manage_nodes'), async (req, res) => {
  try {
    const syncService = new NodeSynchronizationService();
    const result = await syncService.syncAllNodes();
    res.json(result);
  } catch (error) {
    console.error('[SYNC] Failed to sync all nodes:', error);
    res.status(500).json({ error: error.message });
  }
});

// Sync specific node
router.post('/:id(\\d+)/sync', restrictionMiddleware('manage_nodes'), async (req, res) => {
  const nodeId = req.params.id;

  try {
    const syncService = new NodeSynchronizationService();
    const serverSync = await syncService.syncServersToNode(nodeId);
    const stateSync = await syncService.syncServerStates(nodeId);

    res.json({
      node_id: nodeId,
      servers_synced: serverSync.synced,
      states_synced: stateSync.synced
    });
  } catch (error) {
    console.error(`[SYNC] Failed to sync node ${nodeId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Pull servers from remote node
router.post('/:id(\\d+)/pull', async (req, res) => {
  const nodeId = req.params.id;

  try {
    const syncService = new NodeSynchronizationService();
    const result = await syncService.pullServersFromNode(nodeId);
    res.json(result);
  } catch (error) {
    console.error(`[SYNC] Failed to pull from node ${nodeId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Rebalance servers across nodes
router.post('/rebalance', async (req, res) => {
  try {
    const syncService = new NodeSynchronizationService();
    const result = await syncService.rebalanceServers();
    res.json(result);
  } catch (error) {
    console.error('[SYNC] Failed to rebalance servers:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get load balancing analysis
router.get('/load/analysis', async (req, res) => {
  try {
    const loadBalancer = new LoadBalancerService();
    const analysis = await loadBalancer.analyzeLoadDistribution();
    res.json(analysis);
  } catch (error) {
    console.error('[LOAD_BALANCER] Failed to get load analysis:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get load balancing recommendations
router.get('/load/recommendations', async (req, res) => {
  try {
    const loadBalancer = new LoadBalancerService();
    const recommendations = await loadBalancer.getRecommendations();
    res.json(recommendations);
  } catch (error) {
    console.error('[LOAD_BALANCER] Failed to get recommendations:', error);
    res.status(500).json({ error: error.message });
  }
});

// Execute load balancing
router.post('/load/balance', async (req, res) => {
  const { strategy = 'resource_based' } = req.body;

  try {
    const loadBalancer = new LoadBalancerService();
    const result = await loadBalancer.executeLoadBalancing(strategy);
    res.json(result);
  } catch (error) {
    console.error('[LOAD_BALANCER] Failed to execute load balancing:', error);
    res.status(500).json({ error: error.message });
  }
});

// Auto-balance based on recommendations
router.post('/load/auto-balance', async (req, res) => {
  try {
    const loadBalancer = new LoadBalancerService();
    const result = await loadBalancer.autoBalance();
    res.json(result);
  } catch (error) {
    console.error('[LOAD_BALANCER] Failed to auto-balance:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get failover status
router.get('/failover/status', async (req, res) => {
  try {
    const failoverService = new FailoverService();
    const status = await failoverService.getFailoverStatus();
    res.json(status);
  } catch (error) {
    console.error('[FAILOVER] Failed to get failover status:', error);
    res.status(500).json({ error: error.message });
  }
});

// Trigger failover monitoring
router.post('/failover/check', async (req, res) => {
  try {
    const failoverService = new FailoverService();
    const result = await failoverService.monitorAndFailover();
    res.json(result);
  } catch (error) {
    console.error('[FAILOVER] Failed to check failover:', error);
    res.status(500).json({ error: error.message });
  }
});

// Recover a failed node
router.post('/:id(\\d+)/recover', async (req, res) => {
  const nodeId = req.params.id;

  try {
    const failoverService = new FailoverService();
    const result = await failoverService.recoverNode(nodeId);
    res.json(result);
  } catch (error) {
    console.error(`[FAILOVER] Failed to recover node ${nodeId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Remote node management endpoints

// Get comprehensive remote node status
router.get('/:id(\\d+)/status', async (req, res) => {
  const nodeId = req.params.id;

  try {
    const remoteManager = new RemoteNodeManager();
    const status = await remoteManager.getRemoteNodeStatus(nodeId);
    res.json(status);
  } catch (error) {
    console.error(`[REMOTE] Failed to get remote status for node ${nodeId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Execute command on remote node
router.post('/:id(\\d+)/execute', async (req, res) => {
  const nodeId = req.params.id;
  const { command, cwd } = req.body;

  if (!command) {
    return res.status(400).json({ error: 'Command is required' });
  }

  try {
    const remoteManager = new RemoteNodeManager();
    const result = await remoteManager.executeCustomCommand(nodeId, command, cwd);
    res.json(result);
  } catch (error) {
    console.error(`[REMOTE] Failed to execute command on node ${nodeId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Remote server management (explicit namespace to avoid conflicting with local DB servers routes)
router.get('/:id(\\d+)/remote/servers', async (req, res) => {
  const nodeId = req.params.id;

  try {
    const remoteManager = new RemoteNodeManager();
    const servers = await remoteManager.getRemoteServers(nodeId);
    res.json(servers);
  } catch (error) {
    console.error(`[REMOTE] Failed to get remote servers for node ${nodeId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id(\\d+)/remote/servers', async (req, res) => {
  const nodeId = req.params.id;

  try {
    const remoteManager = new RemoteNodeManager();
    const result = await remoteManager.createRemoteServer(nodeId, req.body);
    res.json(result);
  } catch (error) {
    console.error(`[REMOTE] Failed to create remote server on node ${nodeId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id(\\d+)/remote/servers/:serverId/start', async (req, res) => {
  const { id: nodeId, serverId } = req.params;

  try {
    const remoteManager = new RemoteNodeManager();
    const result = await remoteManager.startRemoteServer(nodeId, serverId);
    res.json(result);
  } catch (error) {
    console.error(`[REMOTE] Failed to start remote server ${serverId} on node ${nodeId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id(\\d+)/remote/servers/:serverId/stop', async (req, res) => {
  const { id: nodeId, serverId } = req.params;

  try {
    const remoteManager = new RemoteNodeManager();
    const result = await remoteManager.stopRemoteServer(nodeId, serverId);
    res.json(result);
  } catch (error) {
    console.error(`[REMOTE] Failed to stop remote server ${serverId} on node ${nodeId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Bulk operations
router.post('/bulk/:operation', async (req, res) => {
  const operation = req.params.operation;
  const { node_ids, params = {} } = req.body;

  if (!node_ids || !Array.isArray(node_ids)) {
    return res.status(400).json({ error: 'node_ids array is required' });
  }

  try {
    const remoteManager = new RemoteNodeManager();
    const result = await remoteManager.executeBulkOperation(node_ids, operation, params);
    res.json(result);
  } catch (error) {
    console.error(`[REMOTE] Failed to execute bulk operation ${operation}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Sync configurations to multiple nodes
router.post('/sync/configurations', async (req, res) => {
  const { master_node_id, target_node_ids } = req.body;

  if (!master_node_id || !target_node_ids || !Array.isArray(target_node_ids)) {
    return res.status(400).json({ error: 'master_node_id and target_node_ids array are required' });
  }

  try {
    const remoteManager = new RemoteNodeManager();
    const result = await remoteManager.syncServerConfigurations(master_node_id, target_node_ids);
    res.json(result);
  } catch (error) {
    console.error('[REMOTE] Failed to sync configurations:', error);
    res.status(500).json({ error: error.message });
  }
});

// Collect metrics from multiple nodes
router.post('/metrics/collect', async (req, res) => {
  const { node_ids } = req.body;

  if (!node_ids || !Array.isArray(node_ids)) {
    return res.status(400).json({ error: 'node_ids array is required' });
  }

  try {
    const remoteManager = new RemoteNodeManager();
    const result = await remoteManager.collectNodeMetrics(node_ids);
    res.json(result);
  } catch (error) {
    console.error('[REMOTE] Failed to collect metrics:', error);
    res.status(500).json({ error: error.message });
  }
});

// Resource monitoring endpoints

// Get current resource status for all nodes
router.get('/resources/status', async (req, res) => {
  try {
    const resourceMonitor = new ResourceMonitorService();
    const status = await resourceMonitor.getCurrentResourceStatus();
    res.json(status);
  } catch (error) {
    console.error('[RESOURCE] Failed to get resource status:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get resource history for a specific node
router.get('/:id/resources/history', async (req, res) => {
  const nodeId = req.params.id;
  const { hours = 24 } = req.query;

  try {
    const resourceMonitor = new ResourceMonitorService();
    const history = await resourceMonitor.getResourceHistory(nodeId, parseInt(hours));
    res.json(history);
  } catch (error) {
    console.error(`[RESOURCE] Failed to get resource history for node ${nodeId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Collect resources from all nodes
router.post('/resources/collect', async (req, res) => {
  try {
    const resourceMonitor = new ResourceMonitorService();
    const result = await resourceMonitor.collectAllNodeResources();
    res.json(result);
  } catch (error) {
    console.error('[RESOURCE] Failed to collect resources:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get resource utilization report
router.get('/resources/report', async (req, res) => {
  const { time_range = '24h' } = req.query;

  try {
    const resourceMonitor = new ResourceMonitorService();
    const report = await resourceMonitor.getResourceReport(time_range);
    res.json(report);
  } catch (error) {
    console.error('[RESOURCE] Failed to generate resource report:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get resource alerts for all nodes
router.get('/resources/alerts', async (req, res) => {
  try {
    const resourceMonitor = new ResourceMonitorService();
    const status = await resourceMonitor.getCurrentResourceStatus();

    const alerts = [];
    status.nodes.forEach(nodeStatus => {
      nodeStatus.alerts.forEach(alert => {
        alerts.push({
          node_id: nodeStatus.node.id,
          node_name: nodeStatus.node.name,
          ...alert,
          timestamp: new Date().toISOString()
        });
      });
    });

    res.json({
      total_alerts: alerts.length,
      critical: alerts.filter(a => a.type === 'critical').length,
      warning: alerts.filter(a => a.type === 'warning').length,
      alerts: alerts
    });
  } catch (error) {
    console.error('[RESOURCE] Failed to get resource alerts:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// TUNNEL MANAGEMENT ROUTES
// ============================================

const tunnelService = require('../services/tunnel-service');
const { getAppDir } = require('../lib/paths');

// Start a tunnel for a node (makes it accessible via public URL)
router.post('/:id(\\d+)/tunnel/start', async (req, res) => {
  const nodeId = req.params.id;
  const { localPort = 3001 } = req.body;
  const db = getDatabase();

  try {
    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
    if (!node) {
      return res.status(404).json({ error: 'Node not found' });
    }

    const appDataDir = getAppDir();
    const result = await tunnelService.startQuickTunnel({
      appDataDir,
      localPort: Number(localPort),
      nodeId: String(nodeId),
      onUrl: (url) => {
        // Update node with tunnel URL
        db.prepare('UPDATE nodes SET tunnel_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(url, nodeId);
      },
    });

    res.json({
      ok: true,
      nodeId,
      pid: result.pid,
      url: result.url,
      status: result.status,
      message: result.url
        ? `Tunnel started: ${result.url}`
        : 'Tunnel starting... URL will be available shortly',
    });
  } catch (error) {
    console.error(`[TUNNEL] Failed to start tunnel for node ${nodeId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Stop tunnel for a node
router.post('/:id(\\d+)/tunnel/stop', async (req, res) => {
  const nodeId = req.params.id;
  const db = getDatabase();

  try {
    await tunnelService.stopTunnel(String(nodeId));

    // Clear tunnel URL from node
    db.prepare('UPDATE nodes SET tunnel_url = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(nodeId);

    res.json({ ok: true, message: 'Tunnel stopped' });
  } catch (error) {
    console.error(`[TUNNEL] Failed to stop tunnel for node ${nodeId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Get tunnel status for a node
router.get('/:id(\\d+)/tunnel/status', (req, res) => {
  const nodeId = req.params.id;

  try {
    const status = tunnelService.getTunnelStatus(String(nodeId));
    res.json(status);
  } catch (error) {
    console.error(`[TUNNEL] Failed to get tunnel status for node ${nodeId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// List all active tunnels
router.get('/tunnels', (req, res) => {
  try {
    const tunnels = tunnelService.getAllTunnels();
    res.json({ tunnels, count: tunnels.length });
  } catch (error) {
    console.error('[TUNNEL] Failed to list tunnels:', error);
    res.status(500).json({ error: error.message });
  }
});

// Turn this PC into a node (local machine becomes a hostable node)
router.post('/local/enable', async (req, res) => {
  const { name = 'Local Node', port = 3001, startTunnel = true } = req.body;
  const db = getDatabase();

  try {
    // Check if local node already exists
    let localNode = db.prepare("SELECT * FROM nodes WHERE ip_address = '127.0.0.1' OR ip_address = 'localhost'").get();

    if (!localNode) {
      // Create local node entry
      const result = db.prepare(
        'INSERT INTO nodes (name, ip_address, port, status, last_seen, is_local) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(name, '127.0.0.1', port, 'online', new Date().toISOString(), 1);

      localNode = db.prepare('SELECT * FROM nodes WHERE id = ?').get(result.lastInsertRowid);
    } else {
      // Update existing
      db.prepare('UPDATE nodes SET status = ?, last_seen = ?, is_local = 1 WHERE id = ?')
        .run('online', new Date().toISOString(), localNode.id);
    }

    let tunnelInfo = null;
    if (startTunnel) {
      const appDataDir = getAppDir();
      tunnelInfo = await tunnelService.startQuickTunnel({
        appDataDir,
        localPort: port,
        nodeId: String(localNode.id),
        onUrl: (url) => {
          db.prepare('UPDATE nodes SET tunnel_url = ? WHERE id = ?').run(url, localNode.id);
        },
      });

      // Wait a moment for URL
      await new Promise(r => setTimeout(r, 6000));
      tunnelInfo = tunnelService.getTunnelStatus(String(localNode.id));
    }

    res.json({
      ok: true,
      message: 'This PC is now a Turbonox node!',
      node: {
        id: localNode.id,
        name: localNode.name,
        port,
        isLocal: true,
      },
      tunnel: tunnelInfo,
    });
  } catch (error) {
    console.error('[NODE] Failed to enable local node:', error);
    res.status(500).json({ error: error.message });
  }
});

// Disable this PC as a node
router.post('/local/disable', async (req, res) => {
  const db = getDatabase();

  try {
    const localNode = db.prepare("SELECT * FROM nodes WHERE is_local = 1").get();

    if (localNode) {
      await tunnelService.stopTunnel(String(localNode.id));
      db.prepare('UPDATE nodes SET status = ?, tunnel_url = NULL, is_local = 0 WHERE id = ?')
        .run('offline', localNode.id);
    }

    res.json({ ok: true, message: 'Local node disabled' });
  } catch (error) {
    console.error('[NODE] Failed to disable local node:', error);
    res.status(500).json({ error: error.message });
  }
});

// Install node via SSH
router.post('/install', restrictionMiddleware('manage_nodes'), async (req, res) => {
  const { ipAddress, sshUser, sshPassword, sshKey, sshPort, hostKey, name, port } = req.body;

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');

  console.log(`[NODE] Starting installation ON ${ipAddress}`);
  res.write(`[1/3] Preparing installation for ${ipAddress}...\n`);

  try {
    const db = getDatabase();
    const ttlMs = 15 * 60 * 1000;
    const now = Date.now();
    const code = crypto.randomBytes(16).toString('hex');

    // 1. Create Join Code
    const existing = db.prepare("SELECT value FROM settings WHERE key = 'nodeJoinCodes'").get();
    const map = safeJsonParse(existing?.value, {});
    for (const [k, v] of Object.entries(map)) {
      if (!v || typeof v !== 'object') { delete map[k]; continue; }
      if (!v.created_at || now - Number(v.created_at) > ttlMs) delete map[k];
    }
    map[code] = { created_at: now, ttl_ms: ttlMs };
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('nodeJoinCodes', ?)").run(JSON.stringify(map));

    res.write(`[1/3] Join code generated: ${code}\n`);

    // 2. Construct Command
    let masterUrl = '';
    const settingsRow = db.prepare("SELECT value FROM settings WHERE key = 'general'").get();
    const generalSettings = safeJsonParse(settingsRow?.value, {});
    if (generalSettings.app_url) {
      masterUrl = generalSettings.app_url;
    } else {
      try {
        const publicIp = await import('public-ip');
        const ip = await publicIp.publicIpv4();
        // Default to 3456 if not specified, but usually we need the port mapped?
        // If user has not set app_url, we assume direct IP access on default port.
        masterUrl = `http://${ip}:3456`;
        res.write(`[WARN] No App URL configured. Using detected public IP: ${masterUrl}\n`);
      } catch {
        masterUrl = 'http://YOUR_MASTER_IP:3456';
        res.write(`[WARN] Could not determine public IP. Please check settings or configure App URL.\n`);
      }
    }

    const targetPort = Number(port) || 3001;
    const targetName = name || 'VPS Node';

    res.write(`[2/3] Constructing payload for ${targetName}...\n`);

    const bootstrapCmd = `curl -fsSL "${masterUrl}/api/nodes/bootstrap/linux" | TURBONOX_MASTER_URL="${masterUrl}" TURBONOX_JOIN_CODE="${code}" TURBONOX_NODE_PORT="${targetPort}" TURBONOX_NODE_NAME="${targetName}" bash`;

    res.write(`[3/3] Executing bootstrap on remote host...\n`);
    res.write(`> ${bootstrapCmd}\n\n`);

    const { connectionString } = req.body;

    // RAW CONNECTION STRING MODE
    if (connectionString) {
      res.write(`[MODE] Using Raw Connection String: ${connectionString}\n`);

      const { spawn } = require('child_process');
      const cleanCmd = connectionString.trim();
      let parts = cleanCmd.split(/\s+/);
      if (parts[0] === 'ssh') parts.shift();

      // Force TTY to allow "yes" prompt if needed, though for piping command we might want non-interactive?
      // Actually, if we pipe the bootstrap command as *input* into SSH, standard SSH reads stdin as remote command or input.
      // E.g. echo "ls" | ssh user@host
      // But if we use -tt, it forces a TTY.
      // If user wants to install, we just want to run the command.
      // ssh user@host "command" is standard.
      // But with raw string "ssh user@host -p 22", we can't easily inject the command string as an argument without parsing.
      // Alternative: echo "command" | ssh ... 
      // This works for Tmate too.

      const sshArgs = ['-tt', ...parts, 'bash']; // Run bash explicitly to pipe into it? Or just pipe into ssh directly.
      // Simply piping into ssh usually executes key strokes if no command specified.
      // But we want to run a script. 
      // best way: ssh user@host "bash -c '...'"
      // But we can't inject "bash -c" easily into raw args list without knowing where the host ends.

      // If we pipe into the stdin of the ssh process, it goes to the remote shell.

      const child = spawn('ssh', ['-tt', ...parts], {
        stdio: 'pipe',
        detached: false
      });

      // Write the bootstrap command to the SSH stdin
      // Use a strict delay or just write it?
      // For Tmate/interactive, we might need to wait for a prompt?
      // Let's just write it with a newline.

      child.stdin.write(bootstrapCmd + '\n');
      child.stdin.write('exit\n'); // Exit after running

      child.stdout.on('data', (data) => {
        res.write(data.toString().replace(/\n/g, '\r\n'));
      });

      child.stderr.on('data', (data) => {
        res.write(data.toString().replace(/\n/g, '\r\n'));
      });

      child.on('close', (code) => {
        if (code === 0) {
          res.write('\n[SUCCESS] Installation command completed.\n');
        } else {
          res.write(`\n[ERROR] Command failed with exit code ${code}.\n`);
        }
        res.end();
      });

      return;
    }

    const { SshService } = require('../services/SshService');
    const node = {
      id: 'install-' + Date.now(),
      ip_address: ipAddress,
      ssh_user: sshUser,
      ssh_password: sshPassword,
      ssh_key: sshKey,
      ssh_port: sshPort || 22,
      host_key: hostKey,
      name: targetName
    };

    const result = await SshService.execStream(node, bootstrapCmd, (chunk) => {
      res.write(chunk.replace(/\n/g, '\r\n')); // Ensure CRLF for terminal
    });

    if (result.code === 0) {
      res.write('\n[SUCCESS] Installation command completed.\n');
    } else {
      res.write(`\n[ERROR] Command failed with exit code ${result.code}.\n`);
      res.write('Note: Some environments (like Tmate) do not support remote command execution.\n');
    }
    res.end();

  } catch (error) {
    console.error(error);
    res.write(`\n[ERROR] ${error.message}\n`);
    res.end();
  }
});

module.exports = router;
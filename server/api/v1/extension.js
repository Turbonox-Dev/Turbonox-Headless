const express = require('express');
const { getDatabase } = require('../../lib/database');
const si = require('systeminformation');
const os = require('os');
const axios = require('axios');

const router = express.Router();

const { verifyJWT, canAccessServer, getSessionPermissions } = require('./auth');

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  const token = authHeader.substring(7);
  const decoded = verifyJWT(token);

  if (!decoded) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.user = decoded;
  next();
}

router.use(requireAuth);

router.get('/dashboard', async (req, res) => {
  try {
    const db = getDatabase();
    const accountId = req.user.accountId;

    const [cpu, mem, diskStats] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
    ]);

    const systemStats = {
      cpu: {
        usage: parseFloat(cpu.currentLoad.toFixed(1)),
        cores: os.cpus().length,
      },
      memory: {
        total: parseFloat((mem.total / (1024 ** 3)).toFixed(2)),
        used: parseFloat((mem.used / (1024 ** 3)).toFixed(2)),
        free: parseFloat((mem.free / (1024 ** 3)).toFixed(2)),
        percentage: parseFloat(((mem.used / mem.total) * 100).toFixed(1)),
      },
      disk: diskStats.map(d => ({
        mount: d.mount,
        total: parseFloat((d.size / (1024 ** 3)).toFixed(2)),
        used: parseFloat((d.used / (1024 ** 3)).toFixed(2)),
        available: parseFloat((d.available / (1024 ** 3)).toFixed(2)),
        percentage: parseFloat(d.use.toFixed(1)),
      })),
      uptime: os.uptime(),
      hostname: os.hostname(),
      platform: os.platform(),
    };

    const memberships = getSessionPermissions(db, accountId);
    const allowedOwnerIds = new Set([accountId]);
    
    for (const m of memberships) {
      if (m.permissions?.servers?.view) {
        allowedOwnerIds.add(Number(m.ownerAccountId));
      }
    }

    const ownerIds = Array.from(allowedOwnerIds);
    const placeholders = ownerIds.map(() => '?').join(',');
    const servers = ownerIds.length > 0 
      ? db.prepare(`SELECT * FROM servers WHERE owner_account_id IN (${placeholders}) ORDER BY created_at DESC`).all(...ownerIds)
      : [];

    const serverList = servers.map(server => ({
      id: server.id,
      name: server.name,
      type: server.type,
      status: server.status,
      port: server.port,
      path: server.path,
      node_id: server.node_id,
      created_at: server.created_at,
    }));

    res.json({
      system: systemStats,
      servers: serverList,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[DEV-API] Dashboard error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/system/stats', async (req, res) => {
  try {
    const [cpu, mem, disk, network] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
      si.networkStats(),
    ]);

    const stats = {
      cpu: {
        usage: parseFloat(cpu.currentLoad.toFixed(1)),
        cores: os.cpus().length,
      },
      memory: {
        total: parseFloat((mem.total / (1024 ** 3)).toFixed(2)),
        used: parseFloat((mem.used / (1024 ** 3)).toFixed(2)),
        free: parseFloat((mem.free / (1024 ** 3)).toFixed(2)),
        percentage: parseFloat(((mem.used / mem.total) * 100).toFixed(1)),
      },
      disk: disk.map(d => ({
        mount: d.mount,
        total: parseFloat((d.size / (1024 ** 3)).toFixed(2)),
        used: parseFloat((d.used / (1024 ** 3)).toFixed(2)),
        available: parseFloat((d.available / (1024 ** 3)).toFixed(2)),
        percentage: parseFloat(d.use.toFixed(1)),
      })),
      network: {
        rx: parseFloat((network[0]?.rx_sec / (1024 ** 2)).toFixed(2)) || 0,
        tx: parseFloat((network[0]?.tx_sec / (1024 ** 2)).toFixed(2)) || 0,
      },
      uptime: os.uptime(),
      platform: os.platform(),
      arch: os.arch(),
      hostname: os.hostname(),
      timestamp: new Date().toISOString(),
    };

    res.json(stats);
  } catch (error) {
    console.error('[DEV-API] System stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/servers', async (req, res) => {
  try {
    const db = getDatabase();
    const accountId = req.user.accountId;

    const memberships = getSessionPermissions(db, accountId);
    const allowedOwnerIds = new Set([accountId]);
    
    for (const m of memberships) {
      if (m.permissions?.servers?.view) {
        allowedOwnerIds.add(Number(m.ownerAccountId));
      }
    }

    const ownerIds = Array.from(allowedOwnerIds);
    const placeholders = ownerIds.map(() => '?').join(',');
    const servers = ownerIds.length > 0
      ? db.prepare(`SELECT * FROM servers WHERE owner_account_id IN (${placeholders}) ORDER BY created_at DESC`).all(...ownerIds)
      : [];

    const serverDetails = await Promise.all(
      servers.map(async (server) => {
        let resourceUsage = {
          cpu: 0,
          memory: 0,
        };

        if (server.status === 'running' && server.pid) {
          try {
            const processList = await si.processes();
            const mainProc = processList?.list?.find(p => Number(p.pid) === Number(server.pid));

            if (mainProc) {
              resourceUsage.cpu = parseFloat((mainProc.cpu || 0).toFixed(2));

              const mem = await si.mem();
              resourceUsage.memory = parseFloat(mem.total ? (((mainProc.mem || 0) / mem.total) * 100).toFixed(2) : 0);
            }
          } catch (error) {
            console.error(`[DEV-API] Error getting process ${server.pid}:`, error.message);
          }
        }

        return {
          id: server.id,
          name: server.name,
          type: server.type,
          status: server.status,
          port: server.port,
          pid: server.pid,
          node_id: server.node_id,
          path: server.path,
          uptime: server.started_at ? Math.floor((Date.now() - new Date(server.started_at).getTime()) / 1000) : 0,
          resources: resourceUsage,
          created_at: server.created_at,
          updated_at: server.updated_at,
        };
      })
    );

    res.json({
      servers: serverDetails,
      total: serverDetails.length,
      running: serverDetails.filter(s => s.status === 'running').length,
      stopped: serverDetails.filter(s => s.status === 'stopped').length,
    });
  } catch (error) {
    console.error('[DEV-API] Servers error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/servers/:id', async (req, res) => {
  try {
    const db = getDatabase();
    const accountId = req.user.accountId;
    const serverId = req.params.id;

    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);

    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    if (!canAccessServer(db, accountId, server)) {
      return res.status(403).json({ error: 'You do not have permission to access this server' });
    }

    let uptime = 0;
    if (server.started_at) {
      uptime = Math.floor((Date.now() - new Date(server.started_at).getTime()) / 1000);
    }

    let resourceUsage = {
      cpu: 0,
      memory: 0,
      disk: 0,
    };

    if (server.status === 'running' && server.pid) {
      try {
        const [processList, mem, fsSize] = await Promise.all([
          si.processes(),
          si.mem(),
          si.fsSize(),
        ]);

        const mainProc = processList?.list?.find(p => Number(p.pid) === Number(server.pid));

        if (mainProc) {
          resourceUsage.cpu = parseFloat((mainProc.cpu || 0).toFixed(2));
          resourceUsage.memory = parseFloat(mem.total ? (((mainProc.mem || 0) / mem.total) * 100).toFixed(2) : 0);
        }

        const serverDisk = fsSize.find(d => d.mount === '/');
        if (serverDisk) {
          resourceUsage.disk = parseFloat((serverDisk.use || 0).toFixed(1));
        }
      } catch (error) {
        console.error(`[DEV-API] Error getting server ${serverId} resources:`, error.message);
      }
    }

    res.json({
      id: server.id,
      name: server.name,
      type: server.type,
      status: server.status,
      port: server.port,
      pid: server.pid,
      node_id: server.node_id,
      path: server.path,
      command: server.command,
      start_command: server.start_command,
      uptime,
      resources: resourceUsage,
      public_access: !!server.public_access,
      created_at: server.created_at,
      updated_at: server.updated_at,
    });
  } catch (error) {
    console.error('[DEV-API] Server detail error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/servers/:id/start', async (req, res) => {
  try {
    const db = getDatabase();
    const accountId = req.user.accountId;
    const serverId = req.params.id;

    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);

    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    if (!canAccessServer(db, accountId, server)) {
      return res.status(403).json({ error: 'You do not have permission to control this server' });
    }

    if (server.status === 'running') {
      return res.status(400).json({ error: 'Server is already running' });
    }

    const port = process.env.VOID_BACKEND_PORT || 3456;
    await axios.post(`http://localhost:${port}/api/servers/${serverId}/start`);

    res.json({
      message: 'Server start command sent',
      serverId: server.id,
      status: 'starting',
    });
  } catch (error) {
    console.error('[DEV-API] Start server error:', error);
    res.status(500).json({ error: error.response?.data?.error || error.message });
  }
});

router.post('/servers/:id/stop', async (req, res) => {
  try {
    const db = getDatabase();
    const accountId = req.user.accountId;
    const serverId = req.params.id;

    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);

    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    if (!canAccessServer(db, accountId, server)) {
      return res.status(403).json({ error: 'You do not have permission to control this server' });
    }

    if (server.status !== 'running') {
      return res.status(400).json({ error: 'Server is not running' });
    }

    const port = process.env.VOID_BACKEND_PORT || 3456;
    await axios.post(`http://localhost:${port}/api/servers/${serverId}/stop`);

    res.json({
      message: 'Server stop command sent',
      serverId: server.id,
      status: 'stopping',
    });
  } catch (error) {
    console.error('[DEV-API] Stop server error:', error);
    res.status(500).json({ error: error.response?.data?.error || error.message });
  }
});

router.post('/servers/:id/restart', async (req, res) => {
  try {
    const db = getDatabase();
    const accountId = req.user.accountId;
    const serverId = req.params.id;

    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);

    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    if (!canAccessServer(db, accountId, server)) {
      return res.status(403).json({ error: 'You do not have permission to control this server' });
    }

    const port = process.env.VOID_BACKEND_PORT || 3456;

    let message = '';
    let status = '';

    if (server.status === 'running') {
      await axios.post(`http://localhost:${port}/api/servers/${serverId}/stop`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      await axios.post(`http://localhost:${port}/api/servers/${serverId}/start`);
      message = 'Server restarted';
      status = 'restarting';
    } else {
      await axios.post(`http://localhost:${port}/api/servers/${serverId}/start`);
      message = 'Server started';
      status = 'starting';
    }

    res.json({
      message,
      serverId: server.id,
      status,
    });
  } catch (error) {
    console.error('[DEV-API] Restart server error:', error);
    res.status(500).json({ error: error.response?.data?.error || error.message });
  }
});

router.get('/user/profile', (req, res) => {
  try {
    const db = getDatabase();
    const accountId = req.user.accountId;

    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);

    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const memberships = getSessionPermissions(db, accountId);

    res.json({
      id: account.id,
      email: account.email,
      displayName: account.display_name,
      type: account.type,
      presenceMode: account.presence_mode,
      color: account.color,
      avatar: account.avatar,
      createdAt: account.created_at,
      memberships: memberships.map(m => ({
        sessionId: m.sessionId,
        ownerAccountId: m.ownerAccountId,
        permissions: m.permissions,
      })),
    });
  } catch (error) {
    console.error('[DEV-API] User profile error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    api: 'v1',
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;

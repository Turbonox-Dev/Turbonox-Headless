const express = require('express');
const { getDatabase } = require('../lib/database');
const si = require('systeminformation');
const os = require('os');
const { verifyExtensionToken } = require('./extension');

const router = express.Router();

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  const token = authHeader.substring(7);
  const decoded = verifyExtensionToken(token);

  if (!decoded) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.user = decoded;
  next();
}

function canAccessServer(db, accountId, serverRow) {
  return Number(serverRow.owner_account_id) === Number(accountId);
}

router.use(authMiddleware);

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
        usage: cpu.currentLoad.toFixed(1),
        cores: os.cpus().length,
      },
      memory: {
        total: (mem.total / (1024 ** 3)).toFixed(2),
        used: (mem.used / (1024 ** 3)).toFixed(2),
        free: (mem.free / (1024 ** 3)).toFixed(2),
        percentage: ((mem.used / mem.total) * 100).toFixed(1),
      },
      disk: diskStats.map(d => ({
        mount: d.mount,
        total: (d.size / (1024 ** 3)).toFixed(2),
        used: (d.used / (1024 ** 3)).toFixed(2),
        available: (d.available / (1024 ** 3)).toFixed(2),
        percentage: d.use.toFixed(1),
      })),
      uptime: os.uptime(),
      hostname: os.hostname(),
    };

    const servers = db.prepare('SELECT * FROM servers WHERE owner_account_id = ? ORDER BY created_at DESC').all(accountId);

    const serverList = servers.map(server => ({
      id: server.id,
      name: server.name,
      type: server.type,
      status: server.status,
      port: server.port,
      path: server.path,
      created_at: server.created_at,
    }));

    res.json({
      system: systemStats,
      servers: serverList,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[EXTENSION-API] Dashboard error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/servers', async (req, res) => {
  try {
    const db = getDatabase();
    const accountId = req.user.accountId;

    const servers = db.prepare('SELECT * FROM servers WHERE owner_account_id = ? ORDER BY created_at DESC').all(accountId);

    const serverDetails = await Promise.all(
      servers.map(async (server) => {
        const processList = await si.processes();
        const mainProc = processList?.list?.find(p => Number(p.pid) === Number(server.pid));
        const isRunning = mainProc && server.status === 'running';

        let resourceUsage = {
          cpu: 0,
          memory: 0,
        };

        if (isRunning) {
          resourceUsage.cpu = mainProc.cpu || 0;

          const mem = await si.mem();
          resourceUsage.memory = mem.total ? ((mainProc.mem || 0) / mem.total) * 100 : 0;
        }

        return {
          id: server.id,
          name: server.name,
          type: server.type,
          status: server.status,
          port: server.port,
          pid: server.pid,
          uptime: server.started_at ? Math.floor((Date.now() - new Date(server.started_at).getTime()) / 1000) : 0,
          resources: resourceUsage,
          created_at: server.created_at,
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
    console.error('[EXTENSION-API] Servers error:', error);
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
      const [processList, mem, fsSize] = await Promise.all([
        si.processes(),
        si.mem(),
        si.fsSize(),
      ]);

      const mainProc = processList?.list?.find(p => Number(p.pid) === Number(server.pid));

      if (mainProc) {
        resourceUsage.cpu = mainProc.cpu || 0;
        resourceUsage.memory = mem.total ? ((mainProc.mem || 0) / mem.total) * 100 : 0;
      }

      const serverDisk = fsSize.find(d => d.mount === '/');
      if (serverDisk) {
        resourceUsage.disk = serverDisk.use || 0;
      }
    }

    res.json({
      id: server.id,
      name: server.name,
      type: server.type,
      status: server.status,
      port: server.port,
      path: server.path,
      command: server.command,
      uptime,
      resources: resourceUsage,
      created_at: server.created_at,
      updated_at: server.updated_at,
    });
  } catch (error) {
    console.error('[EXTENSION-API] Server detail error:', error);
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

    const axios = require('axios');
    const port = process.env.VOID_BACKEND_PORT || 3456;
    const result = await axios.post(`http://localhost:${port}/api/servers/${serverId}/start`);

    res.json({
      message: 'Server start command sent',
      serverId: server.id,
      status: 'starting',
    });
  } catch (error) {
    console.error('[EXTENSION-API] Start server error:', error);
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

    const axios = require('axios');
    const port = process.env.VOID_BACKEND_PORT || 3456;
    const result = await axios.post(`http://localhost:${port}/api/servers/${serverId}/stop`);

    res.json({
      message: 'Server stop command sent',
      serverId: server.id,
      status: 'stopping',
    });
  } catch (error) {
    console.error('[EXTENSION-API] Stop server error:', error);
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

    const axios = require('axios');
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
    console.error('[EXTENSION-API] Restart server error:', error);
    res.status(500).json({ error: error.response?.data?.error || error.message });
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
        usage: cpu.currentLoad.toFixed(1),
        cores: os.cpus().length,
      },
      memory: {
        total: (mem.total / (1024 ** 3)).toFixed(2),
        used: (mem.used / (1024 ** 3)).toFixed(2),
        free: (mem.free / (1024 ** 3)).toFixed(2),
        percentage: ((mem.used / mem.total) * 100).toFixed(1),
      },
      disk: disk.map(d => ({
        mount: d.mount,
        total: (d.size / (1024 ** 3)).toFixed(2),
        used: (d.used / (1024 ** 3)).toFixed(2),
        available: (d.available / (1024 ** 3)).toFixed(2),
        percentage: d.use.toFixed(1),
      })),
      network: {
        rx: (network[0]?.rx_sec / (1024 ** 2)).toFixed(2) || '0',
        tx: (network[0]?.tx_sec / (1024 ** 2)).toFixed(2) || '0',
      },
      uptime: os.uptime(),
      platform: os.platform(),
      hostname: os.hostname(),
      timestamp: new Date().toISOString(),
    };

    res.json(stats);
  } catch (error) {
    console.error('[EXTENSION-API] System stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

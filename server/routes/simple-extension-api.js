const express = require('express');
const { getDatabase } = require('../lib/database');
const si = require('systeminformation');
const os = require('os');
const { authMiddleware, canAccessServer } = require('./simple-extension');

const router = express.Router();

router.use(authMiddleware);

router.get('/dashboard', async (req, res) => {
  try {
    const db = getDatabase();
    const apiKey = req.apiKey;

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
    };

    const keyRow = db.prepare('SELECT * FROM api_keys WHERE api_key = ?').get(apiKey);
    let servers;

    if (keyRow && keyRow.account_id === null) {
      servers = db.prepare('SELECT * FROM servers ORDER BY created_at DESC').all();
    } else {
      servers = db.prepare('SELECT * FROM servers WHERE owner_account_id = ? ORDER BY created_at DESC').all(keyRow.account_id);
    }

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
    console.error('[SIMPLE-API] Dashboard error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/servers', async (req, res) => {
  try {
    const db = getDatabase();
    const apiKey = req.apiKey;

    let servers;
    const keyRow = db.prepare('SELECT * FROM api_keys WHERE api_key = ?').get(apiKey);

    if (keyRow && keyRow.account_id === null) {
      servers = db.prepare('SELECT * FROM servers ORDER BY created_at DESC').all();
    } else {
      servers = db.prepare('SELECT * FROM servers WHERE owner_account_id = ? ORDER BY created_at DESC').all(keyRow.account_id);
    }

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
          resourceUsage.cpu = parseFloat((mainProc.cpu || 0).toFixed(2));

          const mem = await si.mem();
          resourceUsage.memory = parseFloat(mem.total ? (((mainProc.mem || 0) / mem.total) * 100).toFixed(2) : 0);
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
    console.error('[SIMPLE-API] Servers error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/servers/:id', async (req, res) => {
  try {
    const db = getDatabase();
    const apiKey = req.apiKey;
    const serverId = req.params.id;

    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);

    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    if (!canAccessServer(db, apiKey, server)) {
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
        resourceUsage.cpu = parseFloat((mainProc.cpu || 0).toFixed(2));
        resourceUsage.memory = parseFloat(mem.total ? (((mainProc.mem || 0) / mem.total) * 100).toFixed(2) : 0);
      }

      const serverDisk = fsSize.find(d => d.mount === '/');
      if (serverDisk) {
        resourceUsage.disk = parseFloat((serverDisk.use || 0).toFixed(1));
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
    console.error('[SIMPLE-API] Server detail error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/servers/:id/start', async (req, res) => {
  try {
    const db = getDatabase();
    const apiKey = req.apiKey;
    const serverId = req.params.id;

    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);

    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    if (!canAccessServer(db, apiKey, server)) {
      return res.status(403).json({ error: 'You do not have permission to control this server' });
    }

    if (server.status === 'running') {
      return res.status(400).json({ error: 'Server is already running' });
    }

    const axios = require('axios');
    const port = process.env.VOID_BACKEND_PORT || 3456;
    await axios.post(`http://localhost:${port}/api/servers/${serverId}/start`);

    res.json({
      message: 'Server start command sent',
      serverId: server.id,
      status: 'starting',
    });
  } catch (error) {
    console.error('[SIMPLE-API] Start server error:', error);
    res.status(500).json({ error: error.response?.data?.error || error.message });
  }
});

router.post('/servers/:id/stop', async (req, res) => {
  try {
    const db = getDatabase();
    const apiKey = req.apiKey;
    const serverId = req.params.id;

    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);

    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    if (!canAccessServer(db, apiKey, server)) {
      return res.status(403).json({ error: 'You do not have permission to control this server' });
    }

    if (server.status !== 'running') {
      return res.status(400).json({ error: 'Server is not running' });
    }

    const axios = require('axios');
    const port = process.env.VOID_BACKEND_PORT || 3456;
    await axios.post(`http://localhost:${port}/api/servers/${serverId}/stop`);

    res.json({
      message: 'Server stop command sent',
      serverId: server.id,
      status: 'stopping',
    });
  } catch (error) {
    console.error('[SIMPLE-API] Stop server error:', error);
    res.status(500).json({ error: error.response?.data?.error || error.message });
  }
});

router.post('/servers/:id/restart', async (req, res) => {
  try {
    const db = getDatabase();
    const apiKey = req.apiKey;
    const serverId = req.params.id;

    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);

    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    if (!canAccessServer(db, apiKey, server)) {
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
    console.error('[SIMPLE-API] Restart server error:', error);
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
      hostname: os.hostname(),
      timestamp: new Date().toISOString(),
    };

    res.json(stats);
  } catch (error) {
    console.error('[SIMPLE-API] System stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

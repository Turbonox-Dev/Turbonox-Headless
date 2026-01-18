/**
 * Turbonox Web Server Entry Point
 * Pure web-based panel - no Electron dependencies
 */

require('dotenv').config();

const express = require('express');
const { initDatabase, getDatabase } = require('./lib/database');
const axios = require('axios');
const WebSocket = require('ws');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const kill = require('tree-kill');
const http = require('http');
const net = require('net');

// Route imports
const systemRoutes = require('./routes/system');
const serverRoutes = require('./routes/servers');
const networkRoutes = require('./routes/network');
const backupRoutes = require('./routes/backups');
const settingsRoutes = require('./routes/settings');
const nodeRoutes = require('./routes/nodes');
const aiRoutes = require('./routes/ai');
const accountRoutes = require('./routes/accounts');
const sessionRoutes = require('./routes/sessions');
const eggRoutes = require('./routes/eggs');
const templateRoutes = require('./routes/templates');
const simpleExtensionRoutes = require('./routes/simple-extension');
const simpleExtensionApiRoutes = require('./routes/simple-extension-api');
const extensionAuthRoutes = require('./routes/extension');
const extensionApiRoutes = require('./routes/extension-api');
const aiHostingRoutes = require('./routes/ai-hosting');
const v1AuthRoutes = require('./api/v1/auth');
const v1ExtensionRoutes = require('./api/v1/extension');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');

// Service imports
const { NodeHealthMonitor } = require('./services/health-monitor');
const { ResourceMonitorService } = require('./services/resource-monitor');
const { FailoverService } = require('./services/failover');
const { BackupScheduler } = require('./services/backup-scheduler');
const { RemoteNodeManager } = require('./services/remote-management');

/**
 * Find an available port starting from startPort
 */
async function findAvailablePort(startPort, endPort = 65535) {
  for (let port = startPort; port <= endPort; port++) {
    try {
      await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on('error', reject);
        server.listen(port, () => {
          server.close(resolve);
        });
      });
      return port;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
    }
  }
  throw new Error('No available ports found');
}

/**
 * Start the Turbonox web server
 */
async function startServer() {
  const app = express();

  // Port configuration: Default 3456, fallback to dynamic if busy
  let PORT = parseInt(process.env.PORT, 10) || 3456;
  try {
    await new Promise((resolve, reject) => {
      const testServer = net.createServer();
      testServer.unref();
      testServer.on('error', reject);
      testServer.listen(PORT, () => {
        testServer.close(resolve);
      });
    });
    console.log(`[SERVER] Using port: ${PORT}`);
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      console.log(`[SERVER] Port ${PORT} busy, finding available port...`);
      PORT = await findAvailablePort(40000 + Math.floor(Math.random() * 10000));
      console.log(`[SERVER] Selected port: ${PORT}`);
    } else {
      throw e;
    }
  }

  process.env.VOID_BACKEND_PORT = String(PORT);

  // CORS configuration
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-Void-App, X-Void-Token, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');

    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    next();
  });

  // Body parsing
  app.use(express.json({ limit: '200mb' }));
  app.use(express.urlencoded({ limit: '200mb', extended: true }));

  // Initialize database
  initDatabase();

  // Remote node proxy middleware
  app.use(async (req, res, next) => {
    if (req.path.startsWith('/api/nodes') || req.path.startsWith('/api/settings')) return next();

    const routesToProxy = ['/api/servers', '/api/system/stats'];
    const matchedRoute = routesToProxy.find(r => req.path.startsWith(r));
    if (!matchedRoute) return next();

    try {
      const db = getDatabase();
      const activeNodeRow = db.prepare("SELECT value FROM settings WHERE key = 'activeNodeId'").get();
      const activeNodeId = activeNodeRow?.value || 'local';

      if (activeNodeId === 'local') return next();

      console.log(`[PROXY] Redirecting ${req.method} ${req.path} to node ${activeNodeId}`);

      const remoteManager = new RemoteNodeManager();

      if (req.path === '/api/system/stats') {
        const stats = await remoteManager.getRemoteSystemStats(activeNodeId);
        return res.json(stats.data);
      }

      if (req.path === '/api/servers' && req.method === 'GET') {
        const servers = await remoteManager.getRemoteServers(activeNodeId);
        return res.json(servers.data);
      }

      next();
    } catch (err) {
      console.error('[PROXY] Error:', err.message);
      next();
    }
  });

  // Mount API routes
  app.use('/api/auth', authRoutes);
  app.use('/api/system', systemRoutes);
  app.use('/api/servers', serverRoutes);
  app.use('/api/network', networkRoutes);
  app.use('/api/backups', backupRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/nodes', nodeRoutes);
  app.use('/api/ai', aiRoutes);
  app.use('/api/accounts', accountRoutes);
  app.use('/api/sessions', sessionRoutes);
  app.use('/api/eggs', eggRoutes);
  app.use('/api/templates', templateRoutes);
  // app.use('/api/control-plane', controlPlaneRoutes); // Removed
  app.use('/api/admin', adminRoutes);
  app.use('/api/extension', extensionAuthRoutes.router);
  app.use('/api/extension', extensionApiRoutes);
  app.use('/api/simple-extension', simpleExtensionRoutes.router);
  app.use('/api/simple-extension', simpleExtensionApiRoutes);
  app.use('/api/ai-hosting', aiHostingRoutes);
  app.use('/v1', v1AuthRoutes.router);
  app.use('/v1/extension', v1ExtensionRoutes);

  // Health check endpoint
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
  });

  // Serve static frontend files
  const buildPath = path.join(__dirname, '../build');
  if (fs.existsSync(buildPath) && fs.existsSync(path.join(buildPath, 'index.html'))) {
    console.log(`[SERVER] Serving static frontend from: ${buildPath}`);
    app.use(express.static(buildPath));

    // SPA fallback - serve index.html for all non-API routes
    app.get('*', (req, res) => {
      if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'Not Found' });
      }
      res.sendFile(path.join(buildPath, 'index.html'));
    });
  } else {
    console.warn(`[SERVER] Build directory not found at: ${buildPath}`);
    console.warn('[SERVER] Run "npm run build" to build the frontend first.');
  }

  // Create HTTP server
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Turbonox Server running at http://0.0.0.0:${PORT}\n`);
  });

  server.on('error', (e) => {
    if (e?.code === 'EADDRINUSE') {
      console.error(`[SERVER] Port ${PORT} already in use`);
      process.exit(1);
    }
  });

  // WebSocket servers for terminal and console
  const wssTerminal = new WebSocket.Server({ noServer: true });
  const wssConsole = new WebSocket.Server({ noServer: true });

  // Handle WebSocket upgrades
  server.on('upgrade', (request, socket, head) => {
    try {
      const parsed = url.parse(request.url, true);
      const pathname = parsed.pathname;

      console.log(`[WS] Upgrade request for ${pathname}`);

      if (pathname !== '/api/servers/terminal' && pathname !== '/api/servers/console') {
        console.warn(`[WS] Rejecting upgrade for unknown path: ${pathname}`);
        socket.destroy();
        return;
      }

      const wss = pathname === '/api/servers/terminal' ? wssTerminal : wssConsole;
      wss.handleUpgrade(request, socket, head, (ws) => {
        console.log(`[WS] Handshake successful for ${pathname}`);
        ws.__query = parsed.query || {};
        wss.emit('connection', ws, request);
      });
    } catch (err) {
      console.error('[WS] Upgrade error:', err);
      try {
        socket.destroy();
      } catch { }
    }
  });

  // Terminal WebSocket handler
  wssTerminal.on('connection', async (ws, req) => {
    const serverId = ws.__query?.serverId;
    const nodeId = ws.__query?.nodeId;
    const connectionString = ws.__query?.connectionString;
    const db = getDatabase();

    const send = (payload) => {
      try {
        ws.send(JSON.stringify(payload));
      } catch { }
    };

    // Raw SSH Connection
    if (connectionString) {
      console.log(`[WS:Terminal] Raw SSH Connection: ${connectionString}`);
      let args = [];
      let command = 'ssh';
      const cleanCmd = connectionString.trim();
      let parts = cleanCmd.split(/\s+/);
      if (parts[0] === 'ssh') parts.shift();
      args = parts;

      try {
        const sshArgs = ['-tt', ...args];
        const child = spawn(command, sshArgs, {
          cwd: process.env.HOME,
          env: process.env,
          stdio: 'pipe',
          detached: false
        });

        send({ type: 'output', stream: 'stdout', data: `\r\n\x1b[36m> Executing: ssh ${sshArgs.join(' ')}\x1b[0m\r\n` });

        child.stdout.on('data', (data) => {
          send({ type: 'output', stream: 'stdout', data: data.toString() });
        });

        child.stderr.on('data', (data) => {
          send({ type: 'output', stream: 'stdout', data: data.toString() });
        });

        child.on('close', (code) => {
          send({ type: 'output', stream: 'stdout', data: `\r\n\x1b[33m> Process exited with code ${code}.\x1b[0m\r\n` });
          ws.close();
        });

        ws.on('message', (raw) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg?.type === 'input') {
              child.stdin.write(msg.data);
            }
          } catch { }
        });

        ws.on('close', () => {
          try { child.kill(); } catch { }
        });
      } catch (err) {
        send({ type: 'error', message: 'Failed to spawn SSH process: ' + err.message });
        ws.close();
      }
      return;
    }

    // SSH Node Terminal
    if (nodeId) {
      console.log(`[WS:Terminal] SSH Connection for node ${nodeId}`);
      try {
        const nodeRow = db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
        if (!nodeRow) {
          send({ type: 'error', message: 'Node not found' });
          ws.close();
          return;
        }

        const { SshService } = require('./services/SshService');
        send({ type: 'output', stream: 'stdout', data: `\r\n\x1b[36m> Connecting to ${nodeRow.name} (${nodeRow.ip_address})...\x1b[0m\r\n` });

        const conn = await SshService.getConnection(nodeRow);
        conn.shell((err, stream) => {
          if (err) {
            send({ type: 'error', message: 'Failed to spawn shell: ' + err.message });
            ws.close();
            return;
          }

          stream.on('close', () => {
            send({ type: 'output', stream: 'stdout', data: '\r\n\x1b[33m> Connection closed.\x1b[0m\r\n' });
            ws.close();
          }).on('data', (data) => {
            send({ type: 'output', stream: 'stdout', data: data.toString('utf-8') });
          });

          ws.on('message', (raw) => {
            try {
              const msg = JSON.parse(raw.toString());
              if (msg?.type === 'input') {
                stream.write(msg.data);
              } else if (msg?.type === 'resize') {
                stream.setWindow(msg.rows, msg.cols, msg.height, msg.width);
              }
            } catch { }
          });

          ws.on('close', () => {
            stream.end();
          });
        });
      } catch (error) {
        console.error('[WS:SSH] Error:', error);
        send({ type: 'error', message: error.message });
        ws.close();
      }
      return;
    }

    // Server Terminal
    console.log(`[WS:Terminal] Server Connection for server ${serverId}`);

    if (!serverId) {
      send({ type: 'error', message: 'Missing serverId' });
      ws.close();
      return;
    }

    let serverRow;
    try {
      serverRow = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
    } catch (e) {
      send({ type: 'error', message: e.message });
      ws.close();
      return;
    }

    if (!serverRow) {
      send({ type: 'error', message: 'Server not found' });
      ws.close();
      return;
    }

    if (!serverRow.path || !fs.existsSync(serverRow.path)) {
      send({ type: 'error', message: 'Server path does not exist' });
      ws.close();
      return;
    }

    const shell = 'bash';
    const shellArgs = ['-i'];

    console.log(`[WS:Terminal] Spawning shell for server ${serverId} at ${serverRow.path}`);

    let child;
    try {
      child = spawn(shell, shellArgs, {
        cwd: path.resolve(serverRow.path),
        env: { ...process.env, TERM: 'xterm-256color' },
        stdio: 'pipe',
        windowsHide: true,
      });
    } catch (e) {
      send({ type: 'error', message: e.message });
      ws.close();
      return;
    }

    send({ type: 'output', stream: 'stdout', data: `\r\n\x1b[1;36m>>> TERMINAL READY: ${serverRow.name} (${serverRow.path})\x1b[0m\r\n\r\n` });

    const normalizeLines = (str) => str.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');

    child.stdout?.on('data', (data) => send({ type: 'output', stream: 'stdout', data: normalizeLines(data.toString('utf8')) }));
    child.stderr?.on('data', (data) => send({ type: 'output', stream: 'stderr', data: normalizeLines(data.toString('utf8')) }));

    child.on('close', (code) => {
      send({ type: 'output', stream: 'stdout', data: `\n[terminal exited with code ${code}]\n` });
      try { ws.close(); } catch { }
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg?.type === 'input' && child?.stdin?.writable) {
          const processed = msg.data === '\r' ? '\r\n' : msg.data;
          child.stdin.write(processed);
        }
      } catch { }
    });

    ws.on('close', () => {
      if (!child || !child.pid) return;
      try {
        kill(child.pid, 'SIGTERM', (err) => {
          if (err) {
            try { kill(child.pid, 'SIGKILL'); } catch { }
          }
        });
      } catch { }
    });
  });

  // Console WebSocket handler
  wssConsole.on('connection', (ws) => {
    const serverId = ws.__query?.serverId;
    const db = getDatabase();

    const send = (payload) => {
      try { ws.send(JSON.stringify(payload)); } catch { }
    };

    if (!serverId) {
      send({ type: 'error', message: 'Missing serverId' });
      ws.close();
      return;
    }

    let serverRow;
    try {
      serverRow = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
    } catch (e) {
      send({ type: 'error', message: e.message });
      ws.close();
      return;
    }

    if (!serverRow) {
      send({ type: 'error', message: 'Server not found' });
      ws.close();
      return;
    }

    const logsDir = path.join(path.resolve(serverRow.path), 'logs');
    const logFilePath = path.join(logsDir, 'output.log');

    try {
      fs.mkdirSync(logsDir, { recursive: true });
      fs.closeSync(fs.openSync(logFilePath, 'a'));
    } catch (e) {
      send({ type: 'error', message: e.message });
      ws.close();
      return;
    }

    const readLastLines = () => {
      try {
        const content = fs.readFileSync(logFilePath, 'utf8');
        const lines = content.split(/\r?\n/).slice(-200).join('\n');
        if (lines.trim()) {
          send({ type: 'output', stream: 'stdout', data: lines + '\n' });
        }
      } catch { }
    };

    readLastLines();
    send({ type: 'output', stream: 'stdout', data: `[console attached] ${serverRow.name}\n` });

    let position = 0;
    try {
      position = fs.statSync(logFilePath).size;
    } catch {
      position = 0;
    }

    const pump = () => {
      try {
        const stat = fs.statSync(logFilePath);
        if (stat.size < position) position = 0;
        if (stat.size === position) return;

        const start = position;
        const end = Math.max(start, stat.size - 1);
        position = stat.size;

        const stream = fs.createReadStream(logFilePath, { start, end });
        stream.on('data', (chunk) => {
          send({ type: 'output', stream: 'stdout', data: chunk.toString('utf8') });
        });
      } catch { }
    };

    const interval = setInterval(pump, 300);
    pump();

    ws.on('close', () => {
      try { clearInterval(interval); } catch { }
    });
  });

  // Start background services
  const lowFootprint = String(process.env.TURBONOX_LOW_FOOTPRINT || '').toLowerCase() === 'true';

  const healthMonitor = new NodeHealthMonitor();
  const resourceMonitor = new ResourceMonitorService();
  const failoverService = new FailoverService();
  const backupScheduler = new BackupScheduler();

  healthMonitor.startMonitoring();

  if (!lowFootprint) {
    resourceMonitor.startMonitoring().catch(() => { });
    failoverService.initializeMonitoring().catch(() => { });
    backupScheduler.scheduleAll().catch((e) => console.error('[BACKUP-SCHED] Failed:', e.message));

    try {
      const { GDriveUploader } = require('./services/gdrive-uploader');
      const gdriveUploader = new GDriveUploader();
      gdriveUploader.start();
    } catch (e) {
      console.error('[GDRIVE] Failed to start:', e.message);
    }
  }

  // Auto-restart previously running servers
  try {
    const db = getDatabase();
    const setRow = db.prepare("SELECT value FROM settings WHERE key = 'autoStart'").get();
    const autoStartEnabled = setRow && String(setRow.value) === 'true';

    if (autoStartEnabled) {
      const rows = db.prepare("SELECT id FROM servers WHERE status = 'running'").all();
      if (Array.isArray(rows) && rows.length > 0) {
        console.log(`[SERVER] Auto-restarting ${rows.length} server(s)...`);
        for (const r of rows) {
          const sid = r?.id;
          if (!sid) continue;
          try {
            await axios.post(`http://localhost:${PORT}/api/servers/${sid}/stop`).catch(() => null);
            await new Promise((res) => setTimeout(res, 500));
            await axios.post(`http://localhost:${PORT}/api/servers/${sid}/start`);
            console.log(`[SERVER] Auto-restarted server ${sid}`);
          } catch (err) {
            console.error(`[SERVER] Failed to auto-restart server ${sid}:`, err?.message);
          }
        }
      }
    }
  } catch (e) {
    console.error('[SERVER] Auto-restart check failed:', e?.message);
  }

  // Graceful shutdown
  const stopAll = () => {
    console.log('\n[SERVER] Shutting down...');
    try { healthMonitor.stopMonitoring(); } catch { }
    try { resourceMonitor.stopMonitoring(); } catch { }
    try { failoverService.stopMonitoring(); } catch { }
    server.close(() => {
      console.log('[SERVER] Stopped.');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000);
  };

  process.on('SIGINT', stopAll);
  process.on('SIGTERM', stopAll);

  return server;
}

// Start the server
startServer().catch((err) => {
  console.error('[SERVER] Fatal error:', err);
  process.exit(1);
});

module.exports = { startServer };

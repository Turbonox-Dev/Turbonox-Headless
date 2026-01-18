const express = require('express');
const router = express.Router();
const ngrok = require('@ngrok/ngrok');
const { spawn } = require('child_process');
const { getDatabase } = require('../lib/database');
const { restrictionMiddleware } = require('../utils/restrictions');
const kill = require('tree-kill');
const os = require('os');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { getNetworkCacheDefaultDir } = require('../lib/paths');
const processRegistry = require('../services/ProcessRegistry');

function getActiveAccountId(db) {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'activeAccountId'").get();
    const id = row?.value ? Number(row.value) : null;
    return Number.isFinite(id) ? id : null;
  } catch {
    return null;
  }
}

function getAccountSessionPermissions(db, accountId) {
  if (!accountId) return [];
  try {
    const rows = db.prepare(
      `SELECT sm.session_id, sm.permissions_json, s.owner_account_id
       FROM session_members sm
       JOIN sessions s ON s.id = sm.session_id
       WHERE sm.account_id = ? AND s.status = 'active'`
    ).all(accountId);

    return (rows || []).map((r) => {
      let perms = {};
      try {
        perms = r.permissions_json ? JSON.parse(r.permissions_json) : {};
      } catch {
        perms = {};
      }
      return {
        ownerAccountId: r.owner_account_id,
        permissions: perms,
      };
    });
  } catch {
    return [];
  }
}

function canFromSession(perms, category, action) {
  if (!perms || typeof perms !== 'object') return false;
  const cat = perms[category];
  if (!cat || typeof cat !== 'object') return false;
  return Boolean(cat[action]);
}

function canAccessServer(db, activeAccountId, serverRow, requiredAction = 'view') {
  if (!activeAccountId || !serverRow) return false;
  if (Number(serverRow.owner_account_id) === Number(activeAccountId)) return true;
  const memberships = getAccountSessionPermissions(db, activeAccountId);
  return memberships.some(
    (m) => Number(m.ownerAccountId) === Number(serverRow.owner_account_id) && canFromSession(m.permissions, 'servers', requiredAction)
  );
}

// Dynamic import for public-ip (ESM module)
let publicIpv4;
(async () => {
  const publicIp = await import('public-ip');
  publicIpv4 = publicIp.publicIpv4;
})();

// Store active tunnel information
const activeTunnels = new Map();

function createTunnelId() {
  return `tunnel_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function findCloudflaredBinary() {
  const candidates = [];
  const exeName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';

  // Packaged: electron-builder typically puts native deps in app.asar.unpacked
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'cloudflared', 'bin', exeName));
  }

  // Dev: from repo root
  candidates.push(path.join(__dirname, '..', '..', '..', 'node_modules', 'cloudflared', 'bin', exeName));

  // Fallbacks
  candidates.push(path.join(process.cwd(), 'node_modules', 'cloudflared', 'bin', exeName));

  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {
      // ignore
    }
  }

  // Last resort: PATH
  return 'cloudflared';
}

function serializeTunnel(tunnel) {
  return {
    id: tunnel.id,
    provider: tunnel.provider,
    status: tunnel.url ? 'active' : 'inactive',
    url: tunnel.url,
    port: tunnel.port,
    serverId: tunnel.serverId,
    startedAt: tunnel.startedAt,
  };
}

async function stopTunnelById(tunnelId) {
  const tunnel = activeTunnels.get(tunnelId);
  if (!tunnel) {
    return false;
  }

  // Stop Cloudflare tunnel process
  if (tunnel.process && tunnel.process.pid) {
    await new Promise((resolve) => {
      kill(tunnel.process.pid, 'SIGTERM', (err) => {
        if (err) {
          console.error('[NETWORK] Error killing cloudflared:', err);
          kill(tunnel.process.pid, 'SIGKILL');
        }
        resolve();
      });
    });
  }

  // Stop Ngrok tunnel
  if (tunnel.ngrokListener) {
    try {
      await tunnel.ngrokListener.close();
      console.log('[NGROK] Listener closed');
    } catch (error) {
      console.error('[NGROK] Error closing listener:', error);
    }
  }

  activeTunnels.delete(tunnelId);
  return true;
}

function getFirstActiveTunnel() {
  const first = activeTunnels.values().next();
  return first.done ? null : first.value;
}

function checkTcpConnect(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch (e) {
        // ignore
      }
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));

    socket.connect(port, host);
  });
}

async function assertLocalBackendReachable(port) {
  const okLocalhost = await checkTcpConnect('localhost', port);
  if (okLocalhost) return;

  const okLoopback = await checkTcpConnect('127.0.0.1', port);
  if (okLoopback) return;

  const error = new Error(`No service is reachable at http://localhost:${port}. Start the server and verify it is listening on that port.`);
  error.code = 'LOCAL_BACKEND_UNREACHABLE';
  error.metadata = { port };
  throw error;
}

// Get network status
router.get('/status', async (req, res) => {
  try {
    const publicIp = publicIpv4 ? await publicIpv4().catch(() => null) : null;

    const tunnels = Array.from(activeTunnels.values()).map(serializeTunnel);

    res.json({
      tunnelActive: activeTunnels.size > 0,
      publicIp: publicIp,
      activeConnections: activeTunnels.size,
      provider: tunnels[0]?.provider || null,
      serverId: tunnels[0]?.serverId || null,
      tunnels,
    });
  } catch (error) {
    console.error('[NETWORK] Error getting status:', error);
    res.json({
      tunnelActive: false,
      publicIp: null,
      activeConnections: 0,
      tunnels: [],
    });
  }
});

// Get tunnel configuration
router.get('/tunnel', (req, res) => {
  const tunnel = getFirstActiveTunnel();
  res.json({
    provider: tunnel?.provider || 'none',
    status: tunnel?.url ? 'active' : 'inactive',
    url: tunnel?.url || null,
    port: tunnel?.port || null,
    serverId: tunnel?.serverId || null,
  });
});

// List active tunnels
router.get('/tunnels', (req, res) => {
  res.json({
    tunnels: Array.from(activeTunnels.values()).map(serializeTunnel),
  });
});

// Start Ngrok tunnel
async function startNgrokTunnel(port, authtoken) {
  try {
    console.log('[NGROK] Starting tunnel on port', port);

    // Configure ngrok
    const config = {
      addr: port,
      authtoken_from_env: false,
    };

    if (authtoken) {
      config.authtoken = authtoken;
    }

    // Start ngrok listener
    const listener = await ngrok.forward(config);
    const url = listener.url();

    console.log('[NGROK] Tunnel established:', url);

    return {
      url: url,
      listener: listener,
    };
  } catch (error) {
    console.error('[NGROK] Failed to start tunnel:', error);
    throw error;
  }
}

// Start Cloudflare tunnel
function startCloudflaredTunnel(port) {
  return new Promise((resolve, reject) => {
    console.log('[CLOUDFLARE] Starting tunnel on port', port);

    try {
      const cloudflaredPath = findCloudflaredBinary();
      // Start cloudflared process
      const cloudflared = spawn(cloudflaredPath, [
        'tunnel',
        '--url', `http://localhost:${port}`,
        '--no-autoupdate'
      ], {
        windowsHide: true,
      });

      let tunnelUrl = null;
      let errorOutput = '';

      cloudflared.stdout.on('data', (data) => {
        const output = data.toString();
        console.log('[CLOUDFLARE]', output);

        // Extract tunnel URL from output
        const urlMatch = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (urlMatch && !tunnelUrl) {
          tunnelUrl = urlMatch[0];
          console.log('[CLOUDFLARE] Tunnel established:', tunnelUrl);
          resolve({
            url: tunnelUrl,
            process: cloudflared,
          });
        }
      });

      cloudflared.stderr.on('data', (data) => {
        const output = data.toString();
        console.error('[CLOUDFLARE] Error:', output);
        errorOutput += output;

        // Also check stderr for URL
        const urlMatch = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (urlMatch && !tunnelUrl) {
          tunnelUrl = urlMatch[0];
          console.log('[CLOUDFLARE] Tunnel established:', tunnelUrl);
          resolve({
            url: tunnelUrl,
            process: cloudflared,
          });
        }
      });

      cloudflared.on('error', (error) => {
        console.error('[CLOUDFLARE] Process error:', error);
        reject(new Error('Failed to start cloudflared: ' + error.message));
      });

      cloudflared.on('close', (code) => {
        console.log('[CLOUDFLARE] Process exited with code', code);
        if (!tunnelUrl) {
          reject(new Error('Cloudflared exited without providing tunnel URL. Make sure cloudflared is installed.'));
        }
      });

      // Timeout after 30 seconds
      setTimeout(() => {
        if (!tunnelUrl) {
          cloudflared.kill();
          reject(new Error('Cloudflared tunnel timeout. Make sure cloudflared is installed and accessible.'));
        }
      }, 30000);

    } catch (error) {
      reject(error);
    }
  });
}

// Start tunnel
router.post('/tunnel/start', restrictionMiddleware('manage_network'), async (req, res) => {
  const { serverId, provider, authtoken } = req.body;

  console.log('[NETWORK] Starting tunnel request:', { serverId, provider });

  if (!serverId || !provider) {
    return res.status(400).json({ error: 'Missing serverId or provider' });
  }

  try {
    // Get server details
    const db = getDatabase();

    const activeAccountId = getActiveAccountId(db);
    if (!activeAccountId) {
      return res.status(400).json({ error: 'No active account set' });
    }

    const stmt = db.prepare('SELECT * FROM servers WHERE id = ?');
    const server = stmt.get(serverId);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    if (!canAccessServer(db, activeAccountId, server, 'control')) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    if (server.status !== 'running') {
      return res.status(400).json({ error: 'Server must be running to start tunnel' });
    }

    // Get actual active port from ProcessRegistry (supports Bridged Ports)
    const runtimeData = processRegistry.get(serverId);
    const port = runtimeData?.bridgedPort || server.port || 3000;

    try {
      await assertLocalBackendReachable(port);
    } catch (e) {
      return res.status(400).json({
        error: e.message,
        details: 'Your server may not be running, may be on a different port, or may be bound to a different interface. Try opening it locally first in your browser.'
      });
    }

    // Start appropriate tunnel
    let tunnelResult;
    const tunnelId = createTunnelId();
    const tunnelState = {
      id: tunnelId,
      process: null,
      url: null,
      provider: provider,
      serverId: serverId,
      port: port,
      ngrokListener: null,
      startedAt: new Date().toISOString(),
    };

    if (provider === 'ngrok') {
      tunnelResult = await startNgrokTunnel(port, authtoken);
      tunnelState.url = tunnelResult.url;
      tunnelState.ngrokListener = tunnelResult.listener;
      tunnelState.process = null;
    } else if (provider === 'cloudflare') {
      tunnelResult = await startCloudflaredTunnel(port);
      tunnelState.url = tunnelResult.url;
      tunnelState.process = tunnelResult.process;
      tunnelState.ngrokListener = null;
    } else {
      return res.status(400).json({ error: 'Invalid provider. Use "ngrok" or "cloudflare"' });
    }

    activeTunnels.set(tunnelId, tunnelState);

    console.log('[NETWORK] Tunnel started successfully:', tunnelState.url);

    res.json({
      message: 'Tunnel started successfully',
      id: tunnelId,
      url: tunnelState.url,
      provider: provider,
      port: port,
    });

  } catch (error) {
    console.error('[NETWORK] Failed to start tunnel:', error);

    res.status(500).json({
      error: 'Failed to start tunnel: ' + error.message,
      details: error.message.includes('cloudflared')
        ? 'Make sure cloudflared is installed. Download from: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/'
        : error.message.includes('authtoken')
          ? 'Invalid or missing Ngrok authtoken. Get one from: https://dashboard.ngrok.com/get-started/your-authtoken'
          : error.message
    });
  }
});

// Start additional tunnel (multi)
router.post('/tunnels/start', restrictionMiddleware('manage_network'), async (req, res) => {
  const { serverId, provider, authtoken } = req.body;

  console.log('[NETWORK] Starting tunnel (multi) request:', { serverId, provider });

  if (!serverId || !provider) {
    return res.status(400).json({ error: 'Missing serverId or provider' });
  }

  try {
    const db = getDatabase();

    const activeAccountId = getActiveAccountId(db);
    if (!activeAccountId) {
      return res.status(400).json({ error: 'No active account set' });
    }

    const stmt = db.prepare('SELECT * FROM servers WHERE id = ?');
    const server = stmt.get(serverId);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    if (!canAccessServer(db, activeAccountId, server, 'control')) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    if (server.status !== 'running') {
      return res.status(400).json({ error: 'Server must be running to start tunnel' });
    }

    // Get actual active port (supports Bridged Ports)
    const runtimeData = processRegistry.get(serverId);
    const port = runtimeData?.bridgedPort || server.port || 3000;

    try {
      await assertLocalBackendReachable(port);
    } catch (e) {
      return res.status(400).json({
        error: e.message,
        details: 'Your server may not be running, may be on a different port, or may be bound to a different interface. Try opening it locally first in your browser.'
      });
    }

    let tunnelResult;
    const tunnelId = createTunnelId();
    const tunnelState = {
      id: tunnelId,
      process: null,
      url: null,
      provider: provider,
      serverId: serverId,
      port: port,
      ngrokListener: null,
      startedAt: new Date().toISOString(),
    };

    if (provider === 'ngrok') {
      tunnelResult = await startNgrokTunnel(port, authtoken);
      tunnelState.url = tunnelResult.url;
      tunnelState.ngrokListener = tunnelResult.listener;
    } else if (provider === 'cloudflare') {
      tunnelResult = await startCloudflaredTunnel(port);
      tunnelState.url = tunnelResult.url;
      tunnelState.process = tunnelResult.process;
    } else {
      return res.status(400).json({ error: 'Invalid provider. Use "ngrok" or "cloudflare"' });
    }

    activeTunnels.set(tunnelId, tunnelState);

    res.json({
      message: 'Tunnel started successfully',
      id: tunnelId,
      url: tunnelState.url,
      provider: provider,
      port: port,
    });
  } catch (error) {
    console.error('[NETWORK] Failed to start tunnel:', error);

    res.status(500).json({
      error: 'Failed to start tunnel: ' + error.message,
      details: error.message.includes('cloudflared')
        ? 'Make sure cloudflared is installed. Download from: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/'
        : error.message.includes('authtoken')
          ? 'Invalid or missing Ngrok authtoken. Get one from: https://dashboard.ngrok.com/get-started/your-authtoken'
          : error.message,
    });
  }
});

// Stop tunnel
router.post('/tunnel/stop', async (req, res) => {
  console.log('[NETWORK] Stopping tunnel');

  const tunnel = getFirstActiveTunnel();
  if (!tunnel) {
    return res.json({ message: 'No active tunnel to stop' });
  }

  try {
    await stopTunnelById(tunnel.id);
    console.log('[NETWORK] Tunnel stopped successfully');
    res.json({ message: 'Tunnel stopped successfully' });
  } catch (error) {
    console.error('[NETWORK] Error stopping tunnel:', error);
    res.status(500).json({ error: 'Error stopping tunnel: ' + error.message });
  }
});

// Stop a specific tunnel by id
router.post('/tunnels/:tunnelId/stop', async (req, res) => {
  const { tunnelId } = req.params;
  console.log('[NETWORK] Stopping tunnel', tunnelId);

  try {
    const stopped = await stopTunnelById(tunnelId);
    if (!stopped) {
      return res.status(404).json({ error: 'Tunnel not found or not active' });
    }
    res.json({ message: 'Tunnel stopped successfully' });
  } catch (error) {
    console.error('[NETWORK] Error stopping tunnel:', error);
    res.status(500).json({ error: 'Error stopping tunnel: ' + error.message });
  }
});

// Save tunnel authtoken/config
router.post('/tunnel/config', (req, res) => {
  const { provider, authtoken } = req.body;

  if (!provider) {
    return res.status(400).json({ error: 'Provider is required' });
  }

  try {
    const db = getDatabase();

    const stmt = db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`);
    stmt.run(`tunnel_${provider}_token`, authtoken || '');
    res.json({ message: 'Configuration saved successfully' });
  } catch (error) {
    console.error('[NETWORK] Error saving config:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/cache-directory', (req, res) => {
  const { directoryPath } = req.body;

  try {
    const db = getDatabase();
    const value = directoryPath ? directoryPath : '';
    const stmt = db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`);
    stmt.run('network_cache_directory', value);
    res.json({ message: 'Cache directory updated', cacheDirectory: directoryPath || null });
  } catch (error) {
    console.error('[NETWORK] Error saving cache directory:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/cache-directory', (req, res) => {
  try {
    const db = getDatabase();
    const stmt = db.prepare(`SELECT value FROM settings WHERE key = ?`);
    const row = stmt.get('network_cache_directory');

    const defaultDir = getNetworkCacheDefaultDir();
    res.json({
      cacheDirectory: row?.value || '',
      defaultCacheDirectory: defaultDir,
    });
  } catch (error) {
    console.error('[NETWORK] Error reading cache directory:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get saved tunnel config
router.get('/tunnel/config/:provider', (req, res) => {
  const { provider } = req.params;

  try {
    const db = getDatabase();

    const stmt = db.prepare(`SELECT value FROM settings WHERE key = ?`);
    const row = stmt.get(`tunnel_${provider}_token`);
    res.json({
      provider: provider,
      authtoken: row ? row.value : null,
      configured: !!row?.value
    });
  } catch (error) {
    console.error('[NETWORK] Error getting config:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
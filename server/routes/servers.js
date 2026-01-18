const express = require('express');
const router = express.Router();
const { getDatabase, getDatabasePath } = require('../lib/database');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { getEggsDir, getLegacyAppDir, getRuntimesDir } = require('../lib/paths');
const { getTemplateById } = require('../services/templates-store');
const kill = require('tree-kill');
const crypto = require('crypto');
const si = require('systeminformation');
const net = require('net');
const { RemoteNodeManager } = require('../services/remote-management');
const { ensureUserForServer, applyFolderAcl, ensureFirewallRule } = require('../services/os-isolation');
const { jobManager } = require('../services/process-limits');
const AuditService = require('../services/AuditService');
const processRegistry = require('../services/ProcessRegistry');
const discordNotifier = require('../services/discord-notifier');
const { authMiddleware, adminRestrictionMiddleware } = require('./auth');
const { restrictionMiddleware } = require('../utils/restrictions');
const CoreOrchestrator = require('../services/CoreOrchestrator');

// Apply auth middleware to all routes
router.use(authMiddleware);
router.use(adminRestrictionMiddleware);

function safeReadJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function normalizeServerRowForResponse(row) {
  if (!row || typeof row !== 'object') return row;

  const normalized = { ...row };
  normalized.execution_mode = 'native';

  // Include bridged port if active
  const runtimeData = processRegistry.get(row.id);
  if (runtimeData && runtimeData.bridgedPort) {
    normalized.bridged_port = runtimeData.bridgedPort;
  }

  // Ensure metadata is always valid JSON for the renderer (older DB rows may contain null/invalid JSON).
  let meta = {};
  try {
    meta = normalized.metadata ? JSON.parse(normalized.metadata) : {};
    if (!meta || typeof meta !== 'object') meta = {};
  } catch {
    meta = {};
  }

  normalized.metadata = JSON.stringify(meta);
  return normalized;
}

function listEggsFromDir(dirPath) {
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const eggs = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const eggDir = path.join(dirPath, ent.name);
    const eggJsonPath = path.join(eggDir, 'egg.json');
    if (!fs.existsSync(eggJsonPath)) continue;
    try {
      const egg = safeReadJson(eggJsonPath);
      if (!egg || typeof egg !== 'object') continue;
      const id = String(egg.id || ent.name);
      eggs.push({
        id,
        source_format: egg.source_format || 'void',
        ptdl: egg.ptdl || null,
      });
    } catch {
      // ignore
    }
  }
  return eggs;
}

function getEggDirs() {
  const dirs = [];
  try {
    dirs.push(path.join(process.cwd(), 'assets', 'eggs'));
  } catch {
    // ignore
  }
  if (process.resourcesPath) {
    try {
      dirs.push(path.join(process.resourcesPath, 'assets', 'eggs'));
    } catch {
      // ignore
    }
  }
  try {
    const appDir = path.join(path.dirname(process.execPath || process.cwd()), 'eggs');
    dirs.push(appDir);
  } catch {
    // ignore
  }
  try {
    const preferredOrLegacy = getEggsDir();
    dirs.push(preferredOrLegacy);
    // If both exist separately (rare), include both for maximum compatibility.
    try {
      const legacy = path.join(getLegacyAppDir(), 'eggs');
      if (legacy && legacy !== preferredOrLegacy) dirs.push(legacy);
    } catch {
      // ignore
    }
  } catch {
    // ignore
  }

  return Array.from(new Set(dirs)).filter((p) => {
    try {
      return fs.existsSync(p) && fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
}

function getPtdlInstallFromEggId(eggId) {
  const dirs = getEggDirs();
  for (const root of dirs) {
    const eggDirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const d of eggDirs) {
      const eggJsonPath = path.join(root, d.name, 'egg.json');
      if (!fs.existsSync(eggJsonPath)) continue;
      try {
        const egg = safeReadJson(eggJsonPath);
        const id = String(egg?.id || d.name);
        if (String(id) !== String(eggId)) continue;
        const isPtdl = String(egg?.source_format || '') === 'pterodactyl';
        const script = egg?.ptdl?.installation?.script;
        if (!isPtdl || !script) return null;
        return {
          script: String(script),
          container: egg?.ptdl?.installation?.container || null,
          entrypoint: egg?.ptdl?.installation?.entrypoint || null,
        };
      } catch {
        // ignore
      }
    }
  }
  return null;
}

function bashEscape(value) {
  return `'${String(value ?? '').replace(/'/g, `'"'"'`)}'`;
}

function windowsPathToWsl(p) {
  const raw = String(p || '').trim();
  if (!raw) return '';
  const m = raw.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!m) return '';
  const drive = m[1].toLowerCase();
  const rest = m[2].replace(/\\/g, '/');
  return `/mnt/${drive}/${rest}`;
}

function ensureDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function getPtdlInstallFromServerMetadata(serverRow) {
  if (!serverRow?.metadata) return null;
  try {
    const meta = JSON.parse(serverRow.metadata);
    const egg = meta?.egg;
    const isPtdl = egg && String(egg.source_format || '') === 'pterodactyl';
    const script = egg?.ptdl?.installation?.script;
    if (!isPtdl || !script) return null;
    return {
      script: String(script),
      container: egg?.ptdl?.installation?.container || null,
      entrypoint: egg?.ptdl?.installation?.entrypoint || null,
    };
  } catch {
    return null;
  }
}

function getEggIdFromServerType(serverRow) {
  const type = String(serverRow?.type || '');
  if (!type.startsWith('egg:')) return null;
  const id = type.slice('egg:'.length).trim();
  return id || null;
}

function getTemplateIdFromServerType(serverRow) {
  const type = String(serverRow?.type || '');
  if (type.startsWith('template:')) {
    const id = type.slice('template:'.length).trim();
    return id || null;
  }
  // Backward compatibility: old egg:* servers are treated as templates.
  if (type.startsWith('egg:')) {
    const id = type.slice('egg:'.length).trim();
    return id || null;
  }
  return null;
}

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
        sessionId: r.session_id,
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

function canAccessServer(db, activeAccountId, serverRow, requiredAction = 'view', userRole = 'user') {
  if (userRole === 'admin') return true;
  if (!activeAccountId || !serverRow) return false;

  // Check ownership
  if (serverRow.panel_user_id && Number(serverRow.panel_user_id) === Number(activeAccountId)) return true;

  return false;
}

function getUserIdentity(db, accountId) {
  try {
    const row = db.prepare('SELECT display_name, email FROM accounts WHERE id = ?').get(accountId);
    if (!row) return String(accountId);
    return row.email ? `${row.display_name} (${row.email})` : row.display_name;
  } catch {
    return String(accountId);
  }
}

// Use centralized ProcessRegistry
// const runningProcesses = new Map();
// const stoppingProcesses = new Set();
const runningProcesses = processRegistry.processes;
const stoppingProcesses = processRegistry.stopping;

const folderSizeCache = new Map();
const FOLDER_SIZE_CACHE_TTL_MS = 30_000;

const limitBreachCounts = new Map();
const LIMIT_POLL_INTERVAL_MS = 2000;
const LIMIT_BREACH_THRESHOLD = 3;

const AUTO_PORT_RANGE = { start: 20000, end: 45000 };

async function isPortBindable(port) {
  return await new Promise((resolve) => {
    if (!port || !Number.isFinite(Number(port))) return resolve(false);
    const srv = net.createServer();
    srv.unref();
    srv.on('error', () => resolve(false));
    srv.listen({ port: Number(port), host: '127.0.0.1' }, () => {
      try {
        srv.close(() => resolve(true));
      } catch {
        resolve(true);
      }
    });
  });
}

function toIntOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseServerMetadata(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function getRuntimeDir() {
  try {
    const root = getRuntimesDir();
    try {
      fs.mkdirSync(root, { recursive: true });
    } catch {
      // ignore
    }
    return root;
  } catch {
    return null;
  }
}

async function ensureServerIsolationPolicy(serverRow) {
  if (!serverRow) return;
  const isolationEnabled = Boolean(serverRow.isolation_enabled);
  if (!isolationEnabled) return;

  const runtimeDir = getRuntimeDir();
  if (!runtimeDir) return;

  const user = await ensureUserForServer({ serverId: serverRow.id, runtimeDir });
  if (user?.supported && user?.username) {
    await applyFolderAcl({ folderPath: serverRow.path, username: user.username });
    try {
      const db = getDatabase();
      const meta = parseServerMetadata(serverRow.metadata);
      meta.runtime_isolation = Object.assign({}, meta.runtime_isolation, {
        username: user.username,
      });
      db.prepare('UPDATE servers SET metadata = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(JSON.stringify(meta), serverRow.id);
    } catch {
      // ignore
    }
  }
}

async function applyServerFirewallPolicy(serverRow) {
  if (!serverRow) return;
  const hasPort = serverRow.port && Number.isFinite(Number(serverRow.port));
  const port = hasPort ? Number(serverRow.port) : null;
  await ensureFirewallRule({
    serverId: serverRow.id,
    port,
    enabled: Boolean(serverRow.public_access),
  });
}

async function allocatePort(db, preferredRange = AUTO_PORT_RANGE) {
  const start = Number(preferredRange?.start) || AUTO_PORT_RANGE.start;
  const end = Number(preferredRange?.end) || AUTO_PORT_RANGE.end;

  const rows = db.prepare('SELECT port FROM servers WHERE port IS NOT NULL').all();
  const used = new Set((rows || []).map((r) => Number(r.port)).filter((n) => Number.isFinite(n)));

  // Try random probes first for speed.
  for (let i = 0; i < 120; i += 1) {
    const candidate = start + Math.floor(Math.random() * (end - start + 1));
    if (used.has(candidate)) continue;
    // Also ensure OS bindability.
    // eslint-disable-next-line no-await-in-loop
    const ok = await isPortBindable(candidate);
    if (!ok) continue;
    return candidate;
  }

  // Fallback scan.
  for (let p = start; p <= end; p += 1) {
    if (used.has(p)) continue;
    // eslint-disable-next-line no-await-in-loop
    const ok = await isPortBindable(p);
    if (!ok) continue;
    return p;
  }

  return null;
}

function extractRssBytes(proc) {
  const memRssRaw =
    typeof proc?.memRss === 'number' ? proc.memRss :
      typeof proc?.mem_rss === 'number' ? proc.mem_rss :
        typeof proc?.memRssBytes === 'number' ? proc.memRssBytes :
          0;

  return memRssRaw > 0 && memRssRaw < 1024 * 1024 * 1024 ? memRssRaw * 1024 : memRssRaw;
}

async function getFolderSizeBytes(rootPath) {
  if (!rootPath) return 0;
  if (!fs.existsSync(rootPath)) return 0;

  const cached = folderSizeCache.get(rootPath);
  if (cached && (Date.now() - cached.at) < FOLDER_SIZE_CACHE_TTL_MS) {
    return cached.size;
  }

  let total = 0;
  const stack = [rootPath];

  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }

      if (entry.isFile()) {
        try {
          const st = await fs.promises.stat(full);
          total += typeof st.size === 'number' ? st.size : 0;
        } catch {
          // ignore
        }
      }
    }
  }

  folderSizeCache.set(rootPath, { size: total, at: Date.now() });
  return total;
}

function ensureLogDir(serverPath) {
  const logPath = path.join(serverPath, 'logs');
  if (!fs.existsSync(logPath)) {
    fs.mkdirSync(logPath, { recursive: true });
  }
  return logPath;
}

function appendServerLog(serverPath, line) {
  try {
    const logPath = ensureLogDir(serverPath);
    fs.appendFileSync(path.join(logPath, 'output.log'), line);
  } catch {
    // ignore
  }
}

function parseEnvVars(server) {
  const raw = server?.env_vars;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
}

function resolveTemplateVars(input, vars) {
  const s = String(input || '');
  if (!s) return s;
  const map = vars && typeof vars === 'object' ? vars : {};
  return s.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, key) => {
    const v = map[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

async function getProcessTreeUsage(pid) {
  if (!pid || Number.isNaN(Number(pid))) {
    return { cpu: 0, rssBytes: 0 };
  }

  const procData = await si.processes();
  const list = procData?.list || [];
  const mainPid = Number(pid);
  const mainProc = list.find(p => Number(p.pid) === mainPid);
  const childProcs = list.filter(p => {
    const ppid = typeof p.ppid === 'number' ? p.ppid : (typeof p.parentPid === 'number' ? p.parentPid : null);
    return ppid !== null && Number(ppid) === mainPid;
  });

  const procsToSum = (mainProc ? [mainProc] : []).concat(childProcs);
  const cpu = procsToSum.reduce((sum, p) => sum + (typeof p.cpu === 'number' ? p.cpu : 0), 0);
  const rssBytes = procsToSum.reduce((sum, p) => sum + extractRssBytes(p), 0);
  return { cpu, rssBytes };
}

async function stopServerInternal(serverId, reason, userIdentity) {
  const db = getDatabase();

  let serverRow;
  try {
    serverRow = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
  } catch {
    serverRow = null;
  }

  const serverProcessData = runningProcesses.get(serverId);
  const serverProcess = serverProcessData?.process;
  if (serverRow?.path && reason) {
    appendServerLog(serverRow.path, `\n[${new Date().toISOString()}] STOP (policy) ${reason}\n`);
    AuditService.log(serverId, 'SERVER_STOP', userIdentity || 'system', `Stopped due to policy: ${reason}`);
  }

  if (serverRow && reason) {
    try {
      const meta = parseServerMetadata(serverRow.metadata);
      meta.last_stop = {
        reason: String(reason),
        at: new Date().toISOString(),
        type: 'policy',
      };
      db.prepare('UPDATE servers SET metadata = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(JSON.stringify(meta), serverId);
    } catch {
      // ignore
    }
  }

  // Use existing serverProcessData from above
  const pid = serverProcessData?.process?.pid;

  if (pid) {
    try {
      await new Promise((resolve) => {
        kill(pid, 'SIGTERM', (err) => {
          if (err) {
            try {
              kill(pid, 'SIGKILL');
            } catch {
              // ignore
            }
          }
          resolve();
        });
      });
    } catch {
      // ignore
    }
  }

  try {
    runningProcesses.delete(serverId);
  } catch {
    // ignore
  }
  try {
    limitBreachCounts.delete(serverId);
  } catch {
    // ignore
  }

  try {
    db.prepare('UPDATE servers SET status = ?, pid = NULL WHERE id = ?').run('stopped', serverId);
  } catch {
    // ignore
  }
}

async function pollAndEnforceLimits() {
  if (runningProcesses.size === 0) return;

  const db = getDatabase();
  const entries = Array.from(runningProcesses.entries());

  for (const [serverId, child] of entries) {
    let row;
    try {
      row = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
    } catch {
      row = null;
    }
    if (!row) continue;
    if (row.status !== 'running') continue;

    const isolationEnabled = Boolean(row.isolation_enabled);
    const cpuLimit = typeof row.cpu_limit_percent === 'number' ? row.cpu_limit_percent : (row.cpu_limit_percent ? Number(row.cpu_limit_percent) : null);
    const memLimitMb = typeof row.memory_limit_mb === 'number' ? row.memory_limit_mb : (row.memory_limit_mb ? Number(row.memory_limit_mb) : null);

    if (!isolationEnabled || (!cpuLimit && !memLimitMb)) {
      limitBreachCounts.delete(serverId);
      continue;
    }

    let usage;
    try {
      usage = await getProcessTreeUsage(child?.process?.pid);
    } catch {
      usage = { cpu: 0, rssBytes: 0 };
    }

    const breaches = [];
    if (cpuLimit && usage.cpu > cpuLimit) {
      breaches.push(`CPU ${usage.cpu.toFixed(1)}% > ${cpuLimit}%`);
    }
    if (memLimitMb) {
      const rssMb = usage.rssBytes / (1024 * 1024);
      if (rssMb > memLimitMb) {
        breaches.push(`RAM ${rssMb.toFixed(0)}MB > ${memLimitMb}MB`);
      }
    }

    if (breaches.length === 0) {
      limitBreachCounts.delete(serverId);
      continue;
    }

    const nextCount = (limitBreachCounts.get(serverId) || 0) + 1;
    limitBreachCounts.set(serverId, nextCount);

    if (nextCount >= LIMIT_BREACH_THRESHOLD) {
      await stopServerInternal(serverId, `Resource limit exceeded (${breaches.join(', ')})`, 'system');
    }
  }
}

setInterval(() => {
  pollAndEnforceLimits().catch(() => null);
}, LIMIT_POLL_INTERVAL_MS);

// Utility: Find a free port
router.get('/utils/free-port', async (req, res) => {
  try {
    const db = getDatabase();
    const port = await allocatePort(db);
    if (!port) {
      return res.status(500).json({ error: 'Could not allocate a free port' });
    }
    res.json({ port });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all servers
// Get all servers
router.get('/', (req, res) => {
  try {
    const db = getDatabase();
    let servers;

    // Admin sees all, users see their own
    if (req.user.role === 'admin') {
      servers = db.prepare('SELECT * FROM servers ORDER BY created_at DESC').all();
    } else {
      servers = db.prepare('SELECT * FROM servers WHERE panel_user_id = ? ORDER BY created_at DESC').all(req.user.id);
    }

    res.json(servers.map(normalizeServerRowForResponse));
  } catch (err) {
    console.error('[SERVERS] List error:', err);
    res.status(500).json({ error: 'Failed to list servers' });
  }
});

router.post('/:id/install', restrictionMiddleware(), async (req, res) => {
  const serverId = req.params.id;
  const db = getDatabase();
  const activeAccountId = req.user.id;

  try {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (!canAccessServer(db, activeAccountId, server, 'control', req.user.role)) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    // 6. Install Phase
    await CoreOrchestrator.runInstall(serverId);
    res.json({ message: 'Install finished successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/resources', async (req, res) => {
  const serverId = req.params.id;
  const db = getDatabase();

  const activeAccountId = req.user.id;
  if (!activeAccountId) {
    return res.status(400).json({ error: 'No active account set' });
  }

  const getDiskForPath = async (targetPath) => {
    if (!targetPath) return { total: 0, used: 0, free: 0, mount: null, server_used_bytes: 0 };
    const root = path.parse(targetPath).root;
    const driveLetter = String(root || '').trim().slice(0, 2).toUpperCase(); // e.g. "C:"
    if (!driveLetter || !driveLetter.endsWith(':')) {
      const serverUsed = await getFolderSizeBytes(targetPath);
      return { total: 0, used: 0, free: 0, mount: null, server_used_bytes: serverUsed };
    }

    const driveTokens = [driveLetter, `${driveLetter}\\`, `${driveLetter}/`].map(s => s.toUpperCase());

    const sizes = await si.fsSize();
    const match = (sizes || []).find((d) => {
      const fsRaw = String(d?.fs || '').toUpperCase();
      const mountRaw = String(d?.mount || '').toUpperCase();
      return driveTokens.some(tok => fsRaw === tok || fsRaw.startsWith(tok) || mountRaw === tok || mountRaw.startsWith(tok));
    });

    if (match) {
      const total = typeof match.size === 'number' ? match.size : 0;
      const used = typeof match.used === 'number' ? match.used : 0;
      const free = typeof match.available === 'number' ? match.available : Math.max(0, total - used);
      const serverUsed = await getFolderSizeBytes(targetPath);
      return { total, used, free, mount: match.mount || match.fs || driveLetter, server_used_bytes: serverUsed };
    }

    // Fallback: fsStats has global totals; return those instead of zeros.
    try {
      const stats = await si.fsStats();
      const total = typeof stats?.total === 'number' ? stats.total : 0;
      const used = typeof stats?.used === 'number' ? stats.used : 0;
      const free = typeof stats?.free === 'number' ? stats.free : Math.max(0, total - used);
      const serverUsed = await getFolderSizeBytes(targetPath);
      return { total, used, free, mount: driveLetter, server_used_bytes: serverUsed };
    } catch {
      const serverUsed = await getFolderSizeBytes(targetPath);
      return { total: 0, used: 0, free: 0, mount: driveLetter, server_used_bytes: serverUsed };
    }
  };

  try {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    if (!canAccessServer(db, activeAccountId, server, 'view', req.user.role)) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const trackedProcessData = runningProcesses.get(serverId);
    const trackedPid = trackedProcessData?.process?.pid ? Number(trackedProcessData.process.pid) : null;

    const dbPid = server.pid ? Number(server.pid) : null;
    const pid = trackedPid || dbPid;
    const status = server.status || (pid ? 'running' : 'stopped');
    const timestamp = new Date().toISOString();

    const disk = await getDiskForPath(server.path);

    if (!pid || Number.isNaN(pid)) {
      return res.json({
        server_id: server.id,
        status: status,
        pid: null,
        timestamp,
        cpu: { usage: 0 },
        memory: { rss: 0, percentage: 0 },
        disk,
      });
    }

    const [procData, mem] = await Promise.all([
      si.processes(),
      si.mem(),
    ]);

    const list = procData?.list || [];
    const mainProc = list.find(p => Number(p.pid) === pid);

    // On Windows when starting with shell=true, the tracked PID can be cmd.exe and the actual workload is a child.
    const childProcs = list.filter(p => {
      const ppid = typeof p.ppid === 'number' ? p.ppid : (typeof p.parentPid === 'number' ? p.parentPid : null);
      return ppid !== null && Number(ppid) === pid;
    });

    const procsToSum = (mainProc ? [mainProc] : []).concat(childProcs);
    const foundAny = procsToSum.length > 0;

    if (!foundAny) {
      // If the DB thinks it's running but we cannot see the process, reconcile state.
      if (server.status === 'running') {
        try {
          db.prepare('UPDATE servers SET status = ?, pid = NULL WHERE id = ?').run('stopped', serverId);
        } catch {
          // ignore
        }
      }

      try {
        runningProcesses.delete(serverId);
      } catch {
        // ignore
      }

      return res.json({
        server_id: server.id,
        status: 'stopped',
        pid: null,
        timestamp,
        cpu: { usage: 0 },
        memory: { rss: 0, percentage: 0 },
        disk,
      });
    }

    const cpuUsage = procsToSum.reduce((sum, p) => sum + (typeof p.cpu === 'number' ? p.cpu : 0), 0);
    const rssBytes = procsToSum.reduce((sum, p) => sum + extractRssBytes(p), 0);
    const memPct = mem?.total ? (rssBytes / mem.total) * 100 : 0;

    const effectivePid = mainProc ? pid : Number(childProcs?.[0]?.pid || pid);

    res.json({
      server_id: server.id,
      status: 'running',
      pid: effectivePid,
      timestamp,
      cpu: {
        usage: cpuUsage,
      },
      memory: {
        rss: rssBytes,
        percentage: memPct,
      },
      disk,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single server
router.get('/:id', (req, res) => {
  try {
    const db = getDatabase();

    const activeAccountId = req.user.id;
    if (!activeAccountId) {
      return res.status(400).json({ error: 'No active account set' });
    }

    const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!row) {
      return res.status(404).json({ error: 'Server not found' });
    }

    if (Number(row.owner_account_id) !== Number(activeAccountId)) {
      const memberships = getAccountSessionPermissions(db, activeAccountId);
      const canView = memberships.some(
        (m) => Number(m.ownerAccountId) === Number(row.owner_account_id) && canFromSession(m.permissions, 'servers', 'view')
      );
      if (!canView) {
        return res.status(403).json({ error: 'Not allowed' });
      }
    }

    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create new server
router.post('/', restrictionMiddleware(), async (req, res) => {

  const {
    name,
    type,
    serverPath,
    command,
    port,
    publicAccess,
    subdomain,
    envVars,
    repo,
    runtime,
    notes,
    autoPort,
    launchScript,
    metadata,
    nodeId,
    executionMode,
    isolationEnabled,
    cpuLimitPercent,
    memoryLimitMb,
    diskLimitMb,
    runtimePreset,
    installCommand,
    startCommand,
  } = req.body;

  if (!name || !type || !command) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Path logic moved down to allocation

  const normalizedLabel = null;

  const db = getDatabase();

  const activeAccountId = req.user.id;
  if (!activeAccountId) {
    return res.status(400).json({ error: 'No active account set' });
  }

  // Quota Checks
  const userQuotas = db.prepare('SELECT server_limit, cpu_limit, memory_limit, disk_limit, backup_limit, port_limit FROM panel_users WHERE id = ?').get(activeAccountId);

  if (req.user.role !== 'admin') {
    // 1. Server Count Limit
    const currentServers = db.prepare('SELECT COUNT(*) as count FROM servers WHERE panel_user_id = ?').get(activeAccountId);
    if (currentServers.count >= (userQuotas?.server_limit || 0)) {
      return res.status(403).json({ error: `Server limit reached (${userQuotas.server_limit}). Contact administrator.` });
    }

    // 2. Resource Limits Capping/Validation
    const reqCpu = typeof cpuLimitPercent === 'number' ? cpuLimitPercent : Number(cpuLimitPercent || 0);
    const reqMem = typeof memoryLimitMb === 'number' ? memoryLimitMb : Number(memoryLimitMb || 0);
    const reqDisk = typeof diskLimitMb === 'number' ? diskLimitMb : Number(diskLimitMb || 0);

    if (reqCpu > (userQuotas?.cpu_limit || 0)) {
      return res.status(403).json({ error: `CPU limit exceeded. Maximum allowed: ${userQuotas.cpu_limit}%` });
    }
    if (reqMem > (userQuotas?.memory_limit || 0)) {
      return res.status(403).json({ error: `Memory limit exceeded. Maximum allowed: ${userQuotas.memory_limit}MB` });
    }
    if (reqDisk > (userQuotas?.disk_limit || 0)) {
      return res.status(403).json({ error: `Disk limit exceeded. Maximum allowed: ${userQuotas.disk_limit}MB` });
    }
  }

  // Validate node exists if specified
  if (nodeId) {
    const stmt = db.prepare('SELECT id FROM nodes WHERE id = ?');
    const row = stmt.get(nodeId);
    if (!row) {
      return res.status(400).json({ error: 'Specified node does not exist' });
    }
  }

  try {
    // 1. & 2. Validation
    await CoreOrchestrator.validate({
      name,
      image: runtimePreset || type, // Simplified mapping
      cpuLimit: cpuLimitPercent,
      memoryLimit: memoryLimitMb
    });

    // 3. Allocation
    const { containerName, defaultPath } = CoreOrchestrator.allocate();
    const finalPath = serverPath || defaultPath;

    // Use quotas if not provided (for non-admin users or simplified UI)
    const finalCpu = cpuLimitPercent !== undefined ? cpuLimitPercent : (userQuotas?.cpu_limit || 100);
    const finalMem = memoryLimitMb !== undefined ? memoryLimitMb : (userQuotas?.memory_limit || 512);
    const finalDisk = diskLimitMb !== undefined ? diskLimitMb : (userQuotas?.disk_limit || 1024);

    let resolvedPort = toIntOrNull(port);
    const wantsAutoPort = Boolean(autoPort);
    if (wantsAutoPort && !resolvedPort) {
      resolvedPort = await allocatePort(db);
      if (!resolvedPort) {
        return res.status(500).json({ error: 'Unable to allocate a free port automatically' });
      }
    }

    if (resolvedPort) {
      const exists = db.prepare('SELECT id FROM servers WHERE port = ?').get(resolvedPort);
      const bindable = await isPortBindable(resolvedPort);
      if (exists || !bindable) {
        // Allocate new port dynamically
        resolvedPort = await allocatePort(db);
        if (!resolvedPort) {
          return res.status(500).json({ error: 'Unable to allocate a free port automatically' });
        }
      }
    } else {
      resolvedPort = await allocatePort(db);
      if (!resolvedPort) {
        return res.status(500).json({ error: 'Unable to allocate a free port automatically' });
      }
    }

    // 4. Filesystem Provisioning
    await CoreOrchestrator.provisionFilesystem(finalPath, finalDisk ? finalDisk / 1024 : null);

    const stmt = db.prepare(`
      INSERT INTO servers (
        owner_account_id,
        name,
        type,
        path,
        command,
        port,
        public_access,
        subdomain,
        env_vars,
        repo,
        runtime,
        notes,
        auto_port,
        launch_script,
        metadata,
        node_id,
        execution_mode,
        isolation_enabled,
        cpu_limit_percent,
        memory_limit_mb,
        disk_limit_mb,
        runtime_preset,
        install_command,
        start_command
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const serializedEnvVars = envVars ? JSON.stringify(envVars) : null;
    const serializedRepo = repo ? JSON.stringify(repo) : null;
    const serializedMetadata = metadata ? JSON.stringify(metadata) : null;

    const result = stmt.run([
      activeAccountId,
      name.trim(),
      type,
      finalPath,
      command,
      resolvedPort,
      publicAccess ? 1 : 0,
      normalizedLabel,
      serializedEnvVars,
      serializedRepo,
      runtime || null,
      notes || null,
      wantsAutoPort ? 1 : 0,
      launchScript || null,
      serializedMetadata,
      nodeId || null,
      'docker',
      isolationEnabled ? 1 : 0,
      typeof finalCpu === 'number' ? finalCpu : finalCpu ? Number(finalCpu) : null,
      typeof finalMem === 'number' ? finalMem : finalMem ? Number(finalMem) : null,
      typeof finalDisk === 'number' ? finalDisk : finalDisk ? Number(finalDisk) : null,
      runtimePreset || null,
      installCommand || null,
      startCommand || null,
    ]);

    const lastId = result.lastInsertRowid;
    res.json({ id: lastId, message: 'Server created successfully' });
    AuditService.log(lastId, 'SERVER_CREATE', getUserIdentity(db, activeAccountId), 'Server created using CoreOrchestrator');
  } catch (error) {
    console.error('[SERVER] Failed to create server:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update server
router.put('/:id', async (req, res) => {
  const {
    name,
    type,
    serverPath,
    command,
    port,
    publicAccess,
    subdomain,
    envVars,
    repo,
    runtime,
    notes,
    autoPort,
    launchScript,
    metadata,
    nodeId,
    executionMode,
    isolationEnabled,
    cpuLimitPercent,
    memoryLimitMb,
    diskLimitMb,
    runtimePreset,
    installCommand,
    startCommand,
  } = req.body;

  const serverId = req.params.id;
  const db = getDatabase();

  const activeAccountId = req.user.id;
  if (!activeAccountId) {
    return res.status(400).json({ error: 'No active account set' });
  }

  try {
    const existingStmt = db.prepare('SELECT * FROM servers WHERE id = ?');
    const existingServer = existingStmt.get(serverId);

    if (!existingServer) {
      return res.status(404).json({ error: 'Server not found' });
    }

    if (!canAccessServer(db, activeAccountId, existingServer, 'edit', req.user.role)) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    // Quota Checks
    const userQuotas = db.prepare('SELECT cpu_limit, memory_limit, disk_limit FROM panel_users WHERE id = ?').get(activeAccountId);

    if (req.user.role !== 'admin') {
      const reqCpu = typeof cpuLimitPercent === 'number' ? cpuLimitPercent : Number(cpuLimitPercent || 0);
      const reqMem = typeof memoryLimitMb === 'number' ? memoryLimitMb : Number(memoryLimitMb || 0);
      const reqDisk = typeof diskLimitMb === 'number' ? diskLimitMb : Number(diskLimitMb || 0);

      if (reqCpu > (userQuotas?.cpu_limit || 0)) {
        return res.status(403).json({ error: `CPU limit exceeded. Maximum allowed: ${userQuotas.cpu_limit}%` });
      }
      if (reqMem > (userQuotas?.memory_limit || 0)) {
        return res.status(403).json({ error: `Memory limit exceeded. Maximum allowed: ${userQuotas.memory_limit}MB` });
      }
      if (reqDisk > (userQuotas?.disk_limit || 0)) {
        return res.status(403).json({ error: `Disk limit exceeded. Maximum allowed: ${userQuotas.disk_limit}MB` });
      }
    }

    const wantsAutoPort = autoPort !== undefined ? Boolean(autoPort) : Boolean(existingServer.auto_port);
    let resolvedPort = port !== undefined ? toIntOrNull(port) : (existingServer.port !== undefined ? toIntOrNull(existingServer.port) : null);
    if (wantsAutoPort && !resolvedPort) {
      resolvedPort = await allocatePort(db);
      if (!resolvedPort) {
        return res.status(500).json({ error: 'Unable to allocate a free port automatically' });
      }
    }

    if (resolvedPort) {
      const exists = db.prepare('SELECT id FROM servers WHERE port = ? AND id != ?').get(resolvedPort, serverId);
      if (exists) {
        return res.status(409).json({ error: `Port ${resolvedPort} is already in use by another server` });
      }

      const bindable = await isPortBindable(resolvedPort);
      if (!bindable) {
        return res.status(409).json({ error: `Port ${resolvedPort} is not available on this machine` });
      }
    }

    const nextPublicAccess = typeof publicAccess === 'boolean' ? publicAccess : Boolean(existingServer.public_access);
    const normalizedSubdomain = null;
    const shouldProvisionDns = false;

    // Validate node exists if specified
    if (nodeId !== undefined && nodeId !== null) {
      const nodeStmt = db.prepare('SELECT id FROM nodes WHERE id = ?');
      const nodeRow = nodeStmt.get(nodeId);
      if (!nodeRow) {
        return res.status(400).json({ error: 'Specified node does not exist' });
      }
    }

    const serializedEnvVars = envVars ? JSON.stringify(envVars) : existingServer.env_vars;
    const serializedRepo = repo ? JSON.stringify(repo) : existingServer.repo;
    const serializedMetadataInput = metadata ? JSON.stringify(metadata) : existingServer.metadata;

    const updateStmt = db.prepare(
      `UPDATE servers SET
        name = ?,
        type = ?,
        path = ?,
        command = ?,
        port = ?,
        public_access = ?,
        subdomain = ?,
        env_vars = ?,
        repo = ?,
        runtime = ?,
        notes = ?,
        auto_port = ?,
        launch_script = ?,
        metadata = ?,
        node_id = ?,
        execution_mode = ?,
        isolation_enabled = ?,
        cpu_limit_percent = ?,
        memory_limit_mb = ?,
        disk_limit_mb = ?,
        runtime_preset = ?,
        install_command = ?,
        start_command = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`
    );

    updateStmt.run([
      name?.trim() ?? existingServer.name,
      type ?? existingServer.type,
      serverPath ?? existingServer.path,
      command ?? existingServer.command,
      resolvedPort,
      nextPublicAccess ? 1 : 0,
      normalizedSubdomain,
      serializedEnvVars,
      serializedRepo,
      runtime ?? existingServer.runtime,
      notes ?? existingServer.notes,
      wantsAutoPort ? 1 : 0,
      launchScript ?? existingServer.launch_script,
      serializedMetadataInput,
      nodeId !== undefined ? nodeId : existingServer.node_id,
      'native',
      isolationEnabled !== undefined ? (isolationEnabled ? 1 : 0) : existingServer.isolation_enabled,
      cpuLimitPercent !== undefined ? (typeof cpuLimitPercent === 'number' ? cpuLimitPercent : cpuLimitPercent ? Number(cpuLimitPercent) : null) : existingServer.cpu_limit_percent,
      memoryLimitMb !== undefined ? (typeof memoryLimitMb === 'number' ? memoryLimitMb : memoryLimitMb ? Number(memoryLimitMb) : null) : existingServer.memory_limit_mb,
      diskLimitMb !== undefined ? (typeof diskLimitMb === 'number' ? diskLimitMb : diskLimitMb ? Number(diskLimitMb) : null) : existingServer.disk_limit_mb,
      runtimePreset !== undefined ? runtimePreset : existingServer.runtime_preset,
      installCommand !== undefined ? installCommand : existingServer.install_command,
      startCommand !== undefined ? startCommand : existingServer.start_command,
      serverId,
    ]);

    const provisionResult = null;
    const updatedServer = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);

    try {
      await ensureServerIsolationPolicy(updatedServer);
      await applyServerFirewallPolicy(updatedServer);
    } catch {
      // ignore
    }

    res.json({ message: 'Server updated successfully', server: updatedServer, dns: provisionResult });
    AuditService.log(serverId, 'SERVER_EDIT', getUserIdentity(db, activeAccountId), 'Server configuration updated');
  } catch (error) {
    console.error('[SERVER] Failed to update server:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start server
router.post('/:id/start', restrictionMiddleware(), async (req, res) => {
  const serverId = req.params.id;
  const db = getDatabase();
  const activeAccountId = req.user.id;

  try {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
    if (!server) return res.status(404).json({ error: 'Server not found' });

    if (!canAccessServer(db, activeAccountId, server, 'control', req.user.role)) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    // Remote-node delegation remains
    if (server.node_id) {
      // (Keep existing remote logic or refactor later)
      // For now, only local servers use CoreOrchestrator
    }

    // 7. Runtime Container Creation & 9. Execution Control
    const result = await CoreOrchestrator.start(serverId);
    res.json({ message: 'Server started successfully', containerId: result.containerId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stop server
router.post('/:id/stop', restrictionMiddleware(), async (req, res) => {
  const serverId = req.params.id;
  const serverProcessData = runningProcesses.get(serverId);
  const serverProcess = serverProcessData?.process;

  const db = getDatabase();
  const activeAccountId = req.user.id;
  if (!activeAccountId) {
    return res.status(400).json({ error: 'No active account set' });
  }

  let serverRow;
  try {
    serverRow = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
  } catch {
    serverRow = null;
  }

  if (serverRow && !canAccessServer(db, activeAccountId, serverRow, 'control', req.user.role)) {
    return res.status(403).json({ error: 'Not allowed' });
  }

  // Remote-node execution path
  if (serverRow?.node_id) {
    try {
      const remoteManager = new RemoteNodeManager();
      const result = await remoteManager.stopRemoteServer(serverRow.node_id, String(serverId));
      try {
        db.prepare('UPDATE servers SET status = ?, pid = NULL WHERE id = ?').run('stopped', serverId);
      } catch {
        // ignore
      }
      return res.json({ message: 'Server stopped successfully (remote)', remote: true, result: result.data });
    } catch (error) {
      return res.status(502).json({ error: error.message || 'Failed to stop server on remote node' });
    }
  }

  console.log(`[STOP] Attempting to stop server ${serverId}, PID: ${serverProcess?.pid}`);

  if (!serverProcess) {
    console.log(`[STOP] Server ${serverId} not found in running processes`);
    // Update database anyway to ensure consistency
    try {
      const stmt = db.prepare('UPDATE servers SET status = ?, pid = NULL WHERE id = ?');
      stmt.run('stopped', serverId);

      try {
        const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
        if (server?.path) {
          const logPath = path.join(server.path, 'logs');
          fs.mkdirSync(logPath, { recursive: true });
          fs.appendFileSync(path.join(logPath, 'output.log'), `\n[${new Date().toISOString()}] STOP requested (no running process found)\n`);
        }
      } catch {
        // ignore
      }

      res.json({ message: 'Server marked as stopped (no running process found)' });
      AuditService.log(serverId, 'SERVER_STOP', getUserIdentity(db, activeAccountId), 'Server marked as stopped (no process)');
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
    return;
  }

  try {
    // Mark as intentional stop (so the close handler doesn't look like a crash)
    stoppingProcesses.add(String(serverId));

    // Cleanup Job Object if it exists
    try {
      await jobManager.closeServerJob(serverId);
      console.log(`[STOP] Cleaned up Job Object for server ${serverId}`);
    } catch (jobError) {
      console.warn(`[STOP] Failed to cleanup Job Object for server ${serverId}:`, jobError.message);
    }

    // Write STOP marker before kill so it shows immediately in the console stream
    try {
      const db = getDatabase();
      const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
      if (server?.path) {
        const logPath = path.join(server.path, 'logs');
        fs.mkdirSync(logPath, { recursive: true });
        fs.appendFileSync(path.join(logPath, 'output.log'), `\n[${new Date().toISOString()}] STOP requested\n`);
        AuditService.log(serverId, 'SERVER_STOP', getUserIdentity(db, activeAccountId), 'Server stop requested');
      }
    } catch {
      // ignore
    }

    const pid = serverProcess.pid;
    console.log(`[STOP] Killing process tree for PID ${pid}`);

    // Use tree-kill to properly kill process tree on Windows
    await new Promise((resolve, reject) => {
      kill(pid, 'SIGTERM', (err) => {
        if (err) {
          console.error(`[STOP] Error killing process ${pid} with SIGTERM:`, err);
          // Try force kill if normal kill fails
          kill(pid, 'SIGKILL', (err2) => {
            if (err2) {
              console.error(`[STOP] Error killing process ${pid} with SIGKILL:`, err2);
              reject(err2);
            } else {
              console.log(`[STOP] Process ${pid} killed with SIGKILL`);
              resolve();
            }
          });
        } else {
          console.log(`[STOP] Process ${pid} killed with SIGTERM`);
          resolve();
        }
      });
    });

    // Wait a bit for process cleanup
    await new Promise(resolve => setTimeout(resolve, 500));

    processRegistry.delete(serverId);
    console.log(`[STOP] Removed server ${serverId} from running processes`);

    const db = getDatabase();
    try {
      const stmt = db.prepare('UPDATE servers SET status = ?, pid = NULL WHERE id = ?');
      stmt.run('stopped', serverId);
      console.log(`[STOP] Server ${serverId} stopped successfully`);
      res.json({ message: 'Server stopped successfully' });
    } catch (err) {
      console.error(`[STOP] Database update error:`, err);
      res.status(500).json({ error: err.message });
    }
  } catch (error) {
    // Even if kill failed, clean up our tracking
    processRegistry.delete(serverId);
    processRegistry.removeStopping(serverId);
    const db = getDatabase();
    try {
      const stmt = db.prepare('UPDATE servers SET status = ?, pid = NULL WHERE id = ?');
      stmt.run('stopped', serverId);
    } catch (dbErr) {
      console.error(`[STOP] Database cleanup error:`, dbErr);
    }
    res.status(500).json({ error: 'Failed to stop server: ' + error.message });
  }
});

// Restart server
router.post('/:id/restart', restrictionMiddleware(), async (req, res) => {
  const serverId = req.params.id;

  const db = getDatabase();

  const activeAccountId = req.user.id;
  if (!activeAccountId) {
    return res.status(400).json({ error: 'No active account set' });
  }

  try {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    AuditService.log(serverId, 'SERVER_RESTART', getUserIdentity(db, activeAccountId), 'Server restart requested');

    // Remote-node execution path
    if (server.node_id) {
      if (!canAccessServer(db, activeAccountId, server, 'control', req.user.role)) {
        return res.status(403).json({ error: 'Not allowed' });
      }

      try {
        const remoteManager = new RemoteNodeManager();
        await remoteManager.stopRemoteServer(server.node_id, String(serverId)).catch(() => null);

        let envVars = null;
        try {
          envVars = server.env_vars ? JSON.parse(server.env_vars) : null;
        } catch {
          envVars = null;
        }

        await remoteManager.createRemoteServer(server.node_id, {
          id: String(server.id),
          name: server.name,
          path: server.path,
          command: server.command,
          start_command: server.start_command || null,
          env_vars: envVars,
        });

        const result = await remoteManager.startRemoteServer(server.node_id, String(serverId));
        try {
          const pid = result?.data?.pid ? Number(result.data.pid) : null;
          db.prepare('UPDATE servers SET status = ?, pid = ? WHERE id = ?').run('running', pid, serverId);
        } catch {
          // ignore
        }

        return res.json({ message: 'Server restarted successfully (remote)', remote: true, result: result.data });
      } catch (error) {
        return res.status(502).json({ error: error.message || 'Failed to restart server on remote node' });
      }
    }

    try {
      const logPath = path.join(server.path, 'logs');
      fs.mkdirSync(logPath, { recursive: true });
      fs.appendFileSync(path.join(logPath, 'output.log'), `\n[${new Date().toISOString()}] RESTART requested\n`);
    } catch {
      // ignore
    }

    if (processRegistry.has(serverId)) {
      const procData = processRegistry.get(serverId);
      processRegistry.markStopping(serverId);
      if (procData?.process?.pid) {
        await new Promise((resolve) => {
          kill(procData.process.pid, 'SIGTERM', (err) => {
            if (err) {
              try {
                kill(procData.process.pid, 'SIGKILL');
              } catch {
                // ignore
              }
            }
            resolve();
          });
        });
      }
      processRegistry.delete(serverId);
      await new Promise(resolve => setTimeout(resolve, 800));
    }

    // Start again
    const [cmd, ...args] = server.command.split(' ');
    const childProcess = spawn(cmd, args, {
      cwd: server.path,
      shell: true,
      env: {
        ...global.process.env,
        PYTHONUTF8: global.process.env.PYTHONUTF8 || '1',
        PYTHONIOENCODING: global.process.env.PYTHONIOENCODING || 'utf-8',
        LANG: global.process.env.LANG || 'C.UTF-8',
        LC_ALL: global.process.env.LC_ALL || 'C.UTF-8',
        TERM: global.process.env.TERM || 'xterm-256color',
      },
    });

    try {
      const logPath = path.join(server.path, 'logs');
      if (!fs.existsSync(logPath)) {
        fs.mkdirSync(logPath, { recursive: true });
      }
      const logFile = fs.createWriteStream(path.join(logPath, 'output.log'), { flags: 'a' });
      try {
        logFile.write(`[${new Date().toISOString()}] START (from restart) requested\n`);
      } catch {
        // ignore
      }

      childProcess.stdout.on('data', (data) => {
        logFile.write(data);
      });

      childProcess.stderr.on('data', (data) => {
        logFile.write(data);
      });

      childProcess.on('close', (code) => {
        try {
          logFile.write(`[${new Date().toISOString()}] Process exited with code ${code}\n`);
        } catch {
          // ignore
        }
        logFile.end();
        processRegistry.delete(serverId);

        try {
          db.prepare('UPDATE servers SET status = ?, pid = NULL WHERE id = ?').run('stopped', serverId);
        } catch {
          // ignore
        }
      });

      childProcess.on('error', (err) => {
        try {
          logFile.write(`[${new Date().toISOString()}] Process error: ${err.message}\n`);
        } catch {
          // ignore
        }
      });
    } catch {
      // ignore log wiring failures
    }

    processRegistry.set(serverId, {
      process: childProcess,
      bridgedPort: null // Restart route currently doesn't implement auto-bridge, would need logic from start route
    });

    try {
      db.prepare('UPDATE servers SET status = ?, pid = ? WHERE id = ?').run('running', childProcess.pid, serverId);
    } catch {
      // ignore
    }

    AuditService.log(serverId, 'SERVER_RESTART', getUserIdentity(db, activeAccountId), 'Server restarted successfully');
    res.json({ message: 'Server restarted successfully', pid: childProcess.pid });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete server
router.delete('/:id', restrictionMiddleware(), (req, res) => {
  const serverId = req.params.id;

  const db = getDatabase();
  const activeAccountId = req.user.id;
  if (!activeAccountId) {
    return res.status(400).json({ error: 'No active account set' });
  }

  const serverRow = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
  if (!serverRow) {
    return res.status(404).json({ error: 'Server not found' });
  }

  try {
    // Always remove firewall rule on delete.
    ensureFirewallRule({ serverId, port: serverRow?.port ? Number(serverRow.port) : null, enabled: false }).catch(() => null);
  } catch {
    // ignore
  }

  if (!canAccessServer(db, activeAccountId, serverRow, 'delete', req.user.role)) {
    return res.status(403).json({ error: 'Not allowed' });
  }

  // Stop if running
  if (processRegistry.has(serverId)) {
    const serverProcessData = processRegistry.get(serverId);
    const pid = serverProcessData?.process?.pid;

    if (pid) {
      // Use tree-kill for proper cleanup
      kill(pid, 'SIGTERM', (err) => {
        if (err) {
          kill(pid, 'SIGKILL');
        }
      });
    }

    processRegistry.delete(serverId);
  }

  // Cleanup Job Object if it exists
  try {
    jobManager.closeServerJob(serverId).catch(() => null);
  } catch {
    // ignore
  }

  try {
    const deleteTxn = db.transaction((id) => {
      // Remove dependent rows first to avoid foreign key constraint failures.
      // This keeps the feature fully functional even without ON DELETE CASCADE in schema.
      try {
        db.prepare('UPDATE backups SET server_id = NULL WHERE server_id = ?').run(id);
      } catch (e) {
        // If backups table or constraint differs, let the transaction surface the error.
        throw e;
      }
      try {
        db.prepare('DELETE FROM logs WHERE server_id = ?').run(id);
      } catch (e) {
        throw e;
      }

      try {
        db.prepare('DELETE FROM backup_schedules WHERE server_id = ?').run(id);
      } catch (e) {
        throw e;
      }

      try {
        db.prepare('UPDATE audit_logs SET server_id = NULL WHERE server_id = ?').run(id);
      } catch (e) {
        throw e;
      }

      const result = db.prepare('DELETE FROM servers WHERE id = ?').run(id);
      return result;
    });

    const result = deleteTxn(serverId);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Server not found' });
    }

    // Delete server files
    if (serverRow.path && fs.existsSync(serverRow.path)) {
      try {
        fs.rmSync(serverRow.path, { recursive: true, force: true });
      } catch (e) {
        console.error(`[DELETE] Failed to delete server files for ${serverId}:`, e);
        // Continue with DB deletion even if file deletion fails
      }
    }

    res.json({ message: 'Server deleted successfully' });
    AuditService.log(null, 'SERVER_DELETE', getUserIdentity(db, activeAccountId), `Server deleted (ID: ${serverId})`, { originalServerId: serverId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get server logs
router.get('/:id/logs', (req, res) => {
  const serverId = req.params.id;
  const db = getDatabase();

  const activeAccountId = req.user.id;
  if (!activeAccountId) {
    return res.status(400).json({ error: 'No active account set' });
  }

  try {
    const stmt = db.prepare('SELECT * FROM servers WHERE id = ?');
    const server = stmt.get(serverId);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    // Remote-node execution path
    if (server.node_id) {
      if (!canAccessServer(db, activeAccountId, server, 'view', req.user.role)) {
        return res.status(403).json({ error: 'Not allowed' });
      }
      const remoteManager = new RemoteNodeManager();
      remoteManager.getRemoteServerLogs(server.node_id, String(serverId))
        .then((result) => {
          const logs = Array.isArray(result?.data?.logs) ? result.data.logs : [];
          res.json({ logs });
        })
        .catch((error) => {
          res.status(502).json({ error: error.message || 'Failed to fetch logs from remote node' });
        });
      return;
    }

    if (!canAccessServer(db, activeAccountId, server, 'view', req.user.role)) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const logPath = path.join(server.path, 'logs', 'output.log');

    if (!fs.existsSync(logPath)) {
      return res.json({ logs: [] });
    }

    try {
      const content = fs.readFileSync(logPath, 'utf-8');
      const lines = content.split('\n').slice(-100); // Last 100 lines
      res.json({ logs: lines });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get audit logs
router.get('/:id/audit-logs', (req, res) => {
  const serverId = req.params.id;
  try {
    const logs = AuditService.getLogs(serverId);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

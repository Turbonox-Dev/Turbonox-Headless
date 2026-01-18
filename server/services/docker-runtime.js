const { spawn } = require('child_process');
const path = require('path');

let dockerReadyCache = { at: 0, ok: false };
const DOCKER_READY_TTL_MS = 1500;

function execDocker(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      shell: false,
      windowsHide: true,
      ...opts,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (d) => {
      stdout += d.toString('utf8');
    });

    child.stderr?.on('data', (d) => {
      stderr += d.toString('utf8');
    });

    child.on('error', (err) => {
      reject(err);
    });

    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr, code });
      const e = new Error(stderr || stdout || `docker ${args.join(' ')} failed with code ${code}`);
      e.code = code;
      e.stdout = stdout;
      e.stderr = stderr;
      reject(e);
    });
  });
}

async function isDockerReady() {
  const now = Date.now();
  if (now - dockerReadyCache.at < DOCKER_READY_TTL_MS) return dockerReadyCache.ok;
  try {
    await execDocker(['info']);
    dockerReadyCache = { at: now, ok: true };
    return true;
  } catch {
    dockerReadyCache = { at: now, ok: false };
    return false;
  }
}

async function ensureImagePulled(image) {
  if (!image) return;
  await waitForDockerReady(120000);
  try {
    await execDocker(['image', 'inspect', image]);
    return;
  } catch {
    // ignore
  }
  await execDocker(['pull', image]);
}

async function waitForDockerReady(timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await isDockerReady();
    if (ok) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

function safeEnvValue(v) {
  if (v === undefined || v === null) return '';
  return String(v);
}

function containerNameForServerId(serverId) {
  return `turbonox-srv-${String(serverId)}`;
}

function resolveUbuntuBaseImage() {
  return 'ubuntu:22.04';
}

function buildUbuntuEntrypointForType({ type, startCommand }) {
  const t = String(type || '').toLowerCase();
  const cmd = String(startCommand || '').trim();

  // Keep the container alive as a "VM-like" server even if user didn't provide a command.
  const safeDefault = 'sleep infinity';

  // Basic hardening: noninteractive apt and common utils.
  const base = [
    'export DEBIAN_FRONTEND=noninteractive',
    'apt-get update -y',
    'apt-get install -y --no-install-recommends ca-certificates curl git bash gnupg',
  ];

  // Node via NodeSource (stable and current).
  const nodeSetup = [
    'apt-get update -y',
    'curl -fsSL https://deb.nodesource.com/setup_20.x | bash -',
    'apt-get install -y --no-install-recommends nodejs',
  ];

  const pythonSetup = [
    'apt-get install -y --no-install-recommends python3 python3-pip python3-venv',
  ];

  const nginxSetup = [
    'apt-get install -y --no-install-recommends nginx',
  ];

  const cleanup = [
    'apt-get clean',
    'rm -rf /var/lib/apt/lists/*',
  ];

  const goWorkdir = ['cd /srv/server || cd /workspace || true'];

  let setup = [];
  // template IDs in this app are like: template:nodejs, template:python, template:static, etc.
  if (t.includes('node')) setup = nodeSetup;
  else if (t.includes('python')) setup = pythonSetup;
  else if (t.includes('static') || t.includes('nginx')) setup = nginxSetup;
  else setup = [];

  const run = cmd ? [cmd] : [safeDefault];
  const script = [...base, ...setup, ...cleanup, ...goWorkdir, ...run].join(' && ');

  return ['bash', '-lc', script];
}

function resolveImageForPreset(preset) {
  const key = String(preset || '').trim().toLowerCase();
  if (!key) return null;

  // Ubuntu VM-like mode uses the Ubuntu base image, not a preset image.
  if (key === 'ubuntu-22.04' || key === 'ubuntu-22.04-vm' || key === 'ubuntu') {
    return null;
  }

  const map = {
    'node18': 'node:18-bookworm-slim',
    'node20': 'node:20-bookworm-slim',
    'python311': 'python:3.11-slim',
    'python312': 'python:3.12-slim',
    'php82': 'php:8.2-cli',
    'php83': 'php:8.3-cli',
    'static-nginx': 'nginx:alpine',
  };

  return map[key] || null;
}

function buildDockerEnvArgs(envVars) {
  const args = [];
  const entries = envVars && typeof envVars === 'object' ? Object.entries(envVars) : [];
  for (const [k, v] of entries) {
    if (!k) continue;
    args.push('-e', `${String(k)}=${safeEnvValue(v)}`);
  }
  return args;
}

function normalizeWindowsVolumeHostPath(p) {
  const raw = String(p || '').trim();
  if (!raw) return raw;
  return path.resolve(raw);
}

function buildVolumeArgs(mounts) {
  const args = [];
  const list = Array.isArray(mounts) ? mounts : [];
  for (const m of list) {
    if (!m) continue;
    const hostPath = normalizeWindowsVolumeHostPath(m.hostPath || m.host_path || m.source || '');
    const containerPath = String(m.containerPath || m.container_path || m.target || '').trim();
    if (!hostPath || !containerPath) continue;
    const ro = Boolean(m.readOnly || m.read_only || m.ro);
    args.push('-v', `${hostPath}:${containerPath}${ro ? ':ro' : ''}`);
  }
  return args;
}

async function runOneOff({ image, workdir, hostPath, envVars, command, logFilePath }) {
  if (!image) throw new Error('Docker image is required');

  await ensureImagePulled(image);

  // Ensure log directory exists
  if (logFilePath) {
    const logDir = path.dirname(logFilePath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
  }

  const primary = hostPath ? [{ hostPath: path.resolve(hostPath), containerPath: '/srv/server' }] : [];
  const vols = buildVolumeArgs(primary);

  const args = ['run', '--rm', ...vols, '-w', '/srv/server'];
  args.push(...buildDockerEnvArgs(envVars));

  // Drop privileges for one-off tasks too
  args.push('--security-opt', 'no-new-privileges:true');
  args.push('--cap-drop', 'ALL');

  args.push(image);
  args.push('sh', '-lc', String(command || '').trim());

  const { spawn } = require('child_process');
  const fs = require('fs');

  return await new Promise((resolve, reject) => {
    const child = spawn('docker', args, { windowsHide: true, shell: false, cwd: workdir || undefined });
    const logStream = logFilePath ? fs.createWriteStream(logFilePath, { flags: 'a' }) : null;

    const write = (buf) => {
      try {
        if (logStream) logStream.write(buf);
      } catch {
        // ignore
      }
    };

    child.stdout?.on('data', write);
    child.stderr?.on('data', write);

    child.on('error', (err) => {
      try { logStream?.end(); } catch { }
      reject(err);
    });

    child.on('close', (code) => {
      try { logStream?.end(); } catch { }
      resolve(Number(code || 0));
    });
  });
}

/**
 * Start a container for a server with full resource isolation.
 * 
 * @param {object} config - Container configuration
 * @param {string} config.serverId - Unique server identifier
 * @param {string} config.image - Docker image to use
 * @param {string} [config.hostPath] - Host path to mount as /srv/server
 * @param {object} [config.envVars] - Environment variables
 * @param {string} [config.startCommand] - Command to run on start
 * @param {number} [config.hostPort] - Port to expose
 * @param {number} [config.cpuLimitPercent] - CPU limit as percentage (e.g., 50 = 50% of one core)
 * @param {number} [config.memoryLimitMb] - Memory limit in MB
 * @param {number} [config.diskLimitGb] - Disk quota in GB (uses tmpfs for enforcement)
 * @param {string} [config.staticIp] - Static IP address to assign
 * @param {string} [config.networkName] - Docker network to connect to
 * @param {number} [config.cpuShares] - Relative CPU weight (default 1024)
 * @param {boolean} [config.enableSwap] - Allow memory swap (default false for isolation)
 */
async function startContainerForServer({
  serverId,
  image,
  hostPath,
  envVars,
  startCommand,
  hostPort,
  cpuLimitPercent,
  memoryLimitMb,
  diskLimitGb,
  staticIp,
  networkName,
  cpuShares,
  enableSwap = false
}) {
  if (!image) throw new Error('No docker image resolved for this server');
  const name = containerNameForServerId(serverId);

  await ensureImagePulled(image);

  const primary = hostPath ? [{ hostPath, containerPath: '/srv/server' }] : [];
  const vols = buildVolumeArgs(primary);
  const args = ['run', '-d', '--name', name, '--restart', 'unless-stopped', ...vols, '-w', '/srv/server'];

  // Network configuration - connect to specific network with optional static IP
  if (networkName) {
    args.push('--network', networkName);
    if (staticIp) {
      args.push('--ip', staticIp);
    }
  }

  // Port mapping (still useful for external access even with static IP)
  if (hostPort) {
    args.push('-p', `${Number(hostPort)}:${Number(hostPort)}`);
  }

  // Memory limit with optional swap control
  if (memoryLimitMb) {
    args.push('--memory', `${Number(memoryLimitMb)}m`);
    if (!enableSwap) {
      // Disable swap to enforce strict memory limits
      args.push('--memory-swap', `${Number(memoryLimitMb)}m`);
    }
  }

  // CPU limit using period/quota (precise control)
  if (cpuLimitPercent) {
    const quota = Math.max(1000, Math.round((Number(cpuLimitPercent) / 100) * 100000));
    args.push('--cpu-period', '100000', '--cpu-quota', String(quota));
  }

  // CPU shares for relative weighting between containers
  if (cpuShares) {
    args.push('--cpu-shares', String(cpuShares));
  }

  // Disk quota using tmpfs for /tmp (provides quota enforcement)
  // Note: For full disk quota on volumes, consider using Docker volume plugins or XFS quotas
  if (diskLimitGb) {
    const diskLimitMb = diskLimitGb * 1024;
    args.push('--tmpfs', `/tmp:size=${diskLimitMb}m,mode=1777`);
    // Also set storage driver options if supported (requires overlay2 with xfs quota enabled or similar)
    try {
      args.push('--storage-opt', `size=${diskLimitGb}G`);
    } catch {
      // ignore if driver doesn't support it
    }
  }

  // Kernel capabilities - drop unnecessary ones for security
  args.push('--cap-drop', 'ALL');
  args.push('--cap-add', 'CHOWN', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--cap-add', 'NET_BIND_SERVICE');

  // Security options
  args.push('--security-opt', 'no-new-privileges:true');

  args.push(...buildDockerEnvArgs(envVars));

  args.push(image);
  args.push('sh', '-lc', String(startCommand || '').trim());

  await waitForDockerReady(120000);

  try {
    await execDocker(['rm', '-f', name]);
  } catch {
    // ignore
  }

  const res = await execDocker(args);
  const containerId = String(res.stdout || '').trim();

  return {
    name,
    containerId,
    staticIp: staticIp || null,
    networkName: networkName || null,
    resources: {
      cpuLimitPercent: cpuLimitPercent || null,
      memoryLimitMb: memoryLimitMb || null,
      diskLimitGb: diskLimitGb || null,
    }
  };
}

async function stopContainerForServer(serverId) {
  const name = containerNameForServerId(serverId);
  await waitForDockerReady(120000);
  try {
    await execDocker(['stop', name]);
  } catch (e) {
    const msg = String(e?.stderr || e?.stdout || e?.message || '');
    const lower = msg.toLowerCase();
    if (lower.includes('no such container') || lower.includes('no such object') || lower.includes('not found')) return;
    throw e;
  }
}

async function restartContainerForServer(serverId) {
  const name = containerNameForServerId(serverId);
  await waitForDockerReady(120000);
  try {
    await execDocker(['restart', name]);
  } catch (e) {
    const msg = String(e?.stderr || e?.stdout || e?.message || '');
    const lower = msg.toLowerCase();
    if (lower.includes('no such container') || lower.includes('no such object') || lower.includes('not found')) return;
    throw e;
  }
}

async function getContainerLogs(serverId, tail = 120) {
  const name = containerNameForServerId(serverId);
  await waitForDockerReady(120000);
  try {
    const res = await execDocker(['logs', '--tail', String(tail), name]);
    return String(res.stdout || '').split(/\r?\n/);
  } catch (e) {
    const msg = String(e?.stderr || e?.message || '');
    if (msg.toLowerCase().includes('no such container')) return [];
    throw e;
  }
}

async function getContainerStats(serverId) {
  const name = containerNameForServerId(serverId);
  await waitForDockerReady(120000);

  try {
    const res = await execDocker(['stats', '--no-stream', '--format', '{{.CPUPerc}}|{{.MemUsage}}', name]);
    const line = String(res.stdout || '').trim();
    if (!line) return { cpuPercent: 0, memUsedBytes: 0, memLimitBytes: 0 };

    const [cpuRaw, memRaw] = line.split('|');
    const cpuPercent = Number(String(cpuRaw || '').replace('%', '').trim()) || 0;

    const memParts = String(memRaw || '').split('/').map((s) => s.trim());
    const parseHuman = (s) => {
      const m = String(s).trim().match(/^([0-9.]+)\s*([KMG]i?B)?$/i);
      if (!m) return 0;
      const n = Number(m[1]);
      const unit = (m[2] || '').toLowerCase();
      const mult = unit.startsWith('k') ? 1024 : unit.startsWith('m') ? 1024 * 1024 : unit.startsWith('g') ? 1024 * 1024 * 1024 : 1;
      return n * mult;
    };

    const memUsedBytes = parseHuman(memParts[0] || '');
    const memLimitBytes = parseHuman(memParts[1] || '');

    return { cpuPercent, memUsedBytes, memLimitBytes };
  } catch (e) {
    const msg = String(e?.stderr || e?.message || '');
    if (msg.toLowerCase().includes('no such container')) return { cpuPercent: 0, memUsedBytes: 0, memLimitBytes: 0 };
    throw e;
  }
}

/**
 * Get the IP address of a container
 */
async function getContainerIP(serverId, networkName) {
  const name = containerNameForServerId(serverId);
  try {
    const format = networkName
      ? `{{.NetworkSettings.Networks.${networkName}.IPAddress}}`
      : '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}';
    const res = await execDocker(['inspect', '--format', format, name]);
    return String(res.stdout || '').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Get full container info including network and resource usage
 */
async function getContainerInfo(serverId) {
  const name = containerNameForServerId(serverId);
  try {
    const res = await execDocker(['inspect', name]);
    const data = JSON.parse(res.stdout);
    const container = data[0];
    if (!container) return null;

    const networks = container.NetworkSettings?.Networks || {};
    const networkInfo = Object.entries(networks).map(([netName, netData]) => ({
      name: netName,
      ip: netData.IPAddress,
      gateway: netData.Gateway,
      macAddress: netData.MacAddress,
    }));

    return {
      id: container.Id,
      name: container.Name,
      state: container.State?.Status,
      running: container.State?.Running,
      networks: networkInfo,
      hostConfig: {
        memory: container.HostConfig?.Memory,
        cpuPeriod: container.HostConfig?.CpuPeriod,
        cpuQuota: container.HostConfig?.CpuQuota,
        cpuShares: container.HostConfig?.CpuShares,
      },
    };
  } catch {
    return null;
  }
}

module.exports = {
  execDocker,
  isDockerReady,
  waitForDockerReady,
  ensureImagePulled,
  containerNameForServerId,
  resolveUbuntuBaseImage,
  buildUbuntuEntrypointForType,
  resolveImageForPreset,
  buildVolumeArgs,
  runOneOff,
  startContainerForServer,
  stopContainerForServer,
  restartContainerForServer,
  getContainerLogs,
  getContainerStats,
  getContainerIP,
  getContainerInfo,
};

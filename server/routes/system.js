const express = require('express');
const router = express.Router();
const si = require('systeminformation');
const os = require('os');
const { spawn } = require('child_process');

router.get('/stats', async (req, res) => {
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
    };

    res.json(stats);
  } catch (error) {
    console.error('Error fetching system stats:', error);
    res.status(500).json({ error: 'Failed to fetch system stats' });
  }
});

router.get('/performance', async (_req, res) => {
  try {
    const mu = process.memoryUsage();
    const ru = typeof process.resourceUsage === 'function' ? process.resourceUsage() : null;
    res.json({
      pid: process.pid,
      platform: process.platform,
      arch: process.arch,
      uptime: process.uptime(),
      loadavg: os.loadavg(),
      memory: {
        rss: mu.rss,
        heapTotal: mu.heapTotal,
        heapUsed: mu.heapUsed,
        external: mu.external,
        arrayBuffers: mu.arrayBuffers,
      },
      resource: ru,
      timestamp: Date.now(),
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'Failed to fetch performance metrics' });
  }
});

router.get('/info', async (req, res) => {
  try {
    const [osInfo, cpuInfo, memInfo] = await Promise.all([
      si.osInfo(),
      si.cpu(),
      si.mem(),
    ]);

    res.json({
      os: {
        platform: osInfo.platform,
        distro: osInfo.distro,
        release: osInfo.release,
        arch: osInfo.arch,
      },
      cpu: {
        manufacturer: cpuInfo.manufacturer,
        brand: cpuInfo.brand,
        cores: cpuInfo.cores,
        speed: cpuInfo.speed,
      },
      memory: {
        total: (memInfo.total / (1024 ** 3)).toFixed(2),
      },
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch system info' });
  }
});

function runCmd(command, args = [], opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { shell: false, windowsHide: true, ...opts });
    } catch (e) {
      resolve({ ok: false, code: 1, stdout: '', stderr: e.message || String(e) });
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr?.on('data', (d) => (stderr += d.toString('utf8')));
    child.on('close', (code) => resolve({ ok: code === 0, code: code ?? 1, stdout, stderr }));
    child.on('error', (e) => resolve({ ok: false, code: 1, stdout, stderr: (e && e.message) || String(e) }));
  });
}

router.get('/wsl/status', async (req, res) => {
  try {
    const platform = os.platform();
    if (platform !== 'win32') {
      return res.json({ supported: false, installed: false, platform });
    }

    const status = await runCmd('wsl.exe', ['--status']);
    if (!status.ok) {
      // If wsl.exe is missing or feature not enabled, return installed=false.
      return res.json({ supported: true, installed: false, platform, error: (status.stderr || status.stdout || '').trim() });
    }

    const list = await runCmd('wsl.exe', ['-l', '-q']);
    const distros = (list.stdout || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);

    res.json({
      supported: true,
      installed: true,
      platform,
      distros,
      raw_status: (status.stdout || '').trim(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to check WSL status' });
  }
});

module.exports = router;

const fs = require('fs');
const path = require('path');

function isLinux() {
  return process.platform === 'linux';
}

function isRoot() {
  try {
    return typeof process.getuid === 'function' && process.getuid() === 0;
  } catch {
    return false;
  }
}

function detectCgroupV2Root() {
  try {
    const root = '/sys/fs/cgroup';
    const controllers = path.join(root, 'cgroup.controllers');
    if (fs.existsSync(controllers)) return root;
  } catch {
  }
  return '';
}

function toMemoryMaxBytes(memoryLimitMB) {
  const mb = Number(memoryLimitMB);
  if (!Number.isFinite(mb) || mb <= 0) return '';
  return String(Math.floor(mb * 1024 * 1024));
}

function toCpuMax(cpuPercent) {
  const pct = Number(cpuPercent);
  if (!Number.isFinite(pct) || pct <= 0) return '';
  const period = 100000;
  const quota = Math.max(1000, Math.floor((pct / 100) * period));
  return `${quota} ${period}`;
}

class CgroupV2JobManager {
  constructor() {
    this.root = detectCgroupV2Root();
    this.base = this.root ? path.join(this.root, 'turbonox') : '';
    this.serverGroups = new Map();
  }

  supported() {
    return Boolean(this.base) && isLinux() && isRoot();
  }

  groupPath(serverId) {
    const safe = String(serverId).replace(/[^0-9]/g, '').slice(0, 18) || String(Date.now());
    return path.join(this.base, `server-${safe}`);
  }

  async createJobForServer(serverId, cpuLimit, memoryLimit) {
    if (!this.supported()) return { supported: false, job: null };
    const grp = this.groupPath(serverId);
    try {
      fs.mkdirSync(this.base, { recursive: true });
      fs.mkdirSync(grp, { recursive: true });
    } catch {
      return { supported: false, job: null };
    }

    try {
      const mem = toMemoryMaxBytes(memoryLimit);
      if (mem) fs.writeFileSync(path.join(grp, 'memory.max'), mem, 'utf8');
    } catch {
    }

    try {
      const cpu = toCpuMax(cpuLimit);
      if (cpu) fs.writeFileSync(path.join(grp, 'cpu.max'), cpu, 'utf8');
    } catch {
    }

    this.serverGroups.set(String(serverId), grp);
    return { supported: true, job: { serverId: String(serverId), path: grp } };
  }

  async addProcessToServerJob(serverId, pid) {
    if (!this.supported()) return { supported: false };
    const grp = this.serverGroups.get(String(serverId)) || this.groupPath(serverId);
    try {
      fs.mkdirSync(grp, { recursive: true });
      fs.writeFileSync(path.join(grp, 'cgroup.procs'), `${Number(pid)}\n`, 'utf8');
      this.serverGroups.set(String(serverId), grp);
      return { supported: true };
    } catch {
      return { supported: false };
    }
  }

  async closeServerJob(serverId) {
    const grp = this.serverGroups.get(String(serverId));
    if (!grp) return { supported: this.supported() };
    this.serverGroups.delete(String(serverId));
    return { supported: this.supported(), path: grp };
  }
}

const linuxManager = new CgroupV2JobManager();

const jobManager = {
  async createJobForServer(serverId, cpuLimit, memoryLimit) {
    return linuxManager.createJobForServer(serverId, cpuLimit, memoryLimit);
  },
  async addProcessToServerJob(serverId, pid) {
    return linuxManager.addProcessToServerJob(serverId, pid);
  },
  async closeServerJob(serverId) {
    return linuxManager.closeServerJob(serverId);
  },
};

module.exports = { jobManager };

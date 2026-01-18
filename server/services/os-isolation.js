const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function run(command, args = []) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { shell: false, windowsHide: true });
    } catch (e) {
      resolve({ ok: false, code: 1, stdout: '', stderr: e?.message || String(e) });
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr?.on('data', (d) => (stderr += d.toString('utf8')));
    child.on('error', (e) => resolve({ ok: false, code: 1, stdout, stderr: e?.message || String(e) }));
    child.on('close', (code) => resolve({ ok: code === 0, code: Number(code ?? 1), stdout, stderr }));
  });
}

function isRoot() {
  try {
    return typeof process.getuid === 'function' && process.getuid() === 0;
  } catch {
    return false;
  }
}

function linuxUsernameForServerId(serverId) {
  const safe = String(serverId).replace(/[^0-9]/g, '').slice(0, 18) || String(Date.now());
  return `tnx-srv-${safe}`;
}

async function ensureLinuxUserForServer({ serverId }) {
  if (!isRoot()) return { ok: true, supported: true, skipped: true, username: null };

  const username = linuxUsernameForServerId(serverId);

  const idRes = await run('id', ['-u', username]);
  if (idRes.ok) return { ok: true, supported: true, username };

  const hasAdduser = (await run('which', ['adduser'])).ok;
  const hasUseradd = (await run('which', ['useradd'])).ok;

  if (hasAdduser) {
    const res = await run('adduser', ['--system', '--no-create-home', '--disabled-login', username]);
    if (!res.ok) throw new Error((res.stderr || res.stdout || 'Failed to create linux server user').trim());
    return { ok: true, supported: true, username };
  }

  if (hasUseradd) {
    const res = await run('useradd', ['--system', '--no-create-home', '--shell', '/usr/sbin/nologin', username]);
    if (!res.ok) throw new Error((res.stderr || res.stdout || 'Failed to create linux server user').trim());
    return { ok: true, supported: true, username };
  }

  return { ok: true, supported: true, skipped: true, username: null };
}

async function applyLinuxFolderAcl({ folderPath, username }) {
  if (!folderPath) return { ok: true, supported: true, skipped: true };

  const full = path.resolve(folderPath);
  try {
    fs.mkdirSync(full, { recursive: true });
  } catch {
    return { ok: true, supported: true, skipped: true };
  }

  if (!isRoot() || !username) return { ok: true, supported: true, skipped: true };

  const chownRes = await run('chown', ['-R', `${username}:${username}`, full]);
  if (!chownRes.ok) return { ok: true, supported: true, skipped: true };

  await run('chmod', ['-R', 'u=rwX,g=rX,o=', full]).catch(() => null);
  return { ok: true, supported: true };
}

async function ensureLinuxFirewallRule({ port, enabled }) {
  const p = Number(port);
  if (!Number.isFinite(p) || p <= 0) return { ok: true, supported: true, skipped: true };
  if (!isRoot()) return { ok: true, supported: true, skipped: true };

  const allow = Boolean(enabled);

  const hasUfw = (await run('which', ['ufw'])).ok;
  if (hasUfw) {
    const action = allow ? 'allow' : 'delete';
    const args = allow ? [action, `${p}/tcp`] : [action, 'allow', `${p}/tcp`];
    await run('ufw', args);
    return { ok: true, supported: true };
  }

  const hasFirewallCmd = (await run('which', ['firewall-cmd'])).ok;
  if (hasFirewallCmd) {
    const flag = allow ? '--add-port' : '--remove-port';
    await run('firewall-cmd', ['--permanent', flag, `${p}/tcp`]);
    await run('firewall-cmd', ['--reload']);
    return { ok: true, supported: true };
  }

  const hasIptables = (await run('which', ['iptables'])).ok;
  if (hasIptables) {
    const base = ['-p', 'tcp', '--dport', String(p), '-j', 'ACCEPT'];
    if (allow) {
      await run('iptables', ['-C', 'INPUT', ...base]).catch(() => null);
      await run('iptables', ['-I', 'INPUT', ...base]).catch(() => null);
    } else {
      await run('iptables', ['-D', 'INPUT', ...base]).catch(() => null);
    }
    return { ok: true, supported: true };
  }

  return { ok: true, supported: true, skipped: true };
}

async function ensureUserForServer({ serverId, runtimeDir }) {
  return ensureLinuxUserForServer({ serverId, runtimeDir });
}

async function applyFolderAcl({ folderPath, username }) {
  return applyLinuxFolderAcl({ folderPath, username });
}

async function ensureFirewallRule({ serverId, port, enabled }) {
  return ensureLinuxFirewallRule({ serverId, port, enabled });
}

module.exports = {
  ensureUserForServer,
  applyFolderAcl,
  ensureFirewallRule,
};

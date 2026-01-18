const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function runPowershell(script, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        windowsHide: true,
        shell: false,
        ...opts,
      });
    } catch (e) {
      return resolve({ ok: false, code: 1, stdout: '', stderr: e?.message || String(e) });
    }

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr?.on('data', (d) => (stderr += d.toString('utf8')));
    child.on('error', (e) => resolve({ ok: false, code: 1, stdout, stderr: e?.message || String(e) }));
    child.on('close', (code) => resolve({ ok: code === 0, code: Number(code ?? 1), stdout, stderr }));
  });
}

function runtimeUsernameForServerId(serverId) {
  const safe = String(serverId).replace(/[^0-9]/g, '').slice(0, 18) || String(Date.now());
  return `tnx_srv_${safe}`;
}

function firewallRuleNameForServerId(serverId) {
  return `Turbonox Server ${String(serverId)}`;
}

function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch {
    // ignore
  }
}

function saveRuntimeSecret(runtimeDir, serverId) {
  ensureDir(runtimeDir);
  const secretPath = path.join(runtimeDir, `server-${String(serverId)}.secret`);
  try {
    if (fs.existsSync(secretPath)) {
      return fs.readFileSync(secretPath, 'utf8').trim();
    }
  } catch {
    // ignore
  }

  const secret = crypto.randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 20);
  try {
    fs.writeFileSync(secretPath, secret, 'utf8');
  } catch {
    // ignore
  }
  return secret;
}

async function ensureWindowsUserForServer({ serverId, runtimeDir }) {
  const platform = process.platform;
  if (platform !== 'win32') {
    return { ok: true, supported: false, username: null, password: null };
  }

  const username = runtimeUsernameForServerId(serverId);
  const password = saveRuntimeSecret(runtimeDir, serverId);

  const script = `
$ErrorActionPreference = 'Stop'
$u = '${username}'
$p = ConvertTo-SecureString '${password}' -AsPlainText -Force

$existing = Get-LocalUser -Name $u -ErrorAction SilentlyContinue
if (-not $existing) {
  New-LocalUser -Name $u -Password $p -PasswordNeverExpires -UserMayNotChangePassword | Out-Null
}

# Ensure not in Administrators
try {
  Remove-LocalGroupMember -Group 'Administrators' -Member $u -ErrorAction SilentlyContinue | Out-Null
} catch { }

Write-Output 'OK'
`;

  const res = await runPowershell(script);
  if (!res.ok) {
    const err = new Error(res.stderr || res.stdout || 'Failed to create server user');
    err.details = res;
    throw err;
  }

  return { ok: true, supported: true, username, password };
}

async function applyFolderAcl({ folderPath, username }) {
  if (process.platform !== 'win32') return { ok: true, supported: false };
  if (!folderPath || !username) return { ok: true, supported: true };

  const full = path.resolve(folderPath);
  const script = `
$ErrorActionPreference = 'Stop'
$path = '${full.replace(/'/g, "''")}'
$user = '${username.replace(/'/g, "''")}'

if (-not (Test-Path -LiteralPath $path)) {
  New-Item -ItemType Directory -Path $path -Force | Out-Null
}

# Give server-user Modify rights; keep inheritance (do not lock out the interactive user)
& icacls $path /grant "${username}:(OI)(CI)M" /T /C | Out-Null
Write-Output 'OK'
`;

  const res = await runPowershell(script);
  if (!res.ok) {
    const err = new Error(res.stderr || res.stdout || 'Failed to apply folder ACL');
    err.details = res;
    throw err;
  }

  return { ok: true, supported: true };
}

async function ensureFirewallRule({ serverId, port, enabled }) {
  if (process.platform !== 'win32') return { ok: true, supported: false };

  const ruleName = firewallRuleNameForServerId(serverId);
  const p = Number(port);
  if (!Number.isFinite(p) || p <= 0) return { ok: true, supported: true, skipped: true };

  const shouldEnable = Boolean(enabled);

  const script = `
$ErrorActionPreference = 'Stop'
$name = '${ruleName.replace(/'/g, "''")}'
$port = ${p}

# Remove existing rule(s) for idempotency
Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue

if (${shouldEnable ? '$true' : '$false'}) {
  New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port | Out-Null
}

Write-Output 'OK'
`;

  const res = await runPowershell(script);
  if (!res.ok) {
    const err = new Error(res.stderr || res.stdout || 'Failed to update firewall rule');
    err.details = res;
    throw err;
  }

  return { ok: true, supported: true };
}

module.exports = {
  runPowershell,
  runtimeUsernameForServerId,
  firewallRuleNameForServerId,
  ensureWindowsUserForServer,
  applyFolderAcl,
  ensureFirewallRule,
};

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const SCRIPTS_DIR = path.join(__dirname, '..', '..', '..', 'scripts');
const DNS_ADD_SCRIPT = path.join(SCRIPTS_DIR, 'tunnel-dns-add.ps1');

function ensureScriptExists(scriptPath) {
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Required script not found at ${scriptPath}`);
  }
}

function createDnsError(code, message, metadata = {}) {
  const error = new Error(message);
  error.code = code;
  error.metadata = metadata;
  return error;
}

function provisionSubdomain(subdomain, options = {}) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      return reject(createDnsError('UNSUPPORTED', 'DNS provisioning is not supported on this platform'));
    }
    try {
      ensureScriptExists(DNS_ADD_SCRIPT);
    } catch (error) {
      return reject(createDnsError('SCRIPT_MISSING', error.message));
    }

    const hostname = `${subdomain}.${options.domain || 'turbonox.oriko.lk'}`;
    const tunnelName = options.tunnelName || 'turbonox';

    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      DNS_ADD_SCRIPT,
      '-Hostname',
      hostname,
      '-TunnelName',
      tunnelName,
    ], {
      windowsHide: true,
    });

    let stderr = '';

    child.stdout.on('data', (data) => {
      console.log(`[DNS] ${data}`.trim());
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      console.error(`[DNS] ${text}`.trim());
    });

    child.on('error', (error) => {
      reject(createDnsError('PROCESS_ERROR', error.message, { hostname, tunnelName }));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ hostname, tunnelName });
      } else {
        reject(createDnsError('SCRIPT_FAILED', stderr || `DNS provisioning script exited with code ${code}`, {
          hostname,
          tunnelName,
          exitCode: code,
        }));
      }
    });
  });
}

module.exports = {
  provisionSubdomain,
  createDnsError,
};

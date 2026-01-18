const fs = require('fs');
const path = require('path');
const os = require('os');

const APPDATA_ROOT = process.env.APPDATA || process.env.HOME || process.cwd();
const LEGACY_APP_DIR = path.join(APPDATA_ROOT, 'VoidHosting');

// Improved dev mode detection that works even when launched via protocol handlers
const isDev = process.env.NODE_ENV === 'development' ||
  process.defaultApp ||
  /[\\/]electron[\\/]dist[\\/]electron/i.test(process.execPath);

const isMultiInstance = String(process.env.TURBONOX_MULTI_INSTANCE || '').toLowerCase() === 'true';

// Extract profile from --profile=NAME argument
const profileArg = process.argv.find(arg => arg.startsWith('--profile='));
const profileName = profileArg ? profileArg.split('=')[1] : null;

let APP_DIR_NAME = 'Turbonox';

if (isDev) {
  if (profileName) {
    APP_DIR_NAME = `Turbonox-Dev-${profileName}`;
  } else if (isMultiInstance) {
    APP_DIR_NAME = `Turbonox-Dev-${process.pid}`;
  } else {
    APP_DIR_NAME = 'Turbonox-Dev';
  }
} else if (profileName) {
  APP_DIR_NAME = `Turbonox-Profile-${profileName}`;
}

const APP_DIR = path.join(APPDATA_ROOT, APP_DIR_NAME);

function ensureDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch {
    // ignore
  }
}

function migrateLegacyAppDir() {
  try {
    if (fs.existsSync(APP_DIR)) return;
    if (!fs.existsSync(LEGACY_APP_DIR)) return;
    fs.renameSync(LEGACY_APP_DIR, APP_DIR);
  } catch {
    // ignore
  }
}

function getAppDir() {
  migrateLegacyAppDir();
  ensureDir(APP_DIR);
  return APP_DIR;
}

function getLegacyAppDir() {
  return LEGACY_APP_DIR;
}

function getDbPath() {
  const preferred = path.join(getAppDir(), 'void.db');
  try {
    if (fs.existsSync(preferred)) return preferred;
  } catch {
    // ignore
  }
  try {
    const legacy = path.join(getLegacyAppDir(), 'void.db');
    if (fs.existsSync(legacy)) return legacy;
  } catch {
    // ignore
  }
  return preferred;
}

function getEggsDir() {
  const preferred = path.join(getAppDir(), 'eggs');
  try {
    if (fs.existsSync(preferred)) return preferred;
  } catch {
    // ignore
  }
  const legacy = path.join(getLegacyAppDir(), 'eggs');
  try {
    if (fs.existsSync(legacy)) return legacy;
  } catch {
    // ignore
  }
  return preferred;
}

function getBackupsDir() {
  const preferred = path.join(getAppDir(), 'backups');
  try {
    if (fs.existsSync(preferred)) return preferred;
  } catch {
    // ignore
  }
  const legacy = path.join(getLegacyAppDir(), 'backups');
  try {
    if (fs.existsSync(legacy)) return legacy;
  } catch {
    // ignore
  }
  return preferred;
}

function getServersDir() {
  const preferred = path.join(getAppDir(), 'servers');
  try {
    if (fs.existsSync(preferred)) return preferred;
  } catch {
    // ignore
  }
  const legacy = path.join(getLegacyAppDir(), 'servers');
  try {
    if (fs.existsSync(legacy)) return legacy;
  } catch {
    // ignore
  }
  return preferred;
}

function getRuntimesDir() {
  const preferred = path.join(getAppDir(), 'runtimes');
  const legacy = path.join(getLegacyAppDir(), 'runtimes');
  try {
    if (fs.existsSync(preferred)) return preferred;
  } catch {
    // ignore
  }
  try {
    if (fs.existsSync(legacy)) return legacy;
  } catch {
    // ignore
  }
  return preferred;
}

function getNetworkCacheDefaultDir() {
  const preferred = path.join(os.tmpdir(), 'turbonox', 'network-cache');
  const legacy = path.join(os.tmpdir(), 'voidhosting', 'network-cache');
  try {
    if (!fs.existsSync(preferred) && fs.existsSync(legacy)) {
      try {
        ensureDir(path.dirname(preferred));
        fs.renameSync(legacy, preferred);
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  return preferred;
}

module.exports = {
  getAppDir,
  getLegacyAppDir,
  getDbPath,
  getEggsDir,
  getBackupsDir,
  getServersDir,
  getRuntimesDir,
  getNetworkCacheDefaultDir,
};

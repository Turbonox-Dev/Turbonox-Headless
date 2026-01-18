const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { getEggsDir } = require('../lib/paths');
const { getDatabase } = require('../lib/database');
const { 
  getTemplateById, 
  verifyTemplate, 
  generateTemplateManifest, 
  verifyAllTemplates 
} = require('../services/templates-store');

const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

function safeReadJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  return parsed;
}

function slugifyId(input) {
  const base = String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 48);
  return base || `egg-${Date.now()}`;
}

function canWriteToDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    const testFile = path.join(dirPath, `.write-test-${Date.now()}.tmp`);
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
    return true;
  } catch {
    return false;
  }
}

function getInstalledEggsDir() {
  const appDir = path.join(path.dirname(process.execPath || process.cwd()), 'eggs');
  if (canWriteToDir(appDir)) return appDir;

  const fallback = getEggsDir();
  if (canWriteToDir(fallback)) return fallback;

  return appDir;
}

function getBundledEggDirs() {
  const candidates = [];

  // Dev.
  candidates.push(path.join(process.cwd(), 'assets', 'eggs'));

  // Production.
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'assets', 'eggs'));
  }

  return candidates.filter((p) => {
    try {
      return fs.existsSync(p) && fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
}

function listEggsFromDir(dirPath, source) {
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
        name: egg.name || id,
        description: egg.description || '',
        version: egg.version || '',
        author: egg.author || '',
        source_format: egg.source_format || 'void',
        source,
        install_supported: egg.install_supported !== false,
        runtime: egg.runtime || 'native',
        default_port: egg.default_port ?? null,
        defaults: egg.defaults && typeof egg.defaults === 'object' ? egg.defaults : null,
        variables: Array.isArray(egg.variables) ? egg.variables : [],
        install_command: egg.install_command || '',
        start_command: egg.start_command || '',
        runtime_preset: egg.runtime_preset || '',
        ptdl: egg.ptdl || null,
        icon: fs.existsSync(path.join(eggDir, 'icon.png')) ? 'icon.png' : null,
        _path: eggDir,
      });
    } catch {
      // ignore
    }
  }

  return eggs;
}

function getEggById(id) {
  const installedDir = getInstalledEggsDir();
  const bundledDirs = getBundledEggDirs();

  const installedEggs = listEggsFromDir(installedDir, 'installed');
  const bundledEggs = bundledDirs.flatMap((d) => listEggsFromDir(d, 'bundled'));

  const all = installedEggs.concat(bundledEggs);
  return all.find((e) => String(e.id) === String(id)) || null;
}

function normalizePtdlVariable(v) {
  return {
    name: v?.name || v?.env_variable || 'Variable',
    description: v?.description || '',
    env_variable: v?.env_variable || '',
    default_value: v?.default_value ?? '',
    user_viewable: v?.user_viewable !== false,
    user_editable: v?.user_editable !== false,
    rules: v?.rules || '',
    field_type: v?.field_type || 'text',
  };
}

function isLikelyLinuxInstallScript(script) {
  const s = String(script || '');
  return /\/bin\/(ash|sh)|apk\s+add|apt\s+get|yum\s+install|\/mnt\/server|\bjq\b|\bcurl\b/i.test(s);
}

function convertPtdlToVoidEgg(ptdl) {
  const name = String(ptdl?.name || '').trim() || 'Imported Egg';
  const id = slugifyId(`${name}-${ptdl?.author || ''}`);
  const startup = String(ptdl?.startup || '').trim();

  const variables = Array.isArray(ptdl?.variables) ? ptdl.variables.map(normalizePtdlVariable) : [];

  const installScript = ptdl?.scripts?.installation?.script;
  const installSupported = true;

  return {
    id,
    name,
    author: ptdl?.author || '',
    description: ptdl?.description || '',
    version: ptdl?.meta?.version || 'PTDL_v2',
    source_format: 'pterodactyl',
    runtime: 'native',
    install_supported: installSupported,
    runtime_preset: 'custom',
    install_command: '',
    start_command: startup,
    variables,
    ptdl: {
      exported_at: ptdl?.exported_at || null,
      features: Array.isArray(ptdl?.features) ? ptdl.features : [],
      installation: {
        container: ptdl?.scripts?.installation?.container || null,
        entrypoint: ptdl?.scripts?.installation?.entrypoint || null,
        script: installScript || null,
      },
    },
  };
}

function writeInstalledEgg(egg) {
  const baseDir = getInstalledEggsDir();
  const eggId = slugifyId(egg?.id || egg?.name);
  const eggDir = path.join(baseDir, eggId);
  fs.mkdirSync(eggDir, { recursive: true });

  const normalized = {
    id: eggId,
    name: egg.name || eggId,
    description: egg.description || '',
    author: egg.author || '',
    version: egg.version || '',
    source_format: egg.source_format || 'void',
    runtime: egg.runtime || 'native',
    install_supported: egg.install_supported !== false,
    runtime_preset: egg.runtime_preset || 'custom',
    install_command: egg.install_command || '',
    start_command: egg.start_command || '',
    variables: Array.isArray(egg.variables) ? egg.variables : [],
    ptdl: egg.ptdl || null,
  };

  fs.writeFileSync(path.join(eggDir, 'egg.json'), JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
}

router.get('/', (req, res) => {
  try {
    const installedDir = getInstalledEggsDir();
    const bundledDirs = getBundledEggDirs();

    const installedEggs = listEggsFromDir(installedDir, 'installed');
    const bundledEggs = bundledDirs.flatMap((d) => listEggsFromDir(d, 'bundled'));

    const byId = new Map();
    for (const e of bundledEggs.concat(installedEggs)) {
      byId.set(String(e.id), e);
    }

    const eggs = Array.from(byId.values()).map((e) => {
      const { _path, ...rest } = e;
      return rest;
    });

    res.json({ eggs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const egg = getEggById(req.params.id);
    if (!egg) return res.status(404).json({ error: 'Egg not found' });
    const { _path, ...rest } = egg;
    res.json(rest);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/import/ptdl', (req, res) => {
  try {
    const raw = req.body?.ptdl;
    const rawText = req.body?.ptdlText;

    let parsed;
    if (raw && typeof raw === 'object') {
      parsed = raw;
    } else if (typeof rawText === 'string') {
      if (Buffer.byteLength(rawText, 'utf8') > MAX_IMPORT_BYTES) {
        return res.status(413).json({ error: 'PTDL JSON too large' });
      }
      parsed = JSON.parse(rawText);
    } else {
      return res.status(400).json({ error: 'Missing ptdl or ptdlText' });
    }

    const egg = convertPtdlToVoidEgg(parsed);
    const stored = writeInstalledEgg(egg);

    res.json({ egg: stored });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const id = String(req.params.id);
    const installedDir = getInstalledEggsDir();
    const eggDir = path.join(installedDir, slugifyId(id));

    if (!eggDir.startsWith(installedDir)) {
      return res.status(400).json({ error: 'Invalid egg id' });
    }

    if (!fs.existsSync(eggDir)) {
      return res.status(404).json({ error: 'Egg not found (installed)' });
    }

    fs.rmSync(eggDir, { recursive: true, force: true });
    res.json({ message: 'Egg deleted' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Verify template package integrity
router.get('/:id/verify', async (req, res) => {
  try {
    const templateId = req.params.id;
    const verification = await verifyTemplate(templateId);
    res.json(verification);
  } catch (error) {
    console.error('[EGGS] Verification failed:', error);
    res.status(500).json({ error: error.message });
  }
});

// Generate package manifest for template
router.post('/:id/generate-manifest', async (req, res) => {
  try {
    const templateId = req.params.id;
    const options = req.body || {};
    const manifest = await generateTemplateManifest(templateId, options);
    res.json({ message: 'Manifest generated successfully', manifest });
  } catch (error) {
    console.error('[EGGS] Manifest generation failed:', error);
    res.status(500).json({ error: error.message });
  }
});

// Verify all templates
router.get('/verify/all', async (req, res) => {
  try {
    const results = await verifyAllTemplates();
    const summary = {
      total: results.length,
      verified: results.filter(r => r.verified).length,
      failed: results.filter(r => !r.verified).length,
      results: results
    };
    res.json(summary);
  } catch (error) {
    console.error('[EGGS] Bulk verification failed:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

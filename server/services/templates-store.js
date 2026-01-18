const fs = require('fs');
const path = require('path');
const { getAppDir } = require('../lib/paths');
const { packageVerification } = require('./package-verification');

function safeReadJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function slugifyId(input) {
  const base = String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 48);
  return base || `template-${Date.now()}`;
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

function getInstalledTemplatesDir() {
  const appDir = path.join(path.dirname(process.execPath || process.cwd()), 'templates');
  if (canWriteToDir(appDir)) return appDir;

  const fallback = path.join(getAppDir(), 'templates');
  if (canWriteToDir(fallback)) return fallback;

  return appDir;
}

function getBundledTemplateDirs() {
  const candidates = [];

  // In development, we look relative to this source file
  // Location: electron/backend/services/templates-store.js
  // Assets are at: ../../../assets
  const devAssets = path.join(__dirname, '..', '..', '..', 'assets');
  candidates.push(path.join(devAssets, 'templates'));
  candidates.push(path.join(devAssets, 'eggs'));

  // In production (packaged), resources are in process.resourcesPath
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'assets', 'templates'));
    candidates.push(path.join(process.resourcesPath, 'assets', 'eggs'));
  }

  // Also check direct project root just in case
  candidates.push(path.join(process.cwd(), 'assets', 'templates'));
  candidates.push(path.join(process.cwd(), 'assets', 'eggs'));

  const seen = new Set();
  return candidates.filter((p) => {
    try {
      if (seen.has(p)) return false;
      seen.add(p);
      return fs.existsSync(p) && fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
}

function normalizeTemplatePayload(raw, dirPath, source) {
  const id = String(raw?.id || path.basename(dirPath));
  const payload = {
    id,
    name: raw?.name || id,
    description: raw?.description || '',
    version: raw?.version || '',
    author: raw?.author || '',
    source_format: raw?.source_format || 'turbonox',
    source,
    runtime: raw?.runtime || 'native',
    install_supported: raw?.install_supported !== false,
    default_port: raw?.default_port ?? null,
    defaults: raw?.defaults && typeof raw.defaults === 'object' ? raw.defaults : null,
    variables: Array.isArray(raw?.variables) ? raw.variables : [],
    install_command: raw?.install_command || '',
    start_command: raw?.start_command || '',
    runtime_preset: raw?.runtime_preset || '',
    icon: fs.existsSync(path.join(dirPath, 'icon.png')) ? 'icon.png' : null,
    _path: dirPath,
  };

  // Add package verification information
  try {
    const manifestPath = path.join(dirPath, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      payload.verification = {
        hasManifest: true,
        hasChecksums: !!manifest.checksums,
        hasSignature: !!manifest.signature,
        algorithm: manifest.checksums?.algorithm || null,
        verified: null // Will be populated by verifyTemplate()
      };
    } else {
      payload.verification = {
        hasManifest: false,
        hasChecksums: false,
        hasSignature: false,
        algorithm: null,
        verified: null
      };
    }
  } catch (error) {
    console.warn(`[TEMPLATES] Failed to read verification info for ${id}:`, error.message);
    payload.verification = {
      hasManifest: false,
      hasChecksums: false,
      hasSignature: false,
      algorithm: null,
      verified: null,
      error: error.message
    };
  }

  return payload;
}

function listTemplatesFromDir(dirPath, source) {
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const templates = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const tDir = path.join(dirPath, ent.name);
    const templateJson = path.join(tDir, 'template.json');
    const eggJson = path.join(tDir, 'egg.json');

    const jsonPath = fs.existsSync(templateJson) ? templateJson : (fs.existsSync(eggJson) ? eggJson : null);
    if (!jsonPath) continue;

    try {
      const raw = safeReadJson(jsonPath);
      if (!raw || typeof raw !== 'object') continue;
      templates.push(normalizeTemplatePayload(raw, tDir, source));
    } catch {
      // ignore
    }
  }

  return templates;
}

function listAllTemplates() {
  const installedDir = getInstalledTemplatesDir();
  const bundledDirs = getBundledTemplateDirs();

  const installed = listTemplatesFromDir(installedDir, 'installed');
  const bundled = bundledDirs.flatMap((d) => listTemplatesFromDir(d, 'bundled'));

  const byId = new Map();
  for (const t of bundled.concat(installed)) {
    byId.set(String(t.id), t);
  }

  return Array.from(byId.values());
}

function getTemplateById(id) {
  const all = listAllTemplates();
  return all.find((t) => String(t.id) === String(id)) || null;
}

function writeInstalledTemplate(template) {
  const baseDir = getInstalledTemplatesDir();
  const templateId = slugifyId(template?.id || template?.name);
  const tDir = path.join(baseDir, templateId);
  fs.mkdirSync(tDir, { recursive: true });

  const normalized = {
    id: templateId,
    name: template.name || templateId,
    description: template.description || '',
    author: template.author || '',
    version: template.version || '',
    source_format: template.source_format || 'turbonox',
    runtime: template.runtime || 'native',
    install_supported: template.install_supported !== false,
    runtime_preset: template.runtime_preset || 'custom',
    install_command: template.install_command || '',
    start_command: template.start_command || '',
    default_port: template.default_port ?? null,
    defaults: template.defaults && typeof template.defaults === 'object' ? template.defaults : null,
    variables: Array.isArray(template.variables) ? template.variables : [],
  };

  fs.writeFileSync(path.join(tDir, 'template.json'), JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
}

function deleteInstalledTemplate(id) {
  const installedDir = getInstalledTemplatesDir();
  const tDir = path.join(installedDir, slugifyId(id));
  if (!tDir.startsWith(installedDir)) {
    const err = new Error('Invalid template id');
    err.code = 'INVALID_ID';
    throw err;
  }
  if (!fs.existsSync(tDir)) {
    const err = new Error('Template not found (installed)');
    err.code = 'NOT_FOUND';
    throw err;
  }
  fs.rmSync(tDir, { recursive: true, force: true });
  return true;
}

/**
 * Verify a template package integrity
 */
async function verifyTemplate(templateId) {
  const template = getTemplateById(templateId);
  if (!template) {
    throw new Error('Template not found');
  }

  if (!template.verification?.hasManifest) {
    return {
      valid: false,
      verified: false,
      errors: ['No manifest found - package cannot be verified'],
      template: template
    };
  }

  try {
    const manifest = await packageVerification.loadManifest(template._path);
    if (!manifest) {
      throw new Error('Failed to load manifest');
    }

    const verification = await packageVerification.verifyPackage(template._path, manifest);
    
    return {
      valid: verification.valid,
      verified: verification.valid,
      errors: verification.errors,
      integrity: verification.integrity,
      signature: verification.signature,
      template: template,
      manifest: manifest
    };
  } catch (error) {
    return {
      valid: false,
      verified: false,
      errors: [error.message],
      template: template
    };
  }
}

/**
 * Generate and save package manifest for a template
 */
async function generateTemplateManifest(templateId, options = {}) {
  const template = getTemplateById(templateId);
  if (!template) {
    throw new Error('Template not found');
  }

  try {
    const manifest = await packageVerification.createPackageManifest(template._path, options);
    const manifestPath = await packageVerification.saveManifest(template._path, manifest);
    
    console.log(`[TEMPLATES] Generated manifest for ${templateId}: ${manifestPath}`);
    return manifest;
  } catch (error) {
    throw new Error(`Failed to generate manifest for ${templateId}: ${error.message}`);
  }
}

/**
 * Verify all installed templates
 */
async function verifyAllTemplates() {
  const allTemplates = listAllTemplates();
  const results = [];

  for (const template of allTemplates) {
    try {
      const verification = await verifyTemplate(template.id);
      results.push(verification);
    } catch (error) {
      results.push({
        valid: false,
        verified: false,
        errors: [error.message],
        template: template
      });
    }
  }

  return results;
}

module.exports = {
  getInstalledTemplatesDir,
  getBundledTemplateDirs,
  listTemplatesFromDir,
  listAllTemplates,
  getTemplateById,
  writeInstalledTemplate,
  deleteInstalledTemplate,
  verifyTemplate,
  generateTemplateManifest,
  verifyAllTemplates,
};

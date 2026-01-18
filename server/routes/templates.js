const express = require('express');
const router = express.Router();
const { listAllTemplates, getTemplateById, writeInstalledTemplate, deleteInstalledTemplate } = require('../services/templates-store');

const MAX_IMPORT_BYTES = 2 * 1024 * 1024;


router.get('/', (req, res) => {
  try {
    const templates = listAllTemplates().map((t) => {
      const { _path, ...rest } = t;
      return rest;
    });

    res.json({ templates });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const t = getTemplateById(req.params.id);
    if (!t) return res.status(404).json({ error: 'Template not found' });
    const { _path, ...rest } = t;
    res.json(rest);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/import', (req, res) => {
  try {
    const raw = req.body?.template;
    const rawText = req.body?.templateText;

    let parsed;
    if (raw && typeof raw === 'object') {
      parsed = raw;
    } else if (typeof rawText === 'string') {
      if (Buffer.byteLength(rawText, 'utf8') > MAX_IMPORT_BYTES) {
        return res.status(413).json({ error: 'Template JSON too large' });
      }
      parsed = JSON.parse(rawText);
    } else {
      return res.status(400).json({ error: 'Missing template or templateText' });
    }

    const stored = writeInstalledTemplate(parsed);
    res.json({ template: stored });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    deleteInstalledTemplate(req.params.id);
    res.json({ message: 'Template deleted' });
  } catch (e) {
    if (e.code === 'NOT_FOUND') return res.status(404).json({ error: e.message });
    if (e.code === 'INVALID_ID') return res.status(400).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

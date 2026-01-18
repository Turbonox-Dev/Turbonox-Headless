const express = require('express');
const router = express.Router();
const { getDatabase } = require('../lib/database');

router.get('/', (req, res) => {
  try {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM settings');
    const rows = stmt.all();

    const settings = {};
    rows.forEach(row => {
      settings[row.key] = row.value;
    });

    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/', (req, res) => {
  const db = getDatabase();
  const updates = req.body;

  try {
    const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

    for (const [key, value] of Object.entries(updates)) {
      stmt.run(key, value);
    }

    res.json({ message: 'Settings updated successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:key', (req, res) => {
  try {
    const db = getDatabase();
    const stmt = db.prepare('SELECT value FROM settings WHERE key = ?');
    const row = stmt.get(req.params.key);
    res.json({ value: row ? row.value : null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
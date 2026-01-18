const express = require('express');
const router = express.Router();

// Feature flags endpoints are disabled in this build. Return 404 / disabled responses.
router.use((req, res) => {
  res.status(404).json({ error: 'Feature flags disabled' });
});

module.exports = router;

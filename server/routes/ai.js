const express = require('express');
const router = express.Router();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { getDatabase } = require('../lib/database');
const { restrictionMiddleware } = require('../utils/restrictions');

function isLocalRequest(req) {
  const ip = req.ip || req.connection?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function requireAppAccess(req, res) {
  if (!isLocalRequest(req)) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  const marker = req.get('X-Void-App');
  if (marker !== '1') {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }

  const expected = process.env.VOID_APP_TOKEN || '';
  const provided = req.get('X-Void-Token') || '';
  if (!expected || provided !== expected) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  return true;
}

function getSetting(db, key, fallback = null) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row?.value ?? fallback;
  } catch {
    return fallback;
  }
}

function setSetting(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}

function asBool(v, fallback = false) {
  if (v === null || v === undefined) return fallback;
  const s = String(v).toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  return fallback;
}

function asInt(v, fallback) {
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : fallback;
}

function redactLines(lines, { enabled, mode }) {
  if (!enabled) return lines;
  const m = String(mode || 'basic').toLowerCase();

  const patterns = [
    // API keys / tokens
    /(api[_-]?key\s*[:=]\s*)([^\s"']+)/gi,
    /(authorization\s*[:=]\s*bearer\s+)([^\s"']+)/gi,
    /(bearer\s+)([a-z0-9\-_.]+)\b/gi,
    /(token\s*[:=]\s*)([^\s"']+)/gi,
    /(secret\s*[:=]\s*)([^\s"']+)/gi,
    /(password\s*[:=]\s*)([^\s"']+)/gi,
  ];

  const extraPatterns = [
    // Connection strings / URLs with creds
    /(mongodb(?:\+srv)?:\/\/)([^\s]+)/gi,
    /(postgres(?:ql)?:\/\/)([^\s]+)/gi,
    /(mysql:\/\/)([^\s]+)/gi,
  ];

  const all = m === 'aggressive' ? patterns.concat(extraPatterns) : patterns;

  return (lines || []).map((line) => {
    let out = String(line ?? '');
    for (const re of all) {
      out = out.replace(re, (match, p1) => `${p1}[REDACTED]`);
    }
    return out;
  });
}

function buildPrompt({ server, logLines, userInstructions }) {
  const name = server?.name || 'Unknown';
  const type = server?.type || 'Unknown';
  const status = server?.status || 'Unknown';
  const port = server?.port ?? 'Unknown';
  const publicAccess = server?.public_access ? 'public' : 'local';

  const header = [
    'You are a senior SRE + full-stack engineer.',
    'Analyze the provided server logs and return a structured diagnostic report.',
    'You must be precise, avoid hallucinating, and cite evidence from the logs.',
    'If multiple causes are possible, list them with confidence.',
    '',
    'Return JSON ONLY with this schema:',
    '{',
    '  "summary": string,',
    '  "severity": "low"|"medium"|"high"|"critical",',
    '  "likely_causes": [{"title": string, "confidence": number, "evidence": string[]}],',
    '  "recommended_fixes": [{"title": string, "steps": string[], "risk": "low"|"medium"|"high"}],',
    '  "suggested_actions": [{"action": "restart_server"|"stop_server"|"start_server"|"open_network"|"none", "reason": string}],',
    '  "questions": string[]',
    '}',
    '',
    `Server context: name=${name}, type=${type}, status=${status}, port=${port}, access=${publicAccess}`,
  ].join('\n');

  const instr = userInstructions ? `\nUser instructions:\n${String(userInstructions)}\n` : '';
  const logs = (logLines || []).join('\n');

  return `${header}${instr}\nLogs:\n${logs}`;
}

async function callOpenAICompat({ baseUrl, apiKey, model, temperature, maxTokens, messages, headers = {} }) {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const resp = await axios.post(
    url,
    {
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...headers,
      },
      timeout: 45000,
    }
  );

  const content = resp?.data?.choices?.[0]?.message?.content;
  return content;
}

router.post('/analyze-logs', restrictionMiddleware('use_ai'), async (req, res) => {
  const db = getDatabase();

  try {
    if (!requireAppAccess(req, res)) return;

    const enabled = asBool(getSetting(db, 'ai.enabled', 'true'), true);
    if (!enabled) {
      return res.status(400).json({ error: 'AI features are disabled in settings.' });
    }

    const serverId = req.body?.serverId;
    const userInstructions = req.body?.instructions || '';
    const overrideLines = Array.isArray(req.body?.logLines) ? req.body.logLines : null;

    const logWindow = asInt(getSetting(db, 'ai.logWindow', '140'), 140);
    const temperatureRaw = Number(getSetting(db, 'ai.temperature', '0.2'));
    const temperature = Number.isFinite(temperatureRaw) ? Math.max(0, Math.min(temperatureRaw, 2)) : 0.2;
    const maxTokens = asInt(getSetting(db, 'ai.maxTokens', '900'), 900);

    const redact = asBool(getSetting(db, 'ai.redactEnabled', 'true'), true);
    const redactMode = getSetting(db, 'ai.redactMode', 'basic');

    const groqEnabled = asBool(getSetting(db, 'ai.groqEnabled', 'true'), true);
    const openrouterEnabled = asBool(getSetting(db, 'ai.openrouterEnabled', 'true'), true);

    const groqModel = getSetting(db, 'ai.groqModel', 'llama-3.1-70b-versatile');
    const openrouterModel = getSetting(db, 'ai.openrouterModel', 'anthropic/claude-3.5-sonnet');

    const groqMax = asInt(getSetting(db, 'ai.groqMaxRequestsBeforeFallback', '5'), 5);
    const windowHours = asInt(getSetting(db, 'ai.usageResetHours', '24'), 24);

    const now = Date.now();
    const windowStart = Number(getSetting(db, 'ai.usageWindowStart', '0')) || 0;
    let groqCount = Number(getSetting(db, 'ai.groqUsageCount', '0')) || 0;

    let effectiveWindowStart = windowStart;
    if (!windowStart || now - windowStart > windowHours * 3600 * 1000) {
      effectiveWindowStart = now;
      setSetting(db, 'ai.usageWindowStart', String(effectiveWindowStart));
      groqCount = 0;
      setSetting(db, 'ai.groqUsageCount', '0');
    }

    let server = null;
    if (serverId) {
      server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
      if (!server) return res.status(404).json({ error: 'Server not found' });
    }

    let logLines = overrideLines;
    if (!logLines) {
      if (!server?.path) return res.status(400).json({ error: 'Missing server path.' });
      const logPath = path.join(server.path, 'logs', 'output.log');
      if (!fs.existsSync(logPath)) {
        logLines = [];
      } else {
        const content = fs.readFileSync(logPath, 'utf-8');
        logLines = content.split(/\r?\n/).slice(-Math.max(20, logWindow));
      }
    }

    logLines = redactLines(logLines, { enabled: redact, mode: redactMode });

    const prompt = buildPrompt({ server, logLines, userInstructions });

    const messages = [
      {
        role: 'system',
        content: 'You analyze logs for a local desktop hosting manager. Be concise but thorough. Output valid JSON only.',
      },
      { role: 'user', content: prompt },
    ];

    const groqApiKey = getSetting(db, 'ai.groqApiKey', '');
    const openrouterApiKey = getSetting(db, 'ai.openrouterApiKey', '');

    const prefer = getSetting(db, 'ai.primaryProvider', 'groq');

    const openrouterAvailable = openrouterEnabled && !!openrouterApiKey;
    const groqAvailable = groqEnabled && !!groqApiKey;

    const shouldUseGroqFirst = prefer === 'groq' && groqAvailable && groqCount < groqMax;
    const shouldUseOpenRouterFirst = prefer === 'openrouter' && openrouterAvailable;

    const providerOrder = [];
    if (shouldUseOpenRouterFirst) providerOrder.push('openrouter');
    if (shouldUseGroqFirst) providerOrder.push('groq');

    if (providerOrder.length === 0) {
      if (groqAvailable && groqCount < groqMax) providerOrder.push('groq');
      if (openrouterAvailable) providerOrder.push('openrouter');
    }

    if (providerOrder.length === 0) {
      // If Groq is configured but the usage limit is exceeded and no OpenRouter fallback exists,
      // return a user-friendly daily limit message.
      if (groqAvailable && !openrouterAvailable && groqCount >= groqMax) {
        const retryAtMs = (effectiveWindowStart || now) + windowHours * 3600 * 1000;
        const retryAtIso = new Date(retryAtMs).toISOString();
        return res.status(429).json({
          error: `You have used up your AI request limit for today. Try again at ${retryAtIso}.`,
          retryAt: retryAtIso,
        });
      }

      return res.status(400).json({ error: 'No AI provider is available.' });
    }

    let lastErr = null;
    for (const provider of providerOrder) {
      try {
        if (provider === 'groq') {
          const content = await callOpenAICompat({
            baseUrl: 'https://api.groq.com/openai/v1',
            apiKey: groqApiKey,
            model: groqModel,
            temperature: Number.isFinite(temperature) ? temperature : 0.2,
            maxTokens,
            messages,
          });

          setSetting(db, 'ai.groqUsageCount', String(groqCount + 1));

          let parsed;
          try {
            parsed = JSON.parse(content);
          } catch {
            throw new Error('Groq returned non-JSON output');
          }
          return res.json({ result: parsed });
        }

        if (provider === 'openrouter') {
          const content = await callOpenAICompat({
            baseUrl: 'https://openrouter.ai/api/v1',
            apiKey: openrouterApiKey,
            model: openrouterModel,
            temperature: Number.isFinite(temperature) ? temperature : 0.2,
            maxTokens,
            messages,
            headers: {
              'HTTP-Referer': 'https://oriko.lk',
              'X-Title': 'Turbonox',
            },
          });

          let parsed;
          try {
            parsed = JSON.parse(content);
          } catch {
            throw new Error('OpenRouter returned non-JSON output');
          }
          return res.json({ result: parsed });
        }
      } catch (e) {
        lastErr = e;
      }
    }

    const msg =
      lastErr?.response?.data?.error?.message ||
      lastErr?.response?.data?.error ||
      lastErr?.message ||
      'AI provider call failed';

    return res.status(500).json({ error: msg });
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const aiHostingService = require('../services/AiHostingService');
const { getDatabase } = require('../lib/database');
const axios = require('axios');

async function callOpenAICompat({ baseUrl, apiKey, model, messages, temperature, maxTokens }) {
    const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
    const resp = await axios.post(
        url,
        {
            model,
            messages,
            temperature: Number(temperature) || 0.7,
            max_tokens: Number(maxTokens) || 1000,
        },
        {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            timeout: 60000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        }
    );
    return resp.data;
}

router.get('/status', async (req, res) => {
    try {
        const status = await aiHostingService.checkOllamaStatus();
        res.json(status);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/models', async (req, res) => {
    try {
        const models = await aiHostingService.listLocalModels();
        res.json({ models });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/running', async (req, res) => {
    try {
        const models = await aiHostingService.getRunningModels();
        res.json({ models });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/pull', async (req, res) => {
    const { modelName } = req.body;
    if (!modelName) return res.status(400).json({ error: 'Model name is required' });

    // Stream progress back to frontend if possible, but for simplicity now just respond when done
    // or use a job/event system.
    try {
        await aiHostingService.pullModel(modelName, (status) => {
            // console.log(`Pulling ${modelName}:`, status);
        });
        res.json({ message: `Model ${modelName} pulled successfully` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.delete('/models/:name', async (req, res) => {
    try {
        await aiHostingService.deleteModel(req.params.name);
        res.json({ message: 'Model deleted' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/generate', async (req, res) => {
    const { provider, model, prompt, systemPrompt, options, messages } = req.body;
    const db = getDatabase();

    try {
        if (provider === 'ollama') {
            if (messages && messages.length > 0) {
                // Transform messages for Ollama Vision support if needed
                const ollamaMessages = messages.map(m => {
                    if (Array.isArray(m.content)) {
                        const text = m.content.find(c => c.type === 'text')?.text || '';
                        const images = m.content
                            .filter(c => c.type === 'image_url')
                            .map(c => {
                                const match = c.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
                                return match ? match[2] : c.image_url.url;
                            });

                        return {
                            role: m.role,
                            content: text,
                            images: images.length > 0 ? images : undefined
                        };
                    }
                    return m;
                });
                const result = await aiHostingService.chat(model, ollamaMessages, options);
                return res.json({ response: result.message?.content, ...result });
            }
            const result = await aiHostingService.generate(model, prompt, systemPrompt, options);
            return res.json(result);
        }

        // Cloud Providers
        let baseUrl = '';
        let apiKey = '';
        let isAnthropic = false;

        const providerConfigs = {
            openai: { url: 'https://api.openai.com/v1', key: 'ai.openaiApiKey' },
            groq: { url: 'https://api.groq.com/openai/v1', key: 'ai.groqApiKey' },
            openrouter: { url: 'https://openrouter.ai/api/v1', key: 'ai.openrouterApiKey' },
            anthropic: { url: 'https://api.anthropic.com/v1', key: 'ai.anthropicApiKey', anthropic: true },
            gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/openai/', key: 'ai.geminiApiKey' },
            mistral: { url: 'https://api.mistral.ai/v1', key: 'ai.mistralApiKey' },
            deepseek: { url: 'https://api.deepseek.com', key: 'ai.deepseekApiKey' },
            perplexity: { url: 'https://api.perplexity.ai', key: 'ai.perplexityApiKey' },
            together: { url: 'https://api.together.xyz/v1', key: 'ai.togetherApiKey' },
            cohere: { url: 'https://api.cohere.ai/v1', key: 'ai.cohereApiKey' }
        };

        const config = providerConfigs[provider];
        if (config) {
            baseUrl = config.url;
            const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(config.key);
            apiKey = row?.value;
            isAnthropic = !!config.anthropic;
        }

        if (!apiKey) throw new Error(`API Key for ${provider} not found in settings.`);

        const payloadMessages = messages || [
            { role: 'system', content: systemPrompt || 'You are a helpful assistant.' },
            { role: 'user', content: prompt }
        ];

        if (isAnthropic) {
            // Anthropic has a different API structure than OpenAI and requires specific vision format
            const transformedMessages = payloadMessages
                .filter(m => m.role !== 'system')
                .map(m => {
                    if (Array.isArray(m.content)) {
                        return {
                            ...m,
                            content: m.content.map(c => {
                                if (c.type === 'image_url') {
                                    const match = c.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
                                    if (match) {
                                        return {
                                            type: 'image',
                                            source: {
                                                type: 'base64',
                                                media_type: match[1],
                                                data: match[2]
                                            }
                                        };
                                    }
                                }
                                return c;
                            })
                        };
                    }
                    return m;
                });

            const resp = await axios.post(
                `${baseUrl}/messages`,
                {
                    model,
                    messages: transformedMessages,
                    system: payloadMessages.find(m => m.role === 'system')?.content || systemPrompt,
                    max_tokens: options?.maxTokens || 2048,
                    temperature: Number(options?.temperature) || 0.7,
                },
                {
                    headers: {
                        'x-api-key': apiKey,
                        'anthropic-version': '2023-06-01',
                        'Content-Type': 'application/json',
                    },
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity,
                    timeout: 60000
                }
            );
            return res.json({ response: resp.data.content?.[0]?.text, ...resp.data });
        }

        const result = await callOpenAICompat({
            baseUrl,
            apiKey,
            model,
            messages: payloadMessages,
            temperature: options?.temperature || 0.7,
            maxTokens: options?.maxTokens || 2048
        });

        res.json({ response: result.choices?.[0]?.message?.content, ...result });
    } catch (error) {
        const errorDetail = error.response?.data || error.message;
        console.error(`[AI Center] Generation Error [${provider}]:`, errorDetail);

        // Return a cleaner structured error to the frontend
        res.status(500).json({
            error: typeof errorDetail === 'object' ? (errorDetail.error?.message || JSON.stringify(errorDetail)) : errorDetail,
            provider,
            status: error.response?.status
        });
    }
});

router.get('/cloud-models/:provider', async (req, res) => {
    const { provider } = req.params;
    const db = getDatabase();

    try {
        const providerConfigs = {
            openai: { url: 'https://api.openai.com/v1', key: 'ai.openaiApiKey' },
            groq: { url: 'https://api.groq.com/openai/v1', key: 'ai.groqApiKey' },
            openrouter: { url: 'https://openrouter.ai/api/v1', key: 'ai.openrouterApiKey' },
            anthropic: { url: 'https://api.anthropic.com/v1', key: 'ai.anthropicApiKey', fixed: [{ id: 'claude-3-5-sonnet-20240620', name: 'Claude 3.5 Sonnet' }, { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus' }, { id: 'claude-3-haiku-20240307', name: 'Claude 3 Haiku' }] },
            gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/openai/', key: 'ai.geminiApiKey' },
            mistral: { url: 'https://api.mistral.ai/v1', key: 'ai.mistralApiKey' },
            deepseek: { url: 'https://api.deepseek.com', key: 'ai.deepseekApiKey' },
            perplexity: { url: 'https://api.perplexity.ai', key: 'ai.perplexityApiKey' },
            together: { url: 'https://api.together.xyz/v1', key: 'ai.togetherApiKey' },
            cohere: { url: 'https://api.cohere.ai/v1', key: 'ai.cohereApiKey' }
        };

        const config = providerConfigs[provider];
        if (!config) throw new Error(`Unsupported provider: ${provider}`);

        if (config.fixed) {
            return res.json({ data: config.fixed });
        }

        const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(config.key);
        const apiKey = row?.value;

        if (!apiKey) throw new Error(`API Key for ${provider} not found.`);

        const resp = await axios.get(`${config.url.replace(/\/$/, '')}/models`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            timeout: 10000
        });

        res.json(resp.data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/config', (req, res) => {
    const db = getDatabase();
    try {
        const forgeRows = db.prepare('SELECT * FROM ai_forge_config').all();
        const settingsRows = db.prepare("SELECT * FROM settings WHERE key LIKE 'ai.%'").all();

        const config = {};
        forgeRows.forEach(r => config[r.key] = r.value);
        settingsRows.forEach(r => config[r.key] = r.value);

        res.json(config);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/config', (req, res) => {
    const db = getDatabase();
    const configs = req.body; // { key: value, ... }
    try {
        const stmtForge = db.prepare('INSERT OR REPLACE INTO ai_forge_config (key, value) VALUES (?, ?)');
        const stmtSettings = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

        const transaction = db.transaction((data) => {
            for (const [k, v] of Object.entries(data)) {
                if (k.startsWith('ai.')) {
                    stmtSettings.run(k, String(v));
                } else {
                    stmtForge.run(k, String(v));
                }
            }
        });

        transaction(configs);
        res.json({ message: 'Configuration saved' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;

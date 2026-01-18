const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

class AiHostingService {
    constructor() {
        this.ollamaUrl = 'http://localhost:11434';
    }

    async checkOllamaStatus() {
        try {
            const resp = await axios.get(`${this.ollamaUrl}/api/tags`, { timeout: 2000 });
            return { installed: true, running: true, models: resp.data?.models || [] };
        } catch (error) {
            // Check if binary exists
            try {
                const where = process.platform === 'win32' ? 'where' : 'which';
                execSync(`${where} ollama`);
                return { installed: true, running: false, models: [] };
            } catch {
                return { installed: false, running: false, models: [] };
            }
        }
    }

    async listLocalModels() {
        try {
            const resp = await axios.get(`${this.ollamaUrl}/api/tags`);
            return resp.data?.models || [];
        } catch {
            return [];
        }
    }

    async getRunningModels() {
        try {
            const resp = await axios.get(`${this.ollamaUrl}/api/ps`);
            return resp.data?.models || [];
        } catch {
            return [];
        }
    }

    async pullModel(modelName, onProgress) {
        try {
            const resp = await axios.post(`${this.ollamaUrl}/api/pull`, { name: modelName }, { responseType: 'stream' });
            resp.data.on('data', (chunk) => {
                try {
                    const lines = chunk.toString().split('\n');
                    for (const line of lines) {
                        if (!line) continue;
                        const status = JSON.parse(line);
                        if (onProgress) onProgress(status);
                    }
                } catch {
                    // ignore parse errors for partial chunks
                }
            });
            return new Promise((resolve, reject) => {
                resp.data.on('end', resolve);
                resp.data.on('error', reject);
            });
        } catch (error) {
            throw new Error(`Failed to pull model: ${error.message}`);
        }
    }

    async deleteModel(modelName) {
        try {
            await axios.delete(`${this.ollamaUrl}/api/delete`, { data: { name: modelName } });
            return true;
        } catch (error) {
            throw new Error(`Failed to delete model: ${error.message}`);
        }
    }

    async generate(model, prompt, systemPrompt, options = {}) {
        try {
            const resp = await axios.post(`${this.ollamaUrl}/api/generate`, {
                model,
                prompt,
                system: systemPrompt,
                stream: false,
                options
            }, {
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
                timeout: 120000 // 2 minutes for local generation
            });
            return resp.data;
        } catch (error) {
            throw new Error(`AI Generation failed: ${error.message}`);
        }
    }

    async chat(model, messages, options = {}) {
        try {
            const resp = await axios.post(`${this.ollamaUrl}/api/chat`, {
                model,
                messages,
                stream: false,
                options
            }, {
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
                timeout: 120000 // 2 minutes for local vision/chat
            });
            return resp.data;
        } catch (error) {
            throw new Error(`AI Chat failed: ${error.message}`);
        }
    }
}

module.exports = new AiHostingService();

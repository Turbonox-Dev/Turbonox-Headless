/**
 * Tunnel Service for Turbonox
 * 
 * Manages Cloudflare tunnels for NAT traversal, allowing nodes behind
 * firewalls/NAT to be accessible from the internet.
 * 
 * Uses Cloudflare's free "quick tunnels" (*.trycloudflare.com) by default.
 * Can be upgraded to named tunnels with your own domain.
 */

const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');

// Track running tunnels
const activeTunnels = new Map();

/**
 * Get the appropriate cloudflared binary name for the current platform
 */
function getCloudflaredBinaryName() {
    const platform = os.platform();
    const arch = os.arch();

    if (platform === 'win32') {
        return 'cloudflared-windows-amd64.exe';
    } else if (platform === 'darwin') {
        return arch === 'arm64' ? 'cloudflared-darwin-arm64' : 'cloudflared-darwin-amd64';
    } else {
        // Linux
        return arch === 'arm64' ? 'cloudflared-linux-arm64' : 'cloudflared-linux-amd64';
    }
}

/**
 * Get the cloudflared download URL
 */
function getCloudflaredDownloadUrl() {
    const binaryName = getCloudflaredBinaryName();
    return `https://github.com/cloudflare/cloudflared/releases/latest/download/${binaryName}`;
}

/**
 * Get the local path for cloudflared binary
 */
function getCloudflaredPath(appDataDir) {
    const binDir = path.join(appDataDir, 'bin');
    const binaryName = os.platform() === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    return path.join(binDir, binaryName);
}

/**
 * Download a file from URL to local path
 */
function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const dir = path.dirname(destPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const file = fs.createWriteStream(destPath);

        const request = (reqUrl) => {
            https.get(reqUrl, (response) => {
                // Handle redirects
                if (response.statusCode === 301 || response.statusCode === 302) {
                    request(response.headers.location);
                    return;
                }

                if (response.statusCode !== 200) {
                    reject(new Error(`Download failed with status ${response.statusCode}`));
                    return;
                }

                response.pipe(file);
                file.on('finish', () => {
                    file.close();
                    // Make executable on Unix
                    if (os.platform() !== 'win32') {
                        fs.chmodSync(destPath, 0o755);
                    }
                    resolve(destPath);
                });
            }).on('error', (err) => {
                fs.unlink(destPath, () => { });
                reject(err);
            });
        };

        request(url);
    });
}

/**
 * Check if cloudflared is installed
 */
async function isCloudflaredInstalled(appDataDir) {
    const cloudflaredPath = getCloudflaredPath(appDataDir);
    return fs.existsSync(cloudflaredPath);
}

/**
 * Install cloudflared binary
 */
async function installCloudflared(appDataDir) {
    const cloudflaredPath = getCloudflaredPath(appDataDir);

    if (await isCloudflaredInstalled(appDataDir)) {
        console.log('[TUNNEL] cloudflared already installed');
        return cloudflaredPath;
    }

    console.log('[TUNNEL] Downloading cloudflared...');
    const url = getCloudflaredDownloadUrl();
    await downloadFile(url, cloudflaredPath);
    console.log('[TUNNEL] cloudflared installed at', cloudflaredPath);

    return cloudflaredPath;
}

/**
 * Start a quick tunnel (free, no auth required)
 * Returns a public URL like https://xyz.trycloudflare.com
 * 
 * @param {object} config - Tunnel configuration
 * @param {string} config.appDataDir - App data directory for storing cloudflared
 * @param {number} config.localPort - Local port to tunnel (e.g., 3001 for node agent)
 * @param {string} config.nodeId - Node identifier for tracking
 * @param {function} [config.onUrl] - Callback when tunnel URL is available
 * @param {function} [config.onError] - Callback on error
 */
async function startQuickTunnel({ appDataDir, localPort, nodeId, onUrl, onError }) {
    // Stop existing tunnel for this node if any
    await stopTunnel(nodeId);

    const cloudflaredPath = await installCloudflared(appDataDir);

    const args = ['tunnel', '--url', `http://localhost:${localPort}`];

    console.log(`[TUNNEL] Starting quick tunnel for node ${nodeId} on port ${localPort}`);

    const child = spawn(cloudflaredPath, args, {
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });

    let tunnelUrl = null;
    let stderr = '';

    // cloudflared outputs the URL to stderr
    child.stderr.on('data', (data) => {
        const output = data.toString();
        stderr += output;

        // Look for the tunnel URL in output
        const urlMatch = output.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
        if (urlMatch && !tunnelUrl) {
            tunnelUrl = urlMatch[0];
            console.log(`[TUNNEL] Node ${nodeId} tunnel URL: ${tunnelUrl}`);

            // Update tunnel info
            const existing = activeTunnels.get(nodeId);
            if (existing) {
                existing.url = tunnelUrl;
                existing.status = 'connected';
            }

            if (typeof onUrl === 'function') {
                onUrl(tunnelUrl);
            }
        }
    });

    child.stdout.on('data', (data) => {
        // cloudflared also logs to stdout
        const output = data.toString();
        const urlMatch = output.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
        if (urlMatch && !tunnelUrl) {
            tunnelUrl = urlMatch[0];
            console.log(`[TUNNEL] Node ${nodeId} tunnel URL: ${tunnelUrl}`);

            const existing = activeTunnels.get(nodeId);
            if (existing) {
                existing.url = tunnelUrl;
                existing.status = 'connected';
            }

            if (typeof onUrl === 'function') {
                onUrl(tunnelUrl);
            }
        }
    });

    child.on('error', (err) => {
        console.error(`[TUNNEL] Failed to start tunnel for node ${nodeId}:`, err);
        activeTunnels.delete(nodeId);
        if (typeof onError === 'function') {
            onError(err);
        }
    });

    child.on('close', (code) => {
        console.log(`[TUNNEL] Tunnel for node ${nodeId} closed with code ${code}`);
        activeTunnels.delete(nodeId);
    });

    // Store tunnel info
    activeTunnels.set(nodeId, {
        process: child,
        pid: child.pid,
        localPort,
        url: null,
        status: 'connecting',
        startedAt: new Date().toISOString(),
    });

    // Wait a bit for URL to be captured
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const info = activeTunnels.get(nodeId);
    return {
        nodeId,
        pid: child.pid,
        url: info?.url || null,
        status: info?.status || 'connecting',
    };
}

/**
 * Stop a tunnel
 */
async function stopTunnel(nodeId) {
    const tunnel = activeTunnels.get(nodeId);
    if (!tunnel) return false;

    try {
        tunnel.process.kill('SIGTERM');
        activeTunnels.delete(nodeId);
        console.log(`[TUNNEL] Stopped tunnel for node ${nodeId}`);
        return true;
    } catch (err) {
        console.error(`[TUNNEL] Failed to stop tunnel for node ${nodeId}:`, err);
        return false;
    }
}

/**
 * Get tunnel status
 */
function getTunnelStatus(nodeId) {
    const tunnel = activeTunnels.get(nodeId);
    if (!tunnel) {
        return { active: false, nodeId };
    }

    return {
        active: true,
        nodeId,
        pid: tunnel.pid,
        url: tunnel.url,
        status: tunnel.status,
        localPort: tunnel.localPort,
        startedAt: tunnel.startedAt,
    };
}

/**
 * Get all active tunnels
 */
function getAllTunnels() {
    const tunnels = [];
    for (const [nodeId, tunnel] of activeTunnels) {
        tunnels.push({
            nodeId,
            pid: tunnel.pid,
            url: tunnel.url,
            status: tunnel.status,
            localPort: tunnel.localPort,
            startedAt: tunnel.startedAt,
        });
    }
    return tunnels;
}

/**
 * Stop all tunnels (cleanup on shutdown)
 */
async function stopAllTunnels() {
    const nodeIds = [...activeTunnels.keys()];
    for (const nodeId of nodeIds) {
        await stopTunnel(nodeId);
    }
}

module.exports = {
    getCloudflaredPath,
    isCloudflaredInstalled,
    installCloudflared,
    startQuickTunnel,
    stopTunnel,
    getTunnelStatus,
    getAllTunnels,
    stopAllTunnels,
};

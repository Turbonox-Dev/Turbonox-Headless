const { Client } = require('ssh2');
const crypto = require('crypto');

class SshService {
    constructor() {
        this.connections = new Map();
    }

    async getConnection(node, options = {}) {
        if (this.connections.has(node.id) && !options.forceNew) {
            return this.connections.get(node.id);
        }

        return new Promise((resolve, reject) => {
            const conn = new Client();
            let hostKeyVerified = false;
            let hostKeyError = null;

            conn
                .on('ready', () => {
                    this.connections.set(node.id, conn);
                    resolve(conn);
                })
                .on('error', (err) => {
                    this.connections.delete(node.id);
                    if (hostKeyError) return reject(hostKeyError);
                    reject(err);
                })
                .on('close', () => {
                    this.connections.delete(node.id);
                })
                .connect({
                    host: node.ip_address,
                    port: node.ssh_port || 22,
                    username: node.ssh_user,
                    password: node.ssh_password,
                    privateKey: node.ssh_key ? Buffer.from(node.ssh_key) : undefined,
                    readyTimeout: 10000,
                    verifyHostKey: (info) => {
                        const hash = crypto.createHash('sha256').update(info.key).digest('base64').replace(/=+$/, '');
                        const fingerprint = `SHA256:${hash}`;

                        // If user explicitly trusted it in the request or it matches stored key
                        if (options.trustHost || node.host_key === fingerprint) {
                            hostKeyVerified = true;
                            return true;
                        }

                        // Mismatch or first time
                        hostKeyError = {
                            code: 'SSH_HOST_KEY_UNVERIFIED',
                            fingerprint: fingerprint,
                            message: `The authenticity of host '${node.ip_address}' can't be established.`,
                            algo: info.algo
                        };
                        return false;
                    }
                });
        });
    }

    async exec(node, command) {
        const conn = await this.getConnection(node);
        return new Promise((resolve, reject) => {
            conn.exec(command, (err, stream) => {
                if (err) return reject(err);
                let stdout = '';
                let stderr = '';
                stream
                    .on('close', (code, signal) => {
                        resolve({ stdout, stderr, code, signal });
                    })
                    .on('data', (data) => {
                        stdout += data.toString();
                    })
                    .stderr.on('data', (data) => {
                        stderr += data.toString();
                    });
            });
        });
    }

    async execStream(node, command, onData) {
        const conn = await this.getConnection(node);
        return new Promise((resolve, reject) => {
            conn.exec(command, (err, stream) => {
                if (err) return reject(err);
                stream
                    .on('close', (code, signal) => {
                        resolve({ code, signal });
                    })
                    .on('data', (data) => {
                        if (onData) onData(data.toString());
                    })
                    .stderr.on('data', (data) => {
                        if (onData) onData(data.toString());
                    });
            });
        });
    }

    /**
     * Fetch system stats via SSH
     * Commands used: 
     * - CPU: top -bn1 | grep "Cpu(s)"
     * - Memory: free -m
     * - Uptime: cat /proc/uptime
     * - Disk: df -h
     */
    async getSystemStats(node) {
        try {
            const cpuCmd = "top -bn1 | grep 'Cpu(s)' | awk '{print $2 + $4}'";
            const memCmd = "free -b | grep Mem";
            const uptimeCmd = "cat /proc/uptime | awk '{print $1}'";
            const diskCmd = "df -BG --output=target,size,used,avail,pcent / | tail -n 1";

            const [cpu, mem, uptime, disk] = await Promise.all([
                this.exec(node, cpuCmd).then(r => r.stdout.trim() || '0'),
                this.exec(node, memCmd).then(r => r.stdout.trim()),
                this.exec(node, uptimeCmd).then(r => r.stdout.trim() || '0'),
                this.exec(node, diskCmd).then(r => r.stdout.trim())
            ]);

            // Parse Memory: Mem: total used free shared buff/cache available
            const memParts = mem.split(/\s+/);
            const memTotal = parseInt(memParts[1]);
            const memUsed = parseInt(memParts[2]);
            const memFree = parseInt(memParts[3]);

            // Parse Disk: target size used avail pcent
            const diskParts = disk.split(/\s+/);

            return {
                cpu: { usage: cpu },
                memory: {
                    total: (memTotal / (1024 ** 3)).toFixed(2),
                    used: (memUsed / (1024 ** 3)).toFixed(2),
                    free: (memFree / (1024 ** 3)).toFixed(2),
                    percentage: ((memUsed / memTotal) * 100).toFixed(1)
                },
                uptime: parseFloat(uptime),
                disk: [{
                    mount: diskParts[0],
                    total: diskParts[1].replace('G', ''),
                    used: diskParts[2].replace('G', ''),
                    available: diskParts[3].replace('G', ''),
                    percentage: diskParts[4].replace('%', '')
                }]
            };
        } catch (error) {
            console.error(`[SSH:${node.name}] Failed to fetch stats:`, error.message);
            throw error;
        }
    }

    /**
     * List servers (containers) if Docker is present
     */
    async getRemoteServers(node) {
        try {
            // For now, let's assume we look for Docker containers
            const dockerCmd = "docker ps --format '{{.ID}}|{{.Names}}|{{.Status}}|{{.Image}}' || echo 'no-docker'";
            const { stdout } = await this.exec(node, dockerCmd);

            if (stdout.includes('no-docker')) return [];

            return stdout.trim().split('\n').filter(Boolean).map(line => {
                const [id, name, status, image] = line.split('|');
                return {
                    id: id,
                    name: name,
                    status: status.toLowerCase().includes('up') ? 'running' : 'stopped',
                    type: 'docker',
                    path: `docker://${image}`,
                    execution_mode: 'docker'
                };
            });
        } catch (error) {
            console.error(`[SSH:${node.name}] Failed to fetch servers:`, error.message);
            return [];
        }
    }
}

module.exports = { SshService: new SshService() };

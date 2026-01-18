const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { getAppDir } = require('../lib/paths');
const { getDatabase } = require('../lib/database');

class CloudDriveService {
    constructor() {
        this.mounts = new Map(); // driveId -> process
    }

    async getAvailableDrives() {
        const db = getDatabase();
        const accounts = db.prepare('SELECT id, display_name, cloud_storage_config FROM accounts').all();

        const drives = [];
        for (const acc of accounts) {
            if (acc.cloud_storage_config) {
                try {
                    const config = JSON.parse(acc.cloud_storage_config);
                    if (config.provider === 'gdrive') {
                        drives.push({
                            id: `gdrive-${acc.id}`,
                            accountId: acc.id,
                            name: `${acc.display_name}'s Google Drive`,
                            provider: 'gdrive',
                            mounted: this.mounts.has(`gdrive-${acc.id}`),
                            mountPoint: config.mountPoint || null
                        });
                    }
                } catch (e) {
                    console.error('[CloudDrive] Failed to parse config for account', acc.id, e.message);
                }
            }
        }

        // Also check global settings for legacy GDrive
        const gdriveTokens = db.prepare("SELECT value FROM settings WHERE key = 'gdrive.tokens'").get();
        if (gdriveTokens?.value) {
            drives.push({
                id: 'gdrive-global',
                accountId: null,
                name: 'Primary Google Drive',
                provider: 'gdrive',
                mounted: this.mounts.has('gdrive-global'),
                mountPoint: null // will be filled if mounted
            });
        }

        return drives;
    }

    async mount(driveId, provider, options = {}) {
        if (this.mounts.has(driveId)) {
            throw new Error('Drive is already mounted');
        }

        const db = getDatabase();
        let credentials = null;

        if (driveId === 'gdrive-global') {
            const credRow = db.prepare("SELECT value FROM settings WHERE key = 'gdrive.credentials'").get();
            const tokenRow = db.prepare("SELECT value FROM settings WHERE key = 'gdrive.tokens'").get();
            if (credRow?.value && tokenRow?.value) {
                credentials = {
                    client_id: JSON.parse(credRow.value).client_id,
                    client_secret: JSON.parse(credRow.value).client_secret,
                    tokens: JSON.parse(tokenRow.value)
                };
            }
        } else if (driveId.startsWith('gdrive-')) {
            const accountId = driveId.replace('gdrive-', '');
            const acc = db.prepare('SELECT cloud_storage_config FROM accounts WHERE id = ?').get(accountId);
            if (acc?.cloud_storage_config) {
                credentials = JSON.parse(acc.cloud_storage_config).credentials;
            }
        }

        if (!credentials) {
            throw new Error('Credentials not found for this drive');
        }

        // Determine mount point (e.g., T: drive)
        const mountPoint = options.mountPoint || await this.findFreeDriveLetter();

        // Create temporary rclone config
        const configPath = await this.createRcloneConfig(driveId, provider, credentials);

        console.log(`[CloudDrive] Mounting ${driveId} to ${mountPoint} using rclone...`);

        // Run rclone mount
        // Note: rclone mount on Windows requires WinFSP installed.
        const args = [
            'mount',
            `${driveId}:`,
            mountPoint,
            '--config', configPath,
            '--vfs-cache-mode', 'full',
            '--no-console',
            '--volname', `${driveId}`
        ];

        const child = spawn('rclone', args, {
            windowsHide: true,
            detached: true
        });

        child.on('error', (err) => {
            console.error(`[CloudDrive] rclone error for ${driveId}:`, err.message);
            this.mounts.delete(driveId);
        });

        child.on('exit', (code) => {
            console.log(`[CloudDrive] rclone exited for ${driveId} with code ${code}`);
            this.mounts.delete(driveId);
        });

        // Wait a bit to see if it crashes immediately
        await new Promise(resolve => setTimeout(resolve, 2000));

        if (child.exitCode !== null) {
            throw new Error(`rclone failed to start (exit code ${child.exitCode}). Ensure rclone and WinFSP are installed.`);
        }

        this.mounts.set(driveId, {
            process: child,
            mountPoint: mountPoint,
            configPath: configPath
        });

        return { success: true, mountPoint };
    }

    async unmount(driveId) {
        const mount = this.mounts.get(driveId);
        if (!mount) return { success: true };

        console.log(`[CloudDrive] Unmounting ${driveId}...`);

        // On Windows, we might need taskkill or just kill the process
        if (process.platform === 'win32') {
            spawn('taskkill', ['/F', '/T', '/PID', mount.process.pid]);
        } else {
            mount.process.kill();
        }

        this.mounts.delete(driveId);

        // Cleanup config file
        try {
            if (fs.existsSync(mount.configPath)) fs.unlinkSync(mount.configPath);
        } catch { }

        return { success: true };
    }

    async createRcloneConfig(driveId, provider, credentials) {
        const configDir = path.join(getAppDir(), 'cloud-configs');
        if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

        const configPath = path.join(configDir, `${driveId}.conf`);
        let content = '';

        if (provider === 'gdrive') {
            content = `
[${driveId}]
type = drive
client_id = ${credentials.client_id}
client_secret = ${credentials.client_secret}
scope = drive.file
token = ${JSON.stringify(credentials.tokens)}
`;
        }

        fs.writeFileSync(configPath, content);
        return configPath;
    }

    async findFreeDriveLetter() {
        if (process.platform !== 'win32') return '/mnt/turbonox';

        const used = new Set();
        // This is a simplified check, ideally use 'wmic logicaldisk get caption'
        // but for now let's just try from T: downwards
        const candidate = 'T:';
        return candidate;
    }
}

const cloudDriveService = new CloudDriveService();
module.exports = { cloudDriveService };

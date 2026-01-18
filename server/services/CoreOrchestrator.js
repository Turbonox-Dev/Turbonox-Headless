const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dockerRuntime = require('./docker-runtime');
const { getDatabase } = require('../lib/database');
const AuditService = require('./AuditService');
const processRegistry = require('./ProcessRegistry');

class CoreOrchestrator {
    /**
     * 1. Input Contract & 2. Validation Layer
     */
    static async validate(serverConfig) {
        const errors = [];
        if (!serverConfig.name) errors.push('Server name is required');
        if (!serverConfig.image) errors.push('Image/runtime identifier is required');

        // Resource limits validation (CPU, RAM, Disk) - only if provided
        if (serverConfig.cpuLimit !== undefined && (serverConfig.cpuLimit < 1 || serverConfig.cpuLimit > 400)) {
            errors.push('CPU limit must be between 1 and 400 percent');
        }
        if (serverConfig.memoryLimit !== undefined && serverConfig.memoryLimit < 128) {
            errors.push('Memory limit must be at least 128MB');
        }

        if (errors.length > 0) {
            throw new Error(`Validation failed: ${errors.join(', ')}`);
        }
        return true;
    }

    /**
     * 3. Allocation Phase
     */
    static allocate(serverId) {
        const uuid = serverId || crypto.randomUUID();
        const containerName = `turbonox-srv-${uuid}`;
        // Default path in the current working directory / instances
        const defaultPath = path.join(process.cwd(), 'instances', uuid);
        return { uuid, containerName, defaultPath };
    }

    /**
     * 4. Filesystem Provisioning
     */
    static async provisionFilesystem(serverPath, diskLimitGb) {
        if (!fs.existsSync(serverPath)) {
            fs.mkdirSync(serverPath, { recursive: true });
        }
        // Apply disk quota logic here if supported by the OS (e.g., XFS quotas or loopback mounts)
        // For now, we rely on Docker's storage-opt if available.
        return serverPath;
    }

    /**
     * 5. Container Specification Build
     */
    static buildSpecification(serverRow, config) {
        return {
            serverId: serverRow.id,
            image: serverRow.image || config.image,
            hostPath: serverRow.path,
            envVars: JSON.parse(serverRow.env_vars || '{}'),
            cpuLimitPercent: serverRow.cpu_limit_percent,
            memoryLimitMb: serverRow.memory_limit_mb,
            diskLimitGb: serverRow.disk_limit_mb ? serverRow.disk_limit_mb / 1024 : null,
            startCommand: serverRow.start_command,
            networkName: 'turbonox-net', // Default network
        };
    }

    /**
     * 6. Install Phase
     */
    static async runInstall(serverId, installCmd, image) {
        const db = getDatabase();
        const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
        if (!server) throw new Error('Server not found');

        AuditService.log(serverId, 'SERVER_INSTALL_START', 'system', 'Starting installation phase');

        try {
            // Create temporary container for install
            const exitCode = await dockerRuntime.runOneOff({
                image: image || server.image || 'ubuntu:22.04',
                hostPath: server.path,
                command: installCmd || server.install_command,
                envVars: JSON.parse(server.env_vars || '{}'),
                logFilePath: path.join(server.path, 'logs', 'install.log')
            });

            if (exitCode !== 0) {
                throw new Error(`Install phase failed with exit code ${exitCode}`);
            }

            AuditService.log(serverId, 'SERVER_INSTALL_SUCCESS', 'system', 'Installation phase completed');
            return true;
        } catch (err) {
            AuditService.log(serverId, 'SERVER_INSTALL_FAILED', 'system', err.message);
            throw err;
        }
    }

    /**
     * 7. Runtime Container Creation & 9. Execution Control
     */
    static async start(serverId) {
        const db = getDatabase();
        const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
        if (!server) throw new Error('Server not found');

        const spec = this.buildSpecification(server, {});

        // 8. Startup Assembly is handled inside dockerRuntime.startContainerForServer
        const result = await dockerRuntime.startContainerForServer(spec);

        db.prepare('UPDATE servers SET status = ?, pid = ? WHERE id = ?')
            .run('running', result.containerId, serverId);

        // 10. Monitoring Loop is handled by the global resource-monitor service
        // which polls dockerRuntime.getContainerStats

        AuditService.log(serverId, 'SERVER_START', 'system', 'Server started in container');
        return result;
    }

    /**
     * 11. Control Operations (STOP)
     */
    static async stop(serverId) {
        await dockerRuntime.stopContainerForServer(serverId);
        const db = getDatabase();
        db.prepare('UPDATE servers SET status = ?, pid = NULL WHERE id = ?')
            .run('stopped', serverId);

        AuditService.log(serverId, 'SERVER_STOP', 'system', 'Server stopped');
    }

    /**
     * 11. Control Operations (KILL)
     */
    static async kill(serverId) {
        const name = dockerRuntime.containerNameForServerId(serverId);
        await dockerRuntime.execDocker(['kill', name]);
        const db = getDatabase();
        db.prepare('UPDATE servers SET status = ?, pid = NULL WHERE id = ?')
            .run('stopped', serverId);

        AuditService.log(serverId, 'SERVER_KILL', 'system', 'Server force killed');
    }

    /**
     * 14. Destruction Logic
     */
    static async destroy(serverId) {
        const db = getDatabase();
        const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);

        try {
            await this.stop(serverId).catch(() => { });
            const name = dockerRuntime.containerNameForServerId(serverId);
            await dockerRuntime.execDocker(['rm', '-f', name]).catch(() => { });

            // Release resources
            if (server?.path && fs.existsSync(server.path)) {
                // Option to archive or just delete? Spec says "Delete filesystem"
                fs.rmSync(server.path, { recursive: true, force: true });
            }

            db.prepare('DELETE FROM servers WHERE id = ?').run(serverId);
            AuditService.log(serverId, 'SERVER_DESTROYED', 'system', 'Server and filesystem removed');
        } catch (err) {
            console.error(`[ORCHESTRATOR] Destruction failed for ${serverId}:`, err);
            throw err;
        }
    }
}

module.exports = CoreOrchestrator;

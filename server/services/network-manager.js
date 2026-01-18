/**
 * Network Manager for Docker Container IP Allocation
 * 
 * Manages Docker macvlan networks and static IP assignments for server containers.
 * This enables each server to have its own dedicated IP address.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Helper to execute docker commands
function execDocker(args, opts = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn('docker', args, {
            shell: false,
            windowsHide: true,
            ...opts,
        });

        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', (d) => {
            stdout += d.toString('utf8');
        });

        child.stderr?.on('data', (d) => {
            stderr += d.toString('utf8');
        });

        child.on('error', (err) => {
            reject(err);
        });

        child.on('close', (code) => {
            if (code === 0) return resolve({ stdout, stderr, code });
            const e = new Error(stderr || stdout || `docker ${args.join(' ')} failed with code ${code}`);
            e.code = code;
            e.stdout = stdout;
            e.stderr = stderr;
            reject(e);
        });
    });
}

/**
 * Network configuration for Turbonox
 */
const TURBONOX_NETWORK_PREFIX = 'turbonox-net';

/**
 * Check if a Docker network exists
 */
async function networkExists(networkName) {
    try {
        await execDocker(['network', 'inspect', networkName]);
        return true;
    } catch {
        return false;
    }
}

/**
 * Create a macvlan network for static IP assignment.
 * 
 * Macvlan allows containers to have their own MAC address and IP on the physical network.
 * 
 * @param {object} config - Network configuration
 * @param {string} config.networkName - Name for the Docker network
 * @param {string} config.subnet - CIDR subnet (e.g., "192.168.1.0/24")
 * @param {string} config.gateway - Gateway IP (e.g., "192.168.1.1")
 * @param {string} config.parentInterface - Host network interface (e.g., "eth0", "ens3")
 * @param {string} [config.ipRange] - Optional IP range for allocation (e.g., "192.168.1.128/25")
 */
async function createMacvlanNetwork({ networkName, subnet, gateway, parentInterface, ipRange }) {
    if (!networkName || !subnet || !gateway || !parentInterface) {
        throw new Error('Missing required network configuration: networkName, subnet, gateway, parentInterface');
    }

    // Check if network already exists
    if (await networkExists(networkName)) {
        console.log(`[NETWORK] Network ${networkName} already exists`);
        return { created: false, networkName };
    }

    const args = [
        'network', 'create',
        '-d', 'macvlan',
        '--subnet', subnet,
        '--gateway', gateway,
        '-o', `parent=${parentInterface}`,
    ];

    if (ipRange) {
        args.push('--ip-range', ipRange);
    }

    args.push(networkName);

    try {
        await execDocker(args);
        console.log(`[NETWORK] Created macvlan network: ${networkName}`);
        return { created: true, networkName };
    } catch (e) {
        console.error(`[NETWORK] Failed to create network ${networkName}:`, e.message);
        throw e;
    }
}

/**
 * Create a bridge network (simpler alternative to macvlan).
 * 
 * Bridge networks allow internal IP assignment and are easier to set up.
 * External access is via port mapping.
 * 
 * @param {object} config - Network configuration
 * @param {string} config.networkName - Name for the Docker network
 * @param {string} [config.subnet] - Optional CIDR subnet (e.g., "172.20.0.0/16")
 * @param {string} [config.gateway] - Optional gateway IP
 */
async function createBridgeNetwork({ networkName, subnet, gateway }) {
    if (!networkName) {
        throw new Error('Network name is required');
    }

    if (await networkExists(networkName)) {
        console.log(`[NETWORK] Network ${networkName} already exists`);
        return { created: false, networkName };
    }

    const args = ['network', 'create', '-d', 'bridge'];

    if (subnet) {
        args.push('--subnet', subnet);
    }

    if (gateway) {
        args.push('--gateway', gateway);
    }

    args.push(networkName);

    try {
        await execDocker(args);
        console.log(`[NETWORK] Created bridge network: ${networkName}`);
        return { created: true, networkName };
    } catch (e) {
        console.error(`[NETWORK] Failed to create network ${networkName}:`, e.message);
        throw e;
    }
}

/**
 * Get or create the default Turbonox server network.
 * Uses a bridge network with a dedicated subnet for server containers.
 */
async function ensureDefaultNetwork() {
    const networkName = `${TURBONOX_NETWORK_PREFIX}-servers`;
    const subnet = '172.30.0.0/16';
    const gateway = '172.30.0.1';

    return await createBridgeNetwork({ networkName, subnet, gateway });
}

/**
 * Calculate a static IP for a server based on its ID.
 * Uses the default Turbonox network subnet.
 * 
 * @param {string|number} serverId - Server identifier
 * @returns {string} IP address in the format 172.30.X.Y
 */
function calculateServerIP(serverId) {
    // Convert serverId to a number for IP calculation
    const id = typeof serverId === 'number' ? serverId : parseInt(serverId, 10) || 1;

    // Distribute across the subnet: 172.30.X.Y
    // Reserve 172.30.0.1 for gateway, start from 172.30.0.10
    const baseOffset = 10;
    const ipOffset = baseOffset + id;

    const thirdOctet = Math.floor(ipOffset / 254);
    const fourthOctet = (ipOffset % 254) + 1;

    return `172.30.${thirdOctet}.${fourthOctet}`;
}

/**
 * Remove a Docker network
 */
async function removeNetwork(networkName) {
    try {
        await execDocker(['network', 'rm', networkName]);
        console.log(`[NETWORK] Removed network: ${networkName}`);
        return true;
    } catch (e) {
        const msg = String(e?.message || '').toLowerCase();
        if (msg.includes('not found') || msg.includes('no such network')) {
            return false;
        }
        throw e;
    }
}

/**
 * List all Turbonox networks
 */
async function listTurbonoxNetworks() {
    try {
        const res = await execDocker([
            'network', 'ls',
            '--filter', `name=${TURBONOX_NETWORK_PREFIX}`,
            '--format', '{{.Name}}'
        ]);
        return res.stdout.trim().split('\n').filter(Boolean);
    } catch {
        return [];
    }
}

/**
 * Get network details including connected containers
 */
async function getNetworkInfo(networkName) {
    try {
        const res = await execDocker(['network', 'inspect', networkName]);
        const data = JSON.parse(res.stdout);
        return data[0] || null;
    } catch {
        return null;
    }
}

/**
 * Disconnect a container from a network
 */
async function disconnectFromNetwork(containerName, networkName) {
    try {
        await execDocker(['network', 'disconnect', networkName, containerName]);
        return true;
    } catch {
        return false;
    }
}

/**
 * Connect a container to a network with a specific IP
 */
async function connectToNetwork(containerName, networkName, ip) {
    const args = ['network', 'connect'];

    if (ip) {
        args.push('--ip', ip);
    }

    args.push(networkName, containerName);

    try {
        await execDocker(args);
        return true;
    } catch (e) {
        console.error(`[NETWORK] Failed to connect ${containerName} to ${networkName}:`, e.message);
        throw e;
    }
}

module.exports = {
    execDocker,
    networkExists,
    createMacvlanNetwork,
    createBridgeNetwork,
    ensureDefaultNetwork,
    calculateServerIP,
    removeNetwork,
    listTurbonoxNetworks,
    getNetworkInfo,
    disconnectFromNetwork,
    connectToNetwork,
    TURBONOX_NETWORK_PREFIX,
};

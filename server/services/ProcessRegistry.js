/**
 * ProcessRegistry.js
 * Manages the runtime state of server processes, including port bridging information.
 */

class ProcessRegistry {
    constructor() {
        this.processes = new Map();
        this.stopping = new Set();
    }

    /**
     * Register a new running process
     * @param {string|number} serverId 
     * @param {object} processData 
     * @param {ChildProcess} processData.process
     * @param {number} [processData.bridgedPort]
     */
    set(serverId, data) {
        this.processes.set(String(serverId), data);
    }

    /**
     * Get process data
     * @param {string|number} serverId 
     * @returns {object|undefined}
     */
    get(serverId) {
        return this.processes.get(String(serverId));
    }

    /**
     * Delete a process
     * @param {string|number} serverId 
     */
    delete(serverId) {
        this.processes.delete(String(serverId));
    }

    /**
     * Check if a server is running
     * @param {string|number} serverId 
     */
    has(serverId) {
        return this.processes.has(String(serverId));
    }

    /**
     * Mark a process as stopping
     */
    markStopping(serverId) {
        this.stopping.add(String(serverId));
    }

    isStopping(serverId) {
        return this.stopping.has(String(serverId));
    }

    removeStopping(serverId) {
        this.stopping.delete(String(serverId));
    }

    /**
     * Get all active processes
     */
    getAll() {
        return Array.from(this.processes.entries()).map(([id, data]) => ({
            serverId: id,
            ...data
        }));
    }
}

// Singleton instance
const registry = new ProcessRegistry();
module.exports = registry;

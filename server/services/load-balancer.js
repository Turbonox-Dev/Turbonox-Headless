const { getDatabase } = require('../lib/database');

class LoadBalancerService {
  constructor() {
    this.strategies = {
      ROUND_ROBIN: 'round_robin',
      LEAST_CONNECTIONS: 'least_connections',
      RESOURCE_BASED: 'resource_based',
      WEIGHTED: 'weighted'
    };
  }

  /**
   * Analyze current load distribution across nodes
   */
  async analyzeLoadDistribution() {
    const db = getDatabase();

    try {
      // Get all nodes with their server counts and resource usage
      const nodes = await new Promise((resolve, reject) => {
        db.all(`
          SELECT
            n.*,
            COUNT(s.id) as server_count,
            COUNT(CASE WHEN s.status = 'running' THEN 1 END) as running_servers,
            n.resources,
            n.capabilities
          FROM nodes n
          LEFT JOIN servers s ON n.id = s.node_id
          WHERE n.status = 'online'
          GROUP BY n.id
          ORDER BY n.created_at
        `, [], (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });

      // Get unassigned servers
      const unassignedServers = await new Promise((resolve, reject) => {
        db.all('SELECT * FROM servers WHERE node_id IS NULL', [], (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });

      // Calculate load metrics for each node
      const nodeMetrics = nodes.map(node => {
        const resources = node.resources ? JSON.parse(node.resources) : {};
        const capabilities = node.capabilities ? JSON.parse(node.capabilities) : {};

        return {
          ...node,
          load_percentage: this.calculateLoadPercentage(node, resources),
          resource_score: this.calculateResourceScore(resources),
          connection_score: node.running_servers || 0,
          weight: this.calculateNodeWeight(node, resources, capabilities)
        };
      });

      return {
        nodes: nodeMetrics,
        unassigned_servers: unassignedServers,
        total_servers: unassignedServers.length + nodeMetrics.reduce((sum, n) => sum + n.server_count, 0),
        average_load: nodeMetrics.length > 0 ? nodeMetrics.reduce((sum, n) => sum + n.load_percentage, 0) / nodeMetrics.length : 0
      };

    } catch (error) {
      console.error('[LOAD_BALANCER] Failed to analyze load distribution:', error.message);
      throw error;
    }
  }

  /**
   * Calculate load percentage for a node based on various factors
   */
  calculateLoadPercentage(node, resources) {
    let loadScore = 0;
    let factors = 0;

    // CPU usage (40% weight)
    if (resources.cpu !== undefined) {
      loadScore += (resources.cpu / 100) * 0.4;
      factors += 0.4;
    }

    // Memory usage (30% weight)
    if (resources.memory !== undefined) {
      const memUsage = typeof resources.memory === 'string' ?
        parseFloat(resources.memory.replace('%', '')) / 100 : resources.memory / 100;
      loadScore += memUsage * 0.3;
      factors += 0.3;
    }

    // Server count ratio (20% weight)
    if (node.server_count !== undefined && node.running_servers !== undefined) {
      const serverRatio = node.running_servers / Math.max(node.server_count, 1);
      loadScore += serverRatio * 0.2;
      factors += 0.2;
    }

    // Network usage (10% weight) - placeholder for future implementation
    loadScore += 0.1; // Assume 10% baseline network load
    factors += 0.1;

    return factors > 0 ? (loadScore / factors) * 100 : 0;
  }

  /**
   * Calculate resource score (higher is better for load balancing)
   */
  calculateResourceScore(resources) {
    let score = 100; // Base score

    // Penalize high CPU usage
    if (resources.cpu > 80) score -= (resources.cpu - 80) * 2;
    else if (resources.cpu > 60) score -= (resources.cpu - 60) * 1;

    // Penalize high memory usage
    if (resources.memory) {
      const memUsage = typeof resources.memory === 'string' ?
        parseFloat(resources.memory.replace('%', '')) : resources.memory;
      if (memUsage > 80) score -= (memUsage - 80) * 2;
      else if (memUsage > 60) score -= (memUsage - 60) * 1;
    }

    // Penalize high disk usage
    if (resources.disk) {
      const diskUsage = typeof resources.disk === 'string' ?
        parseFloat(resources.disk.replace('%', '')) : resources.disk;
      if (diskUsage > 90) score -= (diskUsage - 90) * 3;
      else if (diskUsage > 75) score -= (diskUsage - 75) * 1;
    }

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Calculate node weight for weighted load balancing
   */
  calculateNodeWeight(node, resources, capabilities) {
    let weight = 1.0; // Base weight

    // Resource-based weighting
    if (resources.cpu !== undefined && resources.memory !== undefined) {
      const resourceScore = this.calculateResourceScore(resources);
      weight *= (resourceScore / 50); // Normalize around 1.0
    }

    // Response time weighting
    if (capabilities.response_time) {
      const responseTime = capabilities.response_time;
      if (responseTime < 50) weight *= 1.2; // Fast response bonus
      else if (responseTime > 200) weight *= 0.8; // Slow response penalty
    }

    // Node capabilities weighting
    if (capabilities.version) {
      // Prefer newer versions (simplified check)
      weight *= 1.1;
    }

    return Math.max(0.1, weight); // Minimum weight of 0.1
  }

  /**
   * Round-robin load balancing strategy
   */
  roundRobinBalancing(analysis, serversToAssign = null) {
    const servers = serversToAssign || analysis.unassigned_servers;
    const assignments = [];
    let nodeIndex = 0;

    for (const server of servers) {
      const targetNode = analysis.nodes[nodeIndex % analysis.nodes.length];
      assignments.push({
        server_id: server.id,
        server_name: server.name,
        node_id: targetNode.id,
        node_name: targetNode.name,
        strategy: this.strategies.ROUND_ROBIN
      });
      nodeIndex++;
    }

    return assignments;
  }

  /**
   * Least connections load balancing strategy
   */
  leastConnectionsBalancing(analysis, serversToAssign = null) {
    const servers = serversToAssign || analysis.unassigned_servers;
    const assignments = [];

    // Sort nodes by connection count (ascending)
    const sortedNodes = [...analysis.nodes].sort((a, b) => a.connection_score - b.connection_score);

    for (const server of servers) {
      const targetNode = sortedNodes[0]; // Always pick the least loaded
      assignments.push({
        server_id: server.id,
        server_name: server.name,
        node_id: targetNode.id,
        node_name: targetNode.name,
        strategy: this.strategies.LEAST_CONNECTIONS
      });

      // Update connection count for next assignment
      targetNode.connection_score++;
    }

    return assignments;
  }

  /**
   * Resource-based load balancing strategy
   */
  resourceBasedBalancing(analysis, serversToAssign = null) {
    const servers = serversToAssign || analysis.unassigned_servers;
    const assignments = [];

    for (const server of servers) {
      // Sort nodes by resource score (descending - higher score is better)
      const sortedNodes = [...analysis.nodes].sort((a, b) => b.resource_score - a.resource_score);
      const targetNode = sortedNodes[0];

      assignments.push({
        server_id: server.id,
        server_name: server.name,
        node_id: targetNode.id,
        node_name: targetNode.name,
        strategy: this.strategies.RESOURCE_BASED
      });

      // Slightly reduce resource score to simulate load increase
      targetNode.resource_score *= 0.95;
    }

    return assignments;
  }

  /**
   * Weighted load balancing strategy
   */
  weightedBalancing(analysis, serversToAssign = null) {
    const servers = serversToAssign || analysis.unassigned_servers;
    const assignments = [];

    for (const server of servers) {
      // Calculate weighted selection
      const totalWeight = analysis.nodes.reduce((sum, node) => sum + node.weight, 0);
      let random = Math.random() * totalWeight;

      let selectedNode = analysis.nodes[0];
      for (const node of analysis.nodes) {
        random -= node.weight;
        if (random <= 0) {
          selectedNode = node;
          break;
        }
      }

      assignments.push({
        server_id: server.id,
        server_name: server.name,
        node_id: selectedNode.id,
        node_name: selectedNode.name,
        strategy: this.strategies.WEIGHTED
      });

      // Reduce weight slightly to simulate load increase
      selectedNode.weight *= 0.98;
    }

    return assignments;
  }

  /**
   * Execute load balancing with specified strategy
   */
  async executeLoadBalancing(strategy = this.strategies.RESOURCE_BASED, serversToAssign = null) {
    const db = getDatabase();

    try {
      const analysis = await this.analyzeLoadDistribution();

      if (analysis.nodes.length === 0) {
        throw new Error('No online nodes available for load balancing');
      }

      let assignments = [];

      switch (strategy) {
        case this.strategies.ROUND_ROBIN:
          assignments = this.roundRobinBalancing(analysis, serversToAssign);
          break;
        case this.strategies.LEAST_CONNECTIONS:
          assignments = this.leastConnectionsBalancing(analysis, serversToAssign);
          break;
        case this.strategies.RESOURCE_BASED:
          assignments = this.resourceBasedBalancing(analysis, serversToAssign);
          break;
        case this.strategies.WEIGHTED:
          assignments = this.weightedBalancing(analysis, serversToAssign);
          break;
        default:
          throw new Error(`Unknown load balancing strategy: ${strategy}`);
      }

      // Apply assignments to database
      let applied = 0;
      for (const assignment of assignments) {
        await new Promise((resolve, reject) => {
          db.run(
            'UPDATE servers SET node_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [assignment.node_id, assignment.server_id],
            function(err) {
              if (err) reject(err);
              else {
                applied++;
                resolve();
              }
            }
          );
        });
      }

      return {
        strategy: strategy,
        assignments: assignments,
        applied: applied,
        total_servers: assignments.length,
        nodes_used: [...new Set(assignments.map(a => a.node_id))].length
      };

    } catch (error) {
      console.error('[LOAD_BALANCER] Failed to execute load balancing:', error.message);
      throw error;
    }
  }

  /**
   * Get load balancing recommendations
   */
  async getRecommendations() {
    try {
      const analysis = await this.analyzeLoadDistribution();

      const recommendations = [];

      // Check for unbalanced load
      const loadVariance = this.calculateLoadVariance(analysis.nodes);
      if (loadVariance > 20) { // More than 20% variance
        recommendations.push({
          type: 'rebalance',
          priority: 'high',
          message: `High load variance detected (${loadVariance.toFixed(1)}%). Consider rebalancing servers.`,
          action: 'resource_based'
        });
      }

      // Check for overloaded nodes
      const overloadedNodes = analysis.nodes.filter(n => n.load_percentage > 80);
      if (overloadedNodes.length > 0) {
        recommendations.push({
          type: 'overload',
          priority: 'critical',
          message: `${overloadedNodes.length} node(s) are overloaded (>80% load). Immediate rebalancing recommended.`,
          nodes: overloadedNodes.map(n => n.name),
          action: 'weighted'
        });
      }

      // Check for underutilized nodes
      const underutilizedNodes = analysis.nodes.filter(n => n.load_percentage < 20);
      if (underutilizedNodes.length > 0 && analysis.unassigned_servers.length > 0) {
        recommendations.push({
          type: 'underutilized',
          priority: 'medium',
          message: `${underutilizedNodes.length} node(s) are underutilized (<20% load) with ${analysis.unassigned_servers.length} unassigned servers.`,
          action: 'least_connections'
        });
      }

      return {
        analysis: analysis,
        recommendations: recommendations,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      console.error('[LOAD_BALANCER] Failed to get recommendations:', error.message);
      throw error;
    }
  }

  /**
   * Calculate load variance across nodes
   */
  calculateLoadVariance(nodes) {
    if (nodes.length < 2) return 0;

    const loads = nodes.map(n => n.load_percentage);
    const mean = loads.reduce((sum, load) => sum + load, 0) / loads.length;
    const variance = loads.reduce((sum, load) => sum + Math.pow(load - mean, 2), 0) / loads.length;

    return Math.sqrt(variance); // Standard deviation
  }

  /**
   * Auto-balance based on recommendations
   */
  async autoBalance() {
    try {
      const recommendations = await this.getRecommendations();

      if (recommendations.recommendations.length === 0) {
        return { action: 'none', message: 'No balancing needed' };
      }

      // Execute the highest priority recommendation
      const topRecommendation = recommendations.recommendations[0];

      const result = await this.executeLoadBalancing(topRecommendation.action);

      return {
        action: 'auto_balanced',
        strategy: topRecommendation.action,
        reason: topRecommendation.message,
        result: result
      };

    } catch (error) {
      console.error('[LOAD_BALANCER] Failed to auto-balance:', error.message);
      throw error;
    }
  }
}

module.exports = { LoadBalancerService };
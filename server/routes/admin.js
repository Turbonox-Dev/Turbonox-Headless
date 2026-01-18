/**
 * Admin Routes for Web Panel
 * User management (admin-only)
 */

const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { getDatabase } = require('../lib/database');
const { authMiddleware, adminMiddleware, adminRestrictionMiddleware } = require('./auth');

// All admin routes require authentication and admin role
router.use(authMiddleware);
router.use(adminMiddleware);

/**
 * GET /api/admin/users
 * List all panel users
 */
router.get('/users', (req, res) => {
    try {
        const db = getDatabase();
        const users = db.prepare(`
      SELECT id, email, name, role, is_active, last_login, created_at,
             server_limit, cpu_limit, memory_limit, disk_limit, backup_limit, port_limit
      FROM panel_users
      ORDER BY created_at DESC
    `).all();

        res.json({ ok: true, users });
    } catch (error) {
        console.error('[ADMIN] List users error:', error);
        res.status(500).json({ error: 'Failed to list users' });
    }
});

/**
 * POST /api/admin/users
 * Create a new user
 */
router.post('/users', async (req, res) => {
    try {
        const { email, password, name, role, server_limit, cpu_limit, memory_limit, disk_limit, backup_limit, port_limit } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }

        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }

        const validRoles = ['admin', 'user'];
        const userRole = validRoles.includes(role) ? role : 'user';

        const db = getDatabase();
        const hashedPassword = await bcrypt.hash(password, 10);

        const result = db.prepare(`
      INSERT INTO panel_users (
        email, password, name, role, is_active,
        server_limit, cpu_limit, memory_limit, disk_limit, backup_limit, port_limit
      )
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
    `).run(
            email.toLowerCase().trim(),
            hashedPassword,
            name || '',
            userRole,
            server_limit ?? 0,
            cpu_limit ?? 100,
            memory_limit ?? 1024,
            disk_limit ?? 10240,
            backup_limit ?? 3,
            port_limit ?? 5
        );

        const newUser = db.prepare('SELECT id, email, name, role, is_active, created_at FROM panel_users WHERE id = ?').get(result.lastInsertRowid);

        res.json({ ok: true, user: newUser });
    } catch (error) {
        console.error('[ADMIN] Create user error:', error);
        if (error.message?.includes('UNIQUE constraint')) {
            return res.status(400).json({ error: 'Email already exists' });
        }
        res.status(500).json({ error: 'Failed to create user' });
    }
});

/**
 * GET /api/admin/users/:id
 * Get a single user
 */
router.get('/users/:id', (req, res) => {
    try {
        const db = getDatabase();
        const user = db.prepare(`
      SELECT id, email, name, role, is_active, last_login, created_at,
             server_limit, cpu_limit, memory_limit, disk_limit, backup_limit, port_limit
      FROM panel_users WHERE id = ?
    `).get(req.params.id);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Get server count for this user
        const serverCount = db.prepare('SELECT COUNT(*) as count FROM servers WHERE panel_user_id = ?').get(req.params.id);
        user.serverCount = serverCount?.count || 0;

        res.json({ ok: true, user });
    } catch (error) {
        console.error('[ADMIN] Get user error:', error);
        res.status(500).json({ error: 'Failed to get user' });
    }
});

/**
 * PUT /api/admin/users/:id
 * Update a user
 */
router.put('/users/:id', (req, res) => {
    try {
        const { email, name, role, is_active, server_limit, cpu_limit, memory_limit, disk_limit, backup_limit, port_limit } = req.body;
        const userId = parseInt(req.params.id);

        // Prevent admin from deactivating themselves
        if (req.user.id === userId && is_active === false) {
            return res.status(400).json({ error: 'Cannot deactivate your own account' });
        }

        const db = getDatabase();
        const existing = db.prepare('SELECT * FROM panel_users WHERE id = ?').get(userId);

        if (!existing) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Build update query
        const updates = [];
        const values = [];

        if (email !== undefined) {
            updates.push('email = ?');
            values.push(email.toLowerCase().trim());
        }
        if (name !== undefined) {
            updates.push('name = ?');
            values.push(name);
        }
        if (role !== undefined && ['admin', 'user'].includes(role)) {
            // Prevent removing last admin
            if (role !== 'admin' && existing.role === 'admin') {
                const adminCount = db.prepare("SELECT COUNT(*) as count FROM panel_users WHERE role = 'admin' AND is_active = 1").get();
                if (adminCount.count <= 1) {
                    return res.status(400).json({ error: 'Cannot remove the last admin' });
                }
            }
            updates.push('role = ?');
            values.push(role);
        }
        if (is_active !== undefined) {
            updates.push('is_active = ?');
            values.push(is_active ? 1 : 0);
        }
        if (server_limit !== undefined) {
            updates.push('server_limit = ?');
            values.push(parseInt(server_limit));
        }
        if (cpu_limit !== undefined) {
            updates.push('cpu_limit = ?');
            values.push(parseInt(cpu_limit));
        }
        if (memory_limit !== undefined) {
            updates.push('memory_limit = ?');
            values.push(parseInt(memory_limit));
        }
        if (disk_limit !== undefined) {
            updates.push('disk_limit = ?');
            values.push(parseInt(disk_limit));
        }
        if (backup_limit !== undefined) {
            updates.push('backup_limit = ?');
            values.push(parseInt(backup_limit));
        }
        if (port_limit !== undefined) {
            updates.push('port_limit = ?');
            values.push(parseInt(port_limit));
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }

        updates.push('updated_at = CURRENT_TIMESTAMP');
        values.push(userId);

        db.prepare(`UPDATE panel_users SET ${updates.join(', ')} WHERE id = ?`).run(...values);

        const updated = db.prepare('SELECT id, email, name, role, is_active, created_at FROM panel_users WHERE id = ?').get(userId);
        res.json({ ok: true, user: updated });
    } catch (error) {
        console.error('[ADMIN] Update user error:', error);
        if (error.message?.includes('UNIQUE constraint')) {
            return res.status(400).json({ error: 'Email already exists' });
        }
        res.status(500).json({ error: 'Failed to update user' });
    }
});

/**
 * PUT /api/admin/users/:id/password
 * Reset a user's password
 */
router.put('/users/:id/password', async (req, res) => {
    try {
        const { password } = req.body;

        if (!password || password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }

        const db = getDatabase();
        const user = db.prepare('SELECT id FROM panel_users WHERE id = ?').get(req.params.id);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        db.prepare('UPDATE panel_users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hashedPassword, req.params.id);

        res.json({ ok: true, message: 'Password reset successfully' });
    } catch (error) {
        console.error('[ADMIN] Reset password error:', error);
        res.status(500).json({ error: 'Failed to reset password' });
    }
});

/**
 * DELETE /api/admin/users/:id
 * Delete a user
 */
router.delete('/users/:id', (req, res) => {
    try {
        const userId = parseInt(req.params.id);

        // Prevent self-deletion
        if (req.user.id === userId) {
            return res.status(400).json({ error: 'Cannot delete your own account' });
        }

        const db = getDatabase();
        const user = db.prepare('SELECT * FROM panel_users WHERE id = ?').get(userId);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Prevent deleting last admin
        if (user.role === 'admin') {
            const adminCount = db.prepare("SELECT COUNT(*) as count FROM panel_users WHERE role = 'admin' AND is_active = 1").get();
            if (adminCount.count <= 1) {
                return res.status(400).json({ error: 'Cannot delete the last admin' });
            }
        }

        // Unassign servers from this user (or optionally delete them)
        db.prepare('UPDATE servers SET panel_user_id = NULL WHERE panel_user_id = ?').run(userId);

        // Delete user
        db.prepare('DELETE FROM panel_users WHERE id = ?').run(userId);

        res.json({ ok: true, message: 'User deleted successfully' });
    } catch (error) {
        console.error('[ADMIN] Delete user error:', error);
        res.status(500).json({ error: 'Failed to delete user' });
    }
});

/**
 * GET /api/admin/stats
 * Get admin dashboard stats
 */
router.get('/stats', (req, res) => {
    try {
        const db = getDatabase();

        const userCount = db.prepare('SELECT COUNT(*) as count FROM panel_users').get();
        const activeUsers = db.prepare('SELECT COUNT(*) as count FROM panel_users WHERE is_active = 1').get();
        const serverCount = db.prepare('SELECT COUNT(*) as count FROM servers').get();
        const nodeCount = db.prepare('SELECT COUNT(*) as count FROM nodes').get();

        res.json({
            ok: true,
            stats: {
                totalUsers: userCount.count,
                activeUsers: activeUsers.count,
                totalServers: serverCount.count,
                totalNodes: nodeCount.count
            }
        });
    } catch (error) {
        console.error('[ADMIN] Stats error:', error);
        res.status(500).json({ error: 'Failed to get stats' });
    }
});

module.exports = router;

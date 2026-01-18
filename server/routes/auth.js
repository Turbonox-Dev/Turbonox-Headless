/**
 * Authentication Routes for Web Panel
 * Multi-user email/password authentication system
 */

const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getDatabase } = require('../lib/database');

// JWT secret - use env var or generate a random one per instance
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const JWT_EXPIRES_IN = '7d';

/**
 * JWT Middleware - Verifies token and attaches user to request
 */
function authMiddleware(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const token = authHeader.substring(7);
        const decoded = jwt.verify(token, JWT_SECRET);

        // Attach user to request
        req.user = {
            id: decoded.id,
            email: decoded.email,
            name: decoded.name,
            role: decoded.role
        };

        next();
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token expired' });
        }
        return res.status(401).json({ error: 'Invalid token' });
    }
}

/**
 * Admin-only middleware
 */
function adminMiddleware(req, res, next) {
    if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}

/**
 * Admin restriction middleware - restricts admin users to only nodes and AI routes
 */
function adminRestrictionMiddleware(req, res, next) {
    if (req.user?.role === 'admin') {
        const allowedPaths = ['/api/nodes', '/api/ai'];
        const requestPath = req.path.startsWith('/api/') ? `/api/${req.path.split('/')[2]}` : req.path;

        if (!allowedPaths.some(allowed => requestPath.startsWith(allowed))) {
            return res.status(403).json({ error: 'Admin users only have access to nodes and AI center' });
        }
    }
    next();
}

/**
 * GET /api/auth/status
 * Check if setup is complete (any users exist)
 */
router.get('/status', (req, res) => {
    try {
        const db = getDatabase();
        const userCount = db.prepare('SELECT COUNT(*) as count FROM panel_users').get();

        res.json({
            configured: userCount.count > 0,
            needsSetup: userCount.count === 0
        });
    } catch (error) {
        console.error('[AUTH] Status error:', error);
        res.status(500).json({ error: 'Failed to check auth status' });
    }
});

/**
 * POST /api/auth/setup
 * Create the first admin account (only works when no users exist)
 */
router.post('/setup', async (req, res) => {
    try {
        const { email, password, name } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }

        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }

        const db = getDatabase();

        // Check if any users exist
        const userCount = db.prepare('SELECT COUNT(*) as count FROM panel_users').get();
        if (userCount.count > 0) {
            return res.status(400).json({ error: 'Setup already complete. Please login.' });
        }

        // Hash password and create admin user
        const hashedPassword = await bcrypt.hash(password, 10);

        const result = db.prepare(`
      INSERT INTO panel_users (email, password, name, role, is_active)
      VALUES (?, ?, ?, 'admin', 1)
    `).run(email.toLowerCase().trim(), hashedPassword, name || 'Administrator');

        const userId = result.lastInsertRowid;

        // Generate token
        const token = jwt.sign(
            { id: userId, email: email.toLowerCase().trim(), name: name || 'Administrator', role: 'admin' },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRES_IN }
        );

        // Update last login
        db.prepare('UPDATE panel_users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(userId);

        res.json({
            ok: true,
            token,
            user: {
                id: userId,
                email: email.toLowerCase().trim(),
                name: name || 'Administrator',
                role: 'admin'
            }
        });
    } catch (error) {
        console.error('[AUTH] Setup error:', error);
        if (error.message?.includes('UNIQUE constraint')) {
            return res.status(400).json({ error: 'Email already exists' });
        }
        res.status(500).json({ error: 'Setup failed' });
    }
});

/**
 * POST /api/auth/login
 * Authenticate with email/password
 */
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }

        const db = getDatabase();

        // Find user by email
        const user = db.prepare('SELECT * FROM panel_users WHERE email = ? AND is_active = 1').get(email.toLowerCase().trim());

        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Verify password
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Generate token
        const token = jwt.sign(
            { id: user.id, email: user.email, name: user.name, role: user.role },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRES_IN }
        );

        // Update last login
        db.prepare('UPDATE panel_users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);

        res.json({
            ok: true,
            token,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                role: user.role,
                server_limit: user.server_limit,
                cpu_limit: user.cpu_limit,
                memory_limit: user.memory_limit,
                disk_limit: user.disk_limit,
                backup_limit: user.backup_limit,
                port_limit: user.port_limit
            }
        });
    } catch (error) {
        console.error('[AUTH] Login error:', error);
        res.status(500).json({ error: 'Authentication failed' });
    }
});

/**
 * GET /api/auth/me
 * Get current user info (requires auth)
 */
router.get('/me', authMiddleware, (req, res) => {
    try {
        const db = getDatabase();
        const user = db.prepare('SELECT id, email, name, role, created_at, last_login, server_limit, cpu_limit, memory_limit, disk_limit, backup_limit, port_limit FROM panel_users WHERE id = ?').get(req.user.id);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({ ok: true, user });
    } catch (error) {
        console.error('[AUTH] Me error:', error);
        res.status(500).json({ error: 'Failed to get user info' });
    }
});

/**
 * PUT /api/auth/me
 * Update current user profile
 */
router.put('/me', authMiddleware, (req, res) => {
    try {
        const { name, email } = req.body;
        const db = getDatabase();

        const updates = [];
        const params = [];

        if (name) {
            updates.push('name = ?');
            params.push(name.trim());
        }

        if (email) {
            const newEmail = email.toLowerCase().trim();
            // Check uniqueness if email is changing
            if (newEmail !== req.user.email) {
                const existing = db.prepare('SELECT id FROM panel_users WHERE email = ?').get(newEmail);
                if (existing) {
                    return res.status(400).json({ error: 'Email already taken' });
                }
                updates.push('email = ?');
                params.push(newEmail);
            }
        }

        if (updates.length === 0) {
            return res.json({ ok: true, user: req.user });
        }

        updates.push('updated_at = CURRENT_TIMESTAMP');
        const query = `UPDATE panel_users SET ${updates.join(', ')} WHERE id = ?`;
        params.push(req.user.id);

        db.prepare(query).run(...params);

        // Return updated user and new token
        const user = db.prepare('SELECT id, email, name, role FROM panel_users WHERE id = ?').get(req.user.id);

        const token = jwt.sign(
            { id: user.id, email: user.email, name: user.name, role: user.role },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRES_IN }
        );

        res.json({ ok: true, user, token });

    } catch (error) {
        console.error('[AUTH] Update me error:', error);
        res.status(500).json({ error: 'Failed to update profile' });
    }
});

/**
 * GET /api/auth/verify
 * Verify JWT token validity
 */
router.get('/verify', (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ ok: false, error: 'No token provided' });
        }

        const token = authHeader.substring(7);
        const decoded = jwt.verify(token, JWT_SECRET);

        const db = getDatabase();
        const user = db.prepare('SELECT id, email, name, role, server_limit, cpu_limit, memory_limit, disk_limit, backup_limit, port_limit FROM panel_users WHERE id = ?').get(decoded.id);

        if (!user) {
            return res.status(401).json({ ok: false, error: 'User meta not found' });
        }

        res.json({ ok: true, user });
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ ok: false, error: 'Token expired' });
        }
        return res.status(401).json({ ok: false, error: 'Invalid token' });
    }
});

/**
 * POST /api/auth/change-password
 * Change current user's password
 */
router.post('/change-password', authMiddleware, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Current and new password required' });
        }

        if (newPassword.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }

        const db = getDatabase();
        const user = db.prepare('SELECT password FROM panel_users WHERE id = ?').get(req.user.id);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const validPassword = await bcrypt.compare(currentPassword, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Current password is incorrect' });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        db.prepare('UPDATE panel_users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hashedPassword, req.user.id);

        res.json({ ok: true, message: 'Password changed successfully' });
    } catch (error) {
        console.error('[AUTH] Change password error:', error);
        res.status(500).json({ error: 'Failed to change password' });
    }
});

/**
 * POST /api/auth/logout
 * Client-side logout (just returns success)
 */
router.post('/logout', (req, res) => {
    res.json({ ok: true });
});

/**
 * POST /api/auth/register
 * Public user registration
 */
router.post('/register', async (req, res) => {
    try {
        const { email, password, name } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }

        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }

        const db = getDatabase();

        // Check if email exists
        const existing = db.prepare('SELECT id FROM panel_users WHERE email = ?').get(email.toLowerCase().trim());
        if (existing) {
            return res.status(400).json({ error: 'Email already registered' });
        }

        // Check user count to determine role
        const userCount = db.prepare('SELECT COUNT(*) as count FROM panel_users').get();
        const role = userCount.count === 0 ? 'admin' : 'user';

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Create user
        const result = db.prepare(`
            INSERT INTO panel_users (email, password, name, role, is_active)
            VALUES (?, ?, ?, ?, 1)
        `).run(email.toLowerCase().trim(), hashedPassword, name || 'User', role);

        const userId = result.lastInsertRowid;

        // Generate token
        const token = jwt.sign(
            { id: userId, email: email.toLowerCase().trim(), name: name || 'User', role },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRES_IN }
        );

        // Update last login
        db.prepare('UPDATE panel_users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(userId);

        res.json({
            ok: true,
            token,
            user: {
                id: userId,
                email: email.toLowerCase().trim(),
                name: name || 'User',
                role
            }
        });
    } catch (error) {
        console.error('[AUTH] Register error:', error);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// Export middleware for use in other routes
module.exports = router;
module.exports.authMiddleware = authMiddleware;
module.exports.adminMiddleware = adminMiddleware;
module.exports.adminRestrictionMiddleware = adminRestrictionMiddleware;
module.exports.JWT_SECRET = JWT_SECRET;

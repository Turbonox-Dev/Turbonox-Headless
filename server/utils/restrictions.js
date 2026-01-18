const { getDatabase } = require('../lib/database');

function getCachedCloudUser() {
    const db = getDatabase();
    try {
        const row = db.prepare("SELECT value FROM settings WHERE key = 'controlPlaneUser'").get();
        if (!row?.value) return null;
        return JSON.parse(row.value);
    } catch (e) {
        console.error('[RESTRICTIONS] Failed to get cached cloud user:', e.message);
        return null;
    }
}

function checkRestriction(feature = null) {
    const user = getCachedCloudUser();
    if (!user) return { restricted: false }; // No cloud user linked, assume ok for now (local mode)

    if (user.is_banned) {
        return { restricted: true, reason: 'ACCOUNT_BANNED', message: 'Your account has been suspended.' };
    }

    // If no specific feature requested, just check general restriction
    if (!feature) {
        if (user.is_restricted) {
            return { restricted: true, reason: 'ACCOUNT_RESTRICTED', message: 'Your account is restricted.' };
        }
        return { restricted: false };
    }

    let restrictedFeatures = [];
    try {
        restrictedFeatures = typeof user.restricted_features === 'string'
            ? JSON.parse(user.restricted_features)
            : (Array.isArray(user.restricted_features) ? user.restricted_features : []);
    } catch {
        restrictedFeatures = [];
    }

    if (user.is_restricted || restrictedFeatures.includes(feature)) {
        return { restricted: true, reason: 'FEATURE_RESTRICTED', message: `Access to ${feature} is restricted.` };
    }

    return { restricted: false };
}

function restrictionMiddleware(feature) {
    return (req, res, next) => {
        const check = checkRestriction(feature);
        if (check.restricted) {
            return res.status(403).json({
                error: check.message,
                reason: check.reason,
                code: 'ACCESS_RESTRICTED'
            });
        }
        next();
    };
}

module.exports = {
    getCachedCloudUser,
    checkRestriction,
    restrictionMiddleware
};

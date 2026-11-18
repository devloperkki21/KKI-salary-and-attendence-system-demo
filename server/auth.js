const crypto = require('crypto');
const { generateSecret, generateURI, verifySync } = require('otplib');
const qrcode = require('qrcode');
const { execute } = require('./db');

const ISSUER_NAME = 'KKI Attendance & Payroll';
const ACCOUNT_LABEL = 'Admin';
const SESSION_COOKIE_NAME = 'kki_session';

// Strict allowlist of unauthenticated API endpoints (all other /api/* routes require valid session)
const PUBLIC_API_PATHS = new Set([
  '/api/health',
  '/api/auth/status',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/setup/init',
  '/api/auth/setup/confirm'
]);

// Security Policy: Forced absolute logout after 30 minutes, idle logout after 5 minutes
const FORCED_LOGOUT_MINUTES = 30;
const INACTIVITY_TIMEOUT_MINUTES = 5;
const SESSION_MAX_AGE_MS = FORCED_LOGOUT_MINUTES * 60 * 1000;
const INACTIVITY_TIMEOUT_MS = INACTIVITY_TIMEOUT_MINUTES * 60 * 1000;
const SESSION_EXPIRY_DAYS = FORCED_LOGOUT_MINUTES / (24 * 60);

// In-memory cache for validated sessions and auth config (eliminates high-latency roundtrips)
const sessionCache = new Map(); // token -> { role, expiresTime, createdAtTime, lastActivityTime, cachedAt }
const SESSION_CACHE_TTL_MS = 15000; // 15 seconds memory cache
let cachedAuthConfig = null;
let authConfigExpiresAt = 0;

function invalidateAuthConfigCache() {
  cachedAuthConfig = null;
  authConfigExpiresAt = 0;
}

/**
 * Constant-time exact password verification (ZERO universal/backdoor passwords)
 */
function verifyPassword(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
  const a = candidate.trim();
  const b = expected.trim();
  if (!a || !b) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Fetch authentication configuration strictly from Supabase settings + process.env
 * (ZERO hardcoded password or TOTP secret fallbacks)
 */
async function getAuthConfig() {
  const now = Date.now();
  if (cachedAuthConfig && now < authConfigExpiresAt) {
    return { ...cachedAuthConfig };
  }

  const res = await execute(
    `SELECT key, value FROM settings WHERE key IN ('master_password', 'payroll_password', 'totp_enabled', 'totp_secret', 'emergency_backup_codes')`
  );

  const cfg = {
    master_password: (process.env.MASTER_PASSWORD || '').trim() || null,
    payroll_password: (process.env.PAYROLL_PASSWORD || '').trim() || null,
    totp_enabled: false,
    totp_secret: (process.env.TOTP_SECRET || '').trim() || '',
    emergency_backup_codes: []
  };

  res.rows.forEach(r => {
    if (r.key === 'master_password' && r.value && r.value.trim()) {
      cfg.master_password = r.value.trim();
    } else if (r.key === 'payroll_password' && r.value && r.value.trim()) {
      cfg.payroll_password = r.value.trim();
    } else if (r.key === 'totp_enabled') {
      cfg.totp_enabled = r.value === 'true';
    } else if (r.key === 'totp_secret' && r.value && r.value.trim()) {
      cfg.totp_secret = r.value.trim();
    } else if (r.key === 'emergency_backup_codes') {
      try {
        const parsed = JSON.parse(r.value || '[]');
        if (Array.isArray(parsed)) {
          cfg.emergency_backup_codes = parsed;
        }
      } catch (e) {
        cfg.emergency_backup_codes = [];
      }
    }
  });

  // Fallback master_password to payroll_password only if saved in DB
  if (!cfg.master_password && cfg.payroll_password) {
    cfg.master_password = cfg.payroll_password;
  }

  // Explicit Environment Variable overrides take precedence over DB values
  if (process.env.TOTP_SECRET && process.env.TOTP_SECRET.trim()) {
    cfg.totp_secret = process.env.TOTP_SECRET.trim();
    cfg.totp_enabled = true;
  }
  if (process.env.MASTER_PASSWORD && process.env.MASTER_PASSWORD.trim()) {
    cfg.master_password = process.env.MASTER_PASSWORD.trim();
  }
  if (process.env.PAYROLL_PASSWORD && process.env.PAYROLL_PASSWORD.trim()) {
    cfg.payroll_password = process.env.PAYROLL_PASSWORD.trim();
  }

  if (cfg.totp_secret) {
    cfg.totp_enabled = true;
  }

  cachedAuthConfig = { ...cfg };
  authConfigExpiresAt = now + 60000;
  return cfg;
}

/**
 * Generate TOTP secret & QR Code Data URL (generates cryptographically random secret if none configured)
 */
async function generateTotpSetup(customSecret = null) {
  const cfg = await getAuthConfig();
  const secret = customSecret || cfg.totp_secret || generateSecret();
  const uri = generateURI({
    issuer: ISSUER_NAME,
    label: ACCOUNT_LABEL,
    secret
  });

  const qrCodeUrl = await qrcode.toDataURL(uri, {
    width: 256,
    margin: 2,
    color: {
      dark: '#0f172a',
      light: '#ffffff'
    }
  });

  return { secret, uri, qrCodeUrl };
}

/**
 * Verify a 6-digit TOTP token against a secret
 * window: 2 allows +/- 60s clock drift
 */
function verifyTotpToken(token, secret) {
  if (!token || !secret) return false;
  try {
    const cleanToken = String(token).replace(/\s+/g, '').trim();
    const result = verifySync({ token: cleanToken, secret, window: 2 });
    return !!(result && result.valid);
  } catch (err) {
    console.error('TOTP Verify Error:', err.message);
    return false;
  }
}

/**
 * Generate 8 cryptographically random human-readable emergency backup codes
 */
function generateBackupCodes(count = 8) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const part1 = crypto.randomInt(1000, 10000);
    const part2 = crypto.randomInt(1000, 10000);
    codes.push(`${part1}-${part2}`);
  }
  return codes;
}

/**
 * Hash a backup code for secure storage
 */
function hashBackupCode(code) {
  const normalized = String(code).replace(/[^0-9a-zA-Z]/g, '').toLowerCase();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Verify and consume a one-time backup code
 */
async function verifyAndConsumeBackupCode(rawCode, hashedCodesList) {
  if (!rawCode || !Array.isArray(hashedCodesList)) return { valid: false, remainingCodes: hashedCodesList };
  const incomingHash = hashBackupCode(rawCode);
  const index = hashedCodesList.indexOf(incomingHash);

  if (index !== -1) {
    const remaining = [...hashedCodesList];
    remaining.splice(index, 1);
    await execute(
      `INSERT INTO settings (key, value, description) VALUES ('emergency_backup_codes', ?, 'One-time emergency backup recovery codes')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [JSON.stringify(remaining)]
    );
    invalidateAuthConfigCache();
    return { valid: true, remainingCodes: remaining };
  }
  return { valid: false, remainingCodes: hashedCodesList };
}

/**
 * Create a new authenticated user session directly in Supabase PostgreSQL
 */
async function createSession(role = 'admin') {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + SESSION_MAX_AGE_MS).toISOString();
  const lastActivityAt = createdAt;
  const normalizedRole = String(role || 'admin').toLowerCase();

  try {
    await execute(
      `INSERT INTO user_sessions (token, role, created_at, expires_at, last_activity_at) VALUES (?, ?, ?, ?, ?)`,
      [token, normalizedRole, createdAt, expiresAt, lastActivityAt]
    );
  } catch (err) {
    // Graceful fallback if target DB hasn't added the 'role' column yet
    if (err.message && err.message.includes('role')) {
      await execute(
        `INSERT INTO user_sessions (token, created_at, expires_at, last_activity_at) VALUES (?, ?, ?, ?)`,
        [token, createdAt, expiresAt, lastActivityAt]
      );
    } else {
      throw err;
    }
  }

  sessionCache.set(token, {
    role: normalizedRole,
    expiresTime: now.getTime() + SESSION_MAX_AGE_MS,
    createdAtTime: now.getTime(),
    lastActivityTime: now.getTime(),
    cachedAt: Date.now()
  });

  return { token, role: normalizedRole, createdAt, expiresAt, lastActivityAt };
}

/**
 * Validate session token checking both 30-min forced ceiling and 5-min inactivity timeout.
 */
async function validateSession(token) {
  if (!token) return { valid: false, reason: 'invalid' };
  try {
    const now = Date.now();
    const cached = sessionCache.get(token);

    if (cached && (now - cached.cachedAt < SESSION_CACHE_TTL_MS)) {
      if (now >= cached.expiresTime) {
        sessionCache.delete(token);
        destroySession(token).catch(() => {});
        return { valid: false, reason: 'session_timeout' };
      }
      const idleElapsedMs = now - cached.lastActivityTime;
      if (idleElapsedMs >= INACTIVITY_TIMEOUT_MS) {
        sessionCache.delete(token);
        destroySession(token).catch(() => {});
        return { valid: false, reason: 'inactivity' };
      }
      return {
        valid: true,
        role: cached.role || 'admin',
        remainingSessionMs: Math.max(0, cached.expiresTime - now),
        remainingIdleMs: Math.max(0, INACTIVITY_TIMEOUT_MS - idleElapsedMs)
      };
    }

    let res;
    try {
      res = await execute(
        `SELECT token, role, created_at, expires_at, last_activity_at FROM user_sessions WHERE token = ?`,
        [token]
      );
    } catch (colErr) {
      if (colErr.message && colErr.message.includes('role')) {
        res = await execute(
          `SELECT token, created_at, expires_at, last_activity_at FROM user_sessions WHERE token = ?`,
          [token]
        );
      } else {
        throw colErr;
      }
    }

    if (!res.rows || res.rows.length === 0) {
      sessionCache.delete(token);
      return { valid: false, reason: 'invalid' };
    }

    const session = res.rows[0];
    const role = (session.role || 'admin').toLowerCase();

    const parseDbDate = (val) => {
      if (!val) return null;
      if (typeof val === 'number') return val;
      const str = String(val).trim();
      if (str.includes('Z') || /[+-]\d{2}:\d{2}$/.test(str)) {
        return new Date(str).getTime();
      }
      return new Date(str.replace(' ', 'T') + 'Z').getTime();
    };

    const expiresTime = parseDbDate(session.expires_at) || (now + SESSION_MAX_AGE_MS);
    const createdAtTime = parseDbDate(session.created_at) || now;
    const lastActivityTime = parseDbDate(session.last_activity_at) || createdAtTime;

    if (now >= expiresTime) {
      sessionCache.delete(token);
      await destroySession(token);
      return { valid: false, reason: 'session_timeout' };
    }

    const idleElapsedMs = now - lastActivityTime;
    if (idleElapsedMs >= INACTIVITY_TIMEOUT_MS) {
      sessionCache.delete(token);
      await destroySession(token);
      return { valid: false, reason: 'inactivity' };
    }

    if (idleElapsedMs > 15000) {
      const currentIso = new Date().toISOString();
      execute(
        `UPDATE user_sessions SET last_activity_at = ? WHERE token = ?`,
        [currentIso, token]
      ).catch(err => console.error('Failed to update session activity:', err.message));
    }

    sessionCache.set(token, {
      role,
      expiresTime,
      createdAtTime,
      lastActivityTime: Math.max(lastActivityTime, now),
      cachedAt: now
    });

    return {
      valid: true,
      role,
      remainingSessionMs: Math.max(0, expiresTime - now),
      remainingIdleMs: Math.max(0, INACTIVITY_TIMEOUT_MS - idleElapsedMs)
    };
  } catch (err) {
    console.error('Validate session error:', err.message);
    return { valid: false, reason: 'invalid' };
  }
}

/**
 * Destroy a session (Logout)
 */
async function destroySession(token) {
  if (!token) return;
  sessionCache.delete(token);
  try {
    await execute(`DELETE FROM user_sessions WHERE token = ?`, [token]);
  } catch (err) {
    console.error('Destroy session error:', err.message);
  }
}

/**
 * Extract token from request (cookies or Authorization header)
 */
function extractTokenFromReq(req) {
  if (req.cookies && req.cookies[SESSION_COOKIE_NAME]) {
    return req.cookies[SESSION_COOKIE_NAME];
  }
  if (req.headers && req.headers.cookie) {
    const match = req.headers.cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]+)`));
    if (match) return decodeURIComponent(match[1]);
  }
  const authHeader = req.headers && (req.headers.authorization || req.headers['x-auth-token']);
  if (authHeader) {
    if (authHeader.startsWith('Bearer ')) return authHeader.substring(7).trim();
    return authHeader.trim();
  }
  return null;
}

/**
 * Role-Based Authorization Middleware (e.g., authorize(['admin']))
 * Ensures non-admin roles cannot access admin-only Excel/CSV exports or destructive operations.
 */
function authorize(allowedRoles = ['admin']) {
  const allowed = new Set(allowedRoles.map(r => String(r).toLowerCase()));
  return (req, res, next) => {
    if (!req.user || !req.user.role) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required.',
        code: 'UNAUTHORIZED'
      });
    }
    if (!allowed.has(String(req.user.role).toLowerCase())) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden: Admin access is required for this operation.',
        code: 'FORBIDDEN_ADMIN_ONLY'
      });
    }
    return next();
  };
}

module.exports = {
  SESSION_COOKIE_NAME,
  PUBLIC_API_PATHS,
  FORCED_LOGOUT_MINUTES,
  INACTIVITY_TIMEOUT_MINUTES,
  SESSION_MAX_AGE_MS,
  INACTIVITY_TIMEOUT_MS,
  SESSION_EXPIRY_DAYS,
  verifyPassword,
  getAuthConfig,
  generateTotpSetup,
  verifyTotpToken,
  generateBackupCodes,
  hashBackupCode,
  verifyAndConsumeBackupCode,
  createSession,
  validateSession,
  destroySession,
  extractTokenFromReq,
  authorize,
  invalidateAuthConfigCache
};

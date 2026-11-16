// @ts-nocheck -- JWT request augmentation is narrowed by Auth route contracts.
import { timingSafeEqual } from 'node:crypto';

import jwt from 'jsonwebtoken';

import { apiKeysDb, userDb, appConfigDb } from '../database/index.js';

const API_KEY_PREFIX = 'ck_';

// Use env var if set, otherwise auto-generate a unique secret per installation
const JWT_SECRET = process.env.JWT_SECRET || appConfigDb.getOrCreateJwtSecret();

// Optional API key middleware
const validateApiKey = (req, res, next) => {
  // Skip API key validation if not configured
  if (!process.env.API_KEY) {
    return next();
  }
  
  const apiKey = req.headers['x-api-key'];
  const expectedKey = Buffer.from(process.env.API_KEY);
  const providedKey = Buffer.from(typeof apiKey === 'string' ? apiKey : '');
  if (providedKey.length !== expectedKey.length || !timingSafeEqual(providedKey, expectedKey)) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
};

const describeTokenLifetime = (token) => {
  const claims = jwt.decode(token);
  if (!claims || typeof claims !== 'object' || typeof claims.exp !== 'number') {
    return 'token unparsable';
  }
  const isoSeconds = (unixSeconds) => new Date(unixSeconds * 1000).toISOString().slice(0, 19);
  return `token iat ${typeof claims.iat === 'number' ? isoSeconds(claims.iat) : '?'} exp ${isoSeconds(claims.exp)}`;
};

// Every 401 here makes the web client drop its session and show the login form,
// so each one is logged: the reason, the request and the token's lifetime (never the token).
const logRejectedRequest = (req, reason, token) => {
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  const tokenDescription = token ? describeTokenLifetime(token) : 'no token';
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 80);
  console.warn(`[auth] 401 ${reason}: ${req.method} ${path} from ${req.ip} (${tokenDescription}) ua="${userAgent}"`);
};

// JWT authentication middleware
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  // Also check query param for SSE endpoints (EventSource can't set headers)
  if (!token && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    logRejectedRequest(req, 'no token', null);
    res.setHeader('X-Auth-Error', 'invalid-token');
    return res.status(401).json({
      error: 'Access denied. No token provided.',
      code: 'AUTH_TOKEN_INVALID',
    });
  }

  // Scripts and the `ah` CLI authenticate with a key from Settings -> API keys instead of a login JWT.
  if (token.startsWith(API_KEY_PREFIX)) {
    const keyOwner = apiKeysDb.validateApiKey(token);
    const user = keyOwner ? userDb.getUserById(keyOwner.id) : null;
    if (!user) {
      logRejectedRequest(req, 'invalid API key', null);
      res.setHeader('X-Auth-Error', 'invalid-token');
      return res.status(401).json({ error: 'Invalid API key', code: 'AUTH_TOKEN_INVALID' });
    }
    req.user = user;
    return next();
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });

    // Verify user still exists and is active
    const user = userDb.getUserById(decoded.userId);
    if (!user) {
      logRejectedRequest(req, 'user not found', token);
      res.setHeader('X-Auth-Error', 'invalid-token');
      return res.status(401).json({
        error: 'Invalid token. User not found.',
        code: 'AUTH_TOKEN_INVALID',
      });
    }

    // Auto-refresh: if token is past halfway through its lifetime, issue a new one
    if (decoded.exp && decoded.iat) {
      const now = Math.floor(Date.now() / 1000);
      const halfLife = (decoded.exp - decoded.iat) / 2;
      if (now > decoded.iat + halfLife) {
        const newToken = generateToken(user);
        res.setHeader('X-Refreshed-Token', newToken);
      }
    }

    req.user = user;
    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      logRejectedRequest(req, 'token expired', token);
      res.setHeader('X-Auth-Error', 'session-expired');
      return res.status(401).json({
        error: 'Session expired. Please log in again.',
        code: 'AUTH_TOKEN_EXPIRED',
      });
    }

    logRejectedRequest(req, `token verification failed (${error instanceof Error ? error.message : String(error)})`, token);
    res.setHeader('X-Auth-Error', 'invalid-token');
    return res.status(401).json({
      error: 'Invalid token',
      code: 'AUTH_TOKEN_INVALID',
    });
  }
};

// Generate JWT token
const generateToken = (user) => {
  return jwt.sign(
    {
      userId: user.id,
      username: user.username
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
};

// WebSocket authentication function
const authenticateWebSocket = (token) => {
  if (!token) {
    return null;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    // Verify user actually exists in database (matches REST authenticateToken behavior)
    const user = userDb.getUserById(decoded.userId);
    if (!user) {
      return null;
    }
    return { userId: user.id, username: user.username };
  } catch (error) {
    console.warn(
      'WebSocket token verification failed:',
      error instanceof Error ? error.message : String(error),
      `(${describeTokenLifetime(token)})`,
    );
    return null;
  }
};

export {
  validateApiKey,
  authenticateToken,
  generateToken,
  authenticateWebSocket,
  JWT_SECRET
};

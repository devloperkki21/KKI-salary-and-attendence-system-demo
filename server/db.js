require('dotenv').config();
const https = require('https');
const { createClient } = require('@supabase/supabase-js');
const { Pool } = require('pg');

// Persistent HTTP Keep-Alive Agent for low-latency Supabase HTTPS connections
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 60,
  maxFreeSockets: 30,
  keepAliveMsecs: 60000,
  timeout: 30000
});

// ============================================================================
// Strictly Environment-Driven Configuration (ZERO hardcoded secrets/fallbacks)
// ============================================================================
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_SERVICE_ROLE_KEY = (
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_KEY ||
  ''
).trim();
const SUPABASE_ACCESS_TOKEN = (process.env.SUPABASE_ACCESS_TOKEN || '').trim();
const SUPABASE_PROJECT_REF = (process.env.SUPABASE_PROJECT_REF || '').trim();
const DATABASE_URL = (process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || '').trim();
const DB_SCHEMA = (process.env.DB_SCHEMA || 'public').trim();

if (!/^[a-zA-Z0-9_]+$/.test(DB_SCHEMA)) {
  throw new Error(`Invalid DB_SCHEMA "${DB_SCHEMA}": only alphanumeric and underscore characters are allowed.`);
}

// Initialize official @supabase/supabase-js client when SUPABASE_URL + key are present.
// Always target PostgREST 'public' schema for RPC transport (PostgREST only exposes 'public' by default);
// schema isolation ('public' vs 'demo') is enforced safely inside PostgreSQL via target_schema / search_path.
let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

// Track whether the atomic RPC functions from supabase_attendance_schema.sql are installed
let supabaseRpcAvailable = Boolean(supabase);

// Optional direct PostgreSQL connection pool when DATABASE_URL is configured
let pgPool = null;
if (DATABASE_URL) {
  try {
    pgPool = new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000
    });
    console.log('🔌 Connected to Supabase PostgreSQL via direct connection pool (DATABASE_URL)');
  } catch (err) {
    console.warn('⚠️ Could not initialize pg.Pool from DATABASE_URL:', err.message);
    pgPool = null;
  }
}

/**
 * Escape values safely for PostgreSQL literal interpolation
 */
function escapeSqlVal(val) {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number') return Number.isNaN(val) ? '0' : String(val);
  if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
  const str = String(val).replace(/'/g, "''");
  return `'${str}'`;
}

/**
 * Safely replace '?' placeholders with escaped literals (outside quotes)
 */
function interpolateSql(sql, args = []) {
  if (!args || args.length === 0) return sql;

  let argIdx = 0;
  let inQuote = false;
  let quoteChar = '';
  let result = '';

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];

    if ((ch === "'" || ch === '"') && (i === 0 || sql[i - 1] !== '\\')) {
      if (!inQuote) {
        inQuote = true;
        quoteChar = ch;
      } else if (quoteChar === ch) {
        if (i + 1 < sql.length && sql[i + 1] === ch) {
          result += ch + sql[i + 1];
          i++;
          continue;
        }
        inQuote = false;
      }
      result += ch;
      continue;
    }

    if (!inQuote && ch === '?') {
      if (argIdx >= args.length) {
        throw new Error(`Insufficient arguments for query: expected more than ${args.length}`);
      }
      result += escapeSqlVal(args[argIdx++]);
      continue;
    }

    result += ch;
  }

  return result;
}

/**
 * Normalize legacy SQLite-isms to standard PostgreSQL syntax
 */
function normalizeSql(sql) {
  let normalized = sql.trim();

  if (/^\s*INSERT\s+OR\s+IGNORE\s+INTO\s+/i.test(normalized)) {
    if (!/ON\s+CONFLICT/i.test(normalized)) {
      normalized = normalized.replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO\s+/i, 'INSERT INTO ') + ' ON CONFLICT DO NOTHING';
    } else {
      normalized = normalized.replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO\s+/i, 'INSERT INTO ');
    }
  }

  return normalized;
}

/**
 * Execute SQL via Supabase Management SQL API (only when SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF are set)
 */
function queryViaManagementApi(sql, timeoutMs = 25000) {
  if (!SUPABASE_ACCESS_TOKEN || !SUPABASE_PROJECT_REF) {
    return Promise.reject(
      new Error(
        'Supabase database is not configured. Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (with supabase_attendance_schema.sql RPCs), or DATABASE_URL, or SUPABASE_PROJECT_REF + SUPABASE_ACCESS_TOKEN in environment variables.'
      )
    );
  }

  const schemaPrefix = DB_SCHEMA && DB_SCHEMA !== 'public' ? `SET search_path TO "${DB_SCHEMA}", public;\n` : '';
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ query: schemaPrefix + sql });
    const options = {
      hostname: 'api.supabase.com',
      agent: httpsAgent,
      port: 443,
      path: `/v1/projects/${SUPABASE_PROJECT_REF}/database/query`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: timeoutMs
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(Array.isArray(parsed) ? parsed : (parsed.rows || []));
          } else {
            reject(new Error(parsed?.message || data));
          }
        } catch (e) {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve([]);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Supabase PostgreSQL query timed out'));
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * Execute raw PostgreSQL query directly on Supabase (zero local disk writes)
 * Transport priority:
 *   1. Direct pg.Pool (DATABASE_URL)
 *   2. @supabase/supabase-js RPC (`exec_attendance_sql`)
 *   3. Supabase Management SQL API (env SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF)
 */
async function querySupabaseDirect(sql, timeoutMs = 25000) {
  const schemaPrefix = DB_SCHEMA && DB_SCHEMA !== 'public' ? `SET search_path TO "${DB_SCHEMA}", public;\n` : '';

  // 1. Direct pg.Pool (PostgreSQL TCP)
  if (pgPool) {
    const client = await pgPool.connect();
    try {
      if (schemaPrefix) {
        await client.query(`SET search_path TO "${DB_SCHEMA}", public`);
      }
      const res = await client.query(sql);
      return Array.isArray(res) ? (res[res.length - 1]?.rows || []) : (res.rows || []);
    } finally {
      client.release();
    }
  }

  // 2. Official @supabase/supabase-js RPC (direct PostgREST -> PostgreSQL)
  if (supabase && supabaseRpcAvailable) {
    const { data, error } = await supabase.rpc('exec_attendance_sql', {
      query_text: sql,
      target_schema: DB_SCHEMA
    });
    if (!error) {
      return Array.isArray(data) ? data : [];
    }
    const msg = error.message || '';
    const isMissingRpc =
      error.code === 'PGRST202' ||
      msg.includes('Could not find the function') ||
      msg.includes('does not exist');
    if (isMissingRpc && SUPABASE_ACCESS_TOKEN && SUPABASE_PROJECT_REF) {
      supabaseRpcAvailable = false;
      console.warn('ℹ️ exec_attendance_sql RPC not yet installed on Supabase; falling back to configured Supabase SQL API.');
    } else if (!isMissingRpc) {
      throw new Error(msg);
    } else {
      throw new Error(
        `Supabase RPC "exec_attendance_sql" is not installed. Run supabase_attendance_schema.sql in Supabase SQL Editor first. (${msg})`
      );
    }
  }

  // 3. Configured Supabase Management SQL API
  return queryViaManagementApi(sql, timeoutMs);
}

/**
 * Execute a single atomic SQL query directly against Supabase PostgreSQL
 * Returns { rows: [...] }
 */
async function execute(sql, args = []) {
  const finalSql = interpolateSql(normalizeSql(sql), args);

  try {
    const rows = await querySupabaseDirect(finalSql);
    return { rows: Array.isArray(rows) ? rows : [] };
  } catch (err) {
    // Automatic PostgreSQL sequence self-repair if autoincrement ID collides
    if (err.message && err.message.includes('duplicate key value violates unique constraint')) {
      const match = sql.match(/(?:INTO)\s+["']?([a-zA-Z0-9_]+)["']?/i);
      if (match && match[1]) {
        const tbl = match[1];
        console.warn(`🛡️ Supabase DB: Auto-repairing sequence for '${tbl}' and retrying...`);
        try {
          await querySupabaseDirect(
            `SELECT setval('${DB_SCHEMA}."${tbl}_id_seq"', (SELECT COALESCE(MAX(id), 0) + 1 FROM "${DB_SCHEMA}"."${tbl}"), false);`
          );
          const retryRows = await querySupabaseDirect(finalSql);
          return { rows: Array.isArray(retryRows) ? retryRows : [] };
        } catch (healErr) {
          console.error(`Sequence heal error on ${tbl}:`, healErr.message);
        }
      }
    }

    console.error('Supabase DB Execute Error:', err.message, 'SQL:', finalSql.slice(0, 160));
    throw err;
  }
}

/**
 * Execute batch of SQL statements atomically inside a single PostgreSQL transaction
 */
async function batch(statements) {
  if (!statements || statements.length === 0) return [];
  const BATCH_SIZE = 500;
  const allResults = [];

  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    const chunk = statements.slice(i, i + BATCH_SIZE);
    const normalizedQueries = chunk.map(stmt => {
      if (typeof stmt === 'string') {
        return normalizeSql(stmt).replace(/;?\s*$/, '');
      }
      return interpolateSql(normalizeSql(stmt.sql), stmt.args || []).replace(/;?\s*$/, '');
    });

    // 1. Direct pg.Pool atomic transaction
    if (pgPool) {
      const client = await pgPool.connect();
      try {
        await client.query('BEGIN');
        if (DB_SCHEMA && DB_SCHEMA !== 'public') {
          await client.query(`SET LOCAL search_path TO "${DB_SCHEMA}", public`);
        }
        for (const q of normalizedQueries) {
          if (q.trim()) await client.query(q);
        }
        await client.query('COMMIT');
        allResults.push(...chunk.map(() => ({ rows: [] })));
        continue;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Supabase DB Transaction Error (pg.Pool):', err.message);
        throw err;
      } finally {
        client.release();
      }
    }

    // 2. Official @supabase/supabase-js atomic batch RPC
    if (supabase && supabaseRpcAvailable) {
      const { error } = await supabase.rpc('exec_attendance_batch', {
        queries: normalizedQueries,
        target_schema: DB_SCHEMA
      });
      if (!error) {
        allResults.push(...chunk.map(() => ({ rows: [] })));
        continue;
      }
      const msg = error.message || '';
      const isMissingRpc =
        error.code === 'PGRST202' ||
        msg.includes('Could not find the function') ||
        msg.includes('does not exist');
      if (isMissingRpc && SUPABASE_ACCESS_TOKEN && SUPABASE_PROJECT_REF) {
        supabaseRpcAvailable = false;
      } else {
        console.error('Supabase DB Atomic Batch Error:', msg);
        throw new Error(msg);
      }
    }

    // 3. Atomic BEGIN...COMMIT transaction over configured Supabase SQL API
    const batchSql = ['BEGIN;', ...normalizedQueries.map(q => `${q};`), 'COMMIT;'].join('\n');
    try {
      await queryViaManagementApi(batchSql);
      allResults.push(...chunk.map(() => ({ rows: [] })));
    } catch (err) {
      console.error('Supabase DB Batch Error:', err.message);
      throw err;
    }
  }

  return allResults;
}

/**
 * Direct @supabase/supabase-js atomic relational table helpers
 */
function getSupabaseClient() {
  return supabase;
}

async function upsertRows(table, rows, onConflict) {
  if (!supabase) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for direct Supabase table operations.');
  }
  const { data, error } = await supabase
    .from(table)
    .upsert(rows, onConflict ? { onConflict } : undefined)
    .select();
  if (error) throw new Error(error.message);
  return data || [];
}

async function deleteRows(table, matchFilter) {
  if (!supabase) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for direct Supabase table operations.');
  }
  const { error } = await supabase.from(table).delete().match(matchFilter);
  if (error) throw new Error(error.message);
  return true;
}

/**
 * Calibrate all PostgreSQL sequences on Supabase
 */
async function calibrateSequences() {
  const seqTables = [
    { seq: 'daily_attendance_id_seq', tbl: 'daily_attendance' },
    { seq: 'raw_punches_id_seq', tbl: 'raw_punches' },
    { seq: 'audit_logs_id_seq', tbl: 'audit_logs' },
    { seq: 'workers_id_seq', tbl: 'workers' },
    { seq: 'advances_id_seq', tbl: 'advances' },
    { seq: 'rule_profiles_id_seq', tbl: 'rule_profiles' },
    { seq: 'custom_rules_id_seq', tbl: 'custom_rules' },
    { seq: 'custom_salary_rules_id_seq', tbl: 'custom_salary_rules' },
    { seq: 'paid_holidays_id_seq', tbl: 'paid_holidays' },
    { seq: 'factory_calendar_id_seq', tbl: 'factory_calendar' }
  ];

  for (const t of seqTables) {
    try {
      await querySupabaseDirect(
        `SELECT setval('${DB_SCHEMA}."${t.seq}"', (SELECT COALESCE(MAX(id), 0) + 1 FROM "${DB_SCHEMA}"."${t.tbl}"), false);`
      );
    } catch (e) {
      try {
        await querySupabaseDirect(
          `SELECT setval('${t.seq}', (SELECT COALESCE(MAX(id), 0) + 1 FROM "${t.tbl}"), false);`
        );
      } catch (err2) {}
    }
  }
}

/**
 * Live Supabase Cloud Database Status (uses @supabase/supabase-js when available)
 */
async function getDatabaseStatus() {
  const tables = [
    'settings', 'workers', 'raw_punches', 'daily_attendance',
    'advances', 'audit_logs', 'rule_profiles', 'custom_rules',
    'custom_salary_rules', 'paid_holidays', 'factory_calendar', 'user_sessions'
  ];

  try {
    const counts = {};
    if (supabase && DB_SCHEMA === 'public') {
      const results = await Promise.all(
        tables.map(async (t) => {
          const { count, error } = await supabase
            .from(t)
            .select('*', { count: 'exact', head: true });
          return [t, error ? null : (count || 0)];
        })
      );
      const allOk = results.every(([, c]) => c !== null);
      if (allOk) {
        results.forEach(([t, c]) => { counts[t] = c; });
        return {
          connected: true,
          provider: `Supabase Cloud (@supabase/supabase-js - Schema: ${DB_SCHEMA})`,
          schema: DB_SCHEMA,
          counts
        };
      }
    }

    const sql = tables.map(t => `SELECT '${t}' as tbl, count(*) as cnt FROM "${t}"`).join(' UNION ALL ') + ';';
    const res = await execute(sql);
    if (Array.isArray(res.rows)) {
      res.rows.forEach(r => { counts[r.tbl] = parseInt(r.cnt, 10); });
    }
    return {
      connected: true,
      provider: `Supabase Cloud PostgreSQL (Schema: ${DB_SCHEMA})`,
      schema: DB_SCHEMA,
      counts
    };
  } catch (e) {
    return { connected: false, provider: 'Supabase Cloud', error: e.message };
  }
}

/**
 * Initialize Database on Supabase PostgreSQL:
 * - Verifies cloud database connection (fails fast if env vars missing)
 * - Calibrates sequences & ensures non-destructive schema columns/indexes exist
 * - Syncs ONLY explicitly configured environment variable credentials (never hardcoded defaults)
 * - ZERO local SQLite storage, ZERO seed_data.json loading, ZERO record resurrection on reboot
 */
async function initDatabase() {
  console.log(`🚀 Connecting directly to Supabase Cloud PostgreSQL [Schema: ${DB_SCHEMA}]...`);

  const hasAnyTransport = Boolean(
    pgPool ||
    supabase ||
    (SUPABASE_ACCESS_TOKEN && SUPABASE_PROJECT_REF)
  );
  if (!hasAnyTransport) {
    throw new Error(
      'Missing Supabase configuration in environment variables. Set SUPABASE_URL & SUPABASE_SERVICE_ROLE_KEY (or DATABASE_URL, or SUPABASE_PROJECT_REF & SUPABASE_ACCESS_TOKEN).'
    );
  }

  // Verify live connection
  const ping = await execute('SELECT 1 as ping;');
  if (!ping.rows || ping.rows.length === 0) {
    throw new Error('Could not establish connection to Supabase PostgreSQL database.');
  }
  console.log('✅ Supabase Cloud PostgreSQL connected successfully.');

  // Calibrate sequences so next inserts never collide
  await calibrateSequences();

  // Ensure non-destructive columns & performance indexes exist
  try {
    await querySupabaseDirect(`ALTER TABLE "${DB_SCHEMA}".daily_attendance ADD COLUMN IF NOT EXISTS forfeiture_reason TEXT DEFAULT '';`);
    await querySupabaseDirect(`ALTER TABLE "${DB_SCHEMA}".daily_attendance ADD COLUMN IF NOT EXISTS override_reason TEXT DEFAULT '';`);
    await querySupabaseDirect(`ALTER TABLE "${DB_SCHEMA}".user_sessions ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'admin';`);
    await querySupabaseDirect(`CREATE INDEX IF NOT EXISTS idx_${DB_SCHEMA}_da_date ON "${DB_SCHEMA}".daily_attendance(date);`);
    await querySupabaseDirect(`CREATE INDEX IF NOT EXISTS idx_${DB_SCHEMA}_da_staff_date ON "${DB_SCHEMA}".daily_attendance(staff_no, date);`);
    await querySupabaseDirect(`CREATE INDEX IF NOT EXISTS idx_${DB_SCHEMA}_rp_staff_date ON "${DB_SCHEMA}".raw_punches(staff_no, date);`);
    await querySupabaseDirect(`CREATE INDEX IF NOT EXISTS idx_${DB_SCHEMA}_adv_staff_date ON "${DB_SCHEMA}".advances(staff_no, date);`);
  } catch (e) {
    console.warn('Schema migration warning:', e.message);
  }

  // Synchronize ONLY explicitly provided environment variable credentials (never overwrite with hardcoded defaults)
  try {
    const envCreds = [];
    if (process.env.PAYROLL_PASSWORD && process.env.PAYROLL_PASSWORD.trim()) {
      envCreds.push(['payroll_password', process.env.PAYROLL_PASSWORD.trim(), 'Password to unlock salary and payroll figures']);
    }
    if (process.env.MASTER_PASSWORD && process.env.MASTER_PASSWORD.trim()) {
      envCreds.push(['master_password', process.env.MASTER_PASSWORD.trim(), 'Master Admin Password for application login and access']);
    }
    if (process.env.TOTP_SECRET && process.env.TOTP_SECRET.trim()) {
      envCreds.push(['totp_enabled', 'true', 'Is Google Authenticator 2FA enabled (true/false)']);
      envCreds.push(['totp_secret', process.env.TOTP_SECRET.trim(), 'Base32 secret key for Google Authenticator TOTP']);
    }

    for (const [key, val, desc] of envCreds) {
      await execute(
        `INSERT INTO settings (key, value, description) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;`,
        [key, val, desc]
      );
    }
    if (envCreds.length > 0) {
      console.log('🔒 Security credentials synced from environment variables.');
    }
  } catch (e) {
    console.warn('Credentials sync warning:', e.message);
  }

  // Log live Supabase status
  try {
    const wRes = await execute('SELECT COUNT(*) as cnt FROM workers;');
    const aRes = await execute('SELECT COUNT(*) as cnt FROM daily_attendance;');
    console.log(`📊 Supabase Live Status [Schema: ${DB_SCHEMA}]: ${wRes.rows[0]?.cnt || 0} Workers, ${aRes.rows[0]?.cnt || 0} Daily Attendance Records.`);
  } catch (e) {}

  console.log('✅ Supabase Primary Database Ready (Direct Atomic Queries — Zero SQLite, Zero Seed Resurrection).');
}

let cacheInvalidator = null;
function setCacheInvalidator(fn) {
  cacheInvalidator = fn;
}
function invalidateDatabaseCache() {
  if (typeof cacheInvalidator === 'function') {
    try { cacheInvalidator(); } catch (e) {}
  }
}

const db = {
  execute: async ({ sql, args }) => execute(sql, args),
  batch: async (statements) => batch(statements),
  supabase
};

module.exports = {
  db,
  supabase,
  getSupabaseClient,
  upsertRows,
  deleteRows,
  execute,
  batch,
  initDatabase,
  getDatabaseStatus,
  setCacheInvalidator,
  invalidateDatabaseCache,
  DB_SCHEMA
};

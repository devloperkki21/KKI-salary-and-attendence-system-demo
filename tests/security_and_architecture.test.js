const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`❌ FAIL: ${name}\n   -> ${err.message}`);
    failed++;
  }
}

console.log('=== TEST SUITE: DATABASE ARCHITECTURE, ZERO-RESURRECTION & API SECURITY ===\n');

// 1. Legacy SQLite / cloudSync / seed_data.json removal checks
test('server/cloudSync.js is completely removed', () => {
  assert.strictEqual(fs.existsSync(path.join(ROOT, 'server/cloudSync.js')), false);
});

test('server/migrateToTurso.js (legacy SQLite script) is removed', () => {
  assert.strictEqual(fs.existsSync(path.join(ROOT, 'server/migrateToTurso.js')), false);
});

test('data/seed_data.json and attendance.db are NOT tracked in Git', () => {
  const tracked = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' }).split(/\r?\n/);
  assert.strictEqual(tracked.includes('data/seed_data.json'), false, 'data/seed_data.json must not be tracked');
  assert.strictEqual(tracked.some(f => f.endsWith('.db') || f.endsWith('.sqlite')), false, 'No SQLite .db/.sqlite files may be tracked');
});

test('.gitignore ignores seed_data.json, attendance.db, and whitelists supabase_attendance_schema.sql', () => {
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.ok(gi.includes('data/seed_data.json'), 'Missing data/seed_data.json in .gitignore');
  assert.ok(gi.includes('attendance.db'), 'Missing attendance.db in .gitignore');
  assert.ok(gi.includes('!supabase_attendance_schema.sql'), 'Missing !supabase_attendance_schema.sql in .gitignore');
});

test('supabase_attendance_schema.sql defines relational tables and service_role-only atomic RPCs', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'supabase_attendance_schema.sql'), 'utf8');
  const requiredTables = [
    'settings', 'workers', 'raw_punches', 'daily_attendance',
    'advances', 'audit_logs', 'rule_profiles', 'custom_rules',
    'custom_salary_rules', 'paid_holidays', 'factory_calendar', 'user_sessions'
  ];
  for (const tbl of requiredTables) {
    assert.ok(sql.includes(`CREATE TABLE IF NOT EXISTS ${tbl}`), `Missing table ${tbl} in schema SQL`);
  }
  assert.ok(sql.includes('CREATE OR REPLACE FUNCTION exec_attendance_sql'), 'Missing exec_attendance_sql RPC');
  assert.ok(sql.includes('CREATE OR REPLACE FUNCTION exec_attendance_batch'), 'Missing exec_attendance_batch RPC');
  assert.ok(sql.includes('REVOKE ALL ON FUNCTION exec_attendance_sql(TEXT, TEXT) FROM PUBLIC, anon, authenticated'), 'RPC must revoke public/anon/authenticated');
});

test('scripts/migrate_to_supabase.js exists and uses @supabase/supabase-js with ignoreDuplicates', () => {
  const mig = fs.readFileSync(path.join(ROOT, 'scripts/migrate_to_supabase.js'), 'utf8');
  assert.ok(mig.includes("@supabase/supabase-js"), 'Must use @supabase/supabase-js');
  assert.ok(mig.includes('ignoreDuplicates: true'), 'Must use ignoreDuplicates: true for zero data loss');
  execSync('node --check scripts/migrate_to_supabase.js', { cwd: ROOT });
});

// 2. Zero hardcoded secrets / fallback credentials across entire repo
test('No hardcoded Supabase URLs, JWT keys, PAT tokens, TOTP secrets, or kki123 defaults exist in code', () => {
  const filesToScan = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|jsx|ts|tsx|yaml|yml|sql)$/.test(entry.name)) filesToScan.push(full);
    }
  };
  walk(path.join(ROOT, 'server'));
  walk(path.join(ROOT, 'src'));
  walk(path.join(ROOT, 'scripts'));
  filesToScan.push(path.join(ROOT, 'render.yaml'), path.join(ROOT, '.env.example'));

  const forbidden = [
    { name: 'Hardcoded Supabase project ref', re: /drladbxpfnapxjmoxqhj/ },
    { name: 'Hardcoded JWT key', re: /eyJhbGciOiJIUzI1Ni/ },
    { name: 'Hardcoded base64 Supabase PAT', re: /c2JwX2ZjOTJk/ },
    { name: 'Hardcoded TOTP secret', re: /SLFRTE6JFYKYRJV3NFPSEN7576NKOHAF/ },
    { name: 'Hardcoded default password kki123', re: /kki123/ },
    { name: 'Hardcoded emergency backup code', re: /1942-8371/ }
  ];

  for (const file of filesToScan) {
    const content = fs.readFileSync(file, 'utf8');
    for (const check of forbidden) {
      assert.strictEqual(check.re.test(content), false, `${check.name} found in ${path.relative(ROOT, file)}`);
    }
  }
});

// 3. Database module contract & zero startup resurrection
test('server/db.js exports @supabase/supabase-js helpers and has no backupDatabaseToSeed or holiday resurrection', () => {
  const dbMod = require(path.join(ROOT, 'server/db.js'));
  assert.strictEqual(typeof dbMod.execute, 'function');
  assert.strictEqual(typeof dbMod.batch, 'function');
  assert.strictEqual(typeof dbMod.initDatabase, 'function');
  assert.strictEqual(typeof dbMod.getDatabaseStatus, 'function');
  assert.strictEqual(typeof dbMod.getSupabaseClient, 'function');
  assert.strictEqual(typeof dbMod.upsertRows, 'function');
  assert.strictEqual(typeof dbMod.deleteRows, 'function');
  assert.strictEqual(dbMod.backupDatabaseToSeed, undefined, 'backupDatabaseToSeed must be removed');

  const dbSrc = fs.readFileSync(path.join(ROOT, 'server/db.js'), 'utf8');
  assert.strictEqual(/INSERT INTO paid_holidays/i.test(dbSrc), false, 'Startup holiday resurrection INSERT must be removed');
});

// 4. Auth verification, PUBLIC_API_PATHS lockdown, and Admin-only authorize middleware
test('auth.verifyPassword() enforces exact match only (no backdoors)', () => {
  const auth = require(path.join(ROOT, 'server/auth.js'));
  assert.strictEqual(auth.verifyPassword('SuperSecret#2026', 'SuperSecret#2026'), true);
  assert.strictEqual(auth.verifyPassword('123', 'SuperSecret#2026'), false);
  assert.strictEqual(auth.verifyPassword('admin', 'SuperSecret#2026'), false);
  assert.strictEqual(auth.verifyPassword('admin123', 'SuperSecret#2026'), false);
  assert.strictEqual(auth.verifyPassword('kki123', 'SuperSecret#2026'), false);
  assert.strictEqual(auth.verifyPassword('', 'SuperSecret#2026'), false);
  assert.strictEqual(auth.verifyPassword('anything', null), false);
  assert.strictEqual(auth.verifyPassword('anything', ''), false);
});

test('auth.PUBLIC_API_PATHS locks down attendance data and sensitive auth management routes', () => {
  const auth = require(path.join(ROOT, 'server/auth.js'));
  assert.ok(auth.PUBLIC_API_PATHS.has('/api/health'));
  assert.ok(auth.PUBLIC_API_PATHS.has('/api/auth/login'));
  assert.ok(auth.PUBLIC_API_PATHS.has('/api/auth/status'));

  const mustBePrivate = [
    '/api/workers',
    '/api/attendance/all',
    '/api/attendance/edit',
    '/api/dashboard',
    '/api/export/excel',
    '/api/export/excel/summary',
    '/api/auth/reset-2fa',
    '/api/auth/change-password',
    '/api/auth/regenerate-backup-codes',
    '/api/auth/verify-payroll-password'
  ];
  for (const p of mustBePrivate) {
    assert.strictEqual(auth.PUBLIC_API_PATHS.has(p), false, `${p} must NOT be public`);
  }
});

test('auth.authorize(["admin"]) blocks unauthenticated (401) and non-admin (403) callers, allows admin', () => {
  const auth = require(path.join(ROOT, 'server/auth.js'));
  const mw = auth.authorize(['admin']);

  const mockRes = () => {
    const out = { statusCode: 200, body: null };
    out.status = (code) => { out.statusCode = code; return out; };
    out.json = (b) => { out.body = b; return out; };
    return out;
  };

  // Unauthenticated
  let nextCalled = false;
  const r1 = mockRes();
  mw({}, r1, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(r1.statusCode, 401);

  // Non-admin staff
  nextCalled = false;
  const r2 = mockRes();
  mw({ user: { role: 'staff' } }, r2, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(r2.statusCode, 403);

  // Admin
  nextCalled = false;
  const r3 = mockRes();
  mw({ user: { role: 'admin' } }, r3, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
});

test('All Excel/CSV export & destructive routes in server/index.js enforce auth.authorize(["admin"])', () => {
  const indexSrc = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
  const exportRoutes = [
    "app.get('/api/export/excel', auth.authorize(['admin'])",
    "app.get('/api/export/excel/timings', auth.authorize(['admin'])",
    "app.get('/api/export/excel/summary', auth.authorize(['admin'])",
    "app.get('/api/export/excel/deducted-holidays-and-offs', auth.authorize(['admin'])",
    "app.get('/api/export/excel/paid-holidays-and-off-duty', auth.authorize(['admin'])",
    "app.get('/api/export/excel/fixes-audit', auth.authorize(['admin'])",
    "app.get('/api/export/excel/worker/:staff_no', auth.authorize(['admin'])",
    "app.post('/api/ai-assistant/generate-report', auth.authorize(['admin'])",
    "app.post('/api/google-sheets/sync', auth.authorize(['admin'])",
    "app.post('/api/attendance/clear-range', auth.authorize(['admin'])"
  ];
  for (const sig of exportRoutes) {
    assert.ok(indexSrc.includes(sig), `Missing admin guard on: ${sig}`);
  }
  assert.strictEqual(indexSrc.includes("require('./cloudSync')"), false, 'Must not require cloudSync');
  assert.strictEqual(indexSrc.includes("date('now')"), false, 'Must not contain SQLite date(\'now\')');
  execSync('node --check server/index.js', { cwd: ROOT });
});

console.log(`\n================================`);
console.log(`RESULTS: ${passed} Passed, ${failed} Failed`);
console.log(`================================`);

if (failed > 0) {
  process.exit(1);
}
console.log('🎉 ALL ARCHITECTURE & SECURITY TESTS PASSED!');

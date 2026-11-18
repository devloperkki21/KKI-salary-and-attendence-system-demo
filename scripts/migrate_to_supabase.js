#!/usr/bin/env node
/**
 * Safe Zero-Data-Loss Migration Script -> Supabase Relational PostgreSQL
 *
 * Uses @supabase/supabase-js directly with `ignoreDuplicates: true` (ON CONFLICT DO NOTHING)
 * so existing live Supabase records are NEVER overwritten or lost.
 *
 * Usage:
 *   # Dry-run preview from a legacy SQLite database:
 *   node scripts/migrate_to_supabase.js --sqlite data/attendance_pre_recovery_backup.db
 *
 *   # Dry-run preview from a legacy JSON backup:
 *   node scripts/migrate_to_supabase.js --json data/seed_data.json
 *
 *   # Apply migration (idempotent, zero overwrites):
 *   node scripts/migrate_to_supabase.js --sqlite data/attendance_pre_recovery_backup.db --apply
 *
 * Required Environment Variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_KEY)
 *   DB_SCHEMA (optional, defaults to 'public')
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const DB_SCHEMA = process.env.DB_SCHEMA || 'public';

const TABLE_SPECS = [
  { name: 'settings', conflict: 'key', stripId: false },
  { name: 'workers', conflict: 'staff_no', stripId: true },
  { name: 'raw_punches', conflict: 'staff_no,date', stripId: true },
  { name: 'daily_attendance', conflict: 'staff_no,date', stripId: true },
  { name: 'advances', conflict: null, stripId: true },
  { name: 'audit_logs', conflict: null, stripId: true },
  { name: 'rule_profiles', conflict: 'profile_name', stripId: true },
  { name: 'custom_rules', conflict: null, stripId: true },
  { name: 'custom_salary_rules', conflict: null, stripId: true },
  { name: 'paid_holidays', conflict: 'holiday_date', stripId: true },
  { name: 'factory_calendar', conflict: 'date', stripId: true }
];

function parseArgs(argv) {
  const opts = { sqlite: null, json: null, apply: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--sqlite' && argv[i + 1]) opts.sqlite = argv[++i];
    else if (argv[i] === '--json' && argv[i + 1]) opts.json = argv[++i];
    else if (argv[i] === '--apply') opts.apply = true;
  }
  return opts;
}

function readFromSqlite(dbPath) {
  const absPath = path.resolve(dbPath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`SQLite file not found: ${absPath}`);
  }
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (err) {
    throw new Error('Node >= 22 built-in node:sqlite is required to read legacy SQLite files.');
  }

  const db = new DatabaseSync(absPath, { readOnly: true });
  const existingTables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name)
  );

  const payload = {};
  for (const spec of TABLE_SPECS) {
    if (!existingTables.has(spec.name)) {
      payload[spec.name] = [];
      continue;
    }
    payload[spec.name] = db.prepare(`SELECT * FROM "${spec.name}"`).all();
  }
  db.close();
  return payload;
}

function readFromJson(jsonPath) {
  const absPath = path.resolve(jsonPath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`JSON file not found: ${absPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(absPath, 'utf8'));
  const payload = {};
  for (const spec of TABLE_SPECS) {
    payload[spec.name] = Array.isArray(parsed[spec.name]) ? parsed[spec.name] : [];
  }
  return payload;
}

function sanitizeRow(row, stripId) {
  const copy = { ...row };
  if (stripId && Object.prototype.hasOwnProperty.call(copy, 'id')) {
    delete copy.id;
  }
  // Never migrate sensitive credential keys from legacy dumps
  return copy;
}

async function getCloudCounts(supabase) {
  const counts = {};
  for (const spec of TABLE_SPECS) {
    const { count, error } = await supabase
      .from(spec.name)
      .select('*', { count: 'exact', head: true });
    counts[spec.name] = error ? `ERR(${error.message})` : (count || 0);
  }
  return counts;
}

async function run() {
  const opts = parseArgs(process.argv);

  if (!opts.sqlite && !opts.json) {
    console.error('Usage: node scripts/migrate_to_supabase.js --sqlite <path> | --json <path> [--apply]');
    process.exit(1);
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing required environment variables: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_KEY).');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    db: { schema: DB_SCHEMA },
    auth: { persistSession: false }
  });

  console.log(`\n🛡️  KKI Attendance Safe Supabase Migrator`);
  console.log(`   Target Schema : ${DB_SCHEMA}`);
  console.log(`   Mode          : ${opts.apply ? 'APPLY (Safe Upsert / Zero Overwrite)' : 'DRY-RUN (Read-Only Preview)'}`);

  const sourceData = opts.sqlite ? readFromSqlite(opts.sqlite) : readFromJson(opts.json);

  console.log('\n📊 Existing Supabase Row Counts (BEFORE):');
  const beforeCounts = await getCloudCounts(supabase);
  console.table(
    TABLE_SPECS.map(s => ({
      table: s.name,
      source_rows: (sourceData[s.name] || []).length,
      supabase_before: beforeCounts[s.name]
    }))
  );

  if (!opts.apply) {
    console.log('\n✅ Dry-run complete. No rows were modified.');
    console.log('   Re-run with --apply to migrate missing records safely without overwriting existing data.');
    return;
  }

  const CHUNK_SIZE = 300;
  const PROTECTED_SETTINGS = new Set(['master_password', 'payroll_password', 'totp_secret', 'emergency_backup_codes']);

  for (const spec of TABLE_SPECS) {
    let rows = sourceData[spec.name] || [];
    if (rows.length === 0) continue;

    if (spec.name === 'settings') {
      rows = rows.filter(r => !PROTECTED_SETTINGS.has(r.key));
    }

    // For append-only tables without unique key (advances, audit_logs, custom_rules, custom_salary_rules),
    // skip if target already has rows to guarantee zero duplicate creation on re-run.
    if (!spec.conflict && typeof beforeCounts[spec.name] === 'number' && beforeCounts[spec.name] > 0) {
      console.log(`⏭️  Skipping ${spec.name}: already has ${beforeCounts[spec.name]} rows in Supabase (no natural unique key; preventing duplicates).`);
      continue;
    }

    const cleaned = rows.map(r => sanitizeRow(r, spec.stripId));
    let migrated = 0;

    for (let i = 0; i < cleaned.length; i += CHUNK_SIZE) {
      const chunk = cleaned.slice(i, i + CHUNK_SIZE);
      const query = spec.conflict
        ? supabase.from(spec.name).upsert(chunk, { onConflict: spec.conflict, ignoreDuplicates: true })
        : supabase.from(spec.name).insert(chunk);

      const { error } = await query;
      if (error) {
        throw new Error(`Migration failed on table "${spec.name}" (offset ${i}): ${error.message}`);
      }
      migrated += chunk.length;
    }
    console.log(`✅ Processed ${migrated} rows for "${spec.name}"`);
  }

  console.log('\n📊 Supabase Row Counts (AFTER):');
  const afterCounts = await getCloudCounts(supabase);
  console.table(
    TABLE_SPECS.map(s => ({
      table: s.name,
      before: beforeCounts[s.name],
      after: afterCounts[s.name]
    }))
  );
  console.log('\n🎉 Zero-Data-Loss Migration Completed Successfully!');
}

run().catch(err => {
  console.error('❌ Migration Error:', err.message);
  process.exit(1);
});

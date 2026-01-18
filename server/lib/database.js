const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { getDbPath, getAppDir } = require('./paths');

let db;
let dbCompat;
let resolvedDbPathUsed;

function createSqlite3Compat(database) {
  const bindParams = (stmt, params, method) => {
    if (params === undefined || params === null) return stmt[method]();
    if (Array.isArray(params)) return stmt[method](...params);
    return stmt[method](params);
  };

  const normalizeArgs = (params, callback) => {
    if (typeof params === 'function') {
      return { params: [], callback: params };
    }
    return { params: params ?? [], callback };
  };

  return new Proxy(database, {
    get(target, prop) {
      if (prop === 'get') {
        return (sql, params, callback) => {
          const args = normalizeArgs(params, callback);
          const cb = args.callback;
          if (typeof cb !== 'function') {
            throw new TypeError('Callback is required for db.get(sql, params, callback)');
          }

          process.nextTick(() => {
            try {
              const stmt = target.prepare(sql);
              const row = bindParams(stmt, args.params, 'get');
              cb(null, row);
            } catch (err) {
              cb(err);
            }
          });
        };
      }

      if (prop === 'all') {
        return (sql, params, callback) => {
          const args = normalizeArgs(params, callback);
          const cb = args.callback;
          if (typeof cb !== 'function') {
            throw new TypeError('Callback is required for db.all(sql, params, callback)');
          }

          process.nextTick(() => {
            try {
              const stmt = target.prepare(sql);
              const rows = bindParams(stmt, args.params, 'all');
              cb(null, rows);
            } catch (err) {
              cb(err);
            }
          });
        };
      }

      if (prop === 'run') {
        return (sql, params, callback) => {
          const args = normalizeArgs(params, callback);
          const cb = args.callback;

          process.nextTick(() => {
            try {
              const stmt = target.prepare(sql);
              const info = bindParams(stmt, args.params, 'run');

              if (typeof cb === 'function') {
                cb.call(
                  { lastID: info.lastInsertRowid, changes: info.changes },
                  null
                );
              }
            } catch (err) {
              if (typeof cb === 'function') cb(err);
            }
          });
        };
      }

      const value = Reflect.get(target, prop, target);
      if (typeof value === 'function') return value.bind(target);
      return value;
    }
  });
}

function applyMigrations(database) {
  database.exec(
    `CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );

  const migrations = [
    {
      name: '20251216_add_accounts_sessions',
      statements: [
        `CREATE TABLE IF NOT EXISTS accounts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL DEFAULT 'normal',
          email TEXT,
          display_name TEXT NOT NULL,
          description TEXT,
          color TEXT,
          avatar TEXT,
          presence_mode TEXT DEFAULT 'offline',
          last_heartbeat_at DATETIME,
          settings_json TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          owner_account_id INTEGER NOT NULL,
          name TEXT,
          join_code TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL DEFAULT 'active',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          ended_at DATETIME
        )`,
        `CREATE TABLE IF NOT EXISTS session_members (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER NOT NULL,
          account_id INTEGER NOT NULL,
          role TEXT NOT NULL DEFAULT 'member',
          permissions_json TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(session_id, account_id)
        )`,
        `CREATE TABLE IF NOT EXISTS session_join_requests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER NOT NULL,
          requester_account_id INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          decided_at DATETIME,
          decided_by_account_id INTEGER,
          permissions_json TEXT
        )`,
        `CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_account_id)`,
        `CREATE INDEX IF NOT EXISTS idx_session_members_account ON session_members(account_id)`,
        `CREATE INDEX IF NOT EXISTS idx_join_requests_session_status ON session_join_requests(session_id, status)`,

        "ALTER TABLE servers ADD COLUMN owner_account_id INTEGER",

        // Ensure a default account exists
        `INSERT INTO accounts (type, display_name, description, presence_mode, settings_json)
         SELECT 'normal', 'Primary', 'Default account', 'online', '{}' 
         WHERE NOT EXISTS (SELECT 1 FROM accounts LIMIT 1)`,

        // Ensure settings.activeAccountId exists
        `INSERT OR IGNORE INTO settings (key, value)
         VALUES ('activeAccountId', (SELECT CAST(id AS TEXT) FROM accounts ORDER BY id ASC LIMIT 1))`,

        // Backfill existing servers to the default account
        `UPDATE servers
         SET owner_account_id = (SELECT id FROM accounts ORDER BY id ASC LIMIT 1)
         WHERE owner_account_id IS NULL`,
      ]
    },
    {
      name: '20251216_accounts_email_unique',
      statements: [
        "ALTER TABLE accounts ADD COLUMN email TEXT",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_email_unique ON accounts(email) WHERE email IS NOT NULL AND email <> ''",
      ]
    },
    {
      name: '20240201_add_server_columns',
      statements: [
        "ALTER TABLE servers ADD COLUMN env_vars TEXT",
        "ALTER TABLE servers ADD COLUMN repo TEXT",
        "ALTER TABLE servers ADD COLUMN runtime TEXT",
        "ALTER TABLE servers ADD COLUMN notes TEXT",
        "ALTER TABLE servers ADD COLUMN auto_port INTEGER DEFAULT 0",
        "ALTER TABLE servers ADD COLUMN launch_script TEXT",
        "ALTER TABLE servers ADD COLUMN dns_provisioned INTEGER DEFAULT 0",
        "ALTER TABLE servers ADD COLUMN dns_hostname TEXT",
        "ALTER TABLE servers ADD COLUMN metadata TEXT"
      ]
    },
    {
      name: '20251216_add_server_isolation_limits',
      statements: [
        "ALTER TABLE servers ADD COLUMN execution_mode TEXT DEFAULT 'native'",
        "ALTER TABLE servers ADD COLUMN runtime_preset TEXT",
        "ALTER TABLE servers ADD COLUMN install_command TEXT",
        "ALTER TABLE servers ADD COLUMN start_command TEXT",
        "ALTER TABLE servers ADD COLUMN cpu_limit_percent INTEGER",
        "ALTER TABLE servers ADD COLUMN memory_limit_mb INTEGER",
        "ALTER TABLE servers ADD COLUMN disk_limit_mb INTEGER",
        "ALTER TABLE servers ADD COLUMN isolation_enabled INTEGER DEFAULT 0"
      ]
    },
    {
      name: '20241201_add_node_support',
      statements: [
        "ALTER TABLE servers ADD COLUMN node_id INTEGER REFERENCES nodes(id)",
        "ALTER TABLE nodes ADD COLUMN port INTEGER DEFAULT 3001",
        "ALTER TABLE nodes ADD COLUMN resources TEXT",
        "ALTER TABLE nodes ADD COLUMN capabilities TEXT"
      ]
    },
    {
      name: '20251215_add_nodes_updated_at',
      statements: [
        "ALTER TABLE nodes ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP"
      ]
    },
    {
      name: '20251223_add_node_auth_token',
      statements: [
        "ALTER TABLE nodes ADD COLUMN auth_token TEXT"
      ]
    },
    {
      name: '20251215_backups_metadata_nullable_server_id',
      statements: [
        'PRAGMA foreign_keys=OFF',
        `CREATE TABLE IF NOT EXISTS backups_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          server_id INTEGER,
          filename TEXT NOT NULL,
          size INTEGER,
          metadata TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (server_id) REFERENCES servers(id)
        )`,
        'INSERT INTO backups_new (id, server_id, filename, size, created_at) SELECT id, server_id, filename, size, created_at FROM backups',
        'DROP TABLE backups',
        'ALTER TABLE backups_new RENAME TO backups',
        'PRAGMA foreign_keys=ON'
      ]
    },
    {
      name: '20241201_add_failover_support',
      statements: [
        `CREATE TABLE IF NOT EXISTS failover_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          node_id INTEGER NOT NULL,
          status TEXT NOT NULL,
          details TEXT,
          server_count INTEGER,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (node_id) REFERENCES nodes(id)
        )`
      ]
    },
    {
      name: '20241201_add_resource_monitoring',
      statements: [
        `CREATE TABLE IF NOT EXISTS node_resources (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          node_id INTEGER NOT NULL,
          timestamp DATETIME NOT NULL,
          cpu_usage REAL,
          cpu_cores INTEGER,
          memory_total BIGINT,
          memory_used BIGINT,
          memory_free BIGINT,
          disk_usage TEXT,
          network_interfaces TEXT,
          system_info TEXT,
          raw_data TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (node_id) REFERENCES nodes(id)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_node_resources_node_timestamp
         ON node_resources(node_id, timestamp)`,
        `CREATE INDEX IF NOT EXISTS idx_node_resources_timestamp
         ON node_resources(timestamp)`
      ]
    }
    ,
    {
      name: '20251223_add_backup_schedules',
      statements: [
        `CREATE TABLE IF NOT EXISTS backup_schedules (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          server_id INTEGER NOT NULL,
          cron_expr TEXT NOT NULL,
          incremental INTEGER DEFAULT 0,
          compression_level INTEGER DEFAULT 6,
          retention_days INTEGER DEFAULT 7,
          enabled INTEGER DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (server_id) REFERENCES servers(id)
        )`,
        `INSERT OR IGNORE INTO settings (key, value) VALUES ('backup.retention_days', '7')`
      ]
    },
    {
      name: '20251225_backup_schedule_tracking',
      statements: [
        "ALTER TABLE backup_schedules ADD COLUMN last_run DATETIME",
        "ALTER TABLE backup_schedules ADD COLUMN last_error TEXT",
        "ALTER TABLE backup_schedules ADD COLUMN last_success INTEGER DEFAULT 1"
      ]
    },
    {
      name: '20251231_add_audit_logs',
      statements: [
        `CREATE TABLE IF NOT EXISTS audit_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          server_id INTEGER,
          action TEXT NOT NULL,
          user TEXT,
          details TEXT,
          metadata TEXT,
          ip_address TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (server_id) REFERENCES servers(id)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_audit_logs_server ON audit_logs(server_id)`,
        `CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at)`
      ]
    },
    {
      name: '20251231_add_ai_forge',
      statements: [
        `CREATE TABLE IF NOT EXISTS ai_forge_config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS ai_forge_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          model TEXT NOT NULL,
          prompt TEXT,
          response TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `INSERT OR IGNORE INTO ai_forge_config (key, value) VALUES ('system_prompt', 'You are a helpful, professional AI assistant.')`,
        `INSERT OR IGNORE INTO ai_forge_config (key, value) VALUES ('temperature', '0.7')`,
        `INSERT OR IGNORE INTO ai_forge_config (key, value) VALUES ('top_p', '0.9')`
      ]
    },
    {
      name: '20260104_add_2fa_and_cloud_storage',
      statements: [
        "ALTER TABLE accounts ADD COLUMN two_factor_secret TEXT",
        "ALTER TABLE accounts ADD COLUMN two_factor_enabled INTEGER DEFAULT 0",
        "ALTER TABLE accounts ADD COLUMN cloud_storage_config TEXT"
      ]
    },
    {
      name: '20260107_add_node_tunnel_support',
      statements: [
        "ALTER TABLE nodes ADD COLUMN tunnel_url TEXT",
        "ALTER TABLE nodes ADD COLUMN is_local INTEGER DEFAULT 0"
      ]
    },
    {
      name: '20260114_add_ssh_node_support',
      statements: [
        "ALTER TABLE nodes ADD COLUMN connection_type TEXT DEFAULT 'http'",
        "ALTER TABLE nodes ADD COLUMN ssh_user TEXT",
        "ALTER TABLE nodes ADD COLUMN ssh_password TEXT",
        "ALTER TABLE nodes ADD COLUMN ssh_key TEXT",
        "ALTER TABLE nodes ADD COLUMN ssh_port INTEGER DEFAULT 22",
        "INSERT OR IGNORE INTO settings (key, value) VALUES ('activeNodeId', 'local')"
      ]
    },
    {
      name: '20260114_add_node_host_key',
      statements: [
        "ALTER TABLE nodes ADD COLUMN host_key TEXT"
      ]
    },
    {
      name: '20260117_add_panel_users',
      statements: [
        `CREATE TABLE IF NOT EXISTS panel_users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT NOT NULL UNIQUE,
          password TEXT NOT NULL,
          name TEXT,
          role TEXT DEFAULT 'user',
          is_active INTEGER DEFAULT 1,
          last_login DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE INDEX IF NOT EXISTS idx_panel_users_email ON panel_users(email)`,
        `CREATE INDEX IF NOT EXISTS idx_panel_users_role ON panel_users(role)`,
        // Link servers to panel users
        "ALTER TABLE servers ADD COLUMN panel_user_id INTEGER REFERENCES panel_users(id)"
      ]
    },
    {
      name: '20260117_add_user_quotas',
      statements: [
        "ALTER TABLE panel_users ADD COLUMN server_limit INTEGER DEFAULT 0",
        "ALTER TABLE panel_users ADD COLUMN cpu_limit INTEGER DEFAULT 100",
        "ALTER TABLE panel_users ADD COLUMN memory_limit INTEGER DEFAULT 1024",
        "ALTER TABLE panel_users ADD COLUMN disk_limit INTEGER DEFAULT 10240",
        "ALTER TABLE panel_users ADD COLUMN backup_limit INTEGER DEFAULT 3",
        "ALTER TABLE panel_users ADD COLUMN port_limit INTEGER DEFAULT 5"
      ]
    }
  ];

  for (const migration of migrations) {
    const checkStmt = database.prepare('SELECT 1 FROM migrations WHERE name = ? LIMIT 1');
    const row = checkStmt.get(migration.name);
    if (row) continue;

    const transaction = database.transaction(() => {
      for (const stmt of migration.statements) {
        try {
          database.prepare(stmt).run();
        } catch (err) {
          if (!/duplicate column/i.test(err.message)) {
            console.error('[DB] Migration statement failed:', stmt, err);
            throw err;
          }
        }
      }
      const insertStmt = database.prepare('INSERT INTO migrations (name) VALUES (?)');
      insertStmt.run(migration.name);
    });

    try {
      transaction();
    } catch (err) {
      console.error('[DB] Migration failed:', migration.name, err);
      throw err;
    }
  }
}

function initDatabase() {

  const resolvedDbPath = getDbPath();
  resolvedDbPathUsed = resolvedDbPath;
  const dbDir = path.dirname(resolvedDbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // Ensure our preferred new directory exists even if we're using the legacy DB for now.
  try {
    getAppDir();
  } catch {
    // ignore
  }

  db = new Database(resolvedDbPath);
  dbCompat = createSqlite3Compat(db);

  db.get = dbCompat.get;
  db.all = dbCompat.all;
  db.run = dbCompat.run;
  db.pragma('foreign_keys = ON');

  console.log('Connected to SQLite database');
  console.log('[DB] Compatibility layer enabled:', typeof db.get === 'function' && typeof db.all === 'function' && typeof db.run === 'function');

  db.exec(`
    CREATE TABLE IF NOT EXISTS servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_account_id INTEGER,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      path TEXT NOT NULL,
      command TEXT NOT NULL,
      port INTEGER,
      status TEXT DEFAULT 'stopped',
      public_access INTEGER DEFAULT 0,
      subdomain TEXT,
      env_vars TEXT,
      repo TEXT,
      runtime TEXT,
      notes TEXT,
      auto_port INTEGER DEFAULT 0,
      launch_script TEXT,
      dns_provisioned INTEGER DEFAULT 0,
      dns_hostname TEXT,
      metadata TEXT,
      pid INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      ip_address TEXT NOT NULL,
      port INTEGER DEFAULT 3001,
      status TEXT DEFAULT 'offline',
      last_seen DATETIME,
      resources TEXT,
      capabilities TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ,updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER,
      filename TEXT NOT NULL,
      size INTEGER,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (server_id) REFERENCES servers(id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (server_id) REFERENCES servers(id)
    );
  `);

  applyMigrations(db);
}

function getDatabase() {
  return dbCompat || db;
}

function closeDatabase() {
  if (db) {
    db.close();
  }
}

function getDatabasePath() {
  return resolvedDbPathUsed || null;
}

module.exports = {
  initDatabase,
  getDatabase,
  getDatabasePath,
  closeDatabase,
};
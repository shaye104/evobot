const mysql = require('mysql2/promise');
const { CONFIG } = require('./config');

let dbPool = null;

function isDbConfigured() {
  return (
    CONFIG.MYSQL_HOST &&
    CONFIG.MYSQL_DATABASE &&
    CONFIG.MYSQL_USER &&
    CONFIG.MYSQL_PASSWORD
  );
}

function nowMysql() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

async function getDbPool() {
  if (!isDbConfigured()) return null;
  if (!dbPool) {
    dbPool = mysql.createPool({
      host: CONFIG.MYSQL_HOST,
      port: Number(CONFIG.MYSQL_PORT || 3306),
      user: CONFIG.MYSQL_USER,
      password: CONFIG.MYSQL_PASSWORD,
      database: CONFIG.MYSQL_DATABASE,
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
    });
  }
  return dbPool;
}

async function initPayhipDb() {
  const pool = await getDbPool();
  if (!pool) return false;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS purchases (
      transaction_id VARCHAR(64) PRIMARY KEY,
      email VARCHAR(255),
      product_key VARCHAR(64),
      items_in_cart TEXT,
      status VARCHAR(64),
      amount_gross VARCHAR(64),
      coupon_discount_amount VARCHAR(64),
      amount_net VARCHAR(64),
      currency VARCHAR(16),
      discord_id VARCHAR(32),
      created_at VARCHAR(32),
      redeemed_at VARCHAR(32),
      discord_user_id VARCHAR(32),
      webhook_sent TINYINT(1) DEFAULT 0
    )
  `);
  try {
    await pool.query(
      'CREATE INDEX idx_purchases_discord_id ON purchases (discord_id)'
    );
  } catch {
    // ignore if index already exists
  }
  return true;
}

async function initSupportDb() {
  const pool = await getDbPool();
  if (!pool) return false;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      discord_id VARCHAR(32) UNIQUE,
      discord_username VARCHAR(255),
      discord_avatar VARCHAR(255),
      email VARCHAR(255),
      notifications_enabled TINYINT(1) DEFAULT 0,
      created_at DATETIME,
      updated_at DATETIME
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_roles (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(64) UNIQUE,
      permissions TEXT,
      is_admin TINYINT(1) DEFAULT 0,
      created_at DATETIME
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_members (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT NULL,
      discord_id VARCHAR(32) UNIQUE,
      role_id INT,
      is_active TINYINT(1) DEFAULT 1,
      created_at DATETIME
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticket_panels (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(128),
      description TEXT,
      is_active TINYINT(1) DEFAULT 1,
      sort_order INT DEFAULT 0,
      created_at DATETIME,
      updated_at DATETIME
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticket_statuses (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(64),
      slug VARCHAR(64) UNIQUE,
      is_default_open TINYINT(1) DEFAULT 0,
      is_closed TINYINT(1) DEFAULT 0,
      sort_order INT DEFAULT 0,
      created_at DATETIME
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tickets (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      public_id VARCHAR(16) UNIQUE,
      panel_id INT,
      status_id INT,
      creator_user_id BIGINT,
      creator_discord_id VARCHAR(32),
      creator_email VARCHAR(255),
      subject VARCHAR(255),
      source VARCHAR(16),
      assigned_staff_id BIGINT NULL,
      created_at DATETIME,
      updated_at DATETIME,
      closed_at DATETIME NULL,
      last_message_at DATETIME
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticket_messages (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      ticket_id BIGINT,
      author_type VARCHAR(16),
      author_user_id BIGINT NULL,
      author_discord_id VARCHAR(32) NULL,
      body TEXT,
      source VARCHAR(16),
      created_at DATETIME,
      parent_message_id BIGINT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticket_attachments (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      ticket_message_id BIGINT,
      filename VARCHAR(255),
      storage_path VARCHAR(255),
      storage_url TEXT,
      mime_type VARCHAR(128),
      size_bytes BIGINT,
      created_at DATETIME
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticket_claims (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      ticket_id BIGINT,
      staff_id BIGINT,
      action VARCHAR(16),
      created_at DATETIME
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      actor_user_id BIGINT NULL,
      actor_discord_id VARCHAR(32) NULL,
      actor_type VARCHAR(16),
      action VARCHAR(64),
      entity_type VARCHAR(32),
      entity_id VARCHAR(64),
      metadata TEXT,
      created_at DATETIME
    )
  `);

  const indexStatements = [
    'CREATE INDEX idx_staff_members_role_id ON staff_members (role_id)',
    'CREATE INDEX idx_ticket_panels_active ON ticket_panels (is_active)',
    'CREATE INDEX idx_ticket_statuses_default ON ticket_statuses (is_default_open)',
    'CREATE INDEX idx_tickets_status_id ON tickets (status_id)',
    'CREATE INDEX idx_tickets_panel_id ON tickets (panel_id)',
    'CREATE INDEX idx_tickets_creator_user_id ON tickets (creator_user_id)',
    'CREATE INDEX idx_tickets_assigned_staff_id ON tickets (assigned_staff_id)',
    'CREATE INDEX idx_tickets_last_message_at ON tickets (last_message_at)',
    'CREATE INDEX idx_tickets_created_at ON tickets (created_at)',
    'CREATE INDEX idx_ticket_messages_ticket_id ON ticket_messages (ticket_id)',
    'CREATE INDEX idx_ticket_messages_created_at ON ticket_messages (created_at)',
    'CREATE INDEX idx_ticket_claims_ticket_id ON ticket_claims (ticket_id)',
    'CREATE INDEX idx_audit_logs_created_at ON audit_logs (created_at)',
  ];

  for (const stmt of indexStatements) {
    try {
      await pool.query(stmt);
    } catch {
      // ignore if index already exists
    }
  }

  await ensureSupportDefaults(pool);
  return true;
}

async function ensureSupportDefaults(pool) {
  const now = nowMysql();
  const [roles] = await pool.query('SELECT id, name FROM staff_roles');
  const roleByName = new Map(roles.map((role) => [role.name, role]));

  if (!roleByName.has('Admin')) {
    await pool.query(
      'INSERT INTO staff_roles (name, permissions, is_admin, created_at) VALUES (?, ?, ?, ?)',
      ['Admin', JSON.stringify(['*']), 1, now]
    );
  }
  if (!roleByName.has('Agent')) {
    await pool.query(
      'INSERT INTO staff_roles (name, permissions, is_admin, created_at) VALUES (?, ?, ?, ?)',
      [
        'Agent',
        JSON.stringify([
          'tickets.view',
          'tickets.reply',
          'tickets.claim',
          'tickets.assign',
          'tickets.status',
        ]),
        0,
        now,
      ]
    );
  }

  const [rolesAfter] = await pool.query(
    'SELECT id, name FROM staff_roles'
  );
  const adminRole = rolesAfter.find((role) => role.name === 'Admin');

  const [statuses] = await pool.query(
    'SELECT id, slug, is_default_open FROM ticket_statuses'
  );
  const statusBySlug = new Map(statuses.map((status) => [status.slug, status]));

  if (!statusBySlug.has('open')) {
    await pool.query(
      'INSERT INTO ticket_statuses (name, slug, is_default_open, is_closed, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['Open', 'open', 1, 0, 1, now]
    );
  }
  if (!statusBySlug.has('pending')) {
    await pool.query(
      'INSERT INTO ticket_statuses (name, slug, is_default_open, is_closed, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['Pending', 'pending', 0, 0, 2, now]
    );
  }
  if (!statusBySlug.has('closed')) {
    await pool.query(
      'INSERT INTO ticket_statuses (name, slug, is_default_open, is_closed, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['Closed', 'closed', 0, 1, 3, now]
    );
  }

  if (CONFIG.ADMIN_DISCORD_IDS.length && adminRole) {
    for (const discordId of CONFIG.ADMIN_DISCORD_IDS) {
      await pool.query(
        'INSERT IGNORE INTO users (discord_id, created_at, updated_at) VALUES (?, ?, ?)',
        [discordId, now, now]
      );
      await pool.query(
        'INSERT IGNORE INTO staff_members (discord_id, role_id, is_active, created_at) VALUES (?, ?, ?, ?)',
        [discordId, adminRole.id, 1, now]
      );
    }
  }
}

module.exports = {
  getDbPool,
  initPayhipDb,
  initSupportDb,
  isDbConfigured,
  nowMysql,
};

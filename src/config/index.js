const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

function loadEnv() {
  const candidates = [];
  if (process.env.DOTENV_PATH) {
    candidates.push(process.env.DOTENV_PATH);
  }
  candidates.push(path.join(process.cwd(), '.env'));
  candidates.push(path.join(process.cwd(), 'env'));
  // Support running from repo root as well as from within discord-bot/.
  candidates.push(path.join(process.cwd(), 'discord-bot', '.env'));
  candidates.push(path.join(process.cwd(), 'discord-bot', 'env'));
  // Legacy folder name fallback.
  candidates.push(path.join(process.cwd(), 'DISCORD BOT', '.env'));
  candidates.push(path.join(process.cwd(), 'DISCORD BOT', 'env'));

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      dotenv.config({ path: candidate });
      return candidate;
    }
  }

  dotenv.config();
  return null;
}

loadEnv();

const CONFIG = {
  PORT: process.env.PORT || 3000,
  BASE_URL: process.env.BASE_URL || 'http://localhost:3000',
  SESSION_SECRET: process.env.SESSION_SECRET || '',
  ADMIN_DISCORD_IDS: (process.env.ADMIN_DISCORD_IDS || '')
    .split(',')
    .map((val) => val.trim())
    .filter(Boolean),
  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL || '',
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN || '',
  DISCORD_APP_ID: process.env.DISCORD_APP_ID || '',
  DISCORD_CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET || '',
  DISCORD_OAUTH_CLIENT_ID:
    process.env.DISCORD_OAUTH_CLIENT_ID || process.env.DISCORD_APP_ID || '',
  DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID || '',
  DISCORD_ROLE_ID: process.env.DISCORD_ROLE_ID || '',
  DISCORD_COMMAND_GUILD_ID: process.env.DISCORD_COMMAND_GUILD_ID || '',
  DISCORD_SUPPORT_NOTIFY_CHANNEL_ID:
    process.env.DISCORD_SUPPORT_NOTIFY_CHANNEL_ID || '',
  // Optional per-event notify channels. If unset, fall back to DISCORD_SUPPORT_NOTIFY_CHANNEL_ID.
  DISCORD_TICKET_OPEN_CHANNEL_ID: process.env.DISCORD_TICKET_OPEN_CHANNEL_ID || '',
  DISCORD_TICKET_ESCALATE_CHANNEL_ID:
    process.env.DISCORD_TICKET_ESCALATE_CHANNEL_ID || '',
  BOT_API_TOKEN: process.env.BOT_API_TOKEN || '',
  SUPPORT_API_BASE: process.env.SUPPORT_API_BASE || '',
  BOT_SYNC_INTERVAL_MS: Number(process.env.BOT_SYNC_INTERVAL_MS || 10000),
  PAYHIP_DISCORD_FIELD_LABEL: process.env.PAYHIP_DISCORD_FIELD_LABEL || '',
  MYSQL_HOST: process.env.MYSQL_HOST || '',
  MYSQL_PORT: process.env.MYSQL_PORT || '3306',
  MYSQL_DATABASE: process.env.MYSQL_DATABASE || '',
  MYSQL_USER: process.env.MYSQL_USER || '',
  MYSQL_PASSWORD: process.env.MYSQL_PASSWORD || '',
  MYSQL_WRITE_JSON: process.env.MYSQL_WRITE_JSON || '0',
  UPLOAD_DIR:
    process.env.UPLOAD_DIR || path.join(process.cwd(), 'data', 'uploads'),
};

module.exports = { CONFIG };

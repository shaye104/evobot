const crypto = require('crypto');
const { CONFIG } = require('../config');
const {
  getDbPool,
  initPayhipDb: initMysqlPayhipDb,
  isDbConfigured: isMysqlConfigured,
} = require('../db');
const { loadStoreCached, saveStoreCached, STORE_CACHE } = require('../store');

function nowIso() {
  return new Date().toISOString();
}

function truncate(value, max = 256) {
  const str = String(value ?? '');
  return str.length > max ? `${str.slice(0, max - 3)}...` : str;
}

function wrapCode(value) {
  return `\`${String(value ?? '').replace(/`/g, '')}\``;
}

function wrapSpoiler(value) {
  const clean = String(value ?? '').replace(/\|/g, '');
  return `||${clean}||`;
}

async function getDiscordUserAvatarUrl(discordId) {
  if (!discordId || !CONFIG.DISCORD_BOT_TOKEN) return '';
  try {
    const res = await fetch(`https://discord.com/api/v10/users/${discordId}`, {
      headers: { Authorization: `Bot ${CONFIG.DISCORD_BOT_TOKEN}` },
    });
    if (!res.ok) return '';
    const user = await res.json();
    if (user?.avatar) {
      return `https://cdn.discordapp.com/avatars/${discordId}/${user.avatar}.png`;
    }
  } catch {
    return '';
  }
  return '';
}

async function attachDiscordThumbnail(embed, discordId) {
  const url = await getDiscordUserAvatarUrl(discordId);
  if (url) {
    embed.thumbnail = { url };
  }
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function safeEqualHex(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function extractProductKeys(body) {
  const items = Array.isArray(body.items) ? body.items : [];
  return items
    .map((item) => String(item.product_key || '').trim())
    .filter(Boolean);
}

function extractProductNames(body) {
  const items = Array.isArray(body.items) ? body.items : [];
  return items
    .map((item) => String(item.product_name || '').trim())
    .filter(Boolean);
}

function toMoneyString(value, currency) {
  if (value === null || value === undefined || value === '') return '--';
  const raw = String(value).trim();
  const num = Number(raw);
  if (!Number.isFinite(num)) {
    return currency ? `${raw} ${currency}` : raw;
  }

  const hasDecimal = /[.,]/.test(raw);
  const normalized = hasDecimal ? num : num / 100;
  const formatted = normalized.toFixed(2);
  return currency ? `${formatted} ${currency}` : formatted;
}

function mapRowToPurchase(row) {
  if (!row) return null;
  return {
    transaction_id: row.transaction_id || '',
    email: row.email || '',
    product_key: row.product_key || '',
    items_in_cart: row.items_in_cart || '',
    status: row.status || '',
    amount_gross: row.amount_gross || '',
    coupon_discount_amount: row.coupon_discount_amount || '',
    amount_net: row.amount_net || '',
    currency: row.currency || '',
    discord_id: row.discord_id || '',
    created_at: row.created_at || '',
    redeemed_at: row.redeemed_at || null,
    discord_user_id: row.discord_user_id || '',
    webhook_sent: Boolean(row.webhook_sent),
  };
}

function cleanDbValue(value) {
  if (value === undefined || value === null) return null;
  const str = String(value);
  return str.length === 0 ? null : str;
}

function getApiBase() {
  const base = CONFIG.SUPPORT_API_BASE || CONFIG.BASE_URL || '';
  return base.replace(/\/$/, '');
}

function isApiConfigured() {
  return Boolean(getApiBase() && CONFIG.BOT_API_TOKEN);
}

async function apiRequest(path, { method = 'GET', body } = {}) {
  const base = getApiBase();
  if (!base) throw new Error('Support API base URL is not configured.');
  if (!CONFIG.BOT_API_TOKEN) throw new Error('BOT_API_TOKEN is not configured.');

  const headers = { Authorization: `Bearer ${CONFIG.BOT_API_TOKEN}` };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text };
    }
  }

  if (!res.ok) {
    const message = payload?.error || res.statusText || 'Request failed';
    throw new Error(`Payhip API ${res.status}: ${message}`);
  }
  return payload || {};
}

async function dbGetPurchaseById(transactionId) {
  if (isApiConfigured()) {
    const data = await apiRequest(
      `/api/bot/purchases/${encodeURIComponent(transactionId)}`
    );
    return data.purchase || null;
  }

  const pool = await getDbPool();
  if (!pool) return null;
  const [rows] = await pool.query(
    'SELECT * FROM purchases WHERE transaction_id = ? LIMIT 1',
    [transactionId]
  );
  return mapRowToPurchase(rows?.[0]);
}

async function dbGetPurchasesByDiscordId(discordId) {
  if (isApiConfigured()) {
    const data = await apiRequest(
      `/api/bot/purchases?discord_id=${encodeURIComponent(discordId)}`
    );
    return data.purchases || [];
  }

  const pool = await getDbPool();
  if (!pool) return [];
  const [rows] = await pool.query(
    'SELECT * FROM purchases WHERE discord_id = ?',
    [discordId]
  );
  return rows.map(mapRowToPurchase).filter(Boolean);
}

async function dbUpsertPurchase(purchase) {
  if (isApiConfigured()) {
    await apiRequest('/api/bot/purchases', {
      method: 'POST',
      body: {
        transaction_id: cleanDbValue(purchase.transaction_id),
        email: cleanDbValue(purchase.email),
        product_key: cleanDbValue(purchase.product_key),
        items_in_cart: cleanDbValue(purchase.items_in_cart),
        status: cleanDbValue(purchase.status),
        amount_gross: cleanDbValue(purchase.amount_gross),
        coupon_discount_amount: cleanDbValue(purchase.coupon_discount_amount),
        amount_net: cleanDbValue(purchase.amount_net),
        currency: cleanDbValue(purchase.currency),
        discord_id: cleanDbValue(purchase.discord_id),
        created_at: cleanDbValue(purchase.created_at),
        redeemed_at: cleanDbValue(purchase.redeemed_at),
        discord_user_id: cleanDbValue(purchase.discord_user_id),
        webhook_sent: purchase.webhook_sent ? 1 : 0,
      },
    });
    return;
  }

  const pool = await getDbPool();
  if (!pool) return;
  await pool.query(
    `
    INSERT INTO purchases (
      transaction_id, email, product_key, items_in_cart, status,
      amount_gross, coupon_discount_amount, amount_net, currency,
      discord_id, created_at, redeemed_at, discord_user_id, webhook_sent
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      email = VALUES(email),
      product_key = VALUES(product_key),
      items_in_cart = VALUES(items_in_cart),
      status = VALUES(status),
      amount_gross = VALUES(amount_gross),
      coupon_discount_amount = VALUES(coupon_discount_amount),
      amount_net = VALUES(amount_net),
      currency = VALUES(currency),
      discord_id = VALUES(discord_id),
      created_at = VALUES(created_at),
      redeemed_at = VALUES(redeemed_at),
      discord_user_id = VALUES(discord_user_id),
      webhook_sent = VALUES(webhook_sent)
  `,
    [
      cleanDbValue(purchase.transaction_id),
      cleanDbValue(purchase.email),
      cleanDbValue(purchase.product_key),
      cleanDbValue(purchase.items_in_cart),
      cleanDbValue(purchase.status),
      cleanDbValue(purchase.amount_gross),
      cleanDbValue(purchase.coupon_discount_amount),
      cleanDbValue(purchase.amount_net),
      cleanDbValue(purchase.currency),
      cleanDbValue(purchase.discord_id),
      cleanDbValue(purchase.created_at),
      cleanDbValue(purchase.redeemed_at),
      cleanDbValue(purchase.discord_user_id),
      purchase.webhook_sent ? 1 : 0,
    ]
  );
}

async function dbSeedFromJson(store) {
  if (isApiConfigured()) return;
  const pool = await getDbPool();
  if (!pool) return;
  const [rows] = await pool.query('SELECT COUNT(*) AS count FROM purchases');
  const count = rows?.[0]?.count || 0;
  if (count > 0) return;
  const purchases = Object.values(store.purchases || {});
  for (const purchase of purchases) {
    await dbUpsertPurchase(purchase);
  }
}

function normalizeDiscordId(value) {
  const str = String(value || '').trim();
  const match = str.match(/\d{17,20}/);
  return match ? match[0] : '';
}

function extractDiscordIdFromPayload(body) {
  const label = CONFIG.PAYHIP_DISCORD_FIELD_LABEL;
  const candidates = [];

  const pushCandidate = (val) => {
    const id = normalizeDiscordId(val);
    if (id) candidates.push(id);
  };

  const fields =
    body.custom_fields ||
    body.custom_field_values ||
    body.custom_answers ||
    body.answers ||
    body.questions ||
    body.custom_fields_answers ||
    body.checkout_questions ||
    null;

  if (Array.isArray(fields)) {
    for (const entry of fields) {
      const key =
        entry.label ||
        entry.name ||
        entry.question ||
        entry.field ||
        '';
      const value =
        entry.value ||
        entry.answer ||
        entry.response ||
        entry.result ||
        '';
      if (label && key && key.toLowerCase().includes(label.toLowerCase())) {
        pushCandidate(value);
      }
      if (!label) {
        pushCandidate(value);
      }
    }
  } else if (fields && typeof fields === 'object') {
    for (const [key, value] of Object.entries(fields)) {
      if (label && key.toLowerCase().includes(label.toLowerCase())) {
        pushCandidate(value);
      }
      if (!label) {
        pushCandidate(value);
      }
    }
  }

  return candidates[0] || '';
}

function isAllowedProduct(body) {
  if (CONFIG.PAYHIP_ALLOWED_PRODUCTS.length === 0) return true;
  const keys = extractProductKeys(body);
  if (keys.length === 0) return false;
  return keys.some((key) => CONFIG.PAYHIP_ALLOWED_PRODUCTS.includes(key));
}

async function sendPaidWebhookEmbed(body) {
  if (!CONFIG.DISCORD_WEBHOOK_URL) return;

  const createdAt =
    typeof body.date === 'number'
      ? new Date(body.date * 1000).toISOString()
      : nowIso();
  const productNames = extractProductNames(body);
  const discordId = extractDiscordIdFromPayload(body);
  const currency = body.currency || '';
  const status = body.status || body.type || 'paid';
  const grossAmount =
    body.amount_gross ??
    body.gross_amount ??
    body.gross ??
    body.price ??
    '';
  const netAmount = body.amount_net ?? body.net_amount ?? body.net ?? '';
  const couponDiscount =
    body.coupon_discount_amount ??
    body.discount_amount ??
    body.coupon_discount ??
    '';

  const embed = {
    title: 'New Purchase',
    color: 0x2ecc71,
    timestamp: createdAt,
    fields: [
      {
        name: 'Purchased Products',
        value: wrapCode(truncate(productNames.join(', ') || '--')),
        inline: true,
      },
      {
        name: 'Order ID',
        value: wrapCode(truncate(body.id || '--')),
        inline: true,
      },
      {
        name: 'Order Status',
        value: wrapCode(truncate(status || '--')),
        inline: true,
      },
      {
        name: 'Gross Amount',
        value: wrapCode(truncate(toMoneyString(grossAmount, currency))),
        inline: true,
      },
      {
        name: 'Coupon Discount',
        value: wrapCode(truncate(toMoneyString(couponDiscount, currency))),
        inline: true,
      },
      {
        name: 'Net Amount',
        value: wrapCode(truncate(toMoneyString(netAmount, currency))),
        inline: true,
      },
      {
        name: 'Discord ID',
        value: wrapCode(truncate(discordId || '--')),
        inline: true,
      },
      {
        name: 'Email Address',
        value: wrapSpoiler(
          wrapCode(truncate(String(body.email || '').toLowerCase() || '--'))
        ),
        inline: true,
      },
    ],
    footer: { text: 'Purchased On' },
  };
  await attachDiscordThumbnail(embed, discordId);

  const payload = {
    embeds: [embed],
  };

  try {
    const res = await fetch(CONFIG.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`[payhip] webhook log failed: ${res.status} ${text}`);
    }
  } catch (err) {
    console.error(`[payhip] webhook log error: ${err.message}`);
  }
}

async function sendReprintWebhookEmbed(order) {
  if (!CONFIG.DISCORD_WEBHOOK_URL) return;
  const currency = order.currency || '';
  const createdAt = order.created_at || nowIso();
  const embed = {
    title: 'New Purchase',
    color: 0x2ecc71,
    timestamp: createdAt,
    fields: [
      {
        name: 'Purchased Products',
        value: wrapCode(truncate(order.items_in_cart || '--')),
        inline: true,
      },
      {
        name: 'Order ID',
        value: wrapCode(truncate(order.transaction_id || '--')),
        inline: true,
      },
      {
        name: 'Order Status',
        value: wrapCode(truncate(order.status || '--')),
        inline: true,
      },
      {
        name: 'Gross Amount',
        value: wrapCode(truncate(toMoneyString(order.amount_gross, currency))),
        inline: true,
      },
      {
        name: 'Coupon Discount',
        value: wrapCode(
          truncate(toMoneyString(order.coupon_discount_amount, currency))
        ),
        inline: true,
      },
      {
        name: 'Net Amount',
        value: wrapCode(truncate(toMoneyString(order.amount_net, currency))),
        inline: true,
      },
      {
        name: 'Discord ID',
        value: wrapCode(truncate(order.discord_id || '--')),
        inline: true,
      },
      {
        name: 'Email Address',
        value: wrapSpoiler(
          wrapCode(truncate(String(order.email || '').toLowerCase() || '--'))
        ),
        inline: true,
      },
    ],
    footer: { text: 'Purchased On' },
  };
  await attachDiscordThumbnail(embed, order.discord_id);

  const payload = {
    embeds: [embed],
  };

  try {
    const res = await fetch(CONFIG.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`[payhip] webhook log failed: ${res.status} ${text}`);
    }
  } catch (err) {
    console.error(`[payhip] webhook log error: ${err.message}`);
  }
}

function buildOrderEmbedFromOrder(order) {
  const currency = order.currency || '';
  const createdAt = order.created_at || nowIso();
  const embed = {
    title: 'Order Lookup',
    color: 0x2ecc71,
    timestamp: createdAt,
    fields: [
      {
        name: 'Purchased Products',
        value: wrapCode(truncate(order.items_in_cart || '--')),
        inline: true,
      },
      {
        name: 'Order ID',
        value: wrapCode(truncate(order.transaction_id || '--')),
        inline: true,
      },
      {
        name: 'Order Status',
        value: wrapCode(truncate(order.status || '--')),
        inline: true,
      },
      {
        name: 'Gross Amount',
        value: wrapCode(truncate(toMoneyString(order.amount_gross, currency))),
        inline: true,
      },
      {
        name: 'Coupon Discount',
        value: wrapCode(
          truncate(toMoneyString(order.coupon_discount_amount, currency))
        ),
        inline: true,
      },
      {
        name: 'Net Amount',
        value: wrapCode(truncate(toMoneyString(order.amount_net, currency))),
        inline: true,
      },
      {
        name: 'Discord ID',
        value: wrapCode(truncate(order.discord_id || '--')),
        inline: true,
      },
      {
        name: 'Email Address',
        value: wrapSpoiler(
          wrapCode(truncate(String(order.email || '').toLowerCase() || '--'))
        ),
        inline: true,
      },
    ],
    footer: { text: 'Purchased On' },
  };

  return embed;
}

function shouldWriteJson() {
  return CONFIG.MYSQL_WRITE_JSON !== '0';
}

function isDbConfigured() {
  return isApiConfigured() || isMysqlConfigured();
}

async function initPayhipDb() {
  if (isApiConfigured()) return true;
  return initMysqlPayhipDb();
}

module.exports = {
  initPayhipDb,
  isDbConfigured,
  loadStoreCached,
  saveStoreCached,
  STORE_CACHE,
  sha256Hex,
  safeEqualHex,
  extractProductKeys,
  extractProductNames,
  extractDiscordIdFromPayload,
  isAllowedProduct,
  sendPaidWebhookEmbed,
  sendReprintWebhookEmbed,
  buildOrderEmbedFromOrder,
  attachDiscordThumbnail,
  dbGetPurchaseById,
  dbGetPurchasesByDiscordId,
  dbUpsertPurchase,
  dbSeedFromJson,
  shouldWriteJson,
};

const { CONFIG } = require('../config');

function getApiBase() {
  const base = CONFIG.SUPPORT_API_BASE || CONFIG.BASE_URL || '';
  return base.replace(/\/$/, '');
}

function isBotAuthReady() {
  return Boolean(getApiBase() && CONFIG.BOT_API_TOKEN);
}

async function fetchJson(path, { method = 'GET', body, auth = false } = {}) {
  const base = getApiBase();
  if (!base) {
    throw new Error('Support API base URL is not configured.');
  }

  const headers = {};
  if (auth) {
    if (!CONFIG.BOT_API_TOKEN) {
      throw new Error('BOT_API_TOKEN is not configured.');
    }
    headers.Authorization = `Bearer ${CONFIG.BOT_API_TOKEN}`;
  }
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
    const err = new Error(`Support API ${res.status}: ${message}`);
    err.status = res.status;
    err.path = path;
    throw err;
  }

  return payload || {};
}

async function listPanels() {
  const data = await fetchJson('/api/panels');
  return data.panels || [];
}

async function createDiscordTicket({ discordId, panelId, message, subject, email }) {
  return fetchJson('/api/bot/tickets', {
    method: 'POST',
    auth: true,
    body: {
      discord_id: discordId,
      panel_id: panelId,
      message,
      subject,
      email,
    },
  });
}

async function listActiveDiscordTickets(discordId) {
  const data = await fetchJson(
    `/api/bot/tickets/active?discord_id=${encodeURIComponent(discordId)}`,
    { auth: true }
  );
  return data.tickets || [];
}

async function sendDiscordTicketMessage(publicId, { discordId, message, attachments }) {
  return fetchJson(`/api/bot/tickets/${encodeURIComponent(publicId)}/messages`, {
    method: 'POST',
    auth: true,
    body: {
      discord_id: discordId,
      message,
      attachments,
    },
  });
}

async function listStaffReplies(sinceId) {
  try {
    const data = await fetchJson(
      `/api/bot/messages?since_id=${Number(sinceId || 0)}`,
      { auth: true }
    );
    return {
      messages: data.messages || [],
      attachments: data.attachments || [],
    };
  } catch (err) {
    // Older Support API deployments may not include bot-sync endpoints yet.
    if (err?.status === 404) {
      return { messages: [], attachments: [] };
    }
    throw err;
  }
}

async function listClaimedUserMessages(sinceId) {
  try {
    const data = await fetchJson(
      `/api/bot/claimed-messages?since_id=${Number(sinceId || 0)}`,
      { auth: true }
    );
    return {
      messages: data.messages || [],
      attachments: data.attachments || [],
    };
  } catch (err) {
    if (err?.status === 404) {
      return { messages: [], attachments: [] };
    }
    throw err;
  }
}

async function requestResponsePings() {
  try {
    const data = await fetchJson('/api/bot/request-response', { auth: true });
    return data.requests || [];
  } catch (err) {
    if (err?.status === 404) return [];
    throw err;
  }
}

async function ackResponsePing(id) {
  try {
    return await fetchJson(
      `/api/bot/request-response/${encodeURIComponent(String(id))}`,
      {
        method: 'POST',
        auth: true,
        body: {},
      }
    );
  } catch (err) {
    if (err?.status === 404) return { ok: true };
    throw err;
  }
}

async function listWebhookEvents(sinceId) {
  const data = await fetchJson(
    `/api/bot/events?since_id=${Number(sinceId || 0)}`,
    { auth: true }
  );
  return data.events || [];
}

async function listPurchaseEvents(sinceId, limit = 200) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 200));
  const data = await fetchJson(
    `/api/bot/purchase-feed?since_id=${Number(sinceId || 0)}&limit=${safeLimit}`,
    { auth: true }
  );
  return data.events || [];
}

async function listRecentPurchases({ since, limit = 200 } = {}) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 200));
  const params = new URLSearchParams();
  params.set('limit', String(safeLimit));
  if (since) params.set('since', String(since));
  const data = await fetchJson(`/api/bot/purchases/recent?${params.toString()}`, {
    auth: true,
  });
  return data.purchases || [];
}

module.exports = {
  isBotAuthReady,
  listPanels,
  createDiscordTicket,
  listActiveDiscordTickets,
  sendDiscordTicketMessage,
  listStaffReplies,
  listClaimedUserMessages,
  requestResponsePings,
  ackResponsePing,
  listWebhookEvents,
  listPurchaseEvents,
  listRecentPurchases,
};

const fs = require('fs');
const path = require('path');

// The `jsonsnotifications` file is a sequence of JSON objects separated by whitespace.
// It's not valid JSON as a whole, so we parse by scanning balanced braces.
function parseConcatenatedJsonObjects(text) {
  const out = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (ch === '}') {
      if (depth > 0) depth--;
      if (depth === 0 && start !== -1) {
        const block = text.slice(start, i + 1);
        out.push(block);
        start = -1;
      }
    }
  }

  return out;
}

function deepClone(obj) {
  return obj == null ? obj : JSON.parse(JSON.stringify(obj));
}

function formatFooterTimestamp(date = new Date()) {
  const d = new Date(date);
  // "07 Feb 2026 11:10 UTC"
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  return `${get('day')} ${get('month')} ${get('year')} ${get('hour')}:${get('minute')} UTC`;
}

function addTimestampToEmbedFooter(embed, date = new Date()) {
  const stamp = `Sent: ${formatFooterTimestamp(date)}`;
  if (!embed.footer) {
    embed.footer = { text: stamp };
    return;
  }
  const existing = String(embed.footer.text || '').trim();
  embed.footer.text = existing ? `${existing}\n${stamp}` : stamp;
}

function patchLinkButtons(components, url) {
  if (!Array.isArray(components)) return;
  for (const row of components) {
    if (!row || row.type !== 1) continue; // Action row
    const buttons = Array.isArray(row.components) ? row.components : [];
    for (const btn of buttons) {
      if (!btn || btn.type !== 2) continue;
      if (btn.style === 5) {
        btn.url = url;
        // Link buttons must NOT have custom_id.
        if ('custom_id' in btn) delete btn.custom_id;
      }
    }
  }
}

function replacePlaceholdersInString(str, replacements) {
  let out = str;
  for (const [needle, value] of Object.entries(replacements)) {
    out = out.split(needle).join(String(value ?? ''));
  }
  return out;
}

function replacePlaceholdersDeep(node, replacements) {
  if (node == null) return node;
  if (typeof node === 'string') return replacePlaceholdersInString(node, replacements);
  if (Array.isArray(node)) return node.map((v) => replacePlaceholdersDeep(v, replacements));
  if (typeof node === 'object') {
    for (const k of Object.keys(node)) {
      node[k] = replacePlaceholdersDeep(node[k], replacements);
    }
    return node;
  }
  return node;
}

function buildTemplateMapFromFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const blocks = parseConcatenatedJsonObjects(raw);
  const templates = [];

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    try {
      templates.push(JSON.parse(trimmed));
    } catch (err) {
      throw new Error(`Failed parsing template block: ${err.message}`);
    }
  }

  const map = new Map();
  for (const t of templates) {
    const title = t?.embeds?.[0]?.title ? String(t.embeds[0].title).trim() : '';
    if (!title) continue;
    map.set(title, t);
  }

  return map;
}

function loadNotificationTemplates() {
  const candidates = [];
  if (process.env.DISCORD_NOTIFICATION_TEMPLATES_PATH) {
    candidates.push(process.env.DISCORD_NOTIFICATION_TEMPLATES_PATH);
  }
  // Common case: bot runs with cwd = DISCORD BOT/.
  candidates.push(path.join(process.cwd(), 'jsonsnotifications'));

  // If running from repo root, this finds the templates.
  candidates.push(path.join(process.cwd(), 'DISCORD BOT', 'jsonsnotifications'));

  for (const filePath of candidates) {
    if (filePath && fs.existsSync(filePath)) {
      return { filePath, templates: buildTemplateMapFromFile(filePath) };
    }
  }
  return { filePath: candidates[0] || '', templates: new Map() };
}

function renderTemplate(template, { ticketUrl, replacements, now = new Date() }) {
  const payload = deepClone(template);
  replacePlaceholdersDeep(payload, replacements || {});

  if (Array.isArray(payload.embeds)) {
    for (const embed of payload.embeds) {
      if (embed && typeof embed === 'object') {
        addTimestampToEmbedFooter(embed, now);
      }
    }
  }
  if (ticketUrl) {
    patchLinkButtons(payload.components, ticketUrl);
  }
  return payload;
}

module.exports = {
  loadNotificationTemplates,
  renderTemplate,
};

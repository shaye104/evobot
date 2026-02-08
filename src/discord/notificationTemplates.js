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
  if (!existing) {
    embed.footer.text = stamp;
    return;
  }
  // Avoid accumulating "Sent:" lines if we re-render/edit an embed.
  const lines = existing.split('\n').map((l) => l.trimEnd());
  const kept = lines.filter((l) => !/^Sent:\s+/i.test(l.trim()));
  kept.push(stamp);
  embed.footer.text = kept.join('\n').trim();
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
  const rep = replacements || {};

  // Legacy support: only do exact-string replacement when the caller provided an explicit
  // backticked placeholder needle (e.g. "``ID``"). Never replace raw keys like "ID" since
  // that breaks normal text such as field names like "Ticket ID".
  for (const [needle, value] of Object.entries(rep)) {
    const n = String(needle);
    if (!n.includes('``')) continue;
    out = out.split(n).join(String(value ?? ''));
  }

  // 2) Template-friendly replacement for placeholders inside double-backticks, e.g. ``ID``.
  // This preserves the original formatting (the backticks) from the template.
  // We match whatever is inside ``...`` and swap the inside if we have a value.
  const normalized = new Map();
  for (const [k, v] of Object.entries(rep)) {
    normalized.set(String(k).trim().toLowerCase(), String(v ?? ''));
  }
  out = out.replace(/``([^`]+)``/g, (full, inner) => {
    const key = String(inner || '').trim().toLowerCase();
    if (!key) return full;
    if (!normalized.has(key)) return full;
    const value = normalized.get(key);
    return `\`\`${value}\`\``;
  });

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

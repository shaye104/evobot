const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.cwd(), 'data');
const STORE_PATH = path.join(DATA_DIR, 'store.json');
const STORE_CACHE = {
  data: null,
  loadedAt: 0,
  ttlMs: 5000,
  indexes: {
    byId: new Map(),
    byDiscord: new Map(),
  },
};

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(STORE_PATH)) {
    fs.writeFileSync(
      STORE_PATH,
      JSON.stringify({ purchases: {} }, null, 2),
      'utf8'
    );
  }
}

function loadStore() {
  ensureStore();
  const raw = fs.readFileSync(STORE_PATH, 'utf8');
  return JSON.parse(raw);
}

function saveStore(store) {
  const tmp = STORE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmp, STORE_PATH);
}

function rebuildStoreIndexes(store) {
  const byId = new Map();
  const byDiscord = new Map();
  const purchases = Object.values(store.purchases || {});
  for (const purchase of purchases) {
    const id = String(purchase.transaction_id || '').trim();
    if (id) byId.set(id, purchase);
    const discordId = String(purchase.discord_id || '').trim();
    if (discordId) {
      if (!byDiscord.has(discordId)) byDiscord.set(discordId, []);
      byDiscord.get(discordId).push(purchase);
    }
  }
  STORE_CACHE.indexes.byId = byId;
  STORE_CACHE.indexes.byDiscord = byDiscord;
}

function loadStoreCached() {
  const now = Date.now();
  if (STORE_CACHE.data && now - STORE_CACHE.loadedAt < STORE_CACHE.ttlMs) {
    return STORE_CACHE.data;
  }
  const store = loadStore();
  STORE_CACHE.data = store;
  STORE_CACHE.loadedAt = now;
  rebuildStoreIndexes(store);
  return store;
}

function saveStoreCached(store) {
  saveStore(store);
  STORE_CACHE.data = store;
  STORE_CACHE.loadedAt = Date.now();
  rebuildStoreIndexes(store);
}

module.exports = {
  STORE_CACHE,
  loadStore,
  saveStore,
  loadStoreCached,
  saveStoreCached,
};

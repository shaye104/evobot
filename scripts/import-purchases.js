const fs = require('fs');
const path = require('path');

async function readJson(filePath) {
  const raw = await fs.promises.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

function getApiBase() {
  const base = process.env.SUPPORT_API_BASE || process.env.BASE_URL || '';
  return base.replace(/\/$/, '');
}

async function upsertPurchase(apiBase, token, purchase) {
  const res = await fetch(`${apiBase}/api/bot/purchases`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      transaction_id: purchase.transaction_id,
      email: purchase.email,
      product_key: purchase.product_key,
      items_in_cart: purchase.items_in_cart,
      status: purchase.status,
      amount_gross: purchase.amount_gross,
      coupon_discount_amount: purchase.coupon_discount_amount,
      amount_net: purchase.amount_net,
      currency: purchase.currency,
      discord_id: purchase.discord_id,
      created_at: purchase.created_at,
      redeemed_at: purchase.redeemed_at,
      discord_user_id: purchase.discord_user_id,
      webhook_sent: purchase.webhook_sent,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${text}`);
  }
}

async function main() {
  const apiBase = getApiBase();
  const token = process.env.BOT_API_TOKEN;
  if (!apiBase || !token) {
    console.error('Missing SUPPORT_API_BASE/BASE_URL or BOT_API_TOKEN.');
    process.exit(1);
  }

  const inputPath =
    process.argv[2] ||
    // Default: run inside the bot repo root.
    path.join(process.cwd(), 'data', 'store.json');

  const payload = await readJson(inputPath);
  const purchases = Object.values(payload.purchases || {});
  let success = 0;

  for (const purchase of purchases) {
    try {
      await upsertPurchase(apiBase, token, purchase);
      success += 1;
      if (success % 25 === 0) {
        console.log(`Imported ${success}/${purchases.length} purchases...`);
      }
    } catch (err) {
      console.error(
        `Import failed for ${purchase.transaction_id}: ${err.message}`
      );
    }
  }

  console.log(`Done. Imported ${success}/${purchases.length} purchases.`);
}

main().catch((err) => {
  console.error(`Import failed: ${err.message}`);
  process.exit(1);
});

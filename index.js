const { startDiscordBot } = require('./src/bot/runtime');

async function main() {
  await startDiscordBot();
  console.log('[bot] Discord bot running.');
}

main().catch((err) => {
  console.error(`Server failed to start: ${err.message}`);
});

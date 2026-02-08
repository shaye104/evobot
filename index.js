const { startDiscordBot } = require('./src/discord/bot');

async function main() {
  await startDiscordBot();
  console.log('[bot] Discord bot running.');
}

main().catch((err) => {
  console.error(`Server failed to start: ${err.message}`);
});

const { startDiscordBot } = require('./src/discord/bot');
const { spawn } = require('child_process');

async function main() {
  // Run npm audit on every boot, but never block startup or crash the bot.
  // This is intentionally noisy (npm prints its own guidance) so you can see issues in logs.
  try {
    const child = spawn('npm', ['audit'], {
      cwd: process.cwd(),
      stdio: 'inherit',
      shell: false,
    });
    child.on('error', () => null);
  } catch {
    // Ignore audit failures; bot should still start.
  }

  await startDiscordBot();
  console.log('[bot] Discord bot running.');
}

main().catch((err) => {
  console.error(`Server failed to start: ${err.message}`);
});

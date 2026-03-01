import { createApp } from './app.js';
import { migrate } from './db/migrate.js';

const port = Number(process.env.AGENT_PORT || 4020);
const bind = process.env.AGENT_BIND || '127.0.0.1';

async function main() {
  await migrate();
  const app = createApp();
  app.listen(port, bind, () => {
    console.log(`genesia-agent-service listening on http://${bind}:${port}`);
  });
}

main().catch((err) => {
  console.error('Startup failed:', err?.message || err);
  process.exit(1);
});

import 'dotenv/config';
import { ConfigManager } from '../src/services/ConfigManager';

function mask(value?: string): string {
  if (!value) return '';
  if (value.length <= 6) return '*'.repeat(value.length);
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

async function main() {
  const cm = ConfigManager.getInstance();
  const cfg = cm.getConfig();

  const safe: any = {
    ...cfg,
    exchanges: cfg.exchanges.map(ex => ({
      name: ex.name,
      sandbox: false,
      rateLimit: ex.rateLimit,
      apiKey: mask(process.env[`${ex.name.toUpperCase()}_API_KEY`] || ''),
      secret: mask(process.env[`${ex.name.toUpperCase()}_SECRET`] || ''),
    }))
  };

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(safe, null, 2));
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});


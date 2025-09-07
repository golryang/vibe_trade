import 'dotenv/config';
import { ConfigManager } from '../src/services/ConfigManager';
import { ExchangeFactory } from '../src/exchanges/ExchangeFactory';

async function main() {
  const cm = ConfigManager.getInstance();
  const cfg = cm.getConfig();

  const binance = cfg.exchanges.find(ex => ex.name.toLowerCase().includes('binance'));
  if (!binance) {
    throw new Error('No binance exchange configured in config.json');
  }

  const exchange = await ExchangeFactory.createExchange(binance);
  // Query balance directly without establishing listen key/user stream
  const balance = await exchange.getBalance();

  // eslint-disable-next-line no-console
  console.log('Balance:', balance);
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error('Balance test failed:', err?.response?.data || err?.message || err);
  process.exit(1);
});


import { BaseExchange } from './BaseExchange';
import { BinanceFuturesExchange } from './BinanceFuturesExchange';
import { ExchangeConfig } from '../types';
import { Logger } from '../core/Logger';

export class ExchangeFactory {
  private static logger = Logger.getInstance();
  private static exchanges: Map<string, BaseExchange> = new Map();

  static async createExchange(config: ExchangeConfig): Promise<BaseExchange> {
    const exchangeKey = `${config.name}_main`;
    
    // Return existing instance if already created
    if (ExchangeFactory.exchanges.has(exchangeKey)) {
      return ExchangeFactory.exchanges.get(exchangeKey)!;
    }

    ExchangeFactory.logger.info(`Creating exchange: ${config.name}`, { 
      sandbox: config.sandbox 
    });

    let exchange: BaseExchange;

    switch (config.name.toLowerCase()) {
      case 'binance':
      case 'binance_futures':
        exchange = new BinanceFuturesExchange({
          ...config,
          testnet: false
        });
        break;

      // Add more exchanges here in the future
      case 'bybit':
        throw new Error('Bybit exchange not implemented yet');
      
      case 'okex':
        throw new Error('OKX exchange not implemented yet');

      default:
        throw new Error(`Unknown exchange: ${config.name}`);
    }

    // Store the instance
    ExchangeFactory.exchanges.set(exchangeKey, exchange);
    
    ExchangeFactory.logger.info(`Exchange ${config.name} created successfully`);
    return exchange;
  }

  static async createExchanges(configs: ExchangeConfig[]): Promise<BaseExchange[]> {
    const exchanges = await Promise.all(
      configs.map(config => ExchangeFactory.createExchange(config))
    );
    
    return exchanges;
  }

  static getExchange(name: string, sandbox?: boolean): BaseExchange | null {
    const exchangeKey = `${name}_${sandbox ? 'test' : 'main'}`;
    return ExchangeFactory.exchanges.get(exchangeKey) || null;
  }

  static getAllExchanges(): BaseExchange[] {
    return Array.from(ExchangeFactory.exchanges.values());
  }

  static async connectAll(): Promise<void> {
    const exchanges = Array.from(ExchangeFactory.exchanges.values());
    
    await Promise.allSettled(
      exchanges.map(async (exchange) => {
        try {
          if (!exchange.isConnected()) {
            await exchange.connect();
          }
        } catch (error) {
          ExchangeFactory.logger.error(`Failed to connect ${exchange.getName()}:`, error);
        }
      })
    );
  }

  static async disconnectAll(): Promise<void> {
    const exchanges = Array.from(ExchangeFactory.exchanges.values());
    
    await Promise.allSettled(
      exchanges.map(async (exchange) => {
        try {
          if (exchange.isConnected()) {
            await exchange.disconnect();
          }
        } catch (error) {
          ExchangeFactory.logger.error(`Failed to disconnect ${exchange.getName()}:`, error);
        }
      })
    );
  }

  static reset(): void {
    ExchangeFactory.exchanges.clear();
    ExchangeFactory.logger.info('Exchange factory reset');
  }

  static getSupportedExchanges(): string[] {
    return [
      'binance',
      'binance_futures',
      // 'bybit',
      // 'okex'
    ];
  }

  static validateExchangeConfig(config: ExchangeConfig): string[] {
    const errors: string[] = [];

    if (!config.name) {
      errors.push('Exchange name is required');
    }

    if (!ExchangeFactory.getSupportedExchanges().includes(config.name.toLowerCase())) {
      errors.push(`Unsupported exchange: ${config.name}`);
    }

    if (!config.apiKey || config.apiKey.trim() === '') {
      errors.push('API key is required');
    }

    if (!config.secret || config.secret.trim() === '') {
      errors.push('API secret is required');
    }

    if (typeof config.rateLimit !== 'number' || config.rateLimit <= 0) {
      errors.push('Rate limit must be a positive number');
    }

    // Exchange-specific validation
    if (config.name.toLowerCase().includes('binance')) {
      // Binance-specific validation could go here
    }

    return errors;
  }
}
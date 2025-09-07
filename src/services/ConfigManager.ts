import { readFileSync, writeFileSync, existsSync } from 'fs';
import { BotConfig, ExchangeConfig } from '../types';
import { Logger } from '../core/Logger';
import winston from 'winston';

export interface AppConfig {
  exchanges: ExchangeConfig[];
  bots: BotConfig[];
  system: {
    logLevel: string;
    port: number;
    environment: string;
    maxConcurrentBots: number;
  };
  database: {
    url: string;
    redis: string;
  };
}

export class ConfigManager {
  private static instance: ConfigManager;
  private config!: AppConfig;
  private configPath: string;
  private logger: winston.Logger;

  private constructor(configPath: string = './config.json') {
    this.configPath = configPath;
    this.logger = Logger.getInstance();
    this.loadConfig();
  }

  static getInstance(configPath?: string): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager(configPath);
    }
    return ConfigManager.instance;
  }

  private loadConfig(): void {
    try {
      if (existsSync(this.configPath)) {
        const configData = readFileSync(this.configPath, 'utf-8');
        this.config = JSON.parse(configData);
        this.logger.info(`Configuration loaded from ${this.configPath}`);
      } else {
        this.config = this.getDefaultConfig();
        this.saveConfig();
        this.logger.info(`Default configuration created at ${this.configPath}`);
      }
      
      this.validateConfig();
      this.applyEnvironmentOverrides();
      
    } catch (error) {
      this.logger.error('Failed to load configuration:', error);
      throw error;
    }
  }

  private getDefaultConfig(): AppConfig {
    return {
      exchanges: [
        {
          name: 'binance',
          apiKey: process.env.BINANCE_API_KEY || '',
          secret: process.env.BINANCE_SECRET || '',
          sandbox: false,
          rateLimit: 1200
        },
        {
          name: 'bybit',
          apiKey: process.env.BYBIT_API_KEY || '',
          secret: process.env.BYBIT_SECRET || '',
          sandbox: false,
          rateLimit: 600
        }
      ],
      bots: [
        {
          id: 'cross-venue-hedge-1',
          type: 'CrossVenueHedge',
          name: 'Cross-Venue Hedge Market Maker',
          enabled: false,
          exchanges: ['binance', 'bybit'],
          symbols: ['BTCUSDT', 'ETHUSDT'],
          parameters: {
            minSpreadPercent: 0.1,
            maxPositionSize: 100,
            hedgeThreshold: 50,
            rebalanceInterval: 30000,
            exchanges: ['binance', 'bybit']
          },
          riskLimits: {
            maxPosition: 1000,
            maxDrawdown: 0.05,
            dailyLossLimit: 500
          }
        }
      ],
      system: {
        logLevel: process.env.LOG_LEVEL || 'info',
        port: parseInt(process.env.PORT || '3000'),
        environment: process.env.NODE_ENV || 'development',
        maxConcurrentBots: 10
      },
      database: {
        url: process.env.DATABASE_URL || 'postgresql://localhost:5432/vibe_trade',
        redis: process.env.REDIS_URL || 'redis://localhost:6379'
      }
    };
  }

  private validateConfig(): void {
    if (!this.config.exchanges || this.config.exchanges.length === 0) {
      throw new Error('At least one exchange must be configured');
    }

    if (!this.config.bots || !Array.isArray(this.config.bots)) {
      throw new Error('Bots configuration must be an array');
    }

    for (const bot of this.config.bots) {
      if (!bot.id || !bot.type) {
        throw new Error('Bot must have id and type');
      }
      
      if (!bot.exchanges || bot.exchanges.length === 0) {
        throw new Error(`Bot ${bot.id} must have at least one exchange configured`);
      }

      for (const exchangeName of bot.exchanges) {
        if (!this.config.exchanges.find(ex => ex.name === exchangeName)) {
          throw new Error(`Bot ${bot.id} references unknown exchange: ${exchangeName}`);
        }
      }
    }

    this.logger.info('Configuration validation passed');
  }

  private applyEnvironmentOverrides(): void {
    // Apply environment variable overrides
    if (process.env.LOG_LEVEL) {
      this.config.system.logLevel = process.env.LOG_LEVEL;
    }

    if (process.env.PORT) {
      this.config.system.port = parseInt(process.env.PORT);
    }

    // Update exchange credentials from environment variables
    for (const exchange of this.config.exchanges) {
      const envPrefix = exchange.name.toUpperCase();
      
      const apiKeyEnv = process.env[`${envPrefix}_API_KEY`];
      if (apiKeyEnv) {
        exchange.apiKey = apiKeyEnv;
      }
      
      const secretEnv = process.env[`${envPrefix}_SECRET`];
      if (secretEnv) {
        exchange.secret = secretEnv;
      }
      
      if (process.env[`${envPrefix}_PASSPHRASE`]) {
        exchange.passphrase = process.env[`${envPrefix}_PASSPHRASE`];
      }

      // Support reading credentials from files (e.g., Docker/K8s secrets)
      try {
        if (process.env[`${envPrefix}_API_KEY_FILE`]) {
          const keyPath = process.env[`${envPrefix}_API_KEY_FILE`] as string;
          exchange.apiKey = readFileSync(keyPath, 'utf-8').trim();
        }
        if (process.env[`${envPrefix}_SECRET_FILE`]) {
          const secretPath = process.env[`${envPrefix}_SECRET_FILE`] as string;
          exchange.secret = readFileSync(secretPath, 'utf-8').trim();
        }
      } catch (e) {
        this.logger.warn(`Failed to read credential file for ${exchange.name}: ${e}`);
      }
      // Always use mainnet in this deployment
      exchange.sandbox = false;
    }
  }

  public saveConfig(): void {
    try {
      // Never persist secrets to disk
      const safeConfig: AppConfig = {
        ...this.config,
        exchanges: this.config.exchanges.map(ex => ({
          name: ex.name,
          apiKey: '',
          secret: '',
          passphrase: '',
          sandbox: ex.sandbox,
          rateLimit: ex.rateLimit
        }))
      } as AppConfig;

      const configData = JSON.stringify(safeConfig, null, 2);
      writeFileSync(this.configPath, configData, 'utf-8');
      this.logger.info(`Configuration saved to ${this.configPath}`);
    } catch (error) {
      this.logger.error('Failed to save configuration:', error);
      throw error;
    }
  }

  public getConfig(): AppConfig {
    return JSON.parse(JSON.stringify(this.config));
  }

  public getExchangeConfig(name: string): ExchangeConfig | undefined {
    return this.config.exchanges.find(ex => ex.name === name);
  }

  public getBotConfig(id: string): BotConfig | undefined {
    return this.config.bots.find(bot => bot.id === id);
  }

  public getAllBotConfigs(): BotConfig[] {
    return JSON.parse(JSON.stringify(this.config.bots));
  }

  public getAllExchangeConfigs(): ExchangeConfig[] {
    return JSON.parse(JSON.stringify(this.config.exchanges));
  }

  public updateBotConfig(id: string, updates: Partial<BotConfig>): void {
    const botIndex = this.config.bots.findIndex(bot => bot.id === id);
    if (botIndex === -1) {
      throw new Error(`Bot with ID ${id} not found`);
    }

    this.config.bots[botIndex] = { ...this.config.bots[botIndex], ...updates };
    this.validateConfig();
    this.saveConfig();
    
    this.logger.info(`Bot ${id} configuration updated`);
  }

  public addBotConfig(config: BotConfig): void {
    if (this.config.bots.find(bot => bot.id === config.id)) {
      throw new Error(`Bot with ID ${config.id} already exists`);
    }

    this.config.bots.push(config);
    this.validateConfig();
    this.saveConfig();
    
    this.logger.info(`Bot ${config.id} added to configuration`);
  }

  public removeBotConfig(id: string): void {
    const botIndex = this.config.bots.findIndex(bot => bot.id === id);
    if (botIndex === -1) {
      throw new Error(`Bot with ID ${id} not found`);
    }

    this.config.bots.splice(botIndex, 1);
    this.saveConfig();
    
    this.logger.info(`Bot ${id} removed from configuration`);
  }

  public updateExchangeConfig(name: string, updates: Partial<ExchangeConfig>): void {
    const exchangeIndex = this.config.exchanges.findIndex(ex => ex.name === name);
    if (exchangeIndex === -1) {
      throw new Error(`Exchange ${name} not found`);
    }

    // Don't save sensitive data to config file
    const { apiKey, secret, passphrase, ...safeUpdates } = updates;
    this.config.exchanges[exchangeIndex] = { ...this.config.exchanges[exchangeIndex], ...safeUpdates };
    
    this.validateConfig();
    this.saveConfig();
    
    this.logger.info(`Exchange ${name} configuration updated`);
  }

  public reloadConfig(): void {
    this.logger.info('Reloading configuration...');
    this.loadConfig();
  }
}
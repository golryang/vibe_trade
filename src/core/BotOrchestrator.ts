import { BaseBot } from './BaseBot';
import { BotConfig, BotStatus, BotMetrics } from '../types';
import { Logger } from './Logger';
import { EventBus } from './EventEmitter';
import winston from 'winston';

export class BotOrchestrator {
  private bots: Map<string, BaseBot> = new Map();
  private logger: winston.Logger;
  private eventBus: EventBus;

  constructor() {
    this.logger = Logger.getInstance();
    this.eventBus = EventBus.getInstance();
    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    this.eventBus.on('botStatusChange', this.onBotStatusChange.bind(this));
    this.eventBus.on('error', this.onError.bind(this));

    process.on('SIGINT', this.gracefulShutdown.bind(this));
    process.on('SIGTERM', this.gracefulShutdown.bind(this));
  }

  async addBot(bot: BaseBot): Promise<void> {
    const botId = bot.getConfig().id;
    
    if (this.bots.has(botId)) {
      throw new Error(`Bot with ID ${botId} already exists`);
    }

    this.bots.set(botId, bot);
    this.logger.info(`Added bot ${botId} to orchestrator`);
  }

  async removeBot(botId: string): Promise<void> {
    const bot = this.bots.get(botId);
    if (!bot) {
      throw new Error(`Bot with ID ${botId} not found`);
    }

    if (bot.getStatus() === BotStatus.RUNNING) {
      await bot.stop();
    }

    this.bots.delete(botId);
    this.logger.info(`Removed bot ${botId} from orchestrator`);
  }

  async startBot(botId: string): Promise<void> {
    const bot = this.bots.get(botId);
    if (!bot) {
      throw new Error(`Bot with ID ${botId} not found`);
    }

    await bot.start();
  }

  async stopBot(botId: string): Promise<void> {
    const bot = this.bots.get(botId);
    if (!bot) {
      throw new Error(`Bot with ID ${botId} not found`);
    }

    await bot.stop();
  }

  async startAllBots(): Promise<void> {
    this.logger.info('Starting all bots...');
    
    const startPromises = Array.from(this.bots.values())
      .filter(bot => bot.getConfig().enabled)
      .map(async bot => {
        try {
          await bot.start();
        } catch (error) {
          this.logger.error(`Failed to start bot ${bot.getConfig().id}:`, error);
        }
      });

    await Promise.allSettled(startPromises);
    this.logger.info('All enabled bots start process completed');
  }

  async stopAllBots(): Promise<void> {
    this.logger.info('Stopping all bots...');
    
    const stopPromises = Array.from(this.bots.values())
      .filter(bot => bot.getStatus() === BotStatus.RUNNING)
      .map(async bot => {
        try {
          await bot.stop();
        } catch (error) {
          this.logger.error(`Failed to stop bot ${bot.getConfig().id}:`, error);
        }
      });

    await Promise.allSettled(stopPromises);
    this.logger.info('All bots stopped');
  }

  getBotStatus(botId: string): BotStatus | null {
    const bot = this.bots.get(botId);
    return bot ? bot.getStatus() : null;
  }

  getBotMetrics(botId: string): BotMetrics | null {
    const bot = this.bots.get(botId);
    return bot ? bot.getMetrics() : null;
  }

  // Expose bot instance for callers that need to check existence without adding
  getBot(botId: string) {
    return this.bots.get(botId);
  }

  getAllBots(): BotConfig[] {
    return Array.from(this.bots.values()).map(bot => bot.getConfig());
  }

  getRunningBots(): BotConfig[] {
    return Array.from(this.bots.values())
      .filter(bot => bot.getStatus() === BotStatus.RUNNING)
      .map(bot => bot.getConfig());
  }

  getAllMetrics(): BotMetrics[] {
    return Array.from(this.bots.values()).map(bot => bot.getMetrics());
  }

  async updateBotConfig(botId: string, config: Partial<BotConfig>): Promise<void> {
    const bot = this.bots.get(botId);
    if (!bot) {
      throw new Error(`Bot with ID ${botId} not found`);
    }

    bot.updateConfig(config);
  }

  private onBotStatusChange(data: any): void {
    this.logger.info(`Bot ${data.botId} status changed: ${data.oldStatus} -> ${data.newStatus}`);
  }

  private onError(data: any): void {
    this.logger.error('System error:', data.error, { context: data.context });
  }

  private async gracefulShutdown(): Promise<void> {
    this.logger.info('Received shutdown signal, stopping all bots...');
    
    try {
      await this.stopAllBots();
      this.logger.info('Graceful shutdown completed');
      process.exit(0);
    } catch (error) {
      this.logger.error('Error during graceful shutdown:', error);
      process.exit(1);
    }
  }
}
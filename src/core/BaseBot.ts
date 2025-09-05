import { EventEmitter } from 'events';
import { BotConfig, BotStatus, BotMetrics } from '../types';
import { Logger } from './Logger';
import { EventBus } from './EventEmitter';
import winston from 'winston';

export abstract class BaseBot extends EventEmitter {
  protected config: BotConfig;
  protected status: BotStatus = BotStatus.STOPPED;
  protected logger: winston.Logger;
  protected eventBus: EventBus;
  protected metrics: BotMetrics;
  protected startTime: number = 0;

  constructor(config: BotConfig) {
    super();
    this.config = config;
    this.logger = Logger.createBotLogger(config.id);
    this.eventBus = EventBus.getInstance();
    
    this.metrics = {
      botId: config.id,
      totalPnl: 0,
      dailyPnl: 0,
      winRate: 0,
      totalTrades: 0,
      activePositions: 0,
      uptime: 0,
      lastUpdate: Date.now()
    };

    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    this.eventBus.on('marketData', this.onMarketData.bind(this));
    this.eventBus.on('orderUpdate', this.onOrderUpdate.bind(this));
    this.eventBus.on('positionUpdate', this.onPositionUpdate.bind(this));
  }

  async start(): Promise<void> {
    if (this.status !== BotStatus.STOPPED) {
      throw new Error(`Cannot start bot ${this.config.id}: current status is ${this.status}`);
    }

    try {
      this.setStatus(BotStatus.STARTING);
      this.startTime = Date.now();
      
      this.logger.info(`Starting bot ${this.config.id}`);
      await this.initialize();
      
      this.setStatus(BotStatus.RUNNING);
      this.logger.info(`Bot ${this.config.id} started successfully`);
      
    } catch (error) {
      this.setStatus(BotStatus.ERROR);
      this.logger.error(`Failed to start bot ${this.config.id}:`, error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.status === BotStatus.STOPPED || this.status === BotStatus.STOPPING) {
      return;
    }

    try {
      this.setStatus(BotStatus.STOPPING);
      this.logger.info(`Stopping bot ${this.config.id}`);
      
      await this.cleanup();
      
      this.setStatus(BotStatus.STOPPED);
      this.logger.info(`Bot ${this.config.id} stopped successfully`);
      
    } catch (error) {
      this.setStatus(BotStatus.ERROR);
      this.logger.error(`Error stopping bot ${this.config.id}:`, error);
      throw error;
    }
  }

  protected setStatus(status: BotStatus): void {
    const oldStatus = this.status;
    this.status = status;
    
    this.eventBus.emitBotStatusChange({
      botId: this.config.id,
      oldStatus,
      newStatus: status,
      timestamp: Date.now()
    });
  }

  public getStatus(): BotStatus {
    return this.status;
  }

  public getConfig(): BotConfig {
    return { ...this.config };
  }

  public getMetrics(): BotMetrics {
    this.metrics.uptime = this.startTime ? Date.now() - this.startTime : 0;
    this.metrics.lastUpdate = Date.now();
    return { ...this.metrics };
  }

  public updateConfig(newConfig: Partial<BotConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.logger.info(`Bot ${this.config.id} configuration updated`);
    this.onConfigUpdate(newConfig);
  }

  protected abstract initialize(): Promise<void>;
  protected abstract cleanup(): Promise<void>;
  protected abstract onMarketData(data: any): void;
  protected abstract onOrderUpdate(data: any): void;
  protected abstract onPositionUpdate(data: any): void;
  protected abstract onConfigUpdate(config: Partial<BotConfig>): void;
}
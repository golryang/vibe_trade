import { BotMetrics, Order, Position } from '../types';
import { Logger } from '../core/Logger';
import { EventBus } from '../core/EventEmitter';
import winston from 'winston';

interface TradeMetrics {
  botId: string;
  symbol: string;
  exchange: string;
  side: 'buy' | 'sell';
  amount: number;
  price: number;
  pnl: number;
  timestamp: number;
}

interface SystemMetrics {
  timestamp: number;
  memory: {
    used: number;
    free: number;
    total: number;
  };
  cpu: {
    usage: number;
  };
  activeBots: number;
  totalOrders: number;
  totalPositions: number;
  uptime: number;
}

export class MetricsCollector {
  private static instance: MetricsCollector;
  private logger: winston.Logger;
  private eventBus: EventBus;
  private botMetrics: Map<string, BotMetrics> = new Map();
  private tradeHistory: TradeMetrics[] = [];
  private systemMetrics: SystemMetrics[] = [];
  private startTime: number;

  private constructor() {
    this.logger = Logger.getInstance();
    this.eventBus = EventBus.getInstance();
    this.startTime = Date.now();
    this.setupEventListeners();
    this.startSystemMetricsCollection();
  }

  static getInstance(): MetricsCollector {
    if (!MetricsCollector.instance) {
      MetricsCollector.instance = new MetricsCollector();
    }
    return MetricsCollector.instance;
  }

  private setupEventListeners(): void {
    this.eventBus.on('orderUpdate', this.onOrderUpdate.bind(this));
    this.eventBus.on('positionUpdate', this.onPositionUpdate.bind(this));
    this.eventBus.on('botStatusChange', this.onBotStatusChange.bind(this));
  }

  private startSystemMetricsCollection(): void {
    setInterval(() => {
      this.collectSystemMetrics();
    }, 30000); // Collect every 30 seconds

    // Cleanup old metrics every hour
    setInterval(() => {
      this.cleanupOldMetrics();
    }, 3600000);
  }

  private collectSystemMetrics(): void {
    const memoryUsage = process.memoryUsage();
    
    const metrics: SystemMetrics = {
      timestamp: Date.now(),
      memory: {
        used: memoryUsage.heapUsed,
        free: memoryUsage.heapTotal - memoryUsage.heapUsed,
        total: memoryUsage.heapTotal
      },
      cpu: {
        usage: process.cpuUsage().user / 1000000 // Convert to seconds
      },
      activeBots: this.getActiveBotCount(),
      totalOrders: this.getTotalOrderCount(),
      totalPositions: this.getTotalPositionCount(),
      uptime: Date.now() - this.startTime
    };

    this.systemMetrics.push(metrics);

    // Keep only last 24 hours of system metrics
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    this.systemMetrics = this.systemMetrics.filter(m => m.timestamp > oneDayAgo);
  }

  private onOrderUpdate(order: Order): void {
    if (order.status === 'filled') {
      this.recordTrade(order);
    }
  }

  private onPositionUpdate(position: Position): void {
    // Update position-related metrics
    this.updatePositionMetrics(position);
  }

  private onBotStatusChange(data: any): void {
    this.logger.debug(`Bot status change recorded: ${data.botId} ${data.oldStatus} -> ${data.newStatus}`);
  }

  private recordTrade(order: Order): void {
    const trade: TradeMetrics = {
      botId: '', // This should be passed with the order
      symbol: order.symbol,
      exchange: order.exchange,
      side: order.side,
      amount: order.amount,
      price: order.price || 0,
      pnl: 0, // Calculate based on position
      timestamp: order.timestamp
    };

    this.tradeHistory.push(trade);

    // Keep only last 7 days of trade history
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    this.tradeHistory = this.tradeHistory.filter(t => t.timestamp > sevenDaysAgo);

    this.logger.info('Trade recorded:', {
      symbol: trade.symbol,
      exchange: trade.exchange,
      side: trade.side,
      amount: trade.amount,
      price: trade.price
    });
  }

  private updatePositionMetrics(position: Position): void {
    // This would typically update bot-specific metrics
    // based on position changes
  }

  private cleanupOldMetrics(): void {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    // Clean system metrics
    this.systemMetrics = this.systemMetrics.filter(m => m.timestamp > oneDayAgo);
    
    // Clean trade history
    this.tradeHistory = this.tradeHistory.filter(t => t.timestamp > sevenDaysAgo);

    this.logger.debug('Cleaned up old metrics');
  }

  private getActiveBotCount(): number {
    return Array.from(this.botMetrics.values())
      .filter(metrics => metrics.uptime > 0).length;
  }

  private getTotalOrderCount(): number {
    return this.tradeHistory.length;
  }

  private getTotalPositionCount(): number {
    return Array.from(this.botMetrics.values())
      .reduce((sum, metrics) => sum + metrics.activePositions, 0);
  }

  public updateBotMetrics(botId: string, metrics: BotMetrics): void {
    this.botMetrics.set(botId, metrics);
  }

  public getBotMetrics(botId: string): BotMetrics | undefined {
    return this.botMetrics.get(botId);
  }

  public getAllBotMetrics(): BotMetrics[] {
    return Array.from(this.botMetrics.values());
  }

  public getSystemMetrics(): SystemMetrics[] {
    return [...this.systemMetrics];
  }

  public getLatestSystemMetrics(): SystemMetrics | undefined {
    return this.systemMetrics[this.systemMetrics.length - 1];
  }

  public getTradeHistory(botId?: string, hours?: number): TradeMetrics[] {
    let trades = [...this.tradeHistory];

    if (botId) {
      trades = trades.filter(t => t.botId === botId);
    }

    if (hours) {
      const cutoffTime = Date.now() - (hours * 60 * 60 * 1000);
      trades = trades.filter(t => t.timestamp > cutoffTime);
    }

    return trades.sort((a, b) => b.timestamp - a.timestamp);
  }

  public calculatePnL(botId?: string, period?: 'daily' | 'weekly' | 'monthly'): number {
    let trades = [...this.tradeHistory];

    if (botId) {
      trades = trades.filter(t => t.botId === botId);
    }

    if (period) {
      const now = Date.now();
      let cutoffTime: number;

      switch (period) {
        case 'daily':
          cutoffTime = now - 24 * 60 * 60 * 1000;
          break;
        case 'weekly':
          cutoffTime = now - 7 * 24 * 60 * 60 * 1000;
          break;
        case 'monthly':
          cutoffTime = now - 30 * 24 * 60 * 60 * 1000;
          break;
      }

      trades = trades.filter(t => t.timestamp > cutoffTime);
    }

    return trades.reduce((sum, trade) => sum + trade.pnl, 0);
  }

  public getPerformanceReport(botId?: string): any {
    const trades = this.getTradeHistory(botId);
    const winningTrades = trades.filter(t => t.pnl > 0);
    const losingTrades = trades.filter(t => t.pnl < 0);

    return {
      totalTrades: trades.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate: trades.length > 0 ? (winningTrades.length / trades.length) * 100 : 0,
      totalPnL: trades.reduce((sum, t) => sum + t.pnl, 0),
      dailyPnL: this.calculatePnL(botId, 'daily'),
      weeklyPnL: this.calculatePnL(botId, 'weekly'),
      monthlyPnL: this.calculatePnL(botId, 'monthly'),
      avgWinSize: winningTrades.length > 0 ? 
        winningTrades.reduce((sum, t) => sum + t.pnl, 0) / winningTrades.length : 0,
      avgLossSize: losingTrades.length > 0 ? 
        Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0) / losingTrades.length) : 0
    };
  }
}
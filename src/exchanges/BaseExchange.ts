import { EventEmitter } from 'events';
import { Order, OrderBook, MarketData, Position, ExchangeConfig } from '../types';
import { Logger } from '../core/Logger';
import winston from 'winston';

export abstract class BaseExchange extends EventEmitter {
  protected config: ExchangeConfig;
  protected logger: winston.Logger;
  protected connected: boolean = false;
  protected rateLimitCount: number = 0;
  protected rateLimitResetTime: number = 0;

  constructor(config: ExchangeConfig) {
    super();
    this.config = config;
    this.logger = Logger.getInstance().child({ exchange: config.name });
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  
  abstract subscribeToOrderBook(symbol: string): Promise<void>;
  abstract subscribeToTrades(symbol: string): Promise<void>;
  abstract unsubscribeFromOrderBook(symbol: string): Promise<void>;
  abstract unsubscribeFromTrades(symbol: string): Promise<void>;

  abstract placeOrder(order: Omit<Order, 'id' | 'timestamp' | 'status'>): Promise<Order>;
  abstract cancelOrder(orderId: string, symbol: string): Promise<boolean>;
  abstract getOrder(orderId: string, symbol: string): Promise<Order>;
  abstract getOpenOrders(symbol?: string): Promise<Order[]>;
  
  abstract getBalance(): Promise<Record<string, number>>;
  abstract getPositions(): Promise<Position[]>;
  abstract getOrderBook(symbol: string): Promise<OrderBook>;

  protected async checkRateLimit(url?: string): Promise<void> {
    const now = Date.now();
    
    if (now > this.rateLimitResetTime) {
      this.rateLimitCount = 0;
      this.rateLimitResetTime = now + 60000; // Reset every minute
    }

    if (this.rateLimitCount >= this.config.rateLimit) {
      throw new Error(`Rate limit exceeded for ${this.config.name}`);
    }

    this.rateLimitCount++;
  }

  protected emitOrderBook(orderBook: OrderBook): void {
    this.emit('orderBook', orderBook);
  }

  protected emitTrade(trade: MarketData): void {
    this.emit('trade', trade);
  }

  protected emitOrderUpdate(order: Order): void {
    this.emit('orderUpdate', order);
  }

  protected emitError(error: Error): void {
    this.logger.error(`Exchange ${this.config.name} error:`, error);
    this.emit('error', error);
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public getName(): string {
    return this.config.name;
  }
}
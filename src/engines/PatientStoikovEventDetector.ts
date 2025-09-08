import { EventEmitter } from 'events';
import { Logger } from '../core/Logger';
import { MarketState, StoikovQuotes } from './StoikovEngine';
import { L2OrderBook, L2OrderBookEntry } from '../data/MarketDataProcessor';
import winston from 'winston';

export interface PatientEventConfig {
  // Top-N tracking parameters
  topNThreshold: number;           // N levels to maintain within {3, 5}
  
  // Queue-ahead detection parameters
  queueAheadThreshold: number;     // Max queue ahead ratio {0.3, 0.5}
  queueAheadCheckInterval: number; // Check interval in ms {500, 1000}
  
  // Drift detection parameters
  driftThresholdBps: number;       // Drift cut in bps {5, 8, 12}
  driftCheckInterval: number;      // Check interval in ms {1000, 2000}
  
  // Session TTL parameters
  maxSessionTtl: number;           // Max session TTL {60s, 120s}
  levelTtl: number;               // Per-level TTL {5s, 10s, 20s}
  
  // Rate limiting parameters
  minRequoteInterval: number;      // Min interval between requotes {300, 500}ms
  rateLimitThreshold: number;      // Rate limit threshold (% remaining) {20}
  
  // Jitter to avoid collision
  jitterMs: number;               // Jitter amount {20, 50}ms
}

export interface QuoteSnapshot {
  quotes: StoikovQuotes;
  midAtPost: number;
  timestamp: number;
  levelTtlExpiry: Map<string, number>; // key: 'bid_0', 'ask_1', etc.
}

export interface TopNLevel {
  price: number;
  size: number;
  rank: number;
}

export interface PatientEventData {
  eventType: 'topNExit' | 'drift' | 'queueAhead' | 'sessionTtl' | 'levelTtl';
  reason: string;
  priority: 'high' | 'medium' | 'low';
  data?: any;
}

export interface QueueAheadData {
  side: 'bid' | 'ask';
  level: number;
  queueAhead: number;
  threshold: number;
}

export interface DriftData {
  currentMid: number;
  originalMid: number;
  driftBps: number;
  threshold: number;
}

export class PatientStoikovEventDetector extends EventEmitter {
  private logger: winston.Logger;
  private config: PatientEventConfig;
  
  // Current state
  private currentQuoteSnapshot: QuoteSnapshot | null = null;
  private currentOrderBook: L2OrderBook | null = null;
  private currentMarketState: MarketState | null = null;
  
  // Event tracking
  private lastRequoteTime: number = 0;
  private sessionStartTime: number = 0;
  private eventQueue: PatientEventData[] = [];
  
  // Timers
  private queueAheadTimer: NodeJS.Timeout | null = null;
  private driftTimer: NodeJS.Timeout | null = null;
  private levelTtlTimer: NodeJS.Timeout | null = null;
  private sessionTtlTimer: NodeJS.Timeout | null = null;

  constructor(config: PatientEventConfig) {
    super();
    this.config = config;
    this.logger = Logger.getInstance().child({ module: 'PatientStoikovEventDetector' });
    
    this.validateConfig();
    this.startEventTimers();
    
    this.logger.info('Patient Stoikov event detector initialized', { config });
  }

  private validateConfig(): void {
    const { topNThreshold, queueAheadThreshold, driftThresholdBps } = this.config;
    
    if (topNThreshold < 1 || topNThreshold > 10) {
      throw new Error(`Invalid topNThreshold: ${topNThreshold}. Must be 1-10`);
    }
    
    if (queueAheadThreshold < 0.1 || queueAheadThreshold > 1.0) {
      throw new Error(`Invalid queueAheadThreshold: ${queueAheadThreshold}. Must be 0.1-1.0`);
    }
    
    if (driftThresholdBps < 1 || driftThresholdBps > 50) {
      throw new Error(`Invalid driftThresholdBps: ${driftThresholdBps}. Must be 1-50 bps`);
    }
  }

  private startEventTimers(): void {
    // Queue-ahead detection timer
    this.queueAheadTimer = setInterval(() => {
      this.checkQueueAhead();
    }, this.config.queueAheadCheckInterval);
    
    // Drift detection timer
    this.driftTimer = setInterval(() => {
      this.checkDrift();
    }, this.config.driftCheckInterval);
    
    // Level TTL check timer (more frequent)
    this.levelTtlTimer = setInterval(() => {
      this.checkLevelTtl();
    }, 1000); // Check every second
  }

  public startNewSession(quotes: StoikovQuotes, marketState: MarketState): void {
    this.sessionStartTime = Date.now();
    
    // Create level TTL map
    const levelTtlExpiry = new Map<string, number>();
    const now = Date.now();
    
    // Set TTL for each ladder level
    for (let level = 0; level < 3; level++) { // Assuming max 3 levels
      levelTtlExpiry.set(`bid_${level}`, now + this.config.levelTtl);
      levelTtlExpiry.set(`ask_${level}`, now + this.config.levelTtl);
    }
    
    this.currentQuoteSnapshot = {
      quotes,
      midAtPost: marketState.mid,
      timestamp: now,
      levelTtlExpiry
    };
    
    // Start session TTL timer
    if (this.sessionTtlTimer) {
      clearTimeout(this.sessionTtlTimer);
    }
    
    this.sessionTtlTimer = setTimeout(() => {
      this.emitEvent({
        eventType: 'sessionTtl',
        reason: 'Maximum session TTL reached',
        priority: 'medium'
      });
    }, this.config.maxSessionTtl + Math.random() * this.config.jitterMs);
    
    this.logger.debug('New patient session started', {
      sessionId: this.sessionStartTime,
      midPrice: marketState.mid,
      bidPrice: quotes.bidPrice,
      askPrice: quotes.askPrice
    });
  }

  public updateOrderBook(orderBook: L2OrderBook): void {
    this.currentOrderBook = orderBook;
    
    // Check Top-N exit immediately on order book update
    this.checkTopNExit();
  }

  public updateMarketState(marketState: MarketState): void {
    this.currentMarketState = marketState;
  }

  private checkTopNExit(): void {
    if (!this.currentQuoteSnapshot || !this.currentOrderBook) {
      return;
    }

    const quotes = this.currentQuoteSnapshot.quotes;
    const { bids, asks } = this.currentOrderBook;
    
    // Check bid side
    const bidInTopN = this.isQuoteInTopN(quotes.bidPrice, bids, this.config.topNThreshold);
    if (!bidInTopN) {
      this.emitEvent({
        eventType: 'topNExit',
        reason: `Bid price ${quotes.bidPrice} exited Top-${this.config.topNThreshold}`,
        priority: 'high',
        data: { side: 'bid', price: quotes.bidPrice, topNThreshold: this.config.topNThreshold }
      });
      return;
    }
    
    // Check ask side
    const askInTopN = this.isQuoteInTopN(quotes.askPrice, asks, this.config.topNThreshold);
    if (!askInTopN) {
      this.emitEvent({
        eventType: 'topNExit',
        reason: `Ask price ${quotes.askPrice} exited Top-${this.config.topNThreshold}`,
        priority: 'high',
        data: { side: 'ask', price: quotes.askPrice, topNThreshold: this.config.topNThreshold }
      });
      return;
    }
  }

  private isQuoteInTopN(quotePrice: number, levels: L2OrderBookEntry[], topN: number): boolean {
    if (levels.length < topN) {
      return true; // If book doesn't have N levels, we're safe
    }
    
    // For bids: check if our price is >= the Nth best bid
    // For asks: check if our price is <= the Nth best ask
    const isBid = levels.length > 0 && quotePrice <= levels[0].price;
    
    if (isBid) {
      // Bids are sorted descending, check if we're in top N
      return levels.slice(0, topN).some(level => Math.abs(level.price - quotePrice) < 0.0001);
    } else {
      // Asks are sorted ascending, check if we're in top N
      return levels.slice(0, topN).some(level => Math.abs(level.price - quotePrice) < 0.0001);
    }
  }

  private checkQueueAhead(): void {
    if (!this.currentQuoteSnapshot || !this.currentOrderBook) {
      return;
    }

    const quotes = this.currentQuoteSnapshot.quotes;
    const { bids, asks } = this.currentOrderBook;
    
    // Check bid side queue
    const bidQueueAhead = this.calculateQueueAhead(quotes.bidPrice, bids);
    const bidThreshold = this.getBidTopDepth() * this.config.queueAheadThreshold;
    
    if (bidQueueAhead > bidThreshold) {
      this.emitEvent({
        eventType: 'queueAhead',
        reason: `Bid queue ahead (${bidQueueAhead}) exceeds threshold (${bidThreshold})`,
        priority: 'medium',
        data: {
          side: 'bid',
          level: 0, // Assuming level 0 for now
          queueAhead: bidQueueAhead,
          threshold: bidThreshold
        } as QueueAheadData
      });
      return;
    }
    
    // Check ask side queue
    const askQueueAhead = this.calculateQueueAhead(quotes.askPrice, asks);
    const askThreshold = this.getAskTopDepth() * this.config.queueAheadThreshold;
    
    if (askQueueAhead > askThreshold) {
      this.emitEvent({
        eventType: 'queueAhead',
        reason: `Ask queue ahead (${askQueueAhead}) exceeds threshold (${askThreshold})`,
        priority: 'medium',
        data: {
          side: 'ask',
          level: 0,
          queueAhead: askQueueAhead,
          threshold: askThreshold
        } as QueueAheadData
      });
    }
  }

  private calculateQueueAhead(quotePrice: number, levels: L2OrderBookEntry[]): number {
    // Find the level with our price
    const ourLevel = levels.find(level => Math.abs(level.price - quotePrice) < 0.0001);
    if (!ourLevel) {
      return 0; // We're not in the book
    }
    
    // For simplicity, return the size at our level
    // Real implementation would consider our position in the queue
    return ourLevel.size;
  }

  private getBidTopDepth(): number {
    if (!this.currentOrderBook || this.currentOrderBook.bids.length === 0) {
      return 1000; // Default fallback
    }
    return this.currentOrderBook.bids[0].size;
  }

  private getAskTopDepth(): number {
    if (!this.currentOrderBook || this.currentOrderBook.asks.length === 0) {
      return 1000; // Default fallback
    }
    return this.currentOrderBook.asks[0].size;
  }

  private checkDrift(): void {
    if (!this.currentQuoteSnapshot || !this.currentMarketState) {
      return;
    }

    const originalMid = this.currentQuoteSnapshot.midAtPost;
    const currentMid = this.currentMarketState.mid;
    
    const driftBps = Math.abs((currentMid - originalMid) / originalMid) * 10000;
    
    if (driftBps > this.config.driftThresholdBps) {
      this.emitEvent({
        eventType: 'drift',
        reason: `Price drift (${driftBps.toFixed(2)} bps) exceeds threshold (${this.config.driftThresholdBps} bps)`,
        priority: 'high',
        data: {
          currentMid,
          originalMid,
          driftBps,
          threshold: this.config.driftThresholdBps
        } as DriftData
      });
    }
  }

  private checkLevelTtl(): void {
    if (!this.currentQuoteSnapshot) {
      return;
    }

    const now = Date.now();
    
    for (const [levelKey, expiry] of this.currentQuoteSnapshot.levelTtlExpiry.entries()) {
      if (now >= expiry) {
        this.emitEvent({
          eventType: 'levelTtl',
          reason: `Level TTL expired for ${levelKey}`,
          priority: 'low',
          data: { levelKey, expiry, now }
        });
        
        // Remove expired level from map
        this.currentQuoteSnapshot.levelTtlExpiry.delete(levelKey);
      }
    }
  }

  private emitEvent(event: PatientEventData): void {
    // Check rate limiting
    if (!this.canEmitRequote()) {
      this.logger.debug('Event rate limited, queuing', { eventType: event.eventType });
      this.eventQueue.push(event);
      return;
    }
    
    // Add jitter to avoid collision
    const jitter = Math.random() * this.config.jitterMs;
    
    setTimeout(() => {
      this.logger.info('Patient Stoikov event detected', {
        eventType: event.eventType,
        reason: event.reason,
        priority: event.priority
      });
      
      this.emit('patientEvent', event);
      this.lastRequoteTime = Date.now();
    }, jitter);
  }

  private canEmitRequote(): boolean {
    const timeSinceLastRequote = Date.now() - this.lastRequoteTime;
    return timeSinceLastRequote >= this.config.minRequoteInterval;
  }

  public processEventQueue(): void {
    if (this.eventQueue.length === 0 || !this.canEmitRequote()) {
      return;
    }
    
    // Process highest priority event first
    this.eventQueue.sort((a, b) => {
      const priorityOrder = { high: 3, medium: 2, low: 1 };
      return priorityOrder[b.priority] - priorityOrder[a.priority];
    });
    
    const event = this.eventQueue.shift();
    if (event) {
      this.emitEvent(event);
    }
  }

  public onPartialFill(fillData: any): void {
    // Update inventory and trigger recalculation
    this.emitEvent({
      eventType: 'drift', // Reuse drift event type for inventory updates
      reason: 'Partial fill requires inventory update',
      priority: 'high',
      data: { fillData }
    });
  }

  public updateConfig(updates: Partial<PatientEventConfig>): void {
    this.config = { ...this.config, ...updates };
    this.validateConfig();
    this.logger.info('Patient event detector config updated', { updates });
    this.emit('configUpdated', this.config);
  }

  public getEventStats(): any {
    return {
      sessionUptime: this.sessionStartTime ? Date.now() - this.sessionStartTime : 0,
      queuedEvents: this.eventQueue.length,
      lastRequoteTime: this.lastRequoteTime,
      canRequote: this.canEmitRequote(),
      currentSession: this.currentQuoteSnapshot ? {
        originalMid: this.currentQuoteSnapshot.midAtPost,
        sessionAge: Date.now() - this.currentQuoteSnapshot.timestamp,
        activeLevels: this.currentQuoteSnapshot.levelTtlExpiry.size
      } : null
    };
  }

  public reset(): void {
    // Clear timers
    if (this.queueAheadTimer) clearInterval(this.queueAheadTimer);
    if (this.driftTimer) clearInterval(this.driftTimer);
    if (this.levelTtlTimer) clearInterval(this.levelTtlTimer);
    if (this.sessionTtlTimer) clearTimeout(this.sessionTtlTimer);
    
    // Reset state
    this.currentQuoteSnapshot = null;
    this.currentOrderBook = null;
    this.currentMarketState = null;
    this.eventQueue = [];
    this.lastRequoteTime = 0;
    this.sessionStartTime = 0;
    
    this.logger.info('Patient event detector reset');
  }

  public destroy(): void {
    this.reset();
    this.removeAllListeners();
  }
}
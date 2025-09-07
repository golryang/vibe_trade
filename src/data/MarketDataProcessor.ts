import { EventEmitter } from 'events';
import { Logger } from '../core/Logger';
import { MarketState } from '../engines/StoikovEngine';
import winston from 'winston';

export interface L2OrderBookEntry {
  price: number;
  size: number;
}

export interface L2OrderBook {
  bids: L2OrderBookEntry[];
  asks: L2OrderBookEntry[];
  sequence: number;
  timestamp: number;
}

export interface Trade {
  price: number;
  size: number;
  side: 'buy' | 'sell';
  timestamp: number;
}

export interface BBO {
  bestBid: number;
  bestAsk: number;
  bestBidSize: number;
  bestAskSize: number;
  timestamp: number;
}

export interface MarkData {
  markPrice: number;
  indexPrice: number;
  fundingRate: number;
  timestamp: number;
}

export interface ProcessorConfig {
  topNDepth: number;        // Calculate depth for top N levels {5, 10}
  obiWindow: number;        // OBI calculation window (ms)
  micropriceLevels: number; // Number of levels for microprice calc {3, 5}
  queueThreshold: number;   // Queue-ahead detection threshold
  sequenceTimeout: number;  // Timeout for sequence gaps (ms)
  enableMark: boolean;      // Enable mark/funding processing
}

interface OrderBookMetrics {
  mid: number;
  microprice: number;
  spread: number;
  spreadBps: number;
  obi: number;              // Order Book Imbalance
  topBidDepth: number;      // Depth at top N levels (bid side)
  topAskDepth: number;      // Depth at top N levels (ask side)
  queueAhead: {
    bid: number;            // Queue ahead for bid insertion
    ask: number;            // Queue ahead for ask insertion
  };
  weightedMid: number;      // Volume-weighted mid
  impactBid: number;        // Price impact for market buy
  impactAsk: number;        // Price impact for market sell
}

export class MarketDataProcessor extends EventEmitter {
  private logger: winston.Logger;
  private config: ProcessorConfig;
  
  // Current state
  private currentOrderBook: L2OrderBook | null = null;
  private lastBBO: BBO | null = null;
  private lastMarkData: MarkData | null = null;
  private recentTrades: Trade[] = [];
  
  // Sequence tracking
  private expectedSequence: number = 0;
  private sequenceGaps: number = 0;
  
  // Metrics buffers for windowed calculations
  private obiBuffer: Array<{obi: number, timestamp: number}> = [];
  private midBuffer: Array<{mid: number, timestamp: number}> = [];

  constructor(config: ProcessorConfig) {
    super();
    this.config = config;
    this.logger = Logger.getInstance().child({ module: 'MarketDataProcessor' });
    
    this.validateConfig();
    
    // Cleanup old data periodically
    setInterval(() => this.cleanupOldData(), 10000); // Every 10 seconds
    
    this.logger.info('Market data processor initialized', { config });
  }

  private validateConfig(): void {
    const { topNDepth, obiWindow, micropriceLevels } = this.config;
    
    if (topNDepth < 1 || topNDepth > 20) {
      throw new Error(`Invalid topNDepth: ${topNDepth}. Must be 1-20`);
    }
    
    if (obiWindow < 1000 || obiWindow > 300000) {
      throw new Error(`Invalid obiWindow: ${obiWindow}ms. Must be 1s-5m`);
    }
    
    if (micropriceLevels < 1 || micropriceLevels > 10) {
      throw new Error(`Invalid micropriceLevels: ${micropriceLevels}. Must be 1-10`);
    }
  }

  public processOrderBook(orderBook: L2OrderBook): void {
    // Check sequence continuity
    if (this.expectedSequence > 0 && orderBook.sequence !== this.expectedSequence) {
      this.sequenceGaps++;
      // Throttle noisy warnings to once per second
      const now = Date.now();
      const last = (this as any)._lastSeqWarnTs || 0;
      if (now - last > 1000) {
        this.logger.warn(`Sequence gap detected. Expected: ${this.expectedSequence}, Got: ${orderBook.sequence}`);
        (this as any)._lastSeqWarnTs = now;
      }
    }
    this.expectedSequence = orderBook.sequence + 1;

    // Validate and sort orderbook
    const validatedBook = this.validateOrderBook(orderBook);
    if (!validatedBook) {
      this.logger.error('Invalid orderbook received, skipping');
      return;
    }

    this.currentOrderBook = validatedBook;
    
    // Calculate metrics
    const metrics = this.calculateOrderBookMetrics(validatedBook);
    
    // Update buffers
    this.updateBuffers(metrics, validatedBook.timestamp);
    
    // Create market state for Stoikov engine
    const marketState = this.createMarketState(metrics, validatedBook.timestamp);
    
    this.emit('orderBookProcessed', {
      orderBook: validatedBook,
      metrics,
      marketState
    });

    // Emit market state update
    this.emit('marketStateUpdate', marketState);
  }

  public processTrade(trade: Trade): void {
    // Add to recent trades buffer
    this.recentTrades.push(trade);
    
    // Keep only recent trades (last 5 minutes)
    const fiveMinutesAgo = Date.now() - 300000;
    this.recentTrades = this.recentTrades.filter(t => t.timestamp >= fiveMinutesAgo);
    
    // Emit processed trade
    this.emit('tradeProcessed', trade);
  }

  public processBBO(bbo: BBO): void {
    this.lastBBO = bbo;
    this.emit('bboUpdate', bbo);
  }

  public processMarkData(markData: MarkData): void {
    if (!this.config.enableMark) return;
    
    this.lastMarkData = markData;
    this.emit('markDataUpdate', markData);
  }

  private validateOrderBook(orderBook: L2OrderBook): L2OrderBook | null {
    const { bids, asks } = orderBook;
    
    if (!bids || !asks || bids.length === 0 || asks.length === 0) {
      return null;
    }

    // Check if bids are in descending order and asks in ascending order
    const sortedBids = [...bids].sort((a, b) => b.price - a.price);
    const sortedAsks = [...asks].sort((a, b) => a.price - b.price);
    
    // Check for crossed book
    if (sortedBids[0].price >= sortedAsks[0].price) {
      this.logger.warn('Crossed orderbook detected', { 
        topBid: sortedBids[0].price, 
        topAsk: sortedAsks[0].price 
      });
      return null;
    }

    return {
      ...orderBook,
      bids: sortedBids,
      asks: sortedAsks
    };
  }

  private calculateOrderBookMetrics(orderBook: L2OrderBook): OrderBookMetrics {
    const { bids, asks } = orderBook;
    const { topNDepth, micropriceLevels } = this.config;
    
    // Basic metrics
    const bestBid = bids[0].price;
    const bestAsk = asks[0].price;
    const mid = (bestBid + bestAsk) / 2;
    const spread = bestAsk - bestBid;
    const spreadBps = (spread / mid) * 10000;
    
    // Calculate microprice (volume-weighted price of top N levels)
    const microprice = this.calculateMicroprice(bids, asks, micropriceLevels);
    
    // Calculate order book imbalance (OBI)
    const obi = this.calculateOBI(bids, asks, topNDepth);
    
    // Calculate top N depth
    const topBidDepth = this.calculateDepth(bids, topNDepth);
    const topAskDepth = this.calculateDepth(asks, topNDepth);
    
    // Calculate queue ahead (for order placement optimization)
    const queueAhead = this.calculateQueueAhead(bids, asks);
    
    // Calculate volume-weighted mid
    const weightedMid = this.calculateWeightedMid(bids, asks);
    
    // Calculate price impact for market orders
    const impactBid = this.calculateMarketImpact(asks, 1000); // $1000 market buy
    const impactAsk = this.calculateMarketImpact(bids, 1000); // $1000 market sell
    
    return {
      mid,
      microprice,
      spread,
      spreadBps,
      obi,
      topBidDepth,
      topAskDepth,
      queueAhead,
      weightedMid,
      impactBid,
      impactAsk
    };
  }

  private calculateMicroprice(bids: L2OrderBookEntry[], asks: L2OrderBookEntry[], levels: number): number {
    const topBids = bids.slice(0, levels);
    const topAsks = asks.slice(0, levels);
    
    let bidVolume = 0;
    let askVolume = 0;
    let bidWeightedPrice = 0;
    let askWeightedPrice = 0;
    
    // Calculate weighted prices
    for (const bid of topBids) {
      bidWeightedPrice += bid.price * bid.size;
      bidVolume += bid.size;
    }
    
    for (const ask of topAsks) {
      askWeightedPrice += ask.price * ask.size;
      askVolume += ask.size;
    }
    
    if (bidVolume === 0 || askVolume === 0) {
      return (bids[0].price + asks[0].price) / 2; // Fallback to simple mid
    }
    
    const avgBidPrice = bidWeightedPrice / bidVolume;
    const avgAskPrice = askWeightedPrice / askVolume;
    
    // Weight by relative volumes
    const totalVolume = bidVolume + askVolume;
    const microprice = (avgBidPrice * askVolume + avgAskPrice * bidVolume) / totalVolume;
    
    return microprice;
  }

  private calculateOBI(bids: L2OrderBookEntry[], asks: L2OrderBookEntry[], levels: number): number {
    const topBids = bids.slice(0, levels);
    const topAsks = asks.slice(0, levels);
    
    const bidVolume = topBids.reduce((sum, entry) => sum + entry.size, 0);
    const askVolume = topAsks.reduce((sum, entry) => sum + entry.size, 0);
    
    const totalVolume = bidVolume + askVolume;
    if (totalVolume === 0) return 0;
    
    // OBI = (bidVolume - askVolume) / (bidVolume + askVolume)
    return (bidVolume - askVolume) / totalVolume;
  }

  private calculateDepth(entries: L2OrderBookEntry[], levels: number): number {
    return entries.slice(0, levels).reduce((sum, entry) => sum + entry.size, 0);
  }

  private calculateQueueAhead(bids: L2OrderBookEntry[], asks: L2OrderBookEntry[]): { bid: number, ask: number } {
    // For queue-ahead calculation, we need to know where our order would be placed
    // This is a simplified version - real implementation would consider our order size
    
    const bestBid = bids[0];
    const bestAsk = asks[0];
    
    return {
      bid: bestBid ? bestBid.size : 0, // Size ahead if we place at best bid
      ask: bestAsk ? bestAsk.size : 0  // Size ahead if we place at best ask
    };
  }

  private calculateWeightedMid(bids: L2OrderBookEntry[], asks: L2OrderBookEntry[]): number {
    const bestBid = bids[0];
    const bestAsk = asks[0];
    
    if (!bestBid || !bestAsk) return 0;
    
    const totalSize = bestBid.size + bestAsk.size;
    if (totalSize === 0) return (bestBid.price + bestAsk.price) / 2;
    
    return (bestBid.price * bestAsk.size + bestAsk.price * bestBid.size) / totalSize;
  }

  private calculateMarketImpact(entries: L2OrderBookEntry[], usdAmount: number): number {
    let remainingUsd = usdAmount;
    let totalShares = 0;
    let weightedAvgPrice = 0;
    
    for (const entry of entries) {
      const entryValue = entry.price * entry.size;
      
      if (remainingUsd <= entryValue) {
        // Partial fill of this level
        const sharesNeeded = remainingUsd / entry.price;
        totalShares += sharesNeeded;
        weightedAvgPrice += entry.price * sharesNeeded;
        break;
      } else {
        // Full fill of this level
        totalShares += entry.size;
        weightedAvgPrice += entry.price * entry.size;
        remainingUsd -= entryValue;
      }
    }
    
    if (totalShares === 0) return 0;
    
    return weightedAvgPrice / totalShares;
  }

  private updateBuffers(metrics: OrderBookMetrics, timestamp: number): void {
    // Update OBI buffer
    this.obiBuffer.push({ obi: metrics.obi, timestamp });
    
    // Update mid price buffer  
    this.midBuffer.push({ mid: metrics.mid, timestamp });
  }

  private createMarketState(metrics: OrderBookMetrics, timestamp: number): MarketState {
    return {
      mid: metrics.mid,
      microprice: metrics.microprice,
      spread: metrics.spread,
      volatility: 0, // Will be calculated by StoikovEngine
      intensity: 0,  // Will be calculated by StoikovEngine
      obi: metrics.obi,
      topBidDepth: metrics.topBidDepth,
      topAskDepth: metrics.topAskDepth,
      timestamp
    };
  }

  private cleanupOldData(): void {
    const cutoffTime = Date.now() - this.config.obiWindow;
    
    // Clean OBI buffer
    this.obiBuffer = this.obiBuffer.filter(item => item.timestamp >= cutoffTime);
    
    // Clean mid buffer
    this.midBuffer = this.midBuffer.filter(item => item.timestamp >= cutoffTime);
    
    // Clean trades buffer (keep last 5 minutes)
    const fiveMinutesAgo = Date.now() - 300000;
    this.recentTrades = this.recentTrades.filter(t => t.timestamp >= fiveMinutesAgo);
  }

  public getCurrentOrderBook(): L2OrderBook | null {
    return this.currentOrderBook;
  }

  public getLastBBO(): BBO | null {
    return this.lastBBO;
  }

  public getLastMarkData(): MarkData | null {
    return this.lastMarkData;
  }

  public getRecentTrades(windowMs: number = 60000): Trade[] {
    const cutoffTime = Date.now() - windowMs;
    return this.recentTrades.filter(t => t.timestamp >= cutoffTime);
  }

  public getSequenceGaps(): number {
    return this.sequenceGaps;
  }

  public resetSequenceGaps(): void {
    this.sequenceGaps = 0;
  }

  public updateConfig(updates: Partial<ProcessorConfig>): void {
    this.config = { ...this.config, ...updates };
    this.validateConfig();
    this.logger.info('Market data processor config updated', { updates });
    this.emit('configUpdated', this.config);
  }

  public getStats(): any {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    
    const recentTrades = this.getRecentTrades(60000);
    const tradeVolume = recentTrades.reduce((sum, t) => sum + t.size * t.price, 0);
    
    return {
      orderBookAge: this.currentOrderBook ? now - this.currentOrderBook.timestamp : null,
      bboAge: this.lastBBO ? now - this.lastBBO.timestamp : null,
      markDataAge: this.lastMarkData ? now - this.lastMarkData.timestamp : null,
      sequenceGaps: this.sequenceGaps,
      recentTradeCount: recentTrades.length,
      recentTradeVolume: tradeVolume,
      obiBufferSize: this.obiBuffer.length,
      midBufferSize: this.midBuffer.length,
      currentSpreadBps: this.currentOrderBook ? 
        ((this.currentOrderBook.asks[0].price - this.currentOrderBook.bids[0].price) / 
         ((this.currentOrderBook.asks[0].price + this.currentOrderBook.bids[0].price) / 2)) * 10000 : null
    };
  }
}
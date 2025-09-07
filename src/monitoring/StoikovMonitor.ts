import { EventEmitter } from 'events';
import { Logger } from '../core/Logger';
import { StoikovBot } from '../bots/StoikovBot';
import { StoikovQuotes } from '../engines/StoikovEngine';
import { RiskMetrics } from '../risk/RiskManager';
import winston from 'winston';

export interface StoikovKPIs {
  // Core performance metrics (스펙 요구사항)
  effectiveSpreadBps: number;        // 유효 스프레드(bp)
  fillRatio: number;                 // fill ratio (%)
  avgWaitTimeSec: number;           // 평균 대기시간 (초)
  inventoryVariance: number;         // inventory variance
  sessionDDPct: number;             // DD/세션 (%)
  repostPerSec: number;             // 재호가/초
  rejectionRate: number;            // 거절률 (%)
  
  // Extended performance metrics
  fillLatencyMs: number;            // Fill latency (ms)
  avgInventoryPct: number;          // Average inventory as % NAV
  maxInventoryPct: number;          // Peak inventory
  totalPnL: number;                 // Total PnL
  sessionPnL: number;               // Session PnL
  sharpeRatio: number;              // Risk-adjusted return
  maxDrawdownPct: number;           // Maximum drawdown
  
  // Operational metrics
  uptimeHours: number;              // Bot uptime
  totalOrders: number;              // Total orders placed
  filledOrders: number;             // Orders filled
  cancelledOrders: number;          // Orders cancelled
  avgOrderSize: number;             // Average order size
  
  // Market making quality metrics
  timeBestBidPct: number;           // Time at best bid (%)
  timeBestAskPct: number;           // Time at best ask (%)
  marketSharePct: number;           // Market share of volume
  adverseSelectionRatio: number;    // Adverse selection ratio
  inventoryTurnover: number;        // Inventory turnover rate
  
  // Risk metrics
  riskScore: number;                // Overall risk score (0-1)
  volAdjustedPnL: number;          // Volatility-adjusted PnL
  riskUtilization: number;         // Risk limit utilization
  
  // Timestamp
  timestamp: number;
  sessionStartTime: number;
}

interface PerformanceWindow {
  windowMs: number;
  data: Array<{
    timestamp: number;
    pnl: number;
    inventory: number;
    spread: number;
    fills: number;
    orders: number;
    rejections: number;
    reposts: number;
  }>;
}

interface FillAnalysis {
  fillTimes: number[];
  waitTimes: number[];
  fillPrices: number[];
  marketPrices: number[];
  adverseSelection: number[];
}

export class StoikovMonitor extends EventEmitter {
  private logger: winston.Logger;
  private bot: StoikovBot;
  private sessionStartTime: number;
  
  // Performance windows for different timeframes
  private minuteWindow: PerformanceWindow;
  private hourWindow: PerformanceWindow;
  private sessionWindow: PerformanceWindow;
  
  // Detailed tracking
  private fillAnalysis: FillAnalysis;
  private inventoryHistory: Array<{timestamp: number, inventory: number, price: number}> = [];
  private quoteHistory: Array<{timestamp: number, bid: number, ask: number, mid: number}> = [];
  private orderPlacementTimes: Map<string, number> = new Map();
  
  // Cumulative metrics
  private totalOrders: number = 0;
  private filledOrders: number = 0;
  private cancelledOrders: number = 0;
  private rejectedOrders: number = 0;
  private totalRepostCount: number = 0;
  private totalVolume: number = 0;
  private totalFees: number = 0;
  
  // Market making quality tracking
  private bestBidTime: number = 0;
  private bestAskTime: number = 0;
  private totalActiveTime: number = 0;
  private lastCheckTime: number = 0;
  
  // PnL tracking
  private sessionPnLHistory: number[] = [];
  private sessionHighWaterMark: number = 0;
  private maxDrawdown: number = 0;

  constructor(bot: StoikovBot) {
    super();
    this.bot = bot;
    this.logger = Logger.getInstance().child({ module: 'StoikovMonitor', botId: bot.getConfig().id });
    this.sessionStartTime = Date.now();
    this.lastCheckTime = Date.now();
    
    this.initializeWindows();
    this.initializeFillAnalysis();
    this.setupEventListeners();
    this.startPeriodicTasks();
    
    this.logger.info(`StoikovMonitor initialized for bot ${bot.getConfig().id}`);
  }

  private initializeWindows(): void {
    this.minuteWindow = { windowMs: 60000, data: [] };      // 1 minute
    this.hourWindow = { windowMs: 3600000, data: [] };      // 1 hour  
    this.sessionWindow = { windowMs: Infinity, data: [] };   // Entire session
  }

  private initializeFillAnalysis(): void {
    this.fillAnalysis = {
      fillTimes: [],
      waitTimes: [],
      fillPrices: [],
      marketPrices: [],
      adverseSelection: []
    };
  }

  private setupEventListeners(): void {
    // Listen to bot events for tracking
    // Note: These would need to be exposed by the StoikovBot
    this.bot.on('orderPlaced', this.onOrderPlaced.bind(this));
    this.bot.on('orderFilled', this.onOrderFilled.bind(this));
    this.bot.on('orderCancelled', this.onOrderCancelled.bind(this));
    this.bot.on('orderRejected', this.onOrderRejected.bind(this));
    this.bot.on('quoteUpdated', this.onQuoteUpdated.bind(this));
    this.bot.on('inventoryUpdated', this.onInventoryUpdated.bind(this));
    this.bot.on('repostOccurred', this.onRepostOccurred.bind(this));
  }

  private startPeriodicTasks(): void {
    // Update KPIs every 5 seconds
    setInterval(() => {
      this.updatePerformanceWindows();
      this.updateMarketMakingQuality();
      this.cleanupOldData();
    }, 5000);
    
    // Emit KPI updates every 30 seconds
    setInterval(() => {
      const kpis = this.calculateKPIs();
      this.emit('kpiUpdate', kpis);
      this.logger.debug('KPI update', kpis);
    }, 30000);
    
    // Detailed analysis every 5 minutes
    setInterval(() => {
      this.performDetailedAnalysis();
    }, 300000);
  }

  private updatePerformanceWindows(): void {
    const now = Date.now();
    const botState = this.bot.getBotState();
    const riskMetrics = this.bot.getRiskMetrics();
    const quotes = this.bot.getCurrentQuotes();
    
    const dataPoint = {
      timestamp: now,
      pnl: botState.sessionPnL,
      inventory: botState.currentInventory?.navPct || 0,
      spread: quotes ? (quotes.askPrice - quotes.bidPrice) / quotes.reservationPrice * 10000 : 0,
      fills: botState.totalTrades,
      orders: this.totalOrders,
      rejections: this.rejectedOrders,
      reposts: this.totalRepostCount
    };
    
    // Add to all windows
    this.minuteWindow.data.push(dataPoint);
    this.hourWindow.data.push(dataPoint);
    this.sessionWindow.data.push(dataPoint);
    
    // Clean old data from time-based windows
    const cutoffMinute = now - this.minuteWindow.windowMs;
    const cutoffHour = now - this.hourWindow.windowMs;
    
    this.minuteWindow.data = this.minuteWindow.data.filter(d => d.timestamp >= cutoffMinute);
    this.hourWindow.data = this.hourWindow.data.filter(d => d.timestamp >= cutoffHour);
  }

  private updateMarketMakingQuality(): void {
    const now = Date.now();
    const timeDelta = now - this.lastCheckTime;
    this.totalActiveTime += timeDelta;
    
    // Check if we're at best bid/ask
    const quotes = this.bot.getCurrentQuotes();
    const marketState = this.bot.getBotState().currentMarket;
    
    if (quotes && marketState) {
      // Simplified check - real implementation would compare with exchange orderbook
      const atBestBid = Math.abs(quotes.bidPrice - marketState.mid + marketState.spread/2) < 0.001;
      const atBestAsk = Math.abs(quotes.askPrice - marketState.mid - marketState.spread/2) < 0.001;
      
      if (atBestBid) this.bestBidTime += timeDelta;
      if (atBestAsk) this.bestAskTime += timeDelta;
    }
    
    this.lastCheckTime = now;
  }

  private cleanupOldData(): void {
    const oneHourAgo = Date.now() - 3600000;
    
    // Clean fill analysis data (keep 1 hour)
    this.inventoryHistory = this.inventoryHistory.filter(h => h.timestamp >= oneHourAgo);
    this.quoteHistory = this.quoteHistory.filter(h => h.timestamp >= oneHourAgo);
    
    // Clean order placement times (keep 1 hour)
    for (const [orderId, timestamp] of this.orderPlacementTimes.entries()) {
      if (timestamp < oneHourAgo) {
        this.orderPlacementTimes.delete(orderId);
      }
    }
    
    // Trim fill analysis arrays (keep last 1000 entries)
    const maxEntries = 1000;
    if (this.fillAnalysis.fillTimes.length > maxEntries) {
      Object.keys(this.fillAnalysis).forEach(key => {
        this.fillAnalysis[key as keyof FillAnalysis] = 
          (this.fillAnalysis[key as keyof FillAnalysis] as number[]).slice(-maxEntries);
      });
    }
  }

  private performDetailedAnalysis(): void {
    const kpis = this.calculateKPIs();
    
    // Analyze performance trends
    const trends = this.analyzeTrends();
    
    // Identify potential issues
    const issues = this.identifyIssues(kpis);
    
    // Emit detailed analysis
    this.emit('detailedAnalysis', {
      kpis,
      trends,
      issues,
      timestamp: Date.now()
    });
    
    if (issues.length > 0) {
      this.logger.warn('Performance issues detected', { issues });
    }
  }

  private analyzeTrends(): any {
    const hourData = this.hourWindow.data;
    if (hourData.length < 2) return null;
    
    const recent = hourData.slice(-12); // Last hour (5s intervals)
    const older = hourData.slice(-24, -12); // Previous hour
    
    if (recent.length < 6 || older.length < 6) return null;
    
    const recentAvg = {
      pnl: recent.reduce((sum, d) => sum + d.pnl, 0) / recent.length,
      fillRatio: recent.reduce((sum, d) => sum + d.fills, 0) / recent.reduce((sum, d) => sum + d.orders, 0) * 100,
      spread: recent.reduce((sum, d) => sum + d.spread, 0) / recent.length
    };
    
    const olderAvg = {
      pnl: older.reduce((sum, d) => sum + d.pnl, 0) / older.length,
      fillRatio: older.reduce((sum, d) => sum + d.fills, 0) / older.reduce((sum, d) => sum + d.orders, 0) * 100,
      spread: older.reduce((sum, d) => sum + d.spread, 0) / older.length
    };
    
    return {
      pnlTrend: recentAvg.pnl - olderAvg.pnl,
      fillRatioTrend: recentAvg.fillRatio - olderAvg.fillRatio,
      spreadTrend: recentAvg.spread - olderAvg.spread
    };
  }

  private identifyIssues(kpis: StoikovKPIs): string[] {
    const issues: string[] = [];
    
    // Check for performance issues
    if (kpis.fillRatio < 30) issues.push('Low fill ratio (<30%)');
    if (kpis.rejectionRate > 10) issues.push('High rejection rate (>10%)');
    if (kpis.avgWaitTimeSec > 5) issues.push('High average wait time (>5s)');
    if (kpis.effectiveSpreadBps < 1) issues.push('Very tight spreads (<1bp)');
    if (kpis.maxInventoryPct > 80) issues.push('High inventory risk (>80% of limit)');
    if (kpis.sessionDDPct > 50) issues.push('High session drawdown (>50% of limit)');
    if (kpis.riskScore > 0.8) issues.push('High risk score (>0.8)');
    
    // Check for operational issues
    if (kpis.repostPerSec > 5) issues.push('Excessive reposting (>5/sec)');
    if (kpis.timeBestBidPct < 10 && kpis.timeBestAskPct < 10) issues.push('Rarely at best prices');
    if (kpis.fillLatencyMs > 500) issues.push('High fill latency (>500ms)');
    
    return issues;
  }

  public calculateKPIs(): StoikovKPIs {
    const botState = this.bot.getBotState();
    const executionStats = this.bot.getExecutionStats();
    const riskMetrics = this.bot.getRiskMetrics();
    const stoikovKPIs = this.bot.getStoikovKPIs();
    const now = Date.now();
    
    // Calculate time-based metrics
    const uptimeMs = now - this.sessionStartTime;
    const uptimeHours = uptimeMs / (1000 * 60 * 60);
    
    // Calculate effective spread
    const recentQuotes = this.quoteHistory.slice(-20); // Last 20 quotes
    const avgSpreadBps = recentQuotes.length > 0 ? 
      recentQuotes.reduce((sum, q) => sum + (q.ask - q.bid) / q.mid * 10000, 0) / recentQuotes.length : 0;
    
    // Calculate fill ratio
    const fillRatio = this.totalOrders > 0 ? (this.filledOrders / this.totalOrders) * 100 : 0;
    
    // Calculate average wait time
    const avgWaitTime = this.fillAnalysis.waitTimes.length > 0 ?
      this.fillAnalysis.waitTimes.reduce((a, b) => a + b, 0) / this.fillAnalysis.waitTimes.length / 1000 : 0;
    
    // Calculate inventory variance
    const inventoryValues = this.inventoryHistory.slice(-100).map(h => h.inventory);
    const inventoryVariance = inventoryValues.length > 1 ? this.calculateVariance(inventoryValues) : 0;
    
    // Calculate repost rate (per second)
    const repostPerSec = uptimeMs > 0 ? this.totalRepostCount / (uptimeMs / 1000) : 0;
    
    // Calculate rejection rate
    const rejectionRate = this.totalOrders > 0 ? (this.rejectedOrders / this.totalOrders) * 100 : 0;
    
    // Calculate market making quality
    const timeBestBidPct = this.totalActiveTime > 0 ? (this.bestBidTime / this.totalActiveTime) * 100 : 0;
    const timeBestAskPct = this.totalActiveTime > 0 ? (this.bestAskTime / this.totalActiveTime) * 100 : 0;
    
    // Calculate adverse selection ratio
    const adverseSelectionRatio = this.fillAnalysis.adverseSelection.length > 0 ?
      this.fillAnalysis.adverseSelection.reduce((a, b) => a + b, 0) / this.fillAnalysis.adverseSelection.length : 0;
    
    // Calculate Sharpe ratio (simplified)
    const returns = this.sessionPnLHistory.slice(-100);
    const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const returnVariance = returns.length > 1 ? this.calculateVariance(returns) : 1;
    const sharpeRatio = returnVariance > 0 ? avgReturn / Math.sqrt(returnVariance) : 0;
    
    // Calculate inventory turnover
    const totalTradedVolume = this.totalVolume;
    const avgInventoryValue = inventoryValues.length > 0 ?
      inventoryValues.reduce((a, b) => a + b, 0) / inventoryValues.length : 1;
    const inventoryTurnover = avgInventoryValue > 0 ? totalTradedVolume / avgInventoryValue : 0;
    
    return {
      // Core KPIs (spec requirements)
      effectiveSpreadBps: avgSpreadBps,
      fillRatio,
      avgWaitTimeSec: avgWaitTime,
      inventoryVariance,
      sessionDDPct: riskMetrics?.sessionDDPct || 0,
      repostPerSec,
      rejectionRate,
      
      // Extended performance metrics
      fillLatencyMs: executionStats?.averageFillTime || 0,
      avgInventoryPct: inventoryValues.length > 0 ? 
        inventoryValues.reduce((a, b) => a + b, 0) / inventoryValues.length : 0,
      maxInventoryPct: riskMetrics?.inventoryPct || 0,
      totalPnL: botState.sessionPnL + botState.dailyPnL,
      sessionPnL: botState.sessionPnL,
      sharpeRatio,
      maxDrawdownPct: this.maxDrawdown,
      
      // Operational metrics
      uptimeHours,
      totalOrders: this.totalOrders,
      filledOrders: this.filledOrders,
      cancelledOrders: this.cancelledOrders,
      avgOrderSize: this.totalOrders > 0 ? this.totalVolume / this.totalOrders : 0,
      
      // Market making quality metrics
      timeBestBidPct,
      timeBestAskPct,
      marketSharePct: 0, // Would need market volume data
      adverseSelectionRatio,
      inventoryTurnover,
      
      // Risk metrics
      riskScore: riskMetrics?.overallRiskScore || 0,
      volAdjustedPnL: stoikovKPIs?.totalPnL || 0, // Would need volatility adjustment
      riskUtilization: riskMetrics?.inventoryRisk || 0,
      
      // Timestamp
      timestamp: now,
      sessionStartTime: this.sessionStartTime
    };
  }

  private calculateVariance(values: number[]): number {
    if (values.length < 2) return 0;
    
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const squaredDiffs = values.map(value => Math.pow(value - mean, 2));
    return squaredDiffs.reduce((a, b) => a + b, 0) / (values.length - 1);
  }

  // Event handlers
  private onOrderPlaced(event: any): void {
    this.totalOrders++;
    this.orderPlacementTimes.set(event.clientOrderId, Date.now());
  }

  private onOrderFilled(event: any): void {
    this.filledOrders++;
    this.totalVolume += event.size * event.price;
    
    // Track fill timing
    const placementTime = this.orderPlacementTimes.get(event.clientOrderId);
    if (placementTime) {
      const waitTime = Date.now() - placementTime;
      this.fillAnalysis.waitTimes.push(waitTime);
      this.orderPlacementTimes.delete(event.clientOrderId);
    }
    
    // Track adverse selection
    const marketState = this.bot.getBotState().currentMarket;
    if (marketState) {
      const midPrice = marketState.mid;
      const fillPrice = event.price;
      const adverseSelection = event.side === 'buy' ? 
        (fillPrice - midPrice) / midPrice : (midPrice - fillPrice) / midPrice;
      this.fillAnalysis.adverseSelection.push(adverseSelection);
    }
    
    this.fillAnalysis.fillPrices.push(event.price);
  }

  private onOrderCancelled(event: any): void {
    this.cancelledOrders++;
    this.orderPlacementTimes.delete(event.clientOrderId);
  }

  private onOrderRejected(event: any): void {
    this.rejectedOrders++;
    this.orderPlacementTimes.delete(event.clientOrderId);
  }

  private onQuoteUpdated(event: any): void {
    this.quoteHistory.push({
      timestamp: Date.now(),
      bid: event.bidPrice,
      ask: event.askPrice,
      mid: event.reservationPrice
    });
  }

  private onInventoryUpdated(event: any): void {
    const marketState = this.bot.getBotState().currentMarket;
    if (marketState) {
      this.inventoryHistory.push({
        timestamp: Date.now(),
        inventory: event.inventory.navPct,
        price: marketState.mid
      });
    }
    
    // Update session PnL tracking
    this.sessionPnLHistory.push(event.inventory.unrealizedPnl);
    this.sessionHighWaterMark = Math.max(this.sessionHighWaterMark, event.inventory.unrealizedPnl);
    
    // Update max drawdown
    const currentDrawdown = (this.sessionHighWaterMark - event.inventory.unrealizedPnl) / 
      Math.abs(this.sessionHighWaterMark) * 100;
    this.maxDrawdown = Math.max(this.maxDrawdown, currentDrawdown);
  }

  private onRepostOccurred(event: any): void {
    this.totalRepostCount++;
  }

  // Public methods
  public getDetailedStats(): any {
    const kpis = this.calculateKPIs();
    
    return {
      kpis,
      windows: {
        minute: this.minuteWindow.data.slice(-12), // Last minute
        hour: this.hourWindow.data.slice(-12),    // Last hour sample
        session: this.sessionWindow.data.length   // Session data count
      },
      fillAnalysis: {
        totalFills: this.fillAnalysis.fillTimes.length,
        avgFillTime: this.fillAnalysis.fillTimes.length > 0 ? 
          this.fillAnalysis.fillTimes.reduce((a, b) => a + b, 0) / this.fillAnalysis.fillTimes.length : 0,
        avgAdverseSelection: this.fillAnalysis.adverseSelection.length > 0 ?
          this.fillAnalysis.adverseSelection.reduce((a, b) => a + b, 0) / this.fillAnalysis.adverseSelection.length : 0,
      },
      summary: {
        totalOrders: this.totalOrders,
        filledOrders: this.filledOrders,
        cancelledOrders: this.cancelledOrders,
        rejectedOrders: this.rejectedOrders,
        totalVolume: this.totalVolume,
        totalFees: this.totalFees,
        sessionRuntime: Date.now() - this.sessionStartTime
      }
    };
  }

  public reset(): void {
    this.sessionStartTime = Date.now();
    this.initializeWindows();
    this.initializeFillAnalysis();
    
    // Reset counters
    this.totalOrders = 0;
    this.filledOrders = 0;
    this.cancelledOrders = 0;
    this.rejectedOrders = 0;
    this.totalRepostCount = 0;
    this.totalVolume = 0;
    this.totalFees = 0;
    
    // Reset tracking arrays
    this.inventoryHistory = [];
    this.quoteHistory = [];
    this.orderPlacementTimes.clear();
    this.sessionPnLHistory = [];
    this.sessionHighWaterMark = 0;
    this.maxDrawdown = 0;
    
    // Reset quality metrics
    this.bestBidTime = 0;
    this.bestAskTime = 0;
    this.totalActiveTime = 0;
    this.lastCheckTime = Date.now();
    
    this.logger.info('StoikovMonitor reset');
  }

  public exportData(): any {
    return {
      kpis: this.calculateKPIs(),
      detailedStats: this.getDetailedStats(),
      rawData: {
        inventoryHistory: this.inventoryHistory,
        quoteHistory: this.quoteHistory,
        fillAnalysis: this.fillAnalysis,
        performanceWindows: {
          minute: this.minuteWindow.data,
          hour: this.hourWindow.data,
          session: this.sessionWindow.data.slice(0, 1000) // Limit session data
        }
      },
      metadata: {
        botId: this.bot.getConfig().id,
        sessionStart: this.sessionStartTime,
        exportTime: Date.now()
      }
    };
  }
}
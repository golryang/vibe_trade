import { BaseBot } from '../core/BaseBot';
import { BaseExchange } from '../exchanges/BaseExchange';
import { StoikovEngine, StoikovParams, StoikovQuotes, InventoryState, MarketState } from '../engines/StoikovEngine';
import { MarketDataProcessor, ProcessorConfig, L2OrderBook, Trade, BBO, MarkData } from '../data/MarketDataProcessor';
import { ExecutionEngine, ExecutionConfig, OrderState } from '../execution/ExecutionEngine';
import { RiskManager, RiskLimits, RiskMetrics } from '../risk/RiskManager';
import { BotConfig } from '../types';

interface StoikovBotConfig extends BotConfig {
  parameters: {
    // Stoikov core parameters
    gamma: number;
    volatilityWindow: number;
    intensityWindow: number;
    maxInventoryPct: number;
    
    // Market data parameters
    topNDepth: number;
    obiWeight: number;
    micropriceBias: boolean;
    
    // Execution parameters
    postOnlyOffset: number;
    ttlMs: number;
    repostMs: number;
    ladderLevels: number;
    alphaSizeRatio: number;
    
    // Risk parameters
    driftCutBps: number;
    sessionDDLimitPct: number;
    maxConsecutiveFails: number;
    
    // Regime parameters
    timezoneProfile: 'asia' | 'eu' | 'us' | 'global';
    volRegimeScaler: number;
    
    // Exchange-specific
    exchange: string;
    symbol: string;
  };
}

interface BotState {
  isRunning: boolean;
  lastQuoteTime: number;
  lastTradeTime: number;
  totalTrades: number;
  sessionPnL: number;
  dailyPnL: number;
  currentInventory: InventoryState | null;
  currentMarket: MarketState | null;
  riskMetrics: RiskMetrics | null;
  executionStats: any;
}

export class StoikovBot extends BaseBot {
  private exchange: BaseExchange;
  private stoikovEngine: StoikovEngine;
  private marketProcessor: MarketDataProcessor;
  private executionEngine: ExecutionEngine;
  private riskManager: RiskManager;
  
  private botState: BotState;
  private lastInventoryUpdate: number = 0;
  private quoteUpdateInterval: NodeJS.Timeout | null = null;
  private startTime: number = 0;

  constructor(config: StoikovBotConfig, exchange: BaseExchange) {
    super(config);
    
    if (!exchange) {
      throw new Error('Exchange is required for StoikovBot');
    }
    
    this.exchange = exchange;
    this.initializeState();
    
    try {
      this.initializeEngines(config);
      this.setupEventListeners();
    } catch (error) {
      this.logger.error('Failed to initialize StoikovBot engines:', error);
      throw error;
    }
    
    this.logger.info(`StoikovBot ${config.id} created`, {
      exchange: exchange.getName(),
      symbol: config.parameters.symbol
    });
  }

  private initializeState(): void {
    this.botState = {
      isRunning: false,
      lastQuoteTime: 0,
      lastTradeTime: 0,
      totalTrades: 0,
      sessionPnL: 0,
      dailyPnL: 0,
      currentInventory: null,
      currentMarket: null,
      riskMetrics: null,
      executionStats: null
    };
  }

  private initializeEngines(config: StoikovBotConfig): void {
    const params = config.parameters;
    
    // Initialize Stoikov mathematical engine
    const stoikovParams: StoikovParams = {
      gamma: params.gamma,
      volatilityWindow: params.volatilityWindow,
      intensityWindow: params.intensityWindow,
      maxInventoryPct: params.maxInventoryPct,
      obiWeight: params.obiWeight,
      micropriceBias: params.micropriceBias,
      topNDepth: params.topNDepth,
      postOnlyOffset: params.postOnlyOffset,
      ttlMs: params.ttlMs,
      repostMs: params.repostMs,
      ladderLevels: params.ladderLevels,
      alphaSizeRatio: params.alphaSizeRatio,
      driftCutBps: params.driftCutBps,
      sessionDDLimitPct: params.sessionDDLimitPct,
      maxConsecutiveFails: params.maxConsecutiveFails,
      timezoneProfile: params.timezoneProfile,
      volRegimeScaler: params.volRegimeScaler
    };
    
    this.stoikovEngine = new StoikovEngine(stoikovParams);
    
    // Initialize market data processor
    const processorConfig: ProcessorConfig = {
      topNDepth: params.topNDepth,
      obiWindow: params.volatilityWindow,
      micropriceLevels: 5,
      queueThreshold: 1000,
      sequenceTimeout: 5000,
      enableMark: true
    };
    
    this.marketProcessor = new MarketDataProcessor(processorConfig);
    
    // Initialize execution engine
    const executionConfig: ExecutionConfig = {
      postOnlyOffset: params.postOnlyOffset,
      ttlMs: params.ttlMs,
      repostMs: params.repostMs,
      maxRetries: 3,
      ladderLevels: params.ladderLevels,
      partialFillThresholdPct: 10,
      queueAheadThreshold: 1000,
      priceToleranceTicks: 2,
      flattenTimeoutMs: 5000,
      cooldownMs: 30000,
      fillLatencyTarget: 100,
      repostRateLimit: 10
    };
    
    this.executionEngine = new ExecutionEngine(executionConfig);
    
    // Initialize risk manager
    const riskLimits: RiskLimits = {
      maxInventoryPct: params.maxInventoryPct,
      inventoryWarningPct: 80,
      driftCutBps: params.driftCutBps,
      driftWarningBps: 80,
      sessionDDLimitPct: params.sessionDDLimitPct,
      dailyDDLimitPct: params.sessionDDLimitPct * 2,
      ddWarningPct: 80,
      maxConsecutiveFails: params.maxConsecutiveFails,
      maxOrdersPerSecond: 5,
      maxSpreadMultiplier: 3,
      volSpikeThresholdPct: 200,
      volSpikeCooldownMs: 60000,
      enableEmergencyStop: true,
      enableNewsStop: true,
      newsStopDurationMs: 300000
    };
    
    this.riskManager = new RiskManager(riskLimits);
  }

  private setupEventListeners(): void {
    // Market data events
    if (this.marketProcessor && typeof this.marketProcessor.on === 'function') {
      this.marketProcessor.on('marketStateUpdate', this.onMarketStateUpdate.bind(this));
      this.marketProcessor.on('tradeProcessed', this.onTradeProcessed.bind(this));
    }
    
    // Stoikov engine events
    if (this.stoikovEngine && typeof this.stoikovEngine.on === 'function') {
      this.stoikovEngine.on('quotesCalculated', this.onQuotesCalculated.bind(this));
    }
    
    // Execution engine events
    if (this.executionEngine && typeof this.executionEngine.on === 'function') {
      this.executionEngine.on('placeOrder', this.onPlaceOrder.bind(this));
      this.executionEngine.on('cancelOrder', this.onCancelOrder.bind(this));
      this.executionEngine.on('cancelReplaceOrder', this.onCancelReplaceOrder.bind(this));
      this.executionEngine.on('partialFill', this.onPartialFill.bind(this));
      this.executionEngine.on('fullFill', this.onFullFill.bind(this));
      this.executionEngine.on('requiresRequote', this.onRequiresRequote.bind(this));
      this.executionEngine.on('flattenPosition', this.onFlattenPosition.bind(this));
    }
    
    // Risk manager events
    if (this.riskManager && typeof this.riskManager.on === 'function') {
      this.riskManager.on('riskEvent', this.onRiskEvent.bind(this));
      this.riskManager.on('flattenRequired', this.onFlattenRequired.bind(this));
      this.riskManager.on('emergencyStop', this.onEmergencyStop.bind(this));
      this.riskManager.on('riskWarning', this.onRiskWarning.bind(this));
    }
    
    // Exchange events
    if (this.exchange && typeof this.exchange.on === 'function') {
      this.exchange.on('orderBook', this.onOrderBook.bind(this));
      this.exchange.on('trade', this.onTrade.bind(this));
      this.exchange.on('orderUpdate', this.onOrderUpdate.bind(this));
      this.exchange.on('error', this.onExchangeError.bind(this));
    }
  }

  protected async initialize(): Promise<void> {
    const config = this.config as StoikovBotConfig;
    this.logger.info(`Initializing StoikovBot ${config.id}`);
    
    try {
      // Connect to exchange if not connected
      if (!this.exchange.isConnected()) {
        await this.exchange.connect();
      }
      
      // Subscribe to market data
      await this.exchange.subscribeToOrderBook(config.parameters.symbol);
      await this.exchange.subscribeToTrades(config.parameters.symbol);
      
      // Initialize inventory state
      await this.updateInventoryFromExchange();
      
      // Start quote update loop
      this.startQuoteUpdateLoop();
      
      this.botState.isRunning = true;
      this.startTime = Date.now();
      
      this.logger.info(`StoikovBot ${config.id} initialized successfully`);
      
    } catch (error) {
      this.logger.error(`Failed to initialize StoikovBot ${config.id}:`, error);
      throw error;
    }
  }

  protected async cleanup(): Promise<void> {
    const config = this.config as StoikovBotConfig;
    this.logger.info(`Cleaning up StoikovBot ${config.id}`);
    
    try {
      this.botState.isRunning = false;
      
      // Stop quote updates
      if (this.quoteUpdateInterval) {
        clearInterval(this.quoteUpdateInterval);
        this.quoteUpdateInterval = null;
      }
      
      // Flatten position if not already flat
      if (this.botState.currentInventory && !this.botState.currentInventory.position) {
        await this.flattenPosition();
      }
      
      // Unsubscribe from market data
      await this.exchange.unsubscribeFromOrderBook(config.parameters.symbol);
      await this.exchange.unsubscribeFromTrades(config.parameters.symbol);
      
      // Reset execution engine
      this.executionEngine.reset();
      
      this.logger.info(`StoikovBot ${config.id} cleanup complete`);
      
    } catch (error) {
      this.logger.error(`Error during StoikovBot cleanup:`, error);
      throw error;
    }
  }

  private startQuoteUpdateLoop(): void {
    // Update quotes every 100ms or when required
    this.quoteUpdateInterval = setInterval(() => {
      if (this.botState.isRunning && this.riskManager.canTrade()) {
        this.updateQuotes();
      }
    }, 100);
  }

  private async updateQuotes(): Promise<void> {
    try {
      // Calculate new quotes
      const quotes = this.stoikovEngine.calculateQuotes();
      if (!quotes) {
        this.logger.debug('No quotes calculated, waiting for more data');
        return;
      }
      
      // Apply risk adjustments
      const adjustedQuotes = this.applyRiskAdjustments(quotes);
      
      // Place quotes via execution engine
      await this.executionEngine.placeQuotes(adjustedQuotes);
      
      this.botState.lastQuoteTime = Date.now();
      
    } catch (error) {
      this.logger.error('Error updating quotes:', error);
      this.riskManager.recordFailure('quoteUpdateFailed');
    }
  }

  private applyRiskAdjustments(quotes: StoikovQuotes): StoikovQuotes {
    const sizeMultiplier = this.riskManager.getSizeMultiplier();
    const spreadMultiplier = this.riskManager.getSpreadMultiplier();
    
    return {
      ...quotes,
      bidSize: quotes.bidSize * sizeMultiplier,
      askSize: quotes.askSize * sizeMultiplier,
      halfSpread: quotes.halfSpread * spreadMultiplier,
      bidPrice: quotes.reservationPrice - (quotes.halfSpread * spreadMultiplier),
      askPrice: quotes.reservationPrice + (quotes.halfSpread * spreadMultiplier)
    };
  }

  private async updateInventoryFromExchange(): Promise<void> {
    try {
      const positions = await this.exchange.getPositions();
      const config = this.config as StoikovBotConfig;
      
      // Find position for our symbol
      const position = positions.find(p => p.symbol === config.parameters.symbol);
      
      const inventoryState: InventoryState = {
        position: position ? position.size * (position.side === 'long' ? 1 : -1) : 0,
        navPct: position ? Math.abs(position.size * position.markPrice) / 10000 * 100 : 0, // Assume 10k NAV
        entryPrice: position ? position.entryPrice : 0,
        unrealizedPnl: position ? position.unrealizedPnl : 0,
        drift: 0 // Will be calculated
      };
      
      this.botState.currentInventory = inventoryState;
      this.stoikovEngine.updateInventory(inventoryState);
      this.riskManager.updateInventory(inventoryState);
      
      this.lastInventoryUpdate = Date.now();
      
    } catch (error) {
      this.logger.error('Failed to update inventory from exchange:', error);
    }
  }

  private async flattenPosition(): Promise<void> {
    this.logger.warn('Flattening position');
    
    try {
      if (!this.botState.currentInventory || Math.abs(this.botState.currentInventory.position) < 0.001) {
        this.logger.info('No position to flatten');
        return;
      }
      
      const config = this.config as StoikovBotConfig;
      const position = this.botState.currentInventory.position;
      
      // Place IOC order to flatten position
      const side = position > 0 ? 'sell' : 'buy';
      const size = Math.abs(position);
      
      await this.exchange.placeOrder({
        symbol: config.parameters.symbol,
        side,
        type: 'market',
        amount: size,
        exchange: this.exchange.getName()
      });
      
      this.logger.info(`Flatten order placed: ${side} ${size}`);
      
    } catch (error) {
      this.logger.error('Failed to flatten position:', error);
    }
  }

  // Event handlers
  private onMarketStateUpdate(marketState: MarketState): void {
    this.botState.currentMarket = marketState;
    this.stoikovEngine.updateMarketState(marketState);
    this.riskManager.updateVolatility(marketState.volatility);
  }

  private onTradeProcessed(trade: Trade): void {
    this.stoikovEngine.addTrade(trade.price, trade.size, trade.side, trade.timestamp);
    this.botState.lastTradeTime = trade.timestamp;
  }

  private onQuotesCalculated(quotes: StoikovQuotes): void {
    // Quotes will be handled by the quote update loop
    this.logger.debug('New quotes calculated', {
      bidPrice: quotes.bidPrice,
      askPrice: quotes.askPrice,
      spread: (quotes.askPrice - quotes.bidPrice) * 10000 // in bps
    });
  }

  private async onPlaceOrder(orderRequest: any): Promise<void> {
    try {
      this.riskManager.recordOrderRate();
      
      // Convert quote-size to base quantity (Binance Futures expects base asset quantity)
      const symbol = (this.config as StoikovBotConfig).parameters.symbol;
      const price: number = orderRequest.price;
      const quoteSize: number = orderRequest.size;
      const baseQty = Math.max(Number((quoteSize / price).toFixed(6)), 0.000001);

      const order = await this.exchange.placeOrder({
        symbol,
        side: orderRequest.side,
        type: 'limit',
        amount: baseQty,
        price,
        exchange: this.exchange.getName()
      } as any);
      
      this.logger.debug('Order placed', { clientOrderId: orderRequest.clientOrderId, orderId: order.id });
      // Feed back ack to execution engine so it can store exchange orderId
      this.executionEngine.handleOrderUpdate({
        clientOrderId: orderRequest.clientOrderId,
        orderId: order.id,
        status: 'NEW'
      });
      
    } catch (error) {
      this.logger.error('Failed to place order:', error);
      this.riskManager.recordFailure('orderPlacementFailed');
    }
  }

  private async onCancelOrder(cancelRequest: any): Promise<void> {
    try {
      const config = this.config as StoikovBotConfig;
      await this.exchange.cancelOrder(cancelRequest.orderId, config.parameters.symbol);
      
      this.logger.debug('Order cancelled', { orderId: cancelRequest.orderId });
      
    } catch (error) {
      this.logger.error('Failed to cancel order:', error);
      this.riskManager.recordFailure('orderCancellationFailed');
    }
  }

  private async onCancelReplaceOrder(replaceRequest: any): Promise<void> {
    try {
      // Cancel old order and place new one (simplified - real implementation might use native cancel-replace)
      const config = this.config as StoikovBotConfig;
      await this.exchange.cancelOrder(replaceRequest.orderId, config.parameters.symbol);
      
      // Place new order
      await this.exchange.placeOrder({
        symbol: config.parameters.symbol,
        side: replaceRequest.side,
        type: 'limit',
        amount: replaceRequest.newSize,
        price: replaceRequest.newPrice,
        exchange: this.exchange.getName()
      });
      
      this.logger.debug('Order replaced', { oldOrderId: replaceRequest.orderId });
      
    } catch (error) {
      this.logger.error('Failed to replace order:', error);
      this.riskManager.recordFailure('orderReplaceFailed');
    }
  }

  private onPartialFill(fillEvent: any): void {
    this.logger.info('Partial fill received', fillEvent);
    this.updateInventoryFromExchange();
    this.botState.totalTrades++;
  }

  private onFullFill(fillEvent: any): void {
    this.logger.info('Full fill received', fillEvent);
    this.updateInventoryFromExchange();
    this.botState.totalTrades++;
    
    // Update metrics
    this.metrics.totalTrades = this.botState.totalTrades;
  }

  private onRequiresRequote(event: any): void {
    this.logger.debug('Requote required', { reason: event.reason });
    // Will be handled by quote update loop
  }

  private onFlattenPosition(): void {
    this.flattenPosition();
  }

  private onRiskEvent(event: any): void {
    this.logger.warn('Risk event occurred', event);
  }

  private onFlattenRequired(event: any): void {
    this.logger.warn('Flatten required by risk manager', event);
    this.flattenPosition();
  }

  private onEmergencyStop(event: any): void {
    this.logger.error('Emergency stop triggered', event);
    this.botState.isRunning = false;
    this.flattenPosition();
  }

  private onRiskWarning(event: any): void {
    this.logger.warn('Risk warning', event);
  }

  // Exchange event handlers
  private onOrderBook(orderBook: any): void {
    // Convert to our format and process
    const l2OrderBook = {
      bids: orderBook.bids || [],
      asks: orderBook.asks || [],
      sequence: orderBook.sequence || 0,
      timestamp: orderBook.timestamp || Date.now()
    };
    
    this.marketProcessor.processOrderBook(l2OrderBook);
  }

  private onTrade(trade: any): void {
    const processedTrade: Trade = {
      price: trade.price,
      size: trade.size,
      side: trade.side,
      timestamp: trade.timestamp || Date.now()
    };
    
    this.marketProcessor.processTrade(processedTrade);
  }

  private onOrderUpdate(orderUpdate: any): void {
    this.executionEngine.handleOrderUpdate(orderUpdate);
  }

  private onExchangeError(error: Error): void {
    this.logger.error('Exchange error:', error);
    this.riskManager.recordFailure('exchangeError');
  }

  // BaseBot implementation
  protected onMarketData(data: any): void {
    // Handled by specific event handlers
  }

  protected onOrderUpdate(data: any): void {
    // Handled by execution engine
  }

  protected onPositionUpdate(data: any): void {
    // Handled by inventory updates
  }

  protected onConfigUpdate(config: Partial<BotConfig>): void {
    this.logger.info('Config update received', config);
    // TODO: Update engine configurations
  }

  // Public getters
  public getBotState(): BotState {
    return { ...this.botState };
  }

  public getRiskMetrics(): RiskMetrics | null {
    return this.riskManager.getMetrics();
  }

  public getExecutionStats(): any {
    return this.executionEngine.getStats();
  }

  public getStoikovKPIs(): any {
    return this.stoikovEngine.calculateKPIs();
  }

  public getMarketDataStats(): any {
    return this.marketProcessor.getStats();
  }

  public getCurrentQuotes(): StoikovQuotes | null {
    return this.stoikovEngine.getLastQuotes();
  }

  // Manual controls
  public async emergencyStop(): Promise<void> {
    this.riskManager.emergencyStop('manualStop');
  }

  public async resetEmergencyStop(): Promise<void> {
    this.riskManager.resetEmergencyStop();
    this.botState.isRunning = true;
  }

  public async updateRiskLimits(limits: Partial<RiskLimits>): Promise<void> {
    this.riskManager.updateLimits(limits);
  }

  public async updateStoikovParams(params: Partial<StoikovParams>): Promise<void> {
    this.stoikovEngine.updateParams(params);
  }
}
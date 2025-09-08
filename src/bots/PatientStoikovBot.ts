import { BaseBot } from '../core/BaseBot';
import { BaseExchange } from '../exchanges/BaseExchange';
import { StoikovEngine, StoikovParams, StoikovQuotes, InventoryState, MarketState } from '../engines/StoikovEngine';
import { MarketDataProcessor, ProcessorConfig, L2OrderBook, Trade } from '../data/MarketDataProcessor';
import { PatientExecutionEngine, PatientExecutionConfig, PatientOrderState } from '../execution/PatientExecutionEngine';
import { PatientRiskManager, PatientRiskLimits, PatientRiskMetrics } from '../risk/PatientRiskManager';
import { PatientStoikovConfig, PatientStoikovConfigConverter, PatientStoikovConfigValidator } from '../configs/PatientStoikovConfig';
import { BotConfig } from '../types';
import { Logger } from '../core/Logger';
import winston from 'winston';

interface PatientStoikovBotConfig extends BotConfig {
  patientConfig: PatientStoikovConfig;
}

interface PatientBotState {
  isRunning: boolean;
  currentState: PatientOrderState;
  sessionCount: number;
  lastSessionStart: number;
  lastQuoteTime: number;
  totalFills: number;
  totalRequotes: number;
  sessionPnL: number;
  dailyPnL: number;
  currentInventory: InventoryState | null;
  currentMarket: MarketState | null;
  riskMetrics: PatientRiskMetrics | null;
  performanceKPIs: any;
}

export class PatientStoikovBot extends BaseBot {
  private logger: winston.Logger;
  private exchange: BaseExchange;
  private config: PatientStoikovConfig;
  
  // Core engines
  private stoikovEngine!: StoikovEngine;
  private marketProcessor!: MarketDataProcessor;
  private patientExecutionEngine!: PatientExecutionEngine;
  private patientRiskManager!: PatientRiskManager;
  
  // Bot state
  private botState!: PatientBotState;
  private lastInventoryUpdate: number = 0;
  private eventDrivenMode: boolean = true;
  
  // Performance tracking
  private sessionMetrics: Map<number, any> = new Map();
  private kpiHistory: Array<{timestamp: number, kpis: any}> = [];

  constructor(config: PatientStoikovBotConfig, exchange: BaseExchange) {
    super(config);
    
    if (!config.patientConfig) {
      throw new Error('Patient Stoikov configuration is required');
    }
    
    if (!exchange) {
      throw new Error('Exchange is required for PatientStoikovBot');
    }
    
    this.exchange = exchange;
    this.config = config.patientConfig;
    this.logger = Logger.getInstance().child({ 
      module: 'PatientStoikovBot', 
      botId: config.id 
    });
    
    // Validate configuration
    const validation = PatientStoikovConfigValidator.validate(this.config);
    if (!validation.valid) {
      throw new Error(`Invalid PatientStoikov configuration: ${validation.errors.join(', ')}`);
    }
    
    this.initializeState();
    
    try {
      this.initializeEngines();
      this.setupEventListeners();
    } catch (error) {
      this.logger.error('Failed to initialize PatientStoikovBot engines:', error);
      throw error;
    }
    
    this.logger.info(`PatientStoikovBot ${config.id} created successfully`, {
      exchange: exchange.getName(),
      symbol: this.config.symbol,
      config: PatientStoikovConfigValidator.sanitizeForLogging(this.config)
    });
  }

  private initializeState(): void {
    this.botState = {
      isRunning: false,
      currentState: PatientOrderState.IDLE,
      sessionCount: 0,
      lastSessionStart: 0,
      lastQuoteTime: 0,
      totalFills: 0,
      totalRequotes: 0,
      sessionPnL: 0,
      dailyPnL: 0,
      currentInventory: null,
      currentMarket: null,
      riskMetrics: null,
      performanceKPIs: null
    };
  }

  private initializeEngines(): void {
    // Initialize Stoikov mathematical engine
    const stoikovParams = PatientStoikovConfigConverter.toStoikovParams(this.config);
    this.stoikovEngine = new StoikovEngine(stoikovParams);
    
    // Initialize market data processor
    const processorConfig: ProcessorConfig = {
      topNDepth: this.config.marketDataParams.topNTracking.threshold,
      obiWindow: this.config.stoikovCore.volatilityEstimation.windowMs,
      micropriceLevels: this.config.marketDataParams.micropriceBias.levels,
      queueThreshold: this.config.marketDataParams.queueAhead.thresholdRatio * 1000,
      sequenceTimeout: 5000,
      enableMark: true
    };
    this.marketProcessor = new MarketDataProcessor(processorConfig);
    
    // Initialize Patient execution engine
    const patientExecutionConfig: PatientExecutionConfig = {
      // Base execution config
      postOnlyOffset: this.config.executionParams.postOnlyStrategy.offsetTicks,
      ttlMs: this.config.executionParams.timingParams.levelTtlMs,
      repostMs: this.config.executionParams.timingParams.minRequoteIntervalMs,
      maxRetries: 3,
      ladderLevels: this.config.executionParams.ladderConfig.levels,
      partialFillThresholdPct: 10,
      queueAheadThreshold: this.config.marketDataParams.queueAhead.thresholdRatio * 1000,
      priceToleranceTicks: 2,
      flattenTimeoutMs: 5000,
      cooldownMs: this.config.riskParams.sessionLimits.cooldownMs,
      fillLatencyTarget: 100,
      repostRateLimit: 10,
      
      // Patient-specific config
      patientEventConfig: PatientStoikovConfigConverter.toPatientEventConfig(this.config),
      levelImprovement: {
        enabled: this.config.executionParams.postOnlyStrategy.improvementEnabled,
        improvementTicks: 1,
        maxImprovements: this.config.executionParams.postOnlyStrategy.maxImprovements
      },
      cancelReplaceStrategy: 'atomic',
      batchCancelReplaceDelay: 50,
      rateLimitBuffer: this.config.executionParams.rateLimiting.bufferPct,
      eventCoalescing: {
        enabled: true,
        windowMs: 100
      }
    };
    this.patientExecutionEngine = new PatientExecutionEngine(patientExecutionConfig);
    
    // Initialize Patient risk manager
    const patientRiskLimits: PatientRiskLimits = {
      // Base risk limits
      maxInventoryPct: this.config.stoikovCore.maxInventoryPct,
      inventoryWarningPct: 80,
      driftCutBps: this.config.marketDataParams.drift.cutoffBps,
      driftWarningBps: 80,
      sessionDDLimitPct: this.config.riskParams.sessionLimits.ddLimitPct,
      dailyDDLimitPct: this.config.riskParams.sessionLimits.ddLimitPct * 2,
      ddWarningPct: 80,
      maxConsecutiveFails: this.config.riskParams.sessionLimits.maxConsecutiveFails,
      maxOrdersPerSecond: 5,
      maxSpreadMultiplier: 3,
      volSpikeThresholdPct: this.config.riskParams.emergencyStops.volatilitySpikeThreshold * 100,
      volSpikeCooldownMs: 60000,
      enableEmergencyStop: this.config.riskParams.emergencyStops.enabled,
      enableNewsStop: this.config.riskParams.emergencyStops.newsDetectionEnabled,
      newsStopDurationMs: this.config.riskParams.emergencyStops.newsStopDurationMs,
      
      // Patient-specific limits
      maxWaitTimePerLevel: this.config.executionParams.timingParams.levelTtlMs,
      maxSessionDuration: this.config.executionParams.timingParams.sessionTtlMs,
      maxDailyRequotes: 1000,
      maxTopNExitsPerHour: 20,
      maxDriftEventsPerHour: 10,
      maxQueueAheadEventsPerSession: 5,
      minFillRatio: this.config.monitoringParams.performanceTargets.fillRatioTarget,
      maxSlippageBps: 5,
      minEffectiveSpreadCapture: this.config.monitoringParams.performanceTargets.effectiveSpreadTarget,
      enableVolatilityFloor: false,
      volatilityFloor: 0.05,
      enableLiquidityFloor: this.config.regimeParams.liquidityRegimeDetection.enabled,
      liquidityFloorSize: 100,
      enableRegimeAdjustments: this.config.regimeParams.liquidityRegimeDetection.enabled,
      regimeRiskMultipliers: {
        low: 0.8,
        medium: 1.0,
        high: 1.2
      }
    };
    this.patientRiskManager = new PatientRiskManager(patientRiskLimits);
    
    this.logger.info('All Patient Stoikov engines initialized successfully');
  }

  private setupEventListeners(): void {
    // Market data processor events
    this.marketProcessor.on('marketStateUpdate', this.onMarketStateUpdate.bind(this));
    this.marketProcessor.on('tradeProcessed', this.onTradeProcessed.bind(this));
    this.marketProcessor.on('orderBookProcessed', this.onOrderBookProcessed.bind(this));
    
    // Stoikov engine events
    this.stoikovEngine.on('quotesCalculated', this.onQuotesCalculated.bind(this));
    this.stoikovEngine.on('paramsUpdated', (params: StoikovParams) => {
      this.logger.info('Stoikov parameters updated', { params });
    });
    
    // Patient execution engine events
    this.patientExecutionEngine.on('placeOrder', this.onPlaceOrder.bind(this));
    this.patientExecutionEngine.on('cancelOrder', this.onCancelOrder.bind(this));
    this.patientExecutionEngine.on('cancelReplaceOrder', this.onCancelReplaceOrder.bind(this));
    this.patientExecutionEngine.on('improveLevelPrice', this.onImproveLevelPrice.bind(this));
    this.patientExecutionEngine.on('partialFill', this.onPartialFill.bind(this));
    this.patientExecutionEngine.on('fullFill', this.onFullFill.bind(this));
    this.patientExecutionEngine.on('requiresRequote', this.onRequiresRequote.bind(this));
    this.patientExecutionEngine.on('requiresLevelRefresh', this.onRequiresLevelRefresh.bind(this));
    this.patientExecutionEngine.on('flattenPosition', this.onFlattenPosition.bind(this));
    this.patientExecutionEngine.on('stateTransition', this.onStateTransition.bind(this));
    
    // Patient risk manager events
    this.patientRiskManager.on('riskEvent', this.onRiskEvent.bind(this));
    this.patientRiskManager.on('flattenRequired', this.onFlattenRequired.bind(this));
    this.patientRiskManager.on('pauseTradingRequired', this.onPauseTradingRequired.bind(this));
    this.patientRiskManager.on('pauseTradingRecommended', this.onPauseTradingRecommended.bind(this));
    this.patientRiskManager.on('emergencyStop', this.onEmergencyStop.bind(this));
    this.patientRiskManager.on('riskWarning', this.onRiskWarning.bind(this));
    
    // Exchange events
    this.exchange.on('orderBook', this.onOrderBook.bind(this));
    this.exchange.on('trade', this.onTrade.bind(this));
    this.exchange.on('orderUpdate', this.onExchangeOrderUpdate.bind(this));
    this.exchange.on('error', this.onExchangeError.bind(this));
  }

  protected async initialize(): Promise<void> {
    this.logger.info(`Initializing PatientStoikovBot ${this.config.id}`);
    
    try {
      // Connect to exchange if not connected
      if (!this.exchange.isConnected()) {
        await this.exchange.connect();
      }
      
      // Subscribe to market data
      await this.exchange.subscribeToOrderBook(this.config.symbol);
      await this.exchange.subscribeToTrades(this.config.symbol);
      
      // Initialize inventory state
      await this.updateInventoryFromExchange();
      
      // Start in event-driven mode (no periodic quote updates)
      this.eventDrivenMode = true;
      
      this.botState.isRunning = true;
      this.startTime = Date.now();
      
      this.logger.info(`PatientStoikovBot ${this.config.id} initialized successfully in event-driven mode`);
      
    } catch (error) {
      this.logger.error(`Failed to initialize PatientStoikovBot ${this.config.id}:`, error);
      throw error;
    }
  }

  protected async cleanup(): Promise<void> {
    this.logger.info(`Cleaning up PatientStoikovBot ${this.config.id}`);
    
    try {
      this.botState.isRunning = false;
      
      // Flatten position if not already flat
      if (this.botState.currentInventory && Math.abs(this.botState.currentInventory.position) > 0.001) {
        await this.flattenPosition();
      }
      
      // Unsubscribe from market data
      await this.exchange.unsubscribeFromOrderBook(this.config.symbol);
      await this.exchange.unsubscribeFromTrades(this.config.symbol);
      
      // Cleanup engines
      this.patientExecutionEngine.reset();
      this.patientRiskManager.destroy();
      
      this.logger.info(`PatientStoikovBot ${this.config.id} cleanup complete`);
      
    } catch (error) {
      this.logger.error(`Error during PatientStoikovBot cleanup:`, error);
      throw error;
    }
  }

  private async startNewPatientSession(): Promise<void> {
    if (!this.patientRiskManager.canTrade()) {
      this.logger.debug('Cannot start new session - risk manager prevents trading');
      return;
    }
    
    try {
      // Calculate new quotes
      const quotes = this.stoikovEngine.calculateQuotes();
      if (!quotes) {
        this.logger.debug('No quotes available for new session');
        return;
      }
      
      // Apply risk adjustments
      const adjustedQuotes = this.applyRiskAdjustments(quotes);
      
      // Start new patient session
      await this.patientExecutionEngine.placePatientQuotes(adjustedQuotes, this.botState.currentMarket);
      
      // Update state
      this.botState.sessionCount++;
      this.botState.lastSessionStart = Date.now();
      this.botState.lastQuoteTime = Date.now();
      
      // Notify risk manager
      this.patientRiskManager.onPatientSessionStart();
      
      this.logger.info('New patient session started', {
        sessionId: this.botState.lastSessionStart,
        sessionCount: this.botState.sessionCount,
        bidPrice: adjustedQuotes.bidPrice,
        askPrice: adjustedQuotes.askPrice
      });
      
    } catch (error) {
      this.logger.error('Failed to start new patient session:', error);
    }
  }

  private applyRiskAdjustments(quotes: StoikovQuotes): StoikovQuotes {
    const sizeMultiplier = this.patientRiskManager.getSizeMultiplier();
    const spreadMultiplier = this.patientRiskManager.getSpreadMultiplier();
    
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
      const position = positions.find(p => p.symbol === this.config.symbol);
      
      const inventoryState: InventoryState = {
        position: position ? position.size * (position.side === 'long' ? 1 : -1) : 0,
        navPct: position ? Math.abs(position.size * position.markPrice) / 10000 * 100 : 0,
        entryPrice: position ? position.entryPrice : 0,
        unrealizedPnl: position ? position.unrealizedPnl : 0,
        drift: 0
      };
      
      this.botState.currentInventory = inventoryState;
      
      // Update all engines
      this.stoikovEngine.updateInventory(inventoryState);
      this.patientRiskManager.updateInventory(inventoryState);
      
      this.lastInventoryUpdate = Date.now();
      
    } catch (error) {
      this.logger.error('Failed to update inventory from exchange:', error);
    }
  }

  private async flattenPosition(): Promise<void> {
    this.logger.warn('Flattening position');
    
    try {
      await this.patientExecutionEngine.flattenPosition();
    } catch (error) {
      this.logger.error('Failed to flatten position:', error);
    }
  }

  private updatePerformanceKPIs(): void {
    const stoikovKPIs = this.stoikovEngine.calculateKPIs();
    const patientRiskMetrics = this.patientRiskManager.getPatientMetrics();
    const executionStats = this.patientExecutionEngine.getBaseStats();
    const eventStats = this.patientExecutionEngine.getEventStats();
    
    this.botState.performanceKPIs = {
      // Stoikov metrics
      effectiveSpreadBps: stoikovKPIs?.effectiveSpreadBps || 0,
      inventoryRatio: stoikovKPIs?.inventoryRatio || 0,
      volatilityPct: stoikovKPIs?.volatilityPct || 0,
      
      // Patient-specific metrics
      sessionCount: this.botState.sessionCount,
      avgSessionDuration: patientRiskMetrics.currentSessionDuration,
      fillRatio: patientRiskMetrics.actualFillRatio,
      avgWaitTime: patientRiskMetrics.avgWaitTimePerLevel,
      totalRequotes: this.botState.totalRequotes,
      eventTriggeredRequotes: patientRiskMetrics.sessionRequoteCount,
      
      // Risk metrics
      riskLevel: patientRiskMetrics.riskLevel,
      overallRiskScore: patientRiskMetrics.overallRiskScore,
      liquidityAssessment: patientRiskMetrics.liquidityAssessment,
      currentRegime: patientRiskMetrics.currentRegime,
      
      // Execution metrics
      totalOrders: executionStats.totalOrders,
      filledOrders: executionStats.filledOrders,
      cancelledOrders: executionStats.cancelledOrders,
      avgFillTime: executionStats.averageFillTime,
      rejectionRate: executionStats.rejectionRate
    };
    
    // Store KPI history
    this.kpiHistory.push({
      timestamp: Date.now(),
      kpis: { ...this.botState.performanceKPIs }
    });
    
    // Keep only last 1000 KPI snapshots
    if (this.kpiHistory.length > 1000) {
      this.kpiHistory = this.kpiHistory.slice(-1000);
    }
  }

  // Event handlers
  private onMarketStateUpdate(marketState: MarketState): void {
    this.botState.currentMarket = marketState;
    
    // Update engines
    this.stoikovEngine.updateMarketState(marketState);
    this.patientExecutionEngine.updateMarketState(marketState);
    this.patientRiskManager.updateVolatility(marketState.volatility);
  }

  private onTradeProcessed(trade: Trade): void {
    this.stoikovEngine.addTrade(trade.price, trade.size, trade.side, trade.timestamp);
  }

  private onOrderBookProcessed(data: any): void {
    const { orderBook, metrics } = data;
    
    // Update execution engine for event detection
    this.patientExecutionEngine.updateOrderBook(orderBook);
    
    // Update risk manager with market conditions
    this.patientRiskManager.updateMarketConditions(orderBook);
  }

  private onQuotesCalculated(quotes: StoikovQuotes): void {
    // In event-driven mode, quotes are calculated but not immediately placed
    // They will be used when a patient session needs to start
    this.logger.debug('New quotes calculated', {
      bidPrice: quotes.bidPrice,
      askPrice: quotes.askPrice,
      spread: (quotes.askPrice - quotes.bidPrice) * 10000
    });
  }

  private async onRequiresRequote(data: any): Promise<void> {
    this.logger.info('Requote required', { reason: data.reason, priority: data.priority });
    
    // Record requote event
    this.botState.totalRequotes++;
    this.patientRiskManager.onPatientRequote(data.reason);
    
    // Start new patient session
    await this.startNewPatientSession();
  }

  private onRequiresLevelRefresh(data: any): void {
    this.logger.debug('Level refresh required', { levelKey: data.levelKey });
    // Individual level refresh logic would go here
  }

  private onStateTransition(data: any): void {
    const { from, to } = data;
    this.botState.currentState = to;
    
    this.logger.debug(`Patient state transition: ${from} -> ${to}`);
    
    // Update risk manager
    this.patientRiskManager.updatePatientState(to);
    
    // Handle specific state transitions
    if (to === PatientOrderState.IDLE && from !== PatientOrderState.IDLE) {
      // Session ended, record metrics
      this.recordSessionMetrics();
    }
  }

  private recordSessionMetrics(): void {
    if (this.botState.lastSessionStart > 0) {
      const sessionDuration = Date.now() - this.botState.lastSessionStart;
      
      this.sessionMetrics.set(this.botState.lastSessionStart, {
        sessionId: this.botState.lastSessionStart,
        duration: sessionDuration,
        requotes: this.botState.totalRequotes,
        finalState: this.botState.currentState,
        kpis: { ...this.botState.performanceKPIs }
      });
      
      this.logger.info('Session metrics recorded', {
        sessionId: this.botState.lastSessionStart,
        duration: sessionDuration,
        state: this.botState.currentState
      });
    }
  }

  private async onPlaceOrder(orderRequest: any): Promise<void> {
    try {
      this.patientRiskManager.recordOrderRate();
      
      const symbol = this.config.symbol;
      const price: number = orderRequest.price;
      const quoteSize: number = orderRequest.size;
      
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(quoteSize) || quoteSize <= 0) {
        this.logger.warn('Invalid order parameters, skipping', { price, quoteSize });
        return;
      }
      
      const baseQty = Math.max(Number((quoteSize / price).toFixed(6)), 0.000001);

      const order = await this.exchange.placeOrder({
        symbol,
        side: orderRequest.side,
        type: 'limit',
        amount: baseQty,
        price,
        exchange: this.exchange.getName()
      } as any);
      
      this.logger.debug('Patient order placed', { 
        clientOrderId: orderRequest.clientOrderId, 
        orderId: order.id,
        side: orderRequest.side,
        price,
        size: baseQty
      });
      
      // Notify execution engine
      this.patientExecutionEngine.handleOrderUpdate({
        clientOrderId: orderRequest.clientOrderId,
        orderId: order.id,
        status: 'NEW'
      });
      
    } catch (error) {
      this.logger.error('Failed to place patient order:', error);
      this.patientRiskManager.recordFailure('orderPlacementFailed');
    }
  }

  private async onCancelOrder(cancelRequest: any): Promise<void> {
    try {
      await this.exchange.cancelOrder(cancelRequest.orderId, this.config.symbol);
      this.logger.debug('Patient order cancelled', { orderId: cancelRequest.orderId });
    } catch (error) {
      this.logger.error('Failed to cancel patient order:', error);
      this.patientRiskManager.recordFailure('orderCancellationFailed');
    }
  }

  private async onCancelReplaceOrder(replaceRequest: any): Promise<void> {
    try {
      // Cancel old order
      await this.exchange.cancelOrder(replaceRequest.orderId, this.config.symbol);
      
      // Place new order
      const baseQty = Math.max(Number((replaceRequest.newSize / replaceRequest.newPrice).toFixed(6)), 0.000001);
      
      await this.exchange.placeOrder({
        symbol: this.config.symbol,
        side: replaceRequest.side,
        type: 'limit',
        amount: baseQty,
        price: replaceRequest.newPrice,
        exchange: this.exchange.getName()
      });
      
      this.logger.debug('Patient order replaced', { 
        oldOrderId: replaceRequest.orderId,
        newPrice: replaceRequest.newPrice,
        newSize: replaceRequest.newSize
      });
      
    } catch (error) {
      this.logger.error('Failed to replace patient order:', error);
      this.patientRiskManager.recordFailure('orderReplaceFailed');
    }
  }

  private async onImproveLevelPrice(data: any): Promise<void> {
    try {
      // Cancel old order and place improved order
      await this.exchange.cancelOrder(data.orderId, this.config.symbol);
      
      const baseQty = Math.max(Number((100 / data.improvedPrice).toFixed(6)), 0.000001); // Simplified size calc
      
      await this.exchange.placeOrder({
        symbol: this.config.symbol,
        side: data.levelKey.startsWith('bid') ? 'buy' : 'sell',
        type: 'limit',
        amount: baseQty,
        price: data.improvedPrice,
        exchange: this.exchange.getName()
      });
      
      this.logger.info('Level price improved', {
        levelKey: data.levelKey,
        oldPrice: data.currentPrice,
        newPrice: data.improvedPrice
      });
      
    } catch (error) {
      this.logger.error('Failed to improve level price:', error);
    }
  }

  private onPartialFill(fillEvent: any): void {
    this.logger.info('Patient partial fill received', fillEvent);
    
    // Update inventory and metrics
    this.updateInventoryFromExchange();
    this.botState.totalFills++;
    
    // Notify risk manager
    this.patientRiskManager.onFill({
      slippageBps: 1, // Would calculate actual slippage
      spreadCapture: 2 // Would calculate actual spread capture
    });
  }

  private onFullFill(fillEvent: any): void {
    this.logger.info('Patient full fill received', fillEvent);
    
    // Update inventory and metrics
    this.updateInventoryFromExchange();
    this.botState.totalFills++;
    this.metrics.totalTrades = this.botState.totalFills;
    
    // Notify risk manager
    this.patientRiskManager.onFill({
      slippageBps: 1,
      spreadCapture: 2
    });
  }

  private onFlattenPosition(): void {
    this.flattenPosition();
  }

  private onRiskEvent(event: any): void {
    this.logger.warn('Patient risk event occurred', event);
    
    // Handle risk events based on patient-specific logic
    if (event.metadata?.source === 'patient') {
      // Track patient-specific risk events
      if (event.type === 'topNExitFrequency') {
        this.patientRiskManager.onTopNExit();
      } else if (event.type === 'driftEventFrequency') {
        this.patientRiskManager.onDriftEvent();
      } else if (event.type === 'queueAheadFrequency') {
        this.patientRiskManager.onQueueAheadEvent();
      }
    }
  }

  private onFlattenRequired(event: any): void {
    this.logger.warn('Flatten required by patient risk manager', event);
    this.flattenPosition();
  }

  private onPauseTradingRequired(event: any): void {
    this.logger.error('Trading pause required', event);
    this.botState.isRunning = false;
  }

  private onPauseTradingRecommended(event: any): void {
    this.logger.warn('Trading pause recommended', event);
    // Could implement automatic pause logic here
  }

  private onEmergencyStop(event: any): void {
    this.logger.error('Patient emergency stop triggered', event);
    this.botState.isRunning = false;
    this.flattenPosition();
  }

  private onRiskWarning(event: any): void {
    this.logger.warn('Patient risk warning', event);
  }

  // Exchange event handlers
  private onOrderBook(orderBook: any): void {
    const bids = (orderBook.bids || []).map((b: any) => 
      Array.isArray(b) ? { price: Number(b[0]), size: Number(b[1]) } : 
      { price: Number(b.price), size: Number(b.size) });
    const asks = (orderBook.asks || []).map((a: any) => 
      Array.isArray(a) ? { price: Number(a[0]), size: Number(a[1]) } : 
      { price: Number(a.price), size: Number(a.size) });

    const l2OrderBook: L2OrderBook = {
      bids,
      asks,
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

  private onExchangeOrderUpdate(orderUpdate: any): void {
    this.patientExecutionEngine.handleOrderUpdate(orderUpdate);
  }

  private onExchangeError(error: Error): void {
    this.logger.error('Exchange error:', error);
    this.patientRiskManager.recordFailure('exchangeError');
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
    // Could implement dynamic config updates here
  }

  // Public API
  public getBotState(): PatientBotState {
    return { ...this.botState };
  }

  public getPatientRiskMetrics(): PatientRiskMetrics | null {
    return this.patientRiskManager.getPatientMetrics();
  }

  public getPatientExecutionStats(): any {
    return {
      base: this.patientExecutionEngine.getBaseStats(),
      events: this.patientExecutionEngine.getEventStats(),
      levels: this.patientExecutionEngine.getLevelStates(),
      session: this.patientExecutionEngine.getSessionMetrics()
    };
  }

  public getPatientKPIs(): any {
    this.updatePerformanceKPIs();
    return this.botState.performanceKPIs;
  }

  public getSessionHistory(): any[] {
    return Array.from(this.sessionMetrics.values());
  }

  public getKPIHistory(lastN: number = 100): any[] {
    return this.kpiHistory.slice(-lastN);
  }

  public getCurrentQuotes(): StoikovQuotes | null {
    return this.stoikovEngine.getLastQuotes();
  }

  // Control methods
  public async forceNewSession(): Promise<void> {
    this.logger.info('Forcing new patient session');
    await this.startNewPatientSession();
  }

  public async emergencyStop(): Promise<void> {
    this.patientRiskManager.emergencyStop('manualStop');
  }

  public async resetEmergencyStop(): Promise<void> {
    this.patientRiskManager.resetEmergencyStop();
    this.botState.isRunning = true;
  }

  public async updatePatientConfig(config: Partial<PatientStoikovConfig>): Promise<void> {
    this.config = { ...this.config, ...config };
    
    // Update individual engine configs
    if (config.stoikovCore) {
      const stoikovParams = PatientStoikovConfigConverter.toStoikovParams(this.config);
      this.stoikovEngine.updateParams(stoikovParams);
    }
    
    if (config.riskParams) {
      const riskUpdates = {
        maxInventoryPct: config.riskParams.sessionLimits?.ddLimitPct,
        sessionDDLimitPct: config.riskParams.sessionLimits?.ddLimitPct
      };
      this.patientRiskManager.updatePatientLimits(riskUpdates);
    }
    
    this.logger.info('Patient config updated', { updates: config });
  }
}
import { EventEmitter } from 'events';
import { Logger } from '../core/Logger';
import { ExecutionEngine, ExecutionConfig, OrderState, ManagedOrder, ExecutionStats } from './ExecutionEngine';
import { StoikovQuotes } from '../engines/StoikovEngine';
import { PatientStoikovEventDetector, PatientEventConfig, PatientEventData } from '../engines/PatientStoikovEventDetector';
import winston from 'winston';

// Extended Patient-specific order states
export enum PatientOrderState {
  IDLE = 'idle',
  QUOTE_PLACING = 'quotePlacing',
  WAITING_IN_QUEUE = 'waitingInQueue',
  PARTIAL_FILLED = 'partialFilled',
  TOP_N_EXIT = 'topNExit',
  DRIFT_TRIGGERED = 'driftTriggered',
  QUEUE_AHEAD_TRIGGERED = 'queueAheadTriggered',
  REPLACING_LEVEL = 'replacingLevel',
  RISK_BREACH = 'riskBreach',
  FLATTENING = 'flattening',
  COOLDOWN = 'cooldown',
  ERROR = 'error'
}

export interface PatientExecutionConfig extends ExecutionConfig {
  // Patient-specific parameters
  patientEventConfig: PatientEventConfig;
  
  // Level management
  levelImprovement: {
    enabled: boolean;
    improvementTicks: number;    // ±1, ±2 ticks for queue ahead improvement
    maxImprovements: number;     // Max improvements per level per session
  };
  
  // Cancel-replace strategy
  cancelReplaceStrategy: 'atomic' | 'batch';
  batchCancelReplaceDelay: number; // ms
  
  // Performance optimizations
  rateLimitBuffer: number;         // % buffer to keep for rate limits
  eventCoalescing: {
    enabled: boolean;
    windowMs: number;             // Coalesce events within this window
  };
}

interface PatientLevelState {
  levelKey: string;              // 'bid_0', 'ask_1', etc.
  managedOrder: ManagedOrder | null;
  improvementCount: number;
  lastImprovement: number;
  waitStartTime: number;
  inTopN: boolean;
}

interface PatientSessionMetrics {
  sessionStartTime: number;
  totalRequotes: number;
  eventTriggeredRequotes: number;
  timeBasedRequotes: number;
  topNExits: number;
  driftEvents: number;
  queueAheadEvents: number;
  averageWaitTime: number;
  fillRatioByLevel: Map<string, number>;
  effectiveSpreadCapture: number;
}

export class PatientExecutionEngine extends EventEmitter {
  private logger: winston.Logger;
  private config: PatientExecutionConfig;
  private baseExecutionEngine: ExecutionEngine;
  private eventDetector: PatientStoikovEventDetector;
  
  // Patient state management
  private currentState: PatientOrderState = PatientOrderState.IDLE;
  private levelStates: Map<string, PatientLevelState> = new Map();
  private lastRequoteTime: number = 0;
  private sessionMetrics: PatientSessionMetrics = this.initSessionMetrics();
  
  // Event management
  private eventQueue: PatientEventData[] = [];
  private isProcessingEvents: boolean = false;
  
  // Rate limiting
  private requestsThisSecond: number = 0;
  private rateLimitResetTime: number = 0;

  constructor(config: PatientExecutionConfig) {
    super();
    this.config = config;
    this.logger = Logger.getInstance().child({ module: 'PatientExecutionEngine' });
    
    // Initialize base execution engine
    this.baseExecutionEngine = new ExecutionEngine(config);
    
    // Initialize event detector
    this.eventDetector = new PatientStoikovEventDetector(config.patientEventConfig);
    
    this.setupEventListeners();
    this.startPeriodicTasks();
    
    this.logger.info('Patient execution engine initialized', { config: this.sanitizeConfig(config) });
  }

  private sanitizeConfig(config: PatientExecutionConfig): any {
    // Return a sanitized version for logging (remove sensitive data)
    return {
      ladderLevels: config.ladderLevels,
      postOnlyOffset: config.postOnlyOffset,
      ttlMs: config.ttlMs,
      cancelReplaceStrategy: config.cancelReplaceStrategy,
      rateLimitBuffer: config.rateLimitBuffer
    };
  }

  private initSessionMetrics(): PatientSessionMetrics {
    return {
      sessionStartTime: 0,
      totalRequotes: 0,
      eventTriggeredRequotes: 0,
      timeBasedRequotes: 0,
      topNExits: 0,
      driftEvents: 0,
      queueAheadEvents: 0,
      averageWaitTime: 0,
      fillRatioByLevel: new Map(),
      effectiveSpreadCapture: 0
    };
  }

  private setupEventListeners(): void {
    // Base execution engine events
    this.baseExecutionEngine.on('placeOrder', (orderRequest: any) => {
      this.emit('placeOrder', orderRequest);
    });
    
    this.baseExecutionEngine.on('cancelOrder', (cancelRequest: any) => {
      this.emit('cancelOrder', cancelRequest);
    });
    
    this.baseExecutionEngine.on('cancelReplaceOrder', (replaceRequest: any) => {
      this.emit('cancelReplaceOrder', replaceRequest);
    });
    
    this.baseExecutionEngine.on('partialFill', (fillEvent: any) => {
      this.handlePatientPartialFill(fillEvent);
    });
    
    this.baseExecutionEngine.on('fullFill', (fillEvent: any) => {
      this.handlePatientFullFill(fillEvent);
    });
    
    this.baseExecutionEngine.on('flattenPosition', () => {
      this.transitionToState(PatientOrderState.FLATTENING);
      this.emit('flattenPosition');
    });
    
    // Event detector events
    this.eventDetector.on('patientEvent', (event: PatientEventData) => {
      this.handlePatientEvent(event);
    });
    
    this.eventDetector.on('configUpdated', (config: PatientEventConfig) => {
      this.logger.info('Patient event detector config updated');
    });
  }

  private startPeriodicTasks(): void {
    // Process event queue every 100ms
    setInterval(() => {
      this.processEventQueue();
    }, 100);
    
    // Reset rate limiting counters every second
    setInterval(() => {
      this.resetRateLimit();
    }, 1000);
    
    // Update session metrics every 5 seconds
    setInterval(() => {
      this.updateSessionMetrics();
    }, 5000);
  }

  public async placePatientQuotes(quotes: StoikovQuotes, marketState: any): Promise<void> {
    this.logger.debug('Placing patient quotes', {
      bidPrice: quotes.bidPrice,
      askPrice: quotes.askPrice,
      state: this.currentState
    });
    
    // Check if we can place orders (rate limiting, state checks)
    if (!this.canPlaceQuotes()) {
      this.logger.debug('Cannot place quotes at this time', {
        state: this.currentState,
        rateLimited: this.isRateLimited(),
        timeSinceLastRequote: Date.now() - this.lastRequoteTime
      });
      return;
    }
    
    try {
      // Transition to placing state
      this.transitionToState(PatientOrderState.QUOTE_PLACING);
      
      // Start new patient session
      this.eventDetector.startNewSession(quotes, marketState);
      this.sessionMetrics.sessionStartTime = Date.now();
      
      // Initialize level states
      this.initializeLevelStates(quotes);
      
      // Place quotes via base engine
      await this.baseExecutionEngine.placeQuotes(quotes);
      
      // Transition to waiting state
      this.transitionToState(PatientOrderState.WAITING_IN_QUEUE);
      
      this.lastRequoteTime = Date.now();
      this.sessionMetrics.totalRequotes++;
      
      this.logger.info('Patient quotes placed successfully', {
        sessionId: this.sessionMetrics.sessionStartTime,
        levelCount: this.levelStates.size
      });
      
    } catch (error) {
      this.logger.error('Failed to place patient quotes:', error);
      this.transitionToState(PatientOrderState.ERROR);
      throw error;
    }
  }

  private initializeLevelStates(quotes: StoikovQuotes): void {
    this.levelStates.clear();
    const now = Date.now();
    
    // Initialize bid levels
    for (let level = 0; level < this.config.ladderLevels; level++) {
      const levelKey = `bid_${level}`;
      this.levelStates.set(levelKey, {
        levelKey,
        managedOrder: null,
        improvementCount: 0,
        lastImprovement: 0,
        waitStartTime: now,
        inTopN: true // Assume we start in top-N
      });
    }
    
    // Initialize ask levels
    for (let level = 0; level < this.config.ladderLevels; level++) {
      const levelKey = `ask_${level}`;
      this.levelStates.set(levelKey, {
        levelKey,
        managedOrder: null,
        improvementCount: 0,
        lastImprovement: 0,
        waitStartTime: now,
        inTopN: true
      });
    }
  }

  private canPlaceQuotes(): boolean {
    // State check
    if (this.currentState === PatientOrderState.FLATTENING ||
        this.currentState === PatientOrderState.RISK_BREACH) {
      return false;
    }
    
    // Rate limiting check
    if (this.isRateLimited()) {
      return false;
    }
    
    // Minimum interval check
    const timeSinceLastRequote = Date.now() - this.lastRequoteTime;
    if (timeSinceLastRequote < this.config.patientEventConfig.minRequoteInterval) {
      return false;
    }
    
    return true;
  }

  private isRateLimited(): boolean {
    // Simple rate limiting: max 10 requests per second with buffer
    const maxRequests = 10 * (1 - this.config.rateLimitBuffer / 100);
    return this.requestsThisSecond >= maxRequests;
  }

  private resetRateLimit(): void {
    this.requestsThisSecond = 0;
    this.rateLimitResetTime = Date.now();
  }

  private handlePatientEvent(event: PatientEventData): void {
    this.logger.debug('Received patient event', {
      eventType: event.eventType,
      reason: event.reason,
      priority: event.priority
    });
    
    // Update metrics
    this.updateEventMetrics(event);
    
    // Queue event if we're processing others or rate limited
    if (this.isProcessingEvents || this.isRateLimited()) {
      this.eventQueue.push(event);
      return;
    }
    
    this.processPatientEvent(event);
  }

  private updateEventMetrics(event: PatientEventData): void {
    switch (event.eventType) {
      case 'topNExit':
        this.sessionMetrics.topNExits++;
        break;
      case 'drift':
        this.sessionMetrics.driftEvents++;
        break;
      case 'queueAhead':
        this.sessionMetrics.queueAheadEvents++;
        break;
    }
    this.sessionMetrics.eventTriggeredRequotes++;
  }

  private async processPatientEvent(event: PatientEventData): Promise<void> {
    this.isProcessingEvents = true;
    
    try {
      switch (event.eventType) {
        case 'topNExit':
          await this.handleTopNExit(event);
          break;
        case 'drift':
          await this.handleDrift(event);
          break;
        case 'queueAhead':
          await this.handleQueueAhead(event);
          break;
        case 'sessionTtl':
          await this.handleSessionTtl(event);
          break;
        case 'levelTtl':
          await this.handleLevelTtl(event);
          break;
      }
    } catch (error) {
      this.logger.error('Error processing patient event:', error);
    } finally {
      this.isProcessingEvents = false;
    }
  }

  private async handleTopNExit(event: PatientEventData): Promise<void> {
    this.transitionToState(PatientOrderState.TOP_N_EXIT);
    
    this.logger.warn('Top-N exit detected, triggering requote', {
      eventData: event.data
    });
    
    // Emit requote signal
    this.emit('requiresRequote', {
      reason: 'topNExit',
      priority: 'high',
      eventData: event.data
    });
  }

  private async handleDrift(event: PatientEventData): Promise<void> {
    this.transitionToState(PatientOrderState.DRIFT_TRIGGERED);
    
    this.logger.warn('Price drift detected, triggering requote', {
      eventData: event.data
    });
    
    // Emit requote signal
    this.emit('requiresRequote', {
      reason: 'drift',
      priority: 'high',
      eventData: event.data
    });
  }

  private async handleQueueAhead(event: PatientEventData): Promise<void> {
    this.transitionToState(PatientOrderState.QUEUE_AHEAD_TRIGGERED);
    
    const queueData = event.data;
    
    // Try level improvement if enabled and available
    if (this.config.levelImprovement.enabled && queueData) {
      const improved = await this.tryLevelImprovement(queueData);
      if (improved) {
        this.logger.info('Level improvement applied for queue ahead', {
          side: queueData.side,
          level: queueData.level
        });
        return;
      }
    }
    
    // If no improvement possible, trigger full requote
    this.emit('requiresRequote', {
      reason: 'queueAhead',
      priority: 'medium',
      eventData: event.data
    });
  }

  private async handleSessionTtl(event: PatientEventData): Promise<void> {
    this.logger.info('Session TTL expired, refreshing all quotes');
    
    this.sessionMetrics.timeBasedRequotes++;
    
    this.emit('requiresRequote', {
      reason: 'sessionTtl',
      priority: 'low',
      eventData: event.data
    });
  }

  private async handleLevelTtl(event: PatientEventData): Promise<void> {
    const levelKey = event.data?.levelKey;
    if (levelKey && this.levelStates.has(levelKey)) {
      this.logger.debug(`Level TTL expired for ${levelKey}`);
      
      // Individual level refresh if supported
      this.emit('requiresLevelRefresh', {
        reason: 'levelTtl',
        levelKey,
        priority: 'low'
      });
    }
  }

  private async tryLevelImprovement(queueData: any): Promise<boolean> {
    const levelKey = `${queueData.side}_${queueData.level}`;
    const levelState = this.levelStates.get(levelKey);
    
    if (!levelState || !levelState.managedOrder) {
      return false;
    }
    
    // Check improvement limits
    if (levelState.improvementCount >= this.config.levelImprovement.maxImprovements) {
      this.logger.debug('Max improvements reached for level', { levelKey });
      return false;
    }
    
    // Check improvement cooldown
    const timeSinceLastImprovement = Date.now() - levelState.lastImprovement;
    if (timeSinceLastImprovement < 5000) { // 5 second cooldown
      return false;
    }
    
    // Calculate improved price
    const currentPrice = levelState.managedOrder.price;
    const tickSize = 0.01; // Should come from symbol config
    const improvement = this.config.levelImprovement.improvementTicks * tickSize;
    
    const improvedPrice = queueData.side === 'bid' 
      ? currentPrice + improvement 
      : currentPrice - improvement;
    
    try {
      // Emit level improvement request
      this.emit('improveLevelPrice', {
        orderId: levelState.managedOrder.id,
        clientOrderId: levelState.managedOrder.clientOrderId,
        currentPrice,
        improvedPrice,
        levelKey
      });
      
      // Update level state
      levelState.improvementCount++;
      levelState.lastImprovement = Date.now();
      
      this.logger.info('Level price improved', {
        levelKey,
        currentPrice,
        improvedPrice,
        improvementCount: levelState.improvementCount
      });
      
      return true;
      
    } catch (error) {
      this.logger.error('Failed to improve level price:', error);
      return false;
    }
  }

  private handlePatientPartialFill(fillEvent: any): void {
    this.transitionToState(PatientOrderState.PARTIAL_FILLED);
    
    this.logger.info('Patient partial fill received', {
      clientOrderId: fillEvent.clientOrderId,
      fillSize: fillEvent.fillSize,
      remainingSize: fillEvent.remainingSize
    });
    
    // Update inventory via event detector
    this.eventDetector.onPartialFill(fillEvent);
    
    // Emit to parent
    this.emit('partialFill', fillEvent);
  }

  private handlePatientFullFill(fillEvent: any): void {
    this.logger.info('Patient full fill received', {
      clientOrderId: fillEvent.clientOrderId,
      size: fillEvent.size
    });
    
    // Update level state
    this.updateLevelStateOnFill(fillEvent.clientOrderId);
    
    // Trigger inventory update and potential requote
    this.emit('requiresRequote', {
      reason: 'fullFill',
      priority: 'high',
      fillEvent
    });
    
    // Emit to parent
    this.emit('fullFill', fillEvent);
  }

  private updateLevelStateOnFill(clientOrderId: string): void {
    for (const [levelKey, levelState] of this.levelStates.entries()) {
      if (levelState.managedOrder?.clientOrderId === clientOrderId) {
        const waitTime = Date.now() - levelState.waitStartTime;
        
        // Update metrics
        this.sessionMetrics.fillRatioByLevel.set(levelKey, 
          (this.sessionMetrics.fillRatioByLevel.get(levelKey) || 0) + 1);
        
        this.logger.debug('Level filled', {
          levelKey,
          waitTime,
          improvementCount: levelState.improvementCount
        });
        
        break;
      }
    }
  }

  private processEventQueue(): void {
    if (this.eventQueue.length === 0 || this.isProcessingEvents) {
      return;
    }
    
    // Sort by priority and process highest priority event
    this.eventQueue.sort((a, b) => {
      const priorityOrder = { high: 3, medium: 2, low: 1 };
      return priorityOrder[b.priority] - priorityOrder[a.priority];
    });
    
    const event = this.eventQueue.shift();
    if (event) {
      this.processPatientEvent(event);
    }
  }

  private transitionToState(newState: PatientOrderState): void {
    const oldState = this.currentState;
    this.currentState = newState;
    
    this.logger.debug(`Patient state transition: ${oldState} -> ${newState}`);
    this.emit('stateTransition', { from: oldState, to: newState });
  }

  private updateSessionMetrics(): void {
    if (this.sessionMetrics.sessionStartTime === 0) return;
    
    // Calculate average wait time
    let totalWaitTime = 0;
    let activeLevels = 0;
    
    for (const levelState of this.levelStates.values()) {
      if (levelState.managedOrder) {
        totalWaitTime += Date.now() - levelState.waitStartTime;
        activeLevels++;
      }
    }
    
    this.sessionMetrics.averageWaitTime = activeLevels > 0 ? totalWaitTime / activeLevels : 0;
  }

  // Public API
  public updateOrderBook(orderBook: any): void {
    this.eventDetector.updateOrderBook(orderBook);
  }

  public updateMarketState(marketState: any): void {
    this.eventDetector.updateMarketState(marketState);
  }

  public handleOrderUpdate(orderUpdate: any): void {
    this.baseExecutionEngine.handleOrderUpdate(orderUpdate);
  }

  public async flattenPosition(): Promise<void> {
    this.transitionToState(PatientOrderState.FLATTENING);
    await this.baseExecutionEngine.flattenPosition();
  }

  public getCurrentState(): PatientOrderState {
    return this.currentState;
  }

  public getSessionMetrics(): PatientSessionMetrics {
    return { ...this.sessionMetrics };
  }

  public getEventStats(): any {
    return {
      ...this.eventDetector.getEventStats(),
      queuedPatientEvents: this.eventQueue.length,
      isProcessingEvents: this.isProcessingEvents,
      rateLimitedRequests: this.requestsThisSecond
    };
  }

  public getLevelStates(): Map<string, PatientLevelState> {
    return new Map(this.levelStates);
  }

  public getBaseStats(): ExecutionStats {
    return this.baseExecutionEngine.getStats();
  }

  public updateConfig(updates: Partial<PatientExecutionConfig>): void {
    this.config = { ...this.config, ...updates };
    
    if (updates.patientEventConfig) {
      this.eventDetector.updateConfig(updates.patientEventConfig);
    }
    
    this.logger.info('Patient execution config updated');
    this.emit('configUpdated', this.config);
  }

  public reset(): void {
    this.currentState = PatientOrderState.IDLE;
    this.levelStates.clear();
    this.eventQueue = [];
    this.sessionMetrics = this.initSessionMetrics();
    this.lastRequoteTime = 0;
    
    this.baseExecutionEngine.reset();
    this.eventDetector.reset();
    
    this.logger.info('Patient execution engine reset');
  }

  public destroy(): void {
    this.reset();
    this.eventDetector.destroy();
    this.removeAllListeners();
  }
}
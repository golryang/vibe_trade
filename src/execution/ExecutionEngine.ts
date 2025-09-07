import { EventEmitter } from 'events';
import { Logger } from '../core/Logger';
import { Order } from '../types';
import { StoikovQuotes } from '../engines/StoikovEngine';
import winston from 'winston';

export enum OrderState {
  IDLE = 'idle',
  PLACING = 'placing', 
  MAKER_PLACED = 'makerPlaced',
  PARTIAL_FILLED = 'partialFilled',
  FILLED = 'filled',
  CANCELLING = 'cancelling',
  REPLACING = 'replacing',
  FLATTENING = 'flattening',
  COOLDOWN = 'cooldown',
  ERROR = 'error'
}

export interface ManagedOrder {
  id: string;
  clientOrderId: string;
  side: 'buy' | 'sell';
  price: number;
  originalSize: number;
  filledSize: number;
  remainingSize: number;
  state: OrderState;
  placedTime: number;
  lastUpdateTime: number;
  ttlExpiry: number;
  retryCount: number;
  ladderLevel: number;
  isPostOnly: boolean;
}

export interface ExecutionConfig {
  // Order parameters
  postOnlyOffset: number;    // Offset from quote in ticks
  ttlMs: number;            // Time to live for orders  
  repostMs: number;         // Minimum time between reposts
  maxRetries: number;       // Max retries for failed orders
  ladderLevels: number;     // Number of ladder levels
  
  // State machine parameters
  partialFillThresholdPct: number; // When to handle partial fills (%)
  queueAheadThreshold: number;     // Queue position threshold for replace
  priceToleranceTicks: number;     // Price change tolerance before replace
  
  // Flattening parameters
  flattenTimeoutMs: number;        // Timeout for flatten orders
  cooldownMs: number;              // Cooldown after flattening
  
  // Performance tracking
  fillLatencyTarget: number;       // Target fill latency (ms)
  repostRateLimit: number;         // Max reposts per second
}

export interface ExecutionStats {
  totalOrders: number;
  filledOrders: number;
  partialFills: number;
  cancelledOrders: number;
  failedOrders: number;
  averageFillTime: number;
  repostCount: number;
  flattenEvents: number;
  fillRatio: number;
  avgQueueTime: number;
  rejectionRate: number;
}

interface StateTransition {
  from: OrderState;
  to: OrderState;
  condition: string;
  action?: string;
}

export class ExecutionEngine extends EventEmitter {
  private logger: winston.Logger;
  private config: ExecutionConfig;
  
  // Order management
  private managedOrders: Map<string, ManagedOrder> = new Map();
  private lastRepostTime: number = 0;
  private repostQueue: Array<{clientOrderId: string, timestamp: number}> = [];
  
  // State machine tracking
  private stateTransitions: StateTransition[] = [];
  private currentState: OrderState = OrderState.IDLE;
  
  // Performance metrics
  private stats: ExecutionStats = {
    totalOrders: 0,
    filledOrders: 0,
    partialFills: 0,
    cancelledOrders: 0,
    failedOrders: 0,
    averageFillTime: 0,
    repostCount: 0,
    flattenEvents: 0,
    fillRatio: 0,
    avgQueueTime: 0,
    rejectionRate: 0
  };
  
  private fillTimes: number[] = [];
  private queueTimes: number[] = [];

  constructor(config: ExecutionConfig) {
    super();
    this.config = config;
    this.logger = Logger.getInstance().child({ module: 'ExecutionEngine' });
    
    this.initializeStateMachine();
    this.startPeriodicTasks();
    
    this.logger.info('Execution engine initialized', { config });
  }

  private initializeStateMachine(): void {
    // Define state transitions according to spec
    this.stateTransitions = [
      // From IDLE
      { from: OrderState.IDLE, to: OrderState.PLACING, condition: 'newQuote' },
      
      // From PLACING
      { from: OrderState.PLACING, to: OrderState.MAKER_PLACED, condition: 'orderAcked', action: 'startTTLTimer' },
      { from: OrderState.PLACING, to: OrderState.ERROR, condition: 'orderRejected', action: 'handleRejection' },
      
      // From MAKER_PLACED (core state)
      { from: OrderState.MAKER_PLACED, to: OrderState.FILLED, condition: 'fullFill', action: 'recalculateAndRequote' },
      { from: OrderState.MAKER_PLACED, to: OrderState.PARTIAL_FILLED, condition: 'partialFill', action: 'repostRemaining' },
      { from: OrderState.MAKER_PLACED, to: OrderState.REPLACING, condition: 'ttlExpired|obChanged|queueAhead', action: 'cancelReplace' },
      { from: OrderState.MAKER_PLACED, to: OrderState.FLATTENING, condition: 'driftExceeded|ddExceeded', action: 'flattenPosition' },
      
      // From PARTIAL_FILLED
      { from: OrderState.PARTIAL_FILLED, to: OrderState.FILLED, condition: 'remainingFilled', action: 'recalculateAndRequote' },
      { from: OrderState.PARTIAL_FILLED, to: OrderState.MAKER_PLACED, condition: 'remainderReposted', action: 'startTTLTimer' },
      { from: OrderState.PARTIAL_FILLED, to: OrderState.FLATTENING, condition: 'driftExceeded|ddExceeded', action: 'flattenPosition' },
      
      // From REPLACING
      { from: OrderState.REPLACING, to: OrderState.MAKER_PLACED, condition: 'replaceSuccess', action: 'startTTLTimer' },
      { from: OrderState.REPLACING, to: OrderState.ERROR, condition: 'replaceFailed', action: 'handleError' },
      
      // From FLATTENING
      { from: OrderState.FLATTENING, to: OrderState.COOLDOWN, condition: 'flattenComplete', action: 'startCooldown' },
      { from: OrderState.FLATTENING, to: OrderState.ERROR, condition: 'flattenFailed', action: 'handleError' },
      
      // From COOLDOWN
      { from: OrderState.COOLDOWN, to: OrderState.IDLE, condition: 'cooldownExpired', action: 'restartStrategy' },
      
      // From ERROR
      { from: OrderState.ERROR, to: OrderState.IDLE, condition: 'errorRecovered', action: 'resetState' }
    ];
  }

  private startPeriodicTasks(): void {
    // Check TTL expiry every 100ms
    setInterval(() => {
      this.checkTTLExpiry();
    }, 100);
    
    // Process repost queue
    setInterval(() => {
      this.processRepostQueue();
    }, this.config.repostMs);
    
    // Update stats every second
    setInterval(() => {
      this.updateStats();
    }, 1000);
  }

  public async placeQuotes(quotes: StoikovQuotes): Promise<void> {
    this.logger.debug('Placing quotes', { 
      bidPrice: quotes.bidPrice, 
      askPrice: quotes.askPrice,
      bidSize: quotes.bidSize,
      askSize: quotes.askSize 
    });

    // Check repost rate limit
    if (!this.canRepost()) {
      this.logger.debug('Repost rate limited, queueing');
      return;
    }

    try {
      // Cancel existing orders first if needed
      await this.cancelExistingOrders();
      
      // Place bid orders (ladder levels)
      for (let level = 0; level < this.config.ladderLevels; level++) {
        await this.placeLadderOrder('buy', quotes, level);
      }
      
      // Place ask orders (ladder levels)  
      for (let level = 0; level < this.config.ladderLevels; level++) {
        await this.placeLadderOrder('sell', quotes, level);
      }
      
      this.transitionToState(OrderState.MAKER_PLACED);
      this.lastRepostTime = Date.now();
      
    } catch (error) {
      this.logger.error('Failed to place quotes:', error);
      this.transitionToState(OrderState.ERROR);
      this.stats.failedOrders++;
    }
  }

  private async placeLadderOrder(side: 'buy' | 'sell', quotes: StoikovQuotes, level: number): Promise<void> {
    const isRangeOrder = level > 0;
    const tickSize = 0.01; // Should come from symbol config
    
    // Calculate ladder price
    let price = side === 'buy' ? quotes.bidPrice : quotes.askPrice;
    if (isRangeOrder) {
      const offset = tickSize * (level + 1) * this.config.postOnlyOffset;
      price = side === 'buy' ? price - offset : price + offset;
    }
    
    // Calculate ladder size
    const baseSize = side === 'buy' ? quotes.bidSize : quotes.askSize;
    const size = baseSize / this.config.ladderLevels;
    
    const clientOrderId = `${side}_${level}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    
    const managedOrder: ManagedOrder = {
      id: '',
      clientOrderId,
      side,
      price,
      originalSize: size,
      filledSize: 0,
      remainingSize: size,
      state: OrderState.PLACING,
      placedTime: Date.now(),
      lastUpdateTime: Date.now(),
      ttlExpiry: Date.now() + this.config.ttlMs,
      retryCount: 0,
      ladderLevel: level,
      isPostOnly: true
    };
    
    this.managedOrders.set(clientOrderId, managedOrder);
    this.stats.totalOrders++;
    
    // Emit order placement request (to be handled by exchange adapter)
    this.emit('placeOrder', {
      clientOrderId,
      side,
      price,
      size,
      timeInForce: 'GTX',
      postOnly: true
    });
  }

  public handleOrderUpdate(orderUpdate: any): void {
    const { clientOrderId, status, filledQty, remainingQty, avgPrice } = orderUpdate;
    const managedOrder = this.managedOrders.get(clientOrderId);
    
    if (!managedOrder) {
      this.logger.warn(`Received update for unknown order: ${clientOrderId}`);
      return;
    }
    
    const previousFilledSize = managedOrder.filledSize;
    managedOrder.filledSize = filledQty || 0;
    managedOrder.remainingSize = remainingQty || 0;
    managedOrder.lastUpdateTime = Date.now();
    
    switch (status) {
      case 'NEW':
      case 'ACCEPTED':
        managedOrder.id = orderUpdate.orderId;
        managedOrder.state = OrderState.MAKER_PLACED;
        this.logger.debug(`Order placed: ${clientOrderId}`);
        break;
        
      case 'PARTIALLY_FILLED':
        const newFillSize = managedOrder.filledSize - previousFilledSize;
        if (newFillSize > 0) {
          this.handlePartialFill(managedOrder, newFillSize, avgPrice);
        }
        break;
        
      case 'FILLED':
        const finalFillSize = managedOrder.filledSize - previousFilledSize;
        this.handleFullFill(managedOrder, finalFillSize, avgPrice);
        break;
        
      case 'CANCELED':
        this.handleOrderCanceled(managedOrder);
        break;
        
      case 'REJECTED':
        this.handleOrderRejected(managedOrder, orderUpdate.reason);
        break;
        
      default:
        this.logger.warn(`Unknown order status: ${status} for ${clientOrderId}`);
    }
  }

  private handlePartialFill(order: ManagedOrder, fillSize: number, avgPrice: number): void {
    order.state = OrderState.PARTIAL_FILLED;
    this.stats.partialFills++;
    
    const fillTime = Date.now() - order.placedTime;
    this.fillTimes.push(fillTime);
    
    this.logger.info(`Partial fill: ${order.clientOrderId}`, {
      side: order.side,
      fillSize,
      avgPrice,
      remainingSize: order.remainingSize
    });
    
    // Emit fill event for inventory management
    this.emit('partialFill', {
      orderId: order.id,
      clientOrderId: order.clientOrderId,
      side: order.side,
      fillSize,
      avgPrice,
      remainingSize: order.remainingSize
    });
    
    // Queue remainder for repost if threshold met
    const fillPct = (order.filledSize / order.originalSize) * 100;
    if (fillPct >= this.config.partialFillThresholdPct) {
      this.queueRepost(order.clientOrderId);
    }
  }

  private handleFullFill(order: ManagedOrder, fillSize: number, avgPrice: number): void {
    order.state = OrderState.FILLED;
    this.stats.filledOrders++;
    
    const fillTime = Date.now() - order.placedTime;
    this.fillTimes.push(fillTime);
    
    this.logger.info(`Full fill: ${order.clientOrderId}`, {
      side: order.side,
      size: order.originalSize,
      avgPrice
    });
    
    // Emit fill event for inventory management
    this.emit('fullFill', {
      orderId: order.id,
      clientOrderId: order.clientOrderId,
      side: order.side,
      size: order.originalSize,
      avgPrice
    });
    
    // Remove from managed orders
    this.managedOrders.delete(order.clientOrderId);
    
    // Trigger recalculation and requote
    this.emit('requiresRequote', { reason: 'fullFill', order });
  }

  private handleOrderCanceled(order: ManagedOrder): void {
    order.state = OrderState.IDLE;
    this.stats.cancelledOrders++;
    
    this.logger.debug(`Order canceled: ${order.clientOrderId}`);
    
    // Remove from managed orders
    this.managedOrders.delete(order.clientOrderId);
  }

  private handleOrderRejected(order: ManagedOrder, reason: string): void {
    order.state = OrderState.ERROR;
    order.retryCount++;
    this.stats.failedOrders++;
    
    this.logger.error(`Order rejected: ${order.clientOrderId}`, { reason, retryCount: order.retryCount });
    
    // Retry if under limit
    if (order.retryCount < this.config.maxRetries) {
      setTimeout(() => {
        this.retryOrder(order);
      }, 1000 * order.retryCount); // Exponential backoff
    } else {
      this.managedOrders.delete(order.clientOrderId);
      this.emit('orderFailed', { order, reason });
    }
  }

  private async retryOrder(order: ManagedOrder): Promise<void> {
    order.state = OrderState.PLACING;
    order.placedTime = Date.now();
    order.ttlExpiry = Date.now() + this.config.ttlMs;
    
    this.emit('placeOrder', {
      clientOrderId: order.clientOrderId,
      side: order.side,
      price: order.price,
      size: order.remainingSize,
      timeInForce: 'GTX',
      postOnly: true
    });
  }

  private checkTTLExpiry(): void {
    const now = Date.now();
    
    for (const [clientOrderId, order] of this.managedOrders.entries()) {
      if (order.state === OrderState.MAKER_PLACED && now >= order.ttlExpiry) {
        this.logger.debug(`TTL expired for order: ${clientOrderId}`);
        this.queueRepost(clientOrderId);
      }
    }
  }

  private queueRepost(clientOrderId: string): void {
    this.repostQueue.push({ clientOrderId, timestamp: Date.now() });
    this.emit('requiresRequote', { reason: 'ttlExpired', clientOrderId });
  }

  private processRepostQueue(): void {
    if (this.repostQueue.length === 0) return;
    if (!this.canRepost()) return;
    
    const { clientOrderId } = this.repostQueue.shift()!;
    const order = this.managedOrders.get(clientOrderId);
    
    if (order && order.state === OrderState.MAKER_PLACED) {
      this.cancelAndReplace(order);
    }
  }

  private async cancelAndReplace(order: ManagedOrder): Promise<void> {
    order.state = OrderState.REPLACING;
    this.stats.repostCount++;
    
    this.logger.debug(`Cancel-replacing order: ${order.clientOrderId}`);
    
    // Emit cancel-replace request
    this.emit('cancelReplaceOrder', {
      orderId: order.id,
      clientOrderId: order.clientOrderId,
      newPrice: order.price,
      newSize: order.remainingSize
    });
  }

  private async cancelExistingOrders(): Promise<void> {
    const activeOrders = Array.from(this.managedOrders.values())
      .filter(order => order.state === OrderState.MAKER_PLACED || order.state === OrderState.PLACING);
    
    if (activeOrders.length === 0) return;
    
    this.logger.debug(`Canceling ${activeOrders.length} existing orders`);
    
    // Cancel all active orders
    for (const order of activeOrders) {
      order.state = OrderState.CANCELLING;
      this.emit('cancelOrder', {
        orderId: order.id,
        clientOrderId: order.clientOrderId
      });
    }
    
    // Wait for cancellations (simplified)
    await this.sleep(100);
  }

  public async flattenPosition(): Promise<void> {
    this.logger.warn('Flattening position due to risk limits');
    this.transitionToState(OrderState.FLATTENING);
    this.stats.flattenEvents++;
    
    // Cancel all existing orders first
    await this.cancelExistingOrders();
    
    // Emit flatten request (will be handled by risk manager)
    this.emit('flattenPosition', { 
      timeout: this.config.flattenTimeoutMs,
      method: 'IOC' // Immediate or Cancel market orders
    });
    
    // Start cooldown timer
    setTimeout(() => {
      this.transitionToState(OrderState.COOLDOWN);
      setTimeout(() => {
        this.transitionToState(OrderState.IDLE);
        this.emit('cooldownExpired');
      }, this.config.cooldownMs);
    }, this.config.flattenTimeoutMs);
  }

  private canRepost(): boolean {
    const now = Date.now();
    const timeSinceLastRepost = now - this.lastRepostTime;
    return timeSinceLastRepost >= this.config.repostMs;
  }

  private transitionToState(newState: OrderState): void {
    const oldState = this.currentState;
    this.currentState = newState;
    
    this.logger.debug(`State transition: ${oldState} -> ${newState}`);
    this.emit('stateTransition', { from: oldState, to: newState });
  }

  private updateStats(): void {
    // Calculate fill ratio
    this.stats.fillRatio = this.stats.totalOrders > 0 ? 
      (this.stats.filledOrders / this.stats.totalOrders) * 100 : 0;
    
    // Calculate average fill time
    if (this.fillTimes.length > 0) {
      this.stats.averageFillTime = this.fillTimes.reduce((a, b) => a + b, 0) / this.fillTimes.length;
      
      // Keep only last 100 fill times
      if (this.fillTimes.length > 100) {
        this.fillTimes = this.fillTimes.slice(-100);
      }
    }
    
    // Calculate rejection rate
    this.stats.rejectionRate = this.stats.totalOrders > 0 ?
      (this.stats.failedOrders / this.stats.totalOrders) * 100 : 0;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Public getters
  public getStats(): ExecutionStats {
    return { ...this.stats };
  }

  public getManagedOrders(): ManagedOrder[] {
    return Array.from(this.managedOrders.values());
  }

  public getCurrentState(): OrderState {
    return this.currentState;
  }

  public getConfig(): ExecutionConfig {
    return { ...this.config };
  }

  public updateConfig(updates: Partial<ExecutionConfig>): void {
    this.config = { ...this.config, ...updates };
    this.logger.info('Execution config updated', { updates });
    this.emit('configUpdated', this.config);
  }

  // Reset methods
  public reset(): void {
    this.managedOrders.clear();
    this.repostQueue = [];
    this.currentState = OrderState.IDLE;
    this.logger.info('Execution engine reset');
  }

  public resetStats(): void {
    this.stats = {
      totalOrders: 0,
      filledOrders: 0,
      partialFills: 0,
      cancelledOrders: 0,
      failedOrders: 0,
      averageFillTime: 0,
      repostCount: 0,
      flattenEvents: 0,
      fillRatio: 0,
      avgQueueTime: 0,
      rejectionRate: 0
    };
    this.fillTimes = [];
    this.queueTimes = [];
    this.logger.info('Execution stats reset');
  }
}
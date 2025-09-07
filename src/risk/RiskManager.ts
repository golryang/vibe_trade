import { EventEmitter } from 'events';
import { Logger } from '../core/Logger';
import { InventoryState } from '../engines/StoikovEngine';
import winston from 'winston';

export interface RiskLimits {
  // Inventory limits
  maxInventoryPct: number;        // |q|max as % of NAV {2%, 5%, 10%}
  inventoryWarningPct: number;    // Warning threshold (% of max)
  
  // Drift limits  
  driftCutBps: number;           // Price drift cut {3, 5, 8}bp
  driftWarningBps: number;       // Warning threshold (% of cut)
  
  // Drawdown limits
  sessionDDLimitPct: number;     // Session DD limit {0.3, 0.5, 1.0}% NAV
  dailyDDLimitPct: number;       // Daily DD limit
  ddWarningPct: number;          // Warning threshold (% of limit)
  
  // Operational limits
  maxConsecutiveFails: number;   // Max consecutive fails {5, 10, 20}
  maxOrdersPerSecond: number;    // Rate limiting
  maxSpreadMultiplier: number;   // Emergency spread cap (x normal)
  
  // Volatility-based limits
  volSpikeThresholdPct: number;  // Volatility spike threshold
  volSpikeCooldownMs: number;    // Cooldown after vol spike
  
  // Emergency controls
  enableEmergencyStop: boolean;  // Kill switch
  enableNewsStop: boolean;       // Stop on news events
  newsStopDurationMs: number;    // Duration of news stop
}

export interface RiskMetrics {
  // Current state
  inventoryPct: number;          // Current inventory as % of NAV
  inventoryRisk: number;         // Inventory risk score (0-1)
  driftBps: number;              // Current price drift in bp
  sessionDDPct: number;          // Session drawdown %
  dailyDDPct: number;            // Daily drawdown %
  
  // Counters
  consecutiveFailures: number;   // Current consecutive failures
  ordersPerSecond: number;       // Current order rate
  totalViolations: number;       // Total risk violations today
  
  // Volatility metrics
  currentVolatility: number;     // Current volatility
  baselineVolatility: number;    // Baseline/average volatility  
  volSpikeRatio: number;         // Current vol / baseline vol
  
  // Risk scores (0-1)
  inventoryRiskScore: number;
  driftRiskScore: number;
  ddRiskScore: number;
  overallRiskScore: number;
  
  // Status
  isFlat: boolean;               // Currently flat position
  isInCooldown: boolean;         // In risk cooldown period
  lastViolation: number;         // Timestamp of last violation
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

export interface RiskEvent {
  type: 'inventoryLimit' | 'driftLimit' | 'ddLimit' | 'consecutiveFailures' | 
        'volSpike' | 'emergencyStop' | 'newsStop' | 'rateLimit';
  severity: 'warning' | 'limit' | 'critical';
  value: number;
  limit: number;
  timestamp: number;
  action: 'warn' | 'reduceSize' | 'flatten' | 'stop';
  metadata?: any;
}

export class RiskManager extends EventEmitter {
  private logger: winston.Logger;
  private limits: RiskLimits;
  private metrics: RiskMetrics;
  
  // State tracking
  private sessionStartTime: number;
  private sessionPnL: number = 0;
  private dailyPnL: number = 0;
  private sessionHighWaterMark: number = 0;
  private dailyHighWaterMark: number = 0;
  
  // Failure tracking
  private recentFailures: Array<{timestamp: number, reason: string}> = [];
  private orderRateBuffer: number[] = [];
  
  // Volatility tracking
  private volHistory: Array<{vol: number, timestamp: number}> = [];
  private baselineVol: number = 0.3; // Default baseline volatility
  
  // Emergency state
  private isEmergencyStopped: boolean = false;
  private isNewsStopped: boolean = false;
  private newsStopExpiry: number = 0;
  private cooldownExpiry: number = 0;

  constructor(limits: RiskLimits) {
    super();
    this.limits = limits;
    this.logger = Logger.getInstance().child({ module: 'RiskManager' });
    
    this.sessionStartTime = Date.now();
    this.initializeMetrics();
    this.startPeriodicTasks();
    
    this.logger.info('Risk manager initialized', { limits });
  }

  private initializeMetrics(): void {
    this.metrics = {
      inventoryPct: 0,
      inventoryRisk: 0,
      driftBps: 0,
      sessionDDPct: 0,
      dailyDDPct: 0,
      consecutiveFailures: 0,
      ordersPerSecond: 0,
      totalViolations: 0,
      currentVolatility: this.baselineVol,
      baselineVolatility: this.baselineVol,
      volSpikeRatio: 1.0,
      inventoryRiskScore: 0,
      driftRiskScore: 0,
      ddRiskScore: 0,
      overallRiskScore: 0,
      isFlat: true,
      isInCooldown: false,
      lastViolation: 0,
      riskLevel: 'low'
    };
  }

  private startPeriodicTasks(): void {
    // Update risk metrics every second
    setInterval(() => {
      this.updateRiskMetrics();
      this.checkRiskLimits();
    }, 1000);
    
    // Clean old data every minute
    setInterval(() => {
      this.cleanupOldData();
    }, 60000);
    
    // Update daily metrics at midnight
    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const msUntilMidnight = tomorrow.getTime() - now.getTime();
    
    setTimeout(() => {
      this.resetDailyMetrics();
      setInterval(() => this.resetDailyMetrics(), 24 * 60 * 60 * 1000);
    }, msUntilMidnight);
  }

  public updateInventory(inventory: InventoryState): void {
    const navPct = Math.abs(inventory.navPct);
    this.metrics.inventoryPct = navPct;
    this.metrics.inventoryRisk = navPct / this.limits.maxInventoryPct;
    this.metrics.driftBps = Math.abs(inventory.drift);
    this.metrics.isFlat = Math.abs(inventory.position) < 0.001;
    
    // Check inventory limits
    if (navPct > this.limits.maxInventoryPct) {
      this.emitRiskEvent({
        type: 'inventoryLimit',
        severity: 'limit',
        value: navPct,
        limit: this.limits.maxInventoryPct,
        timestamp: Date.now(),
        action: 'flatten'
      });
    } else if (navPct > this.limits.maxInventoryPct * this.limits.inventoryWarningPct / 100) {
      this.emitRiskEvent({
        type: 'inventoryLimit',
        severity: 'warning',
        value: navPct,
        limit: this.limits.maxInventoryPct,
        timestamp: Date.now(),
        action: 'warn'
      });
    }
    
    // Check drift limits
    if (this.metrics.driftBps > this.limits.driftCutBps) {
      this.emitRiskEvent({
        type: 'driftLimit',
        severity: 'limit',
        value: this.metrics.driftBps,
        limit: this.limits.driftCutBps,
        timestamp: Date.now(),
        action: 'flatten'
      });
    } else if (this.metrics.driftBps > this.limits.driftCutBps * this.limits.driftWarningBps / 100) {
      this.emitRiskEvent({
        type: 'driftLimit',
        severity: 'warning',
        value: this.metrics.driftBps,
        limit: this.limits.driftCutBps,
        timestamp: Date.now(),
        action: 'warn'
      });
    }
    
    this.emit('inventoryUpdated', { inventory, metrics: this.metrics });
  }

  public updatePnL(sessionPnL: number, dailyPnL: number): void {
    this.sessionPnL = sessionPnL;
    this.dailyPnL = dailyPnL;
    
    // Update high water marks
    this.sessionHighWaterMark = Math.max(this.sessionHighWaterMark, sessionPnL);
    this.dailyHighWaterMark = Math.max(this.dailyHighWaterMark, dailyPnL);
    
    // Calculate drawdowns
    const sessionDD = ((this.sessionHighWaterMark - sessionPnL) / Math.abs(this.sessionHighWaterMark)) * 100;
    const dailyDD = ((this.dailyHighWaterMark - dailyPnL) / Math.abs(this.dailyHighWaterMark)) * 100;
    
    this.metrics.sessionDDPct = Math.max(0, sessionDD);
    this.metrics.dailyDDPct = Math.max(0, dailyDD);
    
    // Check drawdown limits
    if (this.metrics.sessionDDPct > this.limits.sessionDDLimitPct) {
      this.emitRiskEvent({
        type: 'ddLimit',
        severity: 'limit',
        value: this.metrics.sessionDDPct,
        limit: this.limits.sessionDDLimitPct,
        timestamp: Date.now(),
        action: 'flatten',
        metadata: { type: 'session' }
      });
    }
    
    if (this.metrics.dailyDDPct > this.limits.dailyDDLimitPct) {
      this.emitRiskEvent({
        type: 'ddLimit',
        severity: 'critical',
        value: this.metrics.dailyDDPct,
        limit: this.limits.dailyDDLimitPct,
        timestamp: Date.now(),
        action: 'stop',
        metadata: { type: 'daily' }
      });
    }
  }

  public updateVolatility(volatility: number): void {
    this.metrics.currentVolatility = volatility;
    
    // Add to history
    this.volHistory.push({ vol: volatility, timestamp: Date.now() });
    
    // Update baseline (rolling average of last hour)
    this.updateBaselineVolatility();
    
    // Calculate vol spike ratio
    this.metrics.volSpikeRatio = volatility / this.metrics.baselineVolatility;
    
    // Check volatility spike
    if (this.metrics.volSpikeRatio > this.limits.volSpikeThresholdPct / 100) {
      this.emitRiskEvent({
        type: 'volSpike',
        severity: 'warning',
        value: this.metrics.volSpikeRatio,
        limit: this.limits.volSpikeThresholdPct / 100,
        timestamp: Date.now(),
        action: 'reduceSize',
        metadata: { 
          currentVol: volatility,
          baselineVol: this.metrics.baselineVolatility 
        }
      });
      
      // Start cooldown
      this.startVolSpikeCooldown();
    }
  }

  public recordFailure(reason: string): void {
    this.recentFailures.push({ timestamp: Date.now(), reason });
    
    // Count consecutive failures (last 5 minutes)
    const fiveMinutesAgo = Date.now() - 300000;
    const recentFailureCount = this.recentFailures.filter(f => f.timestamp >= fiveMinutesAgo).length;
    
    this.metrics.consecutiveFailures = recentFailureCount;
    
    // Check consecutive failure limit
    if (recentFailureCount >= this.limits.maxConsecutiveFails) {
      this.emitRiskEvent({
        type: 'consecutiveFailures',
        severity: 'limit',
        value: recentFailureCount,
        limit: this.limits.maxConsecutiveFails,
        timestamp: Date.now(),
        action: 'flatten',
        metadata: { reasons: this.recentFailures.slice(-5).map(f => f.reason) }
      });
    }
  }

  public recordOrderRate(): void {
    this.orderRateBuffer.push(Date.now());
    
    // Calculate orders per second (last 1 second)
    const oneSecondAgo = Date.now() - 1000;
    const recentOrders = this.orderRateBuffer.filter(t => t >= oneSecondAgo);
    this.metrics.ordersPerSecond = recentOrders.length;
    
    // Check rate limit
    if (this.metrics.ordersPerSecond > this.limits.maxOrdersPerSecond) {
      this.emitRiskEvent({
        type: 'rateLimit',
        severity: 'warning',
        value: this.metrics.ordersPerSecond,
        limit: this.limits.maxOrdersPerSecond,
        timestamp: Date.now(),
        action: 'warn'
      });
    }
  }

  private updateBaselineVolatility(): void {
    const oneHourAgo = Date.now() - 3600000;
    const recentVols = this.volHistory.filter(v => v.timestamp >= oneHourAgo);
    
    if (recentVols.length > 0) {
      this.metrics.baselineVolatility = recentVols.reduce((sum, v) => sum + v.vol, 0) / recentVols.length;
    }
  }

  private updateRiskMetrics(): void {
    // Calculate risk scores (0-1)
    this.metrics.inventoryRiskScore = Math.min(1, this.metrics.inventoryPct / this.limits.maxInventoryPct);
    this.metrics.driftRiskScore = Math.min(1, this.metrics.driftBps / this.limits.driftCutBps);
    this.metrics.ddRiskScore = Math.min(1, Math.max(
      this.metrics.sessionDDPct / this.limits.sessionDDLimitPct,
      this.metrics.dailyDDPct / this.limits.dailyDDLimitPct
    ));
    
    // Overall risk score (weighted average)
    this.metrics.overallRiskScore = (
      this.metrics.inventoryRiskScore * 0.4 +
      this.metrics.driftRiskScore * 0.3 +
      this.metrics.ddRiskScore * 0.3
    );
    
    // Determine risk level
    if (this.metrics.overallRiskScore >= 0.8) {
      this.metrics.riskLevel = 'critical';
    } else if (this.metrics.overallRiskScore >= 0.6) {
      this.metrics.riskLevel = 'high';
    } else if (this.metrics.overallRiskScore >= 0.3) {
      this.metrics.riskLevel = 'medium';
    } else {
      this.metrics.riskLevel = 'low';
    }
    
    // Check cooldown status
    this.metrics.isInCooldown = Date.now() < this.cooldownExpiry;
    
    // Check news stop status
    if (Date.now() >= this.newsStopExpiry) {
      this.isNewsStopped = false;
    }
  }

  private checkRiskLimits(): void {
    // Skip if already in emergency stop
    if (this.isEmergencyStopped || this.isNewsStopped) {
      return;
    }
    
    // Critical risk level triggers flatten
    if (this.metrics.riskLevel === 'critical' && !this.metrics.isFlat) {
      this.logger.warn('Critical risk level reached, flattening position');
      this.emit('flattenRequired', { 
        reason: 'criticalRisk', 
        riskScore: this.metrics.overallRiskScore 
      });
    }
  }

  private emitRiskEvent(event: RiskEvent): void {
    this.logger.warn(`Risk event: ${event.type}`, event);
    this.metrics.totalViolations++;
    this.metrics.lastViolation = event.timestamp;
    
    this.emit('riskEvent', event);
    
    // Take automated action
    switch (event.action) {
      case 'warn':
        this.emit('riskWarning', event);
        break;
      case 'reduceSize':
        this.emit('reduceSizeRequired', event);
        break;
      case 'flatten':
        this.emit('flattenRequired', event);
        break;
      case 'stop':
        this.emergencyStop(event.type);
        break;
    }
  }

  private startVolSpikeCooldown(): void {
    this.cooldownExpiry = Date.now() + this.limits.volSpikeCooldownMs;
    this.logger.info(`Started volatility spike cooldown for ${this.limits.volSpikeCooldownMs}ms`);
  }

  private cleanupOldData(): void {
    const oneHourAgo = Date.now() - 3600000;
    const fiveMinutesAgo = Date.now() - 300000;
    const oneSecondAgo = Date.now() - 1000;
    
    // Clean volatility history (keep 1 hour)
    this.volHistory = this.volHistory.filter(v => v.timestamp >= oneHourAgo);
    
    // Clean failure history (keep 5 minutes)
    this.recentFailures = this.recentFailures.filter(f => f.timestamp >= fiveMinutesAgo);
    
    // Clean order rate buffer (keep 1 second)
    this.orderRateBuffer = this.orderRateBuffer.filter(t => t >= oneSecondAgo);
  }

  private resetDailyMetrics(): void {
    this.dailyPnL = 0;
    this.dailyHighWaterMark = 0;
    this.metrics.dailyDDPct = 0;
    this.metrics.totalViolations = 0;
    this.logger.info('Daily risk metrics reset');
  }

  // Public control methods
  public emergencyStop(reason: string): void {
    if (this.isEmergencyStopped) return;
    
    this.isEmergencyStopped = true;
    this.logger.error(`Emergency stop activated: ${reason}`);
    
    this.emit('emergencyStop', { reason, timestamp: Date.now() });
  }

  public newsStop(durationMs?: number): void {
    const duration = durationMs || this.limits.newsStopDurationMs;
    this.isNewsStopped = true;
    this.newsStopExpiry = Date.now() + duration;
    
    this.logger.warn(`News stop activated for ${duration}ms`);
    this.emit('newsStop', { duration, expiry: this.newsStopExpiry });
  }

  public resetEmergencyStop(): void {
    this.isEmergencyStopped = false;
    this.logger.info('Emergency stop reset');
    this.emit('emergencyStopReset');
  }

  public canTrade(): boolean {
    return !this.isEmergencyStopped && !this.isNewsStopped && !this.metrics.isInCooldown;
  }

  public shouldReduceSize(): boolean {
    return this.metrics.riskLevel === 'high' || this.metrics.volSpikeRatio > 1.5;
  }

  public getSizeMultiplier(): number {
    if (!this.canTrade()) return 0;
    
    switch (this.metrics.riskLevel) {
      case 'critical':
        return 0;
      case 'high':
        return 0.5;
      case 'medium':
        return 0.8;
      default:
        return 1.0;
    }
  }

  public getSpreadMultiplier(): number {
    let multiplier = 1.0;
    
    // Increase spread during high vol
    if (this.metrics.volSpikeRatio > 1.5) {
      multiplier *= Math.min(this.limits.maxSpreadMultiplier, this.metrics.volSpikeRatio);
    }
    
    // Increase spread during high risk
    if (this.metrics.riskLevel === 'high') {
      multiplier *= 1.5;
    } else if (this.metrics.riskLevel === 'critical') {
      multiplier *= 2.0;
    }
    
    return Math.min(multiplier, this.limits.maxSpreadMultiplier);
  }

  // Getters
  public getMetrics(): RiskMetrics {
    return { ...this.metrics };
  }

  public getLimits(): RiskLimits {
    return { ...this.limits };
  }

  public updateLimits(updates: Partial<RiskLimits>): void {
    this.limits = { ...this.limits, ...updates };
    this.logger.info('Risk limits updated', { updates });
    this.emit('limitsUpdated', this.limits);
  }

  public getStatus(): any {
    return {
      canTrade: this.canTrade(),
      isEmergencyStopped: this.isEmergencyStopped,
      isNewsStopped: this.isNewsStopped,
      isInCooldown: this.metrics.isInCooldown,
      riskLevel: this.metrics.riskLevel,
      overallRiskScore: this.metrics.overallRiskScore,
      sizeMultiplier: this.getSizeMultiplier(),
      spreadMultiplier: this.getSpreadMultiplier(),
      sessionRuntime: Date.now() - this.sessionStartTime,
      newsStopExpiry: this.newsStopExpiry,
      cooldownExpiry: this.cooldownExpiry
    };
  }
}
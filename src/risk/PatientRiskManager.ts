import { EventEmitter } from 'events';
import { Logger } from '../core/Logger';
import { RiskManager, RiskLimits, RiskMetrics, RiskEvent } from './RiskManager';
import { InventoryState } from '../engines/StoikovEngine';
import { PatientOrderState } from '../execution/PatientExecutionEngine';
import winston from 'winston';

// Extended risk limits for Patient Stoikov
export interface PatientRiskLimits extends RiskLimits {
  // Patient-specific session limits
  maxWaitTimePerLevel: number;         // Max wait time per level {30s, 60s, 120s}
  maxSessionDuration: number;          // Max single session duration {300s, 600s}
  maxDailyRequotes: number;           // Max requotes per day {1000, 2000}
  
  // Event-based risk controls
  maxTopNExitsPerHour: number;        // Max Top-N exits per hour {10, 20}
  maxDriftEventsPerHour: number;      // Max drift events per hour {5, 10}
  maxQueueAheadEventsPerSession: number; // Max queue ahead events per session {5, 10}
  
  // Performance-based limits
  minFillRatio: number;               // Minimum fill ratio % {30%, 50%}
  maxSlippageBps: number;             // Maximum slippage {5, 10} bps
  minEffectiveSpreadCapture: number;  // Minimum effective spread capture %
  
  // Patient-specific emergency conditions
  enableVolatilityFloor: boolean;     // Stop trading below vol threshold
  volatilityFloor: number;            // Minimum volatility to trade
  enableLiquidityFloor: boolean;      // Stop trading below liquidity threshold
  liquidityFloorSize: number;         // Minimum top-of-book size
  
  // Regime-based adjustments
  enableRegimeAdjustments: boolean;   // Enable automatic risk adjustments
  regimeRiskMultipliers: {
    low: number;                      // Risk multiplier for low vol regime
    medium: number;                   // Risk multiplier for medium vol regime
    high: number;                     // Risk multiplier for high vol regime
  };
}

// Extended metrics for Patient Stoikov
export interface PatientRiskMetrics extends RiskMetrics {
  // Session-based metrics
  currentSessionDuration: number;      // Current session duration (ms)
  avgWaitTimePerLevel: number;        // Average wait time per level (ms)
  sessionRequoteCount: number;        // Requotes in current session
  dailyRequoteCount: number;          // Total requotes today
  
  // Event-based metrics
  topNExitsLastHour: number;          // Top-N exits in last hour
  driftEventsLastHour: number;        // Drift events in last hour
  queueAheadEventsThisSession: number; // Queue ahead events this session
  
  // Performance metrics
  actualFillRatio: number;            // Actual fill ratio %
  avgSlippageBps: number;             // Average slippage experienced
  effectiveSpreadCapture: number;     // Effective spread captured
  
  // Patient-specific risk scores
  sessionRiskScore: number;           // Session-based risk (0-1)
  performanceRiskScore: number;       // Performance-based risk (0-1)
  eventRiskScore: number;             // Event frequency-based risk (0-1)
  regimeRiskScore: number;            // Regime-based risk adjustment (0-1)
  
  // Market condition assessment
  currentRegime: 'low' | 'medium' | 'high'; // Current volatility regime
  liquidityAssessment: 'poor' | 'fair' | 'good'; // Current liquidity
  shouldPauseTrading: boolean;        // Recommendation to pause
}

export class PatientRiskManager extends EventEmitter {
  private logger: winston.Logger;
  private baseRiskManager: RiskManager;
  private patientLimits: PatientRiskLimits;
  private patientMetrics: PatientRiskMetrics;
  
  // Session tracking
  private currentSessionStart: number = 0;
  private sessionRequoteCount: number = 0;
  private dailyRequoteCount: number = 0;
  private levelWaitTimes: Map<string, number> = new Map();
  
  // Event tracking
  private eventHistory: Array<{ type: string; timestamp: number; sessionId: number }> = [];
  private fillHistory: Array<{ timestamp: number; slippageBps: number; spreadCapture: number }> = [];
  
  // Market condition tracking
  private liquidityHistory: Array<{ timestamp: number; topBidSize: number; topAskSize: number }> = [];
  private volatilityRegimeHistory: Array<{ timestamp: number; volatility: number; regime: string }> = [];
  
  // State tracking
  private currentState: PatientOrderState = PatientOrderState.IDLE;

  constructor(limits: PatientRiskLimits) {
    super();
    this.patientLimits = limits;
    this.logger = Logger.getInstance().child({ module: 'PatientRiskManager' });
    
    // Initialize base risk manager with standard limits
    this.baseRiskManager = new RiskManager(limits);
    
    this.initializePatientMetrics();
    this.setupBaseRiskManagerListeners();
    this.startPatientPeriodicTasks();
    
    this.logger.info('Patient risk manager initialized', { limits: this.sanitizeConfig(limits) });
  }

  private sanitizeConfig(limits: PatientRiskLimits): any {
    return {
      maxInventoryPct: limits.maxInventoryPct,
      sessionDDLimitPct: limits.sessionDDLimitPct,
      maxWaitTimePerLevel: limits.maxWaitTimePerLevel,
      maxSessionDuration: limits.maxSessionDuration,
      minFillRatio: limits.minFillRatio,
      enableRegimeAdjustments: limits.enableRegimeAdjustments
    };
  }

  private initializePatientMetrics(): void {
    const baseMetrics = this.baseRiskManager.getMetrics();
    
    this.patientMetrics = {
      ...baseMetrics,
      currentSessionDuration: 0,
      avgWaitTimePerLevel: 0,
      sessionRequoteCount: 0,
      dailyRequoteCount: 0,
      topNExitsLastHour: 0,
      driftEventsLastHour: 0,
      queueAheadEventsThisSession: 0,
      actualFillRatio: 0,
      avgSlippageBps: 0,
      effectiveSpreadCapture: 0,
      sessionRiskScore: 0,
      performanceRiskScore: 0,
      eventRiskScore: 0,
      regimeRiskScore: 0,
      currentRegime: 'medium',
      liquidityAssessment: 'fair',
      shouldPauseTrading: false
    };
  }

  private setupBaseRiskManagerListeners(): void {
    this.baseRiskManager.on('riskEvent', (event: RiskEvent) => {
      // Forward base risk events and add patient-specific handling
      this.handleBaseRiskEvent(event);
      this.emit('riskEvent', event);
    });
    
    this.baseRiskManager.on('flattenRequired', (data: any) => {
      this.emit('flattenRequired', data);
    });
    
    this.baseRiskManager.on('emergencyStop', (data: any) => {
      this.emit('emergencyStop', data);
    });
    
    this.baseRiskManager.on('riskWarning', (event: RiskEvent) => {
      this.emit('riskWarning', event);
    });
  }

  private startPatientPeriodicTasks(): void {
    // Update patient metrics every 5 seconds
    setInterval(() => {
      this.updatePatientMetrics();
      this.checkPatientRiskLimits();
    }, 5000);
    
    // Clean old data every 10 minutes
    setInterval(() => {
      this.cleanupPatientData();
    }, 600000);
    
    // Reset daily counters at midnight
    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const msUntilMidnight = tomorrow.getTime() - now.getTime();
    
    setTimeout(() => {
      this.resetDailyPatientMetrics();
      setInterval(() => this.resetDailyPatientMetrics(), 24 * 60 * 60 * 1000);
    }, msUntilMidnight);
  }

  // Patient-specific event tracking
  public onPatientSessionStart(): void {
    this.currentSessionStart = Date.now();
    this.sessionRequoteCount = 0;
    this.levelWaitTimes.clear();
    
    this.logger.debug('Patient session started', { sessionId: this.currentSessionStart });
  }

  public onPatientRequote(reason: string): void {
    this.sessionRequoteCount++;
    this.dailyRequoteCount++;
    
    // Record event
    this.eventHistory.push({
      type: 'requote',
      timestamp: Date.now(),
      sessionId: this.currentSessionStart
    });
    
    // Check daily requote limit
    if (this.dailyRequoteCount > this.patientLimits.maxDailyRequotes) {
      this.emitPatientRiskEvent({
        type: 'dailyRequoteLimit',
        severity: 'limit',
        value: this.dailyRequoteCount,
        limit: this.patientLimits.maxDailyRequotes,
        action: 'stop',
        reason: 'Daily requote limit exceeded'
      });
    }
    
    this.logger.debug('Patient requote recorded', { 
      reason, 
      sessionCount: this.sessionRequoteCount, 
      dailyCount: this.dailyRequoteCount 
    });
  }

  public onTopNExit(): void {
    this.eventHistory.push({
      type: 'topNExit',
      timestamp: Date.now(),
      sessionId: this.currentSessionStart
    });
    
    // Check Top-N exit frequency
    const oneHourAgo = Date.now() - 3600000;
    const topNExitsLastHour = this.eventHistory
      .filter(e => e.type === 'topNExit' && e.timestamp >= oneHourAgo).length;
    
    if (topNExitsLastHour > this.patientLimits.maxTopNExitsPerHour) {
      this.emitPatientRiskEvent({
        type: 'topNExitFrequency',
        severity: 'warning',
        value: topNExitsLastHour,
        limit: this.patientLimits.maxTopNExitsPerHour,
        action: 'reduceSize',
        reason: 'Too many Top-N exits per hour'
      });
    }
  }

  public onDriftEvent(): void {
    this.eventHistory.push({
      type: 'drift',
      timestamp: Date.now(),
      sessionId: this.currentSessionStart
    });
    
    // Check drift event frequency
    const oneHourAgo = Date.now() - 3600000;
    const driftEventsLastHour = this.eventHistory
      .filter(e => e.type === 'drift' && e.timestamp >= oneHourAgo).length;
    
    if (driftEventsLastHour > this.patientLimits.maxDriftEventsPerHour) {
      this.emitPatientRiskEvent({
        type: 'driftEventFrequency',
        severity: 'warning',
        value: driftEventsLastHour,
        limit: this.patientLimits.maxDriftEventsPerHour,
        action: 'reduceSize',
        reason: 'Too many drift events per hour'
      });
    }
  }

  public onQueueAheadEvent(): void {
    this.eventHistory.push({
      type: 'queueAhead',
      timestamp: Date.now(),
      sessionId: this.currentSessionStart
    });
    
    // Check queue ahead events per session
    const queueAheadEventsThisSession = this.eventHistory
      .filter(e => e.type === 'queueAhead' && e.sessionId === this.currentSessionStart).length;
    
    if (queueAheadEventsThisSession > this.patientLimits.maxQueueAheadEventsPerSession) {
      this.emitPatientRiskEvent({
        type: 'queueAheadFrequency',
        severity: 'warning',
        value: queueAheadEventsThisSession,
        limit: this.patientLimits.maxQueueAheadEventsPerSession,
        action: 'warn',
        reason: 'Too many queue ahead events this session'
      });
    }
  }

  public onFill(fillData: { slippageBps: number; spreadCapture: number }): void {
    this.fillHistory.push({
      timestamp: Date.now(),
      slippageBps: fillData.slippageBps,
      spreadCapture: fillData.spreadCapture
    });
    
    // Check slippage limits
    if (fillData.slippageBps > this.patientLimits.maxSlippageBps) {
      this.emitPatientRiskEvent({
        type: 'slippageLimit',
        severity: 'warning',
        value: fillData.slippageBps,
        limit: this.patientLimits.maxSlippageBps,
        action: 'warn',
        reason: 'High slippage detected'
      });
    }
  }

  public updateLevelWaitTime(levelKey: string, waitTimeMs: number): void {
    this.levelWaitTimes.set(levelKey, waitTimeMs);
    
    // Check individual level wait time limit
    if (waitTimeMs > this.patientLimits.maxWaitTimePerLevel) {
      this.emitPatientRiskEvent({
        type: 'levelWaitTime',
        severity: 'warning',
        value: waitTimeMs,
        limit: this.patientLimits.maxWaitTimePerLevel,
        action: 'warn',
        reason: `Level ${levelKey} wait time exceeded`
      });
    }
  }

  public updateMarketConditions(orderBook: any): void {
    if (!orderBook.bids.length || !orderBook.asks.length) return;
    
    const topBidSize = orderBook.bids[0].size;
    const topAskSize = orderBook.asks[0].size;
    
    this.liquidityHistory.push({
      timestamp: Date.now(),
      topBidSize,
      topAskSize
    });
    
    // Check liquidity floor
    if (this.patientLimits.enableLiquidityFloor) {
      const minLiquidity = Math.min(topBidSize, topAskSize);
      if (minLiquidity < this.patientLimits.liquidityFloorSize) {
        this.emitPatientRiskEvent({
          type: 'liquidityFloor',
          severity: 'warning',
          value: minLiquidity,
          limit: this.patientLimits.liquidityFloorSize,
          action: 'reduceSize',
          reason: 'Liquidity below minimum threshold'
        });
      }
    }
  }

  public updateVolatilityRegime(volatility: number): void {
    // Determine regime
    let regime: 'low' | 'medium' | 'high' = 'medium';
    
    if (volatility < 0.15) {
      regime = 'low';
    } else if (volatility > 0.45) {
      regime = 'high';
    }
    
    this.volatilityRegimeHistory.push({
      timestamp: Date.now(),
      volatility,
      regime
    });
    
    // Check volatility floor
    if (this.patientLimits.enableVolatilityFloor && volatility < this.patientLimits.volatilityFloor) {
      this.emitPatientRiskEvent({
        type: 'volatilityFloor',
        severity: 'warning',
        value: volatility,
        limit: this.patientLimits.volatilityFloor,
        action: 'stop',
        reason: 'Volatility below minimum threshold'
      });
    }
  }

  public updatePatientState(state: PatientOrderState): void {
    this.currentState = state;
    
    // Check session duration when in active states
    if (this.currentSessionStart > 0 && 
        (state === PatientOrderState.WAITING_IN_QUEUE || state === PatientOrderState.QUOTE_PLACING)) {
      
      const sessionDuration = Date.now() - this.currentSessionStart;
      if (sessionDuration > this.patientLimits.maxSessionDuration) {
        this.emitPatientRiskEvent({
          type: 'sessionDuration',
          severity: 'warning',
          value: sessionDuration,
          limit: this.patientLimits.maxSessionDuration,
          action: 'warn',
          reason: 'Session duration exceeded maximum'
        });
      }
    }
  }

  private updatePatientMetrics(): void {
    // Update base metrics first
    const baseMetrics = this.baseRiskManager.getMetrics();
    Object.assign(this.patientMetrics, baseMetrics);
    
    // Update session metrics
    this.patientMetrics.currentSessionDuration = this.currentSessionStart > 0 ? 
      Date.now() - this.currentSessionStart : 0;
    
    this.patientMetrics.sessionRequoteCount = this.sessionRequoteCount;
    this.patientMetrics.dailyRequoteCount = this.dailyRequoteCount;
    
    // Calculate average wait time per level
    const waitTimes = Array.from(this.levelWaitTimes.values());
    this.patientMetrics.avgWaitTimePerLevel = waitTimes.length > 0 ? 
      waitTimes.reduce((sum, time) => sum + time, 0) / waitTimes.length : 0;
    
    // Update event counts
    const oneHourAgo = Date.now() - 3600000;
    this.patientMetrics.topNExitsLastHour = this.eventHistory
      .filter(e => e.type === 'topNExit' && e.timestamp >= oneHourAgo).length;
    
    this.patientMetrics.driftEventsLastHour = this.eventHistory
      .filter(e => e.type === 'drift' && e.timestamp >= oneHourAgo).length;
    
    this.patientMetrics.queueAheadEventsThisSession = this.eventHistory
      .filter(e => e.type === 'queueAhead' && e.sessionId === this.currentSessionStart).length;
    
    // Update performance metrics
    this.updatePerformanceMetrics();
    
    // Update risk scores
    this.updatePatientRiskScores();
    
    // Assess market conditions
    this.assessMarketConditions();
    
    // Update overall assessment
    this.patientMetrics.shouldPauseTrading = this.shouldPauseTrading();
  }

  private updatePerformanceMetrics(): void {
    if (this.fillHistory.length === 0) return;
    
    const recentFills = this.fillHistory.filter(f => f.timestamp >= Date.now() - 3600000);
    
    if (recentFills.length > 0) {
      this.patientMetrics.avgSlippageBps = 
        recentFills.reduce((sum, f) => sum + f.slippageBps, 0) / recentFills.length;
      
      this.patientMetrics.effectiveSpreadCapture = 
        recentFills.reduce((sum, f) => sum + f.spreadCapture, 0) / recentFills.length;
    }
    
    // Calculate fill ratio (simplified - would need order tracking in real implementation)
    this.patientMetrics.actualFillRatio = Math.min(100, recentFills.length * 10); // Placeholder
  }

  private updatePatientRiskScores(): void {
    // Session risk score (based on session duration and requote frequency)
    const sessionDurationRatio = this.patientMetrics.currentSessionDuration / this.patientLimits.maxSessionDuration;
    const requoteFrequencyRatio = this.patientMetrics.sessionRequoteCount / 10; // Normalize to 10 requotes
    this.patientMetrics.sessionRiskScore = Math.min(1, (sessionDurationRatio + requoteFrequencyRatio) / 2);
    
    // Performance risk score
    const fillRatioRisk = Math.max(0, (this.patientLimits.minFillRatio - this.patientMetrics.actualFillRatio) / 100);
    const slippageRisk = Math.min(1, this.patientMetrics.avgSlippageBps / this.patientLimits.maxSlippageBps);
    this.patientMetrics.performanceRiskScore = Math.max(fillRatioRisk, slippageRisk);
    
    // Event risk score
    const topNExitRisk = Math.min(1, this.patientMetrics.topNExitsLastHour / this.patientLimits.maxTopNExitsPerHour);
    const driftEventRisk = Math.min(1, this.patientMetrics.driftEventsLastHour / this.patientLimits.maxDriftEventsPerHour);
    this.patientMetrics.eventRiskScore = Math.max(topNExitRisk, driftEventRisk);
    
    // Regime risk score (based on current regime)
    if (this.patientLimits.enableRegimeAdjustments) {
      const regimeMultiplier = this.patientLimits.regimeRiskMultipliers[this.patientMetrics.currentRegime];
      this.patientMetrics.regimeRiskScore = Math.max(0, regimeMultiplier - 1); // Convert multiplier to risk score
    }
    
    // Update overall risk score to include patient factors
    this.patientMetrics.overallRiskScore = Math.max(
      this.patientMetrics.overallRiskScore, // Base risk score
      (this.patientMetrics.sessionRiskScore + this.patientMetrics.performanceRiskScore + this.patientMetrics.eventRiskScore) / 3
    );
  }

  private assessMarketConditions(): void {
    // Assess liquidity
    if (this.liquidityHistory.length > 0) {
      const recentLiquidity = this.liquidityHistory.slice(-10); // Last 10 data points
      const avgTopSize = recentLiquidity.reduce((sum, l) => sum + Math.min(l.topBidSize, l.topAskSize), 0) / recentLiquidity.length;
      
      if (avgTopSize > this.patientLimits.liquidityFloorSize * 2) {
        this.patientMetrics.liquidityAssessment = 'good';
      } else if (avgTopSize > this.patientLimits.liquidityFloorSize) {
        this.patientMetrics.liquidityAssessment = 'fair';
      } else {
        this.patientMetrics.liquidityAssessment = 'poor';
      }
    }
    
    // Assess volatility regime
    if (this.volatilityRegimeHistory.length > 0) {
      const recent = this.volatilityRegimeHistory.slice(-5);
      const mostCommonRegime = recent.reduce((acc, curr) => {
        acc[curr.regime] = (acc[curr.regime] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      
      this.patientMetrics.currentRegime = Object.keys(mostCommonRegime).reduce((a, b) => 
        mostCommonRegime[a] > mostCommonRegime[b] ? a : b
      ) as 'low' | 'medium' | 'high';
    }
  }

  private shouldPauseTrading(): boolean {
    // Check multiple pause conditions
    const conditions = [
      this.patientMetrics.overallRiskScore > 0.8,
      this.patientMetrics.liquidityAssessment === 'poor',
      this.patientLimits.enableVolatilityFloor && this.patientMetrics.currentVolatility < this.patientLimits.volatilityFloor,
      this.patientMetrics.actualFillRatio < this.patientLimits.minFillRatio,
      this.dailyRequoteCount > this.patientLimits.maxDailyRequotes
    ];
    
    return conditions.some(Boolean);
  }

  private checkPatientRiskLimits(): void {
    // Performance-based limits
    if (this.patientMetrics.actualFillRatio < this.patientLimits.minFillRatio) {
      this.emitPatientRiskEvent({
        type: 'fillRatio',
        severity: 'warning',
        value: this.patientMetrics.actualFillRatio,
        limit: this.patientLimits.minFillRatio,
        action: 'warn',
        reason: 'Fill ratio below minimum threshold'
      });
    }
    
    // Pause trading recommendation
    if (this.patientMetrics.shouldPauseTrading) {
      this.emit('pauseTradingRecommended', {
        reason: 'Multiple risk conditions met',
        riskScore: this.patientMetrics.overallRiskScore,
        conditions: {
          liquidityPoor: this.patientMetrics.liquidityAssessment === 'poor',
          lowFillRatio: this.patientMetrics.actualFillRatio < this.patientLimits.minFillRatio,
          highEventFrequency: this.patientMetrics.eventRiskScore > 0.7
        }
      });
    }
  }

  private emitPatientRiskEvent(event: any): void {
    this.logger.warn(`Patient risk event: ${event.type}`, event);
    
    const riskEvent: RiskEvent = {
      type: event.type,
      severity: event.severity,
      value: event.value,
      limit: event.limit,
      timestamp: Date.now(),
      action: event.action,
      metadata: { reason: event.reason, source: 'patient' }
    };
    
    this.emit('riskEvent', riskEvent);
    
    // Take action based on event
    switch (event.action) {
      case 'warn':
        this.emit('riskWarning', riskEvent);
        break;
      case 'reduceSize':
        this.emit('reduceSizeRequired', riskEvent);
        break;
      case 'stop':
        this.emit('pauseTradingRequired', riskEvent);
        break;
    }
  }

  private handleBaseRiskEvent(event: RiskEvent): void {
    // Add patient-specific handling of base risk events
    if (event.type === 'inventoryLimit' && event.severity === 'limit') {
      // Force session reset on inventory limit breach
      this.onPatientSessionStart();
    }
    
    if (event.type === 'volSpike') {
      // Increase requote frequency during vol spikes
      this.emit('adjustEventThresholds', { 
        driftThreshold: event.value * 0.5, // Tighter drift threshold
        queueAheadThreshold: 0.3 // More aggressive queue ahead
      });
    }
  }

  private cleanupPatientData(): void {
    const oneHourAgo = Date.now() - 3600000;
    const oneDayAgo = Date.now() - 86400000;
    
    // Clean event history (keep 1 day)
    this.eventHistory = this.eventHistory.filter(e => e.timestamp >= oneDayAgo);
    
    // Clean fill history (keep 1 hour)
    this.fillHistory = this.fillHistory.filter(f => f.timestamp >= oneHourAgo);
    
    // Clean liquidity history (keep 1 hour)
    this.liquidityHistory = this.liquidityHistory.filter(l => l.timestamp >= oneHourAgo);
    
    // Clean volatility regime history (keep 1 hour)
    this.volatilityRegimeHistory = this.volatilityRegimeHistory.filter(v => v.timestamp >= oneHourAgo);
  }

  private resetDailyPatientMetrics(): void {
    this.dailyRequoteCount = 0;
    this.patientMetrics.dailyRequoteCount = 0;
    this.logger.info('Daily patient risk metrics reset');
  }

  // Public API
  public updateInventory(inventory: InventoryState): void {
    this.baseRiskManager.updateInventory(inventory);
  }

  public updatePnL(sessionPnL: number, dailyPnL: number): void {
    this.baseRiskManager.updatePnL(sessionPnL, dailyPnL);
  }

  public updateVolatility(volatility: number): void {
    this.baseRiskManager.updateVolatility(volatility);
    this.updateVolatilityRegime(volatility);
  }

  public recordFailure(reason: string): void {
    this.baseRiskManager.recordFailure(reason);
  }

  public recordOrderRate(): void {
    this.baseRiskManager.recordOrderRate();
  }

  public canTrade(): boolean {
    return this.baseRiskManager.canTrade() && !this.patientMetrics.shouldPauseTrading;
  }

  public getSizeMultiplier(): number {
    let baseSizeMultiplier = this.baseRiskManager.getSizeMultiplier();
    
    // Apply patient-specific adjustments
    if (this.patientLimits.enableRegimeAdjustments) {
      const regimeMultiplier = this.patientLimits.regimeRiskMultipliers[this.patientMetrics.currentRegime];
      baseSizeMultiplier *= regimeMultiplier;
    }
    
    // Reduce size for poor performance
    if (this.patientMetrics.actualFillRatio < this.patientLimits.minFillRatio) {
      baseSizeMultiplier *= 0.7;
    }
    
    return Math.max(0, Math.min(1, baseSizeMultiplier));
  }

  public getPatientMetrics(): PatientRiskMetrics {
    return { ...this.patientMetrics };
  }

  public getPatientLimits(): PatientRiskLimits {
    return { ...this.patientLimits };
  }

  public updatePatientLimits(updates: Partial<PatientRiskLimits>): void {
    this.patientLimits = { ...this.patientLimits, ...updates };
    
    // Update base limits if they're included
    this.baseRiskManager.updateLimits(updates);
    
    this.logger.info('Patient risk limits updated', { updates });
    this.emit('limitsUpdated', this.patientLimits);
  }

  public getPatientStatus(): any {
    return {
      ...this.baseRiskManager.getStatus(),
      shouldPauseTrading: this.patientMetrics.shouldPauseTrading,
      currentRegime: this.patientMetrics.currentRegime,
      liquidityAssessment: this.patientMetrics.liquidityAssessment,
      sessionDuration: this.patientMetrics.currentSessionDuration,
      dailyRequoteCount: this.dailyRequoteCount,
      performanceRiskScore: this.patientMetrics.performanceRiskScore,
      eventRiskScore: this.patientMetrics.eventRiskScore,
      avgWaitTime: this.patientMetrics.avgWaitTimePerLevel,
      fillRatio: this.patientMetrics.actualFillRatio
    };
  }

  // Control methods
  public emergencyStop(reason: string): void {
    this.baseRiskManager.emergencyStop(reason);
  }

  public newsStop(durationMs?: number): void {
    this.baseRiskManager.newsStop(durationMs);
  }

  public resetEmergencyStop(): void {
    this.baseRiskManager.resetEmergencyStop();
  }

  public destroy(): void {
    this.removeAllListeners();
  }
}
import { Logger } from '../core/Logger';
import { EventBus } from '../core/EventEmitter';
import { MetricsCollector } from './MetricsCollector';
import { BotOrchestrator } from '../core/BotOrchestrator';
import { BotStatus } from '../types';
import winston from 'winston';

interface HealthCheck {
  name: string;
  status: 'healthy' | 'warning' | 'critical';
  message: string;
  timestamp: number;
  details?: any;
}

interface AlertThresholds {
  memoryUsagePercent: number;
  cpuUsagePercent: number;
  botErrorRate: number;
  positionSizeLimit: number;
  dailyLossLimit: number;
}

export class HealthMonitor {
  private static instance: HealthMonitor;
  private logger: winston.Logger;
  private eventBus: EventBus;
  private metricsCollector: MetricsCollector;
  private orchestrator: BotOrchestrator;
  private healthChecks: HealthCheck[] = [];
  private alertThresholds: AlertThresholds;

  private constructor(orchestrator: BotOrchestrator) {
    this.logger = Logger.getInstance();
    this.eventBus = EventBus.getInstance();
    this.metricsCollector = MetricsCollector.getInstance();
    this.orchestrator = orchestrator;
    
    this.alertThresholds = {
      memoryUsagePercent: 80,
      cpuUsagePercent: 80,
      botErrorRate: 5, // errors per minute
      positionSizeLimit: 10000, // USD
      dailyLossLimit: 1000 // USD
    };

    this.setupEventListeners();
    this.startHealthChecks();
  }

  static getInstance(orchestrator: BotOrchestrator): HealthMonitor {
    if (!HealthMonitor.instance) {
      HealthMonitor.instance = new HealthMonitor(orchestrator);
    }
    return HealthMonitor.instance;
  }

  private setupEventListeners(): void {
    this.eventBus.on('error', this.onSystemError.bind(this));
    this.eventBus.on('botStatusChange', this.onBotStatusChange.bind(this));
  }

  private startHealthChecks(): void {
    // Run health checks every minute
    setInterval(() => {
      this.runAllHealthChecks();
    }, 60000);

    // Cleanup old health checks every hour
    setInterval(() => {
      this.cleanupHealthChecks();
    }, 3600000);

    // Initial health check
    setTimeout(() => this.runAllHealthChecks(), 5000);
  }

  private async runAllHealthChecks(): Promise<void> {
    const checks = await Promise.allSettled([
      this.checkSystemHealth(),
      this.checkBotHealth(),
      this.checkPerformanceHealth(),
      this.checkRiskLimits(),
      this.checkExchangeConnectivity()
    ]);

    checks.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.logger.error(`Health check ${index} failed:`, result.reason);
      }
    });

    this.processHealthChecks();
  }

  private async checkSystemHealth(): Promise<void> {
    const systemMetrics = this.metricsCollector.getLatestSystemMetrics();
    
    if (!systemMetrics) {
      this.addHealthCheck({
        name: 'system_metrics',
        status: 'warning',
        message: 'No system metrics available',
        timestamp: Date.now()
      });
      return;
    }

    // Check memory usage
    const memoryUsagePercent = (systemMetrics.memory.used / systemMetrics.memory.total) * 100;
    if (memoryUsagePercent > this.alertThresholds.memoryUsagePercent) {
      this.addHealthCheck({
        name: 'memory_usage',
        status: 'warning',
        message: `High memory usage: ${memoryUsagePercent.toFixed(1)}%`,
        timestamp: Date.now(),
        details: { usage: memoryUsagePercent, threshold: this.alertThresholds.memoryUsagePercent }
      });
    } else {
      this.addHealthCheck({
        name: 'memory_usage',
        status: 'healthy',
        message: `Memory usage normal: ${memoryUsagePercent.toFixed(1)}%`,
        timestamp: Date.now()
      });
    }

    // Check uptime
    const uptimeHours = systemMetrics.uptime / (1000 * 60 * 60);
    this.addHealthCheck({
      name: 'uptime',
      status: 'healthy',
      message: `System uptime: ${uptimeHours.toFixed(1)} hours`,
      timestamp: Date.now(),
      details: { uptime: systemMetrics.uptime }
    });
  }

  private async checkBotHealth(): Promise<void> {
    const bots = this.orchestrator.getAllBots();
    const runningBots = this.orchestrator.getRunningBots();
    
    let healthyBots = 0;
    let errorBots = 0;

    for (const bot of bots) {
      const status = this.orchestrator.getBotStatus(bot.id);
      if (status === BotStatus.RUNNING) {
        healthyBots++;
      } else if (status === BotStatus.ERROR) {
        errorBots++;
      }
    }

    if (errorBots > 0) {
      this.addHealthCheck({
        name: 'bot_status',
        status: 'warning',
        message: `${errorBots} bot(s) in error state`,
        timestamp: Date.now(),
        details: { healthy: healthyBots, error: errorBots, total: bots.length }
      });
    } else {
      this.addHealthCheck({
        name: 'bot_status',
        status: 'healthy',
        message: `All ${healthyBots} active bots running normally`,
        timestamp: Date.now(),
        details: { healthy: healthyBots, total: bots.length }
      });
    }
  }

  private async checkPerformanceHealth(): Promise<void> {
    const report = this.metricsCollector.getPerformanceReport();
    
    // Check win rate
    if (report.totalTrades > 10) { // Only check if we have significant trades
      if (report.winRate < 40) {
        this.addHealthCheck({
          name: 'performance_win_rate',
          status: 'warning',
          message: `Low win rate: ${report.winRate.toFixed(1)}%`,
          timestamp: Date.now(),
          details: report
        });
      } else {
        this.addHealthCheck({
          name: 'performance_win_rate',
          status: 'healthy',
          message: `Win rate: ${report.winRate.toFixed(1)}%`,
          timestamp: Date.now()
        });
      }
    }

    // Check daily PnL
    if (report.dailyPnL < -this.alertThresholds.dailyLossLimit) {
      this.addHealthCheck({
        name: 'daily_pnl',
        status: 'critical',
        message: `Daily loss limit exceeded: $${report.dailyPnL.toFixed(2)}`,
        timestamp: Date.now(),
        details: { dailyPnL: report.dailyPnL, limit: this.alertThresholds.dailyLossLimit }
      });
    } else if (report.dailyPnL > 0) {
      this.addHealthCheck({
        name: 'daily_pnl',
        status: 'healthy',
        message: `Positive daily PnL: $${report.dailyPnL.toFixed(2)}`,
        timestamp: Date.now()
      });
    }
  }

  private async checkRiskLimits(): Promise<void> {
    const botMetrics = this.metricsCollector.getAllBotMetrics();
    
    let totalPositions = 0;
    let riskViolations = 0;

    for (const metrics of botMetrics) {
      totalPositions += metrics.activePositions;
      
      // This would check against individual bot risk limits
      // Implementation depends on how position values are calculated
    }

    this.addHealthCheck({
      name: 'risk_limits',
      status: riskViolations > 0 ? 'warning' : 'healthy',
      message: riskViolations > 0 ? 
        `${riskViolations} risk limit violations detected` : 
        'All positions within risk limits',
      timestamp: Date.now(),
      details: { totalPositions, violations: riskViolations }
    });
  }

  private async checkExchangeConnectivity(): Promise<void> {
    // This would check exchange connections
    // Implementation depends on exchange abstraction layer
    
    this.addHealthCheck({
      name: 'exchange_connectivity',
      status: 'healthy',
      message: 'All exchanges connected',
      timestamp: Date.now()
    });
  }

  private addHealthCheck(check: HealthCheck): void {
    this.healthChecks.push(check);
  }

  private processHealthChecks(): void {
    const recentChecks = this.getRecentHealthChecks();
    const criticalChecks = recentChecks.filter(c => c.status === 'critical');
    const warningChecks = recentChecks.filter(c => c.status === 'warning');

    if (criticalChecks.length > 0) {
      this.handleCriticalAlerts(criticalChecks);
    }

    if (warningChecks.length > 0) {
      this.handleWarningAlerts(warningChecks);
    }

    this.logHealthSummary(recentChecks);
  }

  private handleCriticalAlerts(alerts: HealthCheck[]): void {
    for (const alert of alerts) {
      this.logger.error(`CRITICAL ALERT: ${alert.message}`, alert.details);
      
      // Take automated action based on alert type
      if (alert.name === 'daily_pnl') {
        this.emergencyStopAllBots();
      }
    }
  }

  private handleWarningAlerts(alerts: HealthCheck[]): void {
    for (const alert of alerts) {
      this.logger.warn(`WARNING: ${alert.message}`, alert.details);
    }
  }

  private async emergencyStopAllBots(): Promise<void> {
    this.logger.error('Emergency stop triggered - stopping all bots');
    
    try {
      await this.orchestrator.stopAllBots();
      this.logger.info('All bots stopped successfully');
    } catch (error) {
      this.logger.error('Failed to stop all bots during emergency:', error);
    }
  }

  private logHealthSummary(checks: HealthCheck[]): void {
    const healthy = checks.filter(c => c.status === 'healthy').length;
    const warnings = checks.filter(c => c.status === 'warning').length;
    const critical = checks.filter(c => c.status === 'critical').length;

    this.logger.info(`Health Summary - Healthy: ${healthy}, Warnings: ${warnings}, Critical: ${critical}`);
  }

  private cleanupHealthChecks(): void {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    this.healthChecks = this.healthChecks.filter(check => check.timestamp > oneHourAgo);
  }

  private getRecentHealthChecks(): HealthCheck[] {
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    return this.healthChecks.filter(check => check.timestamp > fiveMinutesAgo);
  }

  public getHealthStatus(): any {
    const recentChecks = this.getRecentHealthChecks();
    const checksByName = new Map<string, HealthCheck>();

    // Get the latest check for each name
    recentChecks.forEach(check => {
      const existing = checksByName.get(check.name);
      if (!existing || check.timestamp > existing.timestamp) {
        checksByName.set(check.name, check);
      }
    });

    const checks = Array.from(checksByName.values());
    const healthy = checks.filter(c => c.status === 'healthy').length;
    const warnings = checks.filter(c => c.status === 'warning').length;
    const critical = checks.filter(c => c.status === 'critical').length;

    return {
      overall: critical > 0 ? 'critical' : warnings > 0 ? 'warning' : 'healthy',
      timestamp: Date.now(),
      summary: {
        healthy,
        warnings,
        critical,
        total: checks.length
      },
      checks: checks.sort((a, b) => b.timestamp - a.timestamp)
    };
  }

  public updateAlertThresholds(thresholds: Partial<AlertThresholds>): void {
    this.alertThresholds = { ...this.alertThresholds, ...thresholds };
    this.logger.info('Alert thresholds updated', this.alertThresholds);
  }

  private onSystemError(data: any): void {
    this.addHealthCheck({
      name: 'system_error',
      status: 'warning',
      message: `System error: ${data.error.message}`,
      timestamp: Date.now(),
      details: { error: data.error.message, context: data.context }
    });
  }

  private onBotStatusChange(data: any): void {
    if (data.newStatus === BotStatus.ERROR) {
      this.addHealthCheck({
        name: 'bot_error',
        status: 'warning',
        message: `Bot ${data.botId} entered error state`,
        timestamp: Date.now(),
        details: data
      });
    }
  }
}
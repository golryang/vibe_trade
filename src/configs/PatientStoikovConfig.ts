import { StoikovParams } from '../engines/StoikovEngine';
import { PatientEventConfig } from '../engines/PatientStoikovEventDetector';
import { PatientExecutionConfig } from '../execution/PatientExecutionEngine';
import { RiskLimits } from '../risk/RiskManager';

// Core Patient Stoikov configuration interface
export interface PatientStoikovConfig {
  // Basic bot config
  id: string;
  enabled: boolean;
  exchange: string;
  symbol: string;
  
  // Stoikov core parameters (data axis 1)
  stoikovCore: {
    gamma: number;                    // Risk aversion {0.3, 0.6, 1.0}
    volatilityEstimation: {
      method: 'ewma' | 'garch' | 'parkinson';
      windowMs: number;               // EWMA window {5s, 30s, 5m}
      alpha?: number;                 // EWMA decay factor (auto-calculated if not provided)
    };
    intensityRegime: {
      level: 'low' | 'medium' | 'high'; // Trade intensity regime
      customLambda?: number;          // Custom lambda if not using regime
    };
    maxInventoryPct: number;          // |q|max NAV% {2%, 5%, 10%}
    spreadScaler: number;             // Regime spread scaler {0.8x, 1.0x, 1.4x}
  };
  
  // Orderbook/execution based event parameters (data axis 2)
  marketDataParams: {
    topNTracking: {
      threshold: number;              // Top-N levels to maintain {3, 5}
      checkIntervalMs: number;        // Check frequency {100, 200}
    };
    queueAhead: {
      thresholdRatio: number;         // Queue ahead threshold {0.3, 0.5}
      basedOnTopDepth: boolean;       // Use top-1 depth as base
      checkIntervalMs: number;        // Check frequency {500, 1000}
    };
    drift: {
      cutoffBps: number;              // Drift cut {5, 8, 12} bp
      checkIntervalMs: number;        // Check frequency {1000, 2000}
      referencePrice: 'mid' | 'microprice'; // Reference for drift calculation
    };
    tradeIntensity: {
      enabled: boolean;
      thresholds: {
        low: number;                  // Trades/sec threshold for low regime
        high: number;                 // Trades/sec threshold for high regime
      };
      windowMs: number;               // Window for intensity calculation {60s}
    };
    micropriceBias: {
      enabled: boolean;
      weight: number;                 // Microprice weight {0, 0.3, 0.6}
      levels: number;                 // Number of levels for calculation {3, 5}
    };
  };
  
  // Execution parameters (data axis 3)
  executionParams: {
    postOnlyStrategy: {
      offsetTicks: number;            // Post-only offset {±1, ±2} ticks
      improvementEnabled: boolean;    // Enable queue-ahead improvement
      maxImprovements: number;        // Max improvements per level per session
    };
    ladderConfig: {
      levels: number;                 // Ladder levels {1, 2, 3}
      distribution: 'equal' | 'weighted'; // Size distribution across levels
      weightDecay?: number;           // Decay factor for weighted distribution
    };
    timingParams: {
      minRequoteIntervalMs: number;   // Min requote interval {300, 500} ms
      levelTtlMs: number;             // Level TTL {5s, 10s, 20s}
      sessionTtlMs: number;           // Session TTL {60s, 120s}
      jitterMs: number;               // Jitter {20, 50} ms
    };
    rateLimiting: {
      enabled: boolean;
      bufferPct: number;              // Keep buffer % of rate limit {20}
      backoffStrategy: 'linear' | 'exponential';
      maxBackoffMs: number;
    };
  };
  
  // Risk parameters (data axis 4)
  riskParams: {
    sessionLimits: {
      ddLimitPct: number;             // Session DD limit {0.3%, 0.5%, 1.0%} NAV
      maxConsecutiveFails: number;    // Max consecutive fails {10, 20}
      cooldownMs: number;             // Cooldown duration {5s, 15s}
    };
    emergencyStops: {
      enabled: boolean;
      volatilitySpikeThreshold: number; // σ spike threshold (multiple of avg)
      newsDetectionEnabled: boolean;   // Enable news-based stops
      newsStopDurationMs: number;     // News stop duration
    };
    inventoryManagement: {
      rebalanceThreshold: number;     // Inventory rebalance threshold (% of max)
      rebalanceMethod: 'gradual' | 'immediate';
      skewIntensity: number;          // Inventory skew intensity {1.0, 2.0}
    };
  };
  
  // Regime and timezone adjustments
  regimeParams: {
    timezoneProfile: 'asia' | 'eu' | 'us' | 'global';
    volatilityRegimeScaler: number;   // Volatility regime adjustment factor
    liquidityRegimeDetection: {
      enabled: boolean;
      method: 'spread' | 'depth' | 'combined';
      adjustmentFactor: number;
    };
  };
  
  // Performance and monitoring
  monitoringParams: {
    enableDetailedLogging: boolean;
    logLevel: 'error' | 'warn' | 'info' | 'debug';
    metricsCollectionIntervalMs: number;
    performanceTargets: {
      fillRatioTarget: number;        // Target fill ratio %
      avgQueueTimeTarget: number;     // Target average queue time (ms)
      effectiveSpreadTarget: number;  // Target effective spread (bps)
    };
  };
}

// Predefined configuration presets
export class PatientStoikovConfigPresets {
  
  // Conservative setup (recommended starting point)
  static getConservativePreset(): Partial<PatientStoikovConfig> {
    return {
      stoikovCore: {
        gamma: 0.6,
        volatilityEstimation: {
          method: 'ewma',
          windowMs: 30000 // 30s
        },
        intensityRegime: {
          level: 'medium'
        },
        maxInventoryPct: 5, // 5% NAV
        spreadScaler: 1.0
      },
      marketDataParams: {
        topNTracking: {
          threshold: 3,
          checkIntervalMs: 200
        },
        queueAhead: {
          thresholdRatio: 0.4,
          basedOnTopDepth: true,
          checkIntervalMs: 500
        },
        drift: {
          cutoffBps: 8,
          checkIntervalMs: 1000,
          referencePrice: 'mid'
        },
        tradeIntensity: {
          enabled: true,
          thresholds: {
            low: 0.5,
            high: 2.0
          },
          windowMs: 60000
        },
        micropriceBias: {
          enabled: true,
          weight: 0.3,
          levels: 3
        }
      },
      executionParams: {
        postOnlyStrategy: {
          offsetTicks: 1,
          improvementEnabled: true,
          maxImprovements: 2
        },
        ladderConfig: {
          levels: 2,
          distribution: 'equal'
        },
        timingParams: {
          minRequoteIntervalMs: 500,
          levelTtlMs: 10000, // 10s
          sessionTtlMs: 120000, // 120s
          jitterMs: 50
        },
        rateLimiting: {
          enabled: true,
          bufferPct: 20,
          backoffStrategy: 'linear',
          maxBackoffMs: 5000
        }
      },
      riskParams: {
        sessionLimits: {
          ddLimitPct: 0.5,
          maxConsecutiveFails: 15,
          cooldownMs: 10000
        },
        emergencyStops: {
          enabled: true,
          volatilitySpikeThreshold: 2.0,
          newsDetectionEnabled: false,
          newsStopDurationMs: 300000
        },
        inventoryManagement: {
          rebalanceThreshold: 80, // 80% of max inventory
          rebalanceMethod: 'gradual',
          skewIntensity: 1.5
        }
      },
      regimeParams: {
        timezoneProfile: 'global',
        volatilityRegimeScaler: 1.0,
        liquidityRegimeDetection: {
          enabled: true,
          method: 'combined',
          adjustmentFactor: 1.2
        }
      },
      monitoringParams: {
        enableDetailedLogging: true,
        logLevel: 'info',
        metricsCollectionIntervalMs: 5000,
        performanceTargets: {
          fillRatioTarget: 60,
          avgQueueTimeTarget: 5000,
          effectiveSpreadTarget: 2.0
        }
      }
    };
  }
  
  // Aggressive setup (higher frequency, tighter controls)
  static getAggressivePreset(): Partial<PatientStoikovConfig> {
    return {
      stoikovCore: {
        gamma: 0.3,
        volatilityEstimation: {
          method: 'ewma',
          windowMs: 5000 // 5s
        },
        intensityRegime: {
          level: 'high'
        },
        maxInventoryPct: 2, // 2% NAV
        spreadScaler: 0.8
      },
      marketDataParams: {
        topNTracking: {
          threshold: 5,
          checkIntervalMs: 100
        },
        queueAhead: {
          thresholdRatio: 0.3,
          basedOnTopDepth: true,
          checkIntervalMs: 500
        },
        drift: {
          cutoffBps: 5,
          checkIntervalMs: 1000,
          referencePrice: 'microprice'
        },
        micropriceBias: {
          enabled: true,
          weight: 0.6,
          levels: 5
        }
      },
      executionParams: {
        postOnlyStrategy: {
          offsetTicks: 1,
          improvementEnabled: true,
          maxImprovements: 3
        },
        ladderConfig: {
          levels: 3,
          distribution: 'weighted',
          weightDecay: 0.7
        },
        timingParams: {
          minRequoteIntervalMs: 300,
          levelTtlMs: 5000, // 5s
          sessionTtlMs: 60000, // 60s
          jitterMs: 20
        }
      },
      riskParams: {
        sessionLimits: {
          ddLimitPct: 0.3,
          maxConsecutiveFails: 10,
          cooldownMs: 5000
        },
        inventoryManagement: {
          rebalanceThreshold: 70,
          rebalanceMethod: 'immediate',
          skewIntensity: 2.0
        }
      }
    };
  }
  
  // Patient setup (longer waits, wider tolerances)  
  static getPatientPreset(): Partial<PatientStoikovConfig> {
    return {
      stoikovCore: {
        gamma: 1.0,
        volatilityEstimation: {
          method: 'ewma',
          windowMs: 300000 // 5m
        },
        intensityRegime: {
          level: 'low'
        },
        maxInventoryPct: 10, // 10% NAV
        spreadScaler: 1.4
      },
      marketDataParams: {
        topNTracking: {
          threshold: 3,
          checkIntervalMs: 500
        },
        queueAhead: {
          thresholdRatio: 0.5,
          basedOnTopDepth: true,
          checkIntervalMs: 1000
        },
        drift: {
          cutoffBps: 12,
          checkIntervalMs: 2000,
          referencePrice: 'mid'
        },
        micropriceBias: {
          enabled: false,
          weight: 0,
          levels: 3
        }
      },
      executionParams: {
        postOnlyStrategy: {
          offsetTicks: 2,
          improvementEnabled: false,
          maxImprovements: 1
        },
        ladderConfig: {
          levels: 1,
          distribution: 'equal'
        },
        timingParams: {
          minRequoteIntervalMs: 1000,
          levelTtlMs: 20000, // 20s
          sessionTtlMs: 300000, // 300s
          jitterMs: 100
        }
      },
      riskParams: {
        sessionLimits: {
          ddLimitPct: 1.0,
          maxConsecutiveFails: 20,
          cooldownMs: 15000
        },
        inventoryManagement: {
          rebalanceThreshold: 90,
          rebalanceMethod: 'gradual',
          skewIntensity: 1.0
        }
      }
    };
  }
}

// Configuration validation utilities
export class PatientStoikovConfigValidator {
  
  static validate(config: PatientStoikovConfig): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    
    // Validate core Stoikov parameters
    if (config.stoikovCore.gamma <= 0 || config.stoikovCore.gamma > 5) {
      errors.push(`Invalid gamma: ${config.stoikovCore.gamma}. Must be > 0 and <= 5`);
    }
    
    if (config.stoikovCore.maxInventoryPct <= 0 || config.stoikovCore.maxInventoryPct > 50) {
      errors.push(`Invalid maxInventoryPct: ${config.stoikovCore.maxInventoryPct}. Must be > 0 and <= 50`);
    }
    
    // Validate market data parameters
    if (config.marketDataParams.topNTracking.threshold < 1 || 
        config.marketDataParams.topNTracking.threshold > 10) {
      errors.push(`Invalid topN threshold: ${config.marketDataParams.topNTracking.threshold}. Must be 1-10`);
    }
    
    if (config.marketDataParams.queueAhead.thresholdRatio < 0.1 || 
        config.marketDataParams.queueAhead.thresholdRatio > 1.0) {
      errors.push(`Invalid queue ahead threshold: ${config.marketDataParams.queueAhead.thresholdRatio}. Must be 0.1-1.0`);
    }
    
    if (config.marketDataParams.drift.cutoffBps < 1 || 
        config.marketDataParams.drift.cutoffBps > 100) {
      errors.push(`Invalid drift cutoff: ${config.marketDataParams.drift.cutoffBps}. Must be 1-100 bps`);
    }
    
    // Validate execution parameters
    if (config.executionParams.ladderConfig.levels < 1 || 
        config.executionParams.ladderConfig.levels > 5) {
      errors.push(`Invalid ladder levels: ${config.executionParams.ladderConfig.levels}. Must be 1-5`);
    }
    
    if (config.executionParams.timingParams.minRequoteIntervalMs < 100 || 
        config.executionParams.timingParams.minRequoteIntervalMs > 5000) {
      errors.push(`Invalid min requote interval: ${config.executionParams.timingParams.minRequoteIntervalMs}. Must be 100-5000ms`);
    }
    
    // Validate risk parameters
    if (config.riskParams.sessionLimits.ddLimitPct <= 0 || 
        config.riskParams.sessionLimits.ddLimitPct > 5) {
      errors.push(`Invalid DD limit: ${config.riskParams.sessionLimits.ddLimitPct}. Must be > 0 and <= 5%`);
    }
    
    // Cross-validation checks
    if (config.executionParams.timingParams.levelTtlMs > config.executionParams.timingParams.sessionTtlMs) {
      errors.push('Level TTL cannot be greater than session TTL');
    }
    
    if (config.stoikovCore.maxInventoryPct < config.riskParams.sessionLimits.ddLimitPct) {
      errors.push('Max inventory % should generally be higher than DD limit %');
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }
  
  static sanitizeForLogging(config: PatientStoikovConfig): any {
    // Return a version safe for logging (remove sensitive data if any)
    return {
      id: config.id,
      exchange: config.exchange,
      symbol: config.symbol,
      gamma: config.stoikovCore.gamma,
      maxInventory: config.stoikovCore.maxInventoryPct,
      topN: config.marketDataParams.topNTracking.threshold,
      driftCutoff: config.marketDataParams.drift.cutoffBps,
      ladderLevels: config.executionParams.ladderConfig.levels,
      sessionTtl: config.executionParams.timingParams.sessionTtlMs,
      ddLimit: config.riskParams.sessionLimits.ddLimitPct
    };
  }
}

// Configuration conversion utilities
export class PatientStoikovConfigConverter {
  
  // Convert to legacy StoikovParams format for backward compatibility
  static toStoikovParams(config: PatientStoikovConfig): StoikovParams {
    return {
      gamma: config.stoikovCore.gamma,
      volatilityWindow: config.stoikovCore.volatilityEstimation.windowMs,
      intensityWindow: config.marketDataParams.tradeIntensity.windowMs || 60000,
      maxInventoryPct: config.stoikovCore.maxInventoryPct,
      obiWeight: config.marketDataParams.micropriceBias.weight || 0,
      micropriceBias: config.marketDataParams.micropriceBias.enabled,
      topNDepth: config.marketDataParams.topNTracking.threshold,
      postOnlyOffset: config.executionParams.postOnlyStrategy.offsetTicks,
      ttlMs: config.executionParams.timingParams.levelTtlMs,
      repostMs: config.executionParams.timingParams.minRequoteIntervalMs,
      ladderLevels: config.executionParams.ladderConfig.levels,
      alphaSizeRatio: 0.8, // Default value
      driftCutBps: config.marketDataParams.drift.cutoffBps,
      sessionDDLimitPct: config.riskParams.sessionLimits.ddLimitPct,
      maxConsecutiveFails: config.riskParams.sessionLimits.maxConsecutiveFails,
      timezoneProfile: config.regimeParams.timezoneProfile,
      volRegimeScaler: config.regimeParams.volatilityRegimeScaler || 1.0
    };
  }
  
  // Convert to PatientEventConfig format
  static toPatientEventConfig(config: PatientStoikovConfig): PatientEventConfig {
    return {
      topNThreshold: config.marketDataParams.topNTracking.threshold,
      queueAheadThreshold: config.marketDataParams.queueAhead.thresholdRatio,
      queueAheadCheckInterval: config.marketDataParams.queueAhead.checkIntervalMs,
      driftThresholdBps: config.marketDataParams.drift.cutoffBps,
      driftCheckInterval: config.marketDataParams.drift.checkIntervalMs,
      maxSessionTtl: config.executionParams.timingParams.sessionTtlMs,
      levelTtl: config.executionParams.timingParams.levelTtlMs,
      minRequoteInterval: config.executionParams.timingParams.minRequoteIntervalMs,
      rateLimitThreshold: config.executionParams.rateLimiting.bufferPct || 20,
      jitterMs: config.executionParams.timingParams.jitterMs
    };
  }
}
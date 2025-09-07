import { BaseBot } from '../core/BaseBot';
import { CrossVenueHedgeBot } from '../bots/CrossVenueHedgeBot';
import { StoikovBot } from '../bots/StoikovBot';
import { BaseExchange } from '../exchanges/BaseExchange';
import { BotConfig } from '../types';
import { Logger } from '../core/Logger';

export class BotFactory {
  private static logger = Logger.getInstance();

  static async createBot(config: BotConfig, exchanges: BaseExchange[]): Promise<BaseBot> {
    BotFactory.logger.info(`Creating bot: ${config.type} (${config.id})`);

    switch (config.type) {
      case 'CrossVenueHedge':
        // Filter exchanges based on bot configuration
        const botExchanges = exchanges.filter(ex => 
          config.exchanges.includes(ex.getName())
        );
        
        if (botExchanges.length < 2) {
          throw new Error(`CrossVenueHedge bot requires at least 2 exchanges, got ${botExchanges.length}`);
        }
        
        return new CrossVenueHedgeBot(config as any, botExchanges);

      case 'StoikovBot':
        // Single exchange bot
        const stoikovExchange = exchanges.find(ex => 
          config.exchanges.includes(ex.getName())
        );
        
        if (!stoikovExchange) {
          throw new Error(`StoikovBot requires exactly 1 exchange from: ${config.exchanges.join(', ')}`);
        }
        
        return new StoikovBot(config as any, stoikovExchange);

      // Add more bot types here as they are implemented  
      case 'SimpleMarketMaker':
        throw new Error('SimpleMarketMaker bot not implemented yet');
      
      case 'ArbitrageBot':
        throw new Error('ArbitrageBot not implemented yet');
      
      case 'GridBot':
        throw new Error('GridBot not implemented yet');

      default:
        throw new Error(`Unknown bot type: ${config.type}`);
    }
  }

  static getSupportedBotTypes(): string[] {
    return [
      'CrossVenueHedge',
      'StoikovBot',
      // 'SimpleMarketMaker',
      // 'ArbitrageBot',
      // 'GridBot'
    ];
  }

  static getBotTypeDescription(type: string): string {
    const descriptions: Record<string, string> = {
      'CrossVenueHedge': 'Cross-Venue Hedge Market Making - 여러 거래소 간 차익거래 및 헤징',
      'StoikovBot': 'Single-Venue Risk-Averse Stoikov - 고급 단일 거래소 마켓메이킹 (무헷지)',
      'SimpleMarketMaker': '단순 마켓메이킹 - 단일 거래소에서 호가 제공',
      'ArbitrageBot': '차익거래 봇 - 거래소 간 가격 차이 이용',
      'GridBot': '그리드 봇 - 격자형 매매 전략'
    };
    
    return descriptions[type] || '설명 없음';
  }

  static validateBotConfig(config: BotConfig): string[] {
    const errors: string[] = [];

    // Basic validation
    if (!config.id || config.id.trim() === '') {
      errors.push('봇 ID가 필요합니다');
    }

    if (!config.name || config.name.trim() === '') {
      errors.push('봇 이름이 필요합니다');
    }

    if (!config.type || !BotFactory.getSupportedBotTypes().includes(config.type)) {
      errors.push(`지원되지 않는 봇 타입: ${config.type}`);
    }

    if (!config.exchanges || config.exchanges.length === 0) {
      errors.push('최소 하나의 거래소가 필요합니다');
    }

    if (!config.symbols || config.symbols.length === 0) {
      errors.push('최소 하나의 심볼이 필요합니다');
    }

    // Type-specific validation
    if (config.type === 'CrossVenueHedge') {
      if (config.exchanges.length < 2) {
        errors.push('CrossVenueHedge 봇은 최소 2개의 거래소가 필요합니다');
      }

      const params = config.parameters;
      if (!params) {
        errors.push('CrossVenueHedge 봇은 파라미터가 필요합니다');
      } else {
        if (typeof params.minSpreadPercent !== 'number' || params.minSpreadPercent <= 0) {
          errors.push('최소 스프레드는 0보다 큰 숫자여야 합니다');
        }

        if (typeof params.maxPositionSize !== 'number' || params.maxPositionSize <= 0) {
          errors.push('최대 포지션 크기는 0보다 큰 숫자여야 합니다');
        }

        if (typeof params.hedgeThreshold !== 'number' || params.hedgeThreshold <= 0) {
          errors.push('헤징 임계값은 0보다 큰 숫자여야 합니다');
        }

        if (typeof params.rebalanceInterval !== 'number' || params.rebalanceInterval < 1000) {
          errors.push('리밸런싱 간격은 1000ms 이상이어야 합니다');
        }
      }

      // Risk limits validation
      if (!config.riskLimits) {
        errors.push('리스크 한도가 필요합니다');
      } else {
        if (typeof config.riskLimits.maxPosition !== 'number' || config.riskLimits.maxPosition <= 0) {
          errors.push('최대 포지션 한도는 0보다 큰 숫자여야 합니다');
        }

        if (typeof config.riskLimits.maxDrawdown !== 'number' || 
            config.riskLimits.maxDrawdown <= 0 || 
            config.riskLimits.maxDrawdown > 1) {
          errors.push('최대 손실률은 0과 1 사이의 숫자여야 합니다');
        }

        if (typeof config.riskLimits.dailyLossLimit !== 'number' || config.riskLimits.dailyLossLimit <= 0) {
          errors.push('일일 손실 한도는 0보다 큰 숫자여야 합니다');
        }
      }
    }

    if (config.type === 'StoikovBot') {
      if (config.exchanges.length !== 1) {
        errors.push('StoikovBot은 정확히 1개의 거래소가 필요합니다');
      }

      if (config.symbols.length !== 1) {
        errors.push('StoikovBot은 정확히 1개의 심볼이 필요합니다');
      }

      const params = config.parameters;
      if (!params) {
        errors.push('StoikovBot은 파라미터가 필요합니다');
      } else {
        // Core Stoikov parameters
        if (typeof params.gamma !== 'number' || params.gamma <= 0 || params.gamma > 5) {
          errors.push('gamma는 0보다 크고 5보다 작은 숫자여야 합니다');
        }

        if (typeof params.volatilityWindow !== 'number' || params.volatilityWindow < 1000 || params.volatilityWindow > 600000) {
          errors.push('변동성 윈도우는 1초-10분 사이여야 합니다');
        }

        if (typeof params.maxInventoryPct !== 'number' || params.maxInventoryPct <= 0 || params.maxInventoryPct > 50) {
          errors.push('최대 인벤토리는 0-50% 사이여야 합니다');
        }

        // Execution parameters
        if (typeof params.ttlMs !== 'number' || params.ttlMs < 100 || params.ttlMs > 5000) {
          errors.push('TTL은 100ms-5초 사이여야 합니다');
        }

        if (typeof params.repostMs !== 'number' || params.repostMs < 50 || params.repostMs > 1000) {
          errors.push('리포스트 간격은 50ms-1초 사이여야 합니다');
        }

        if (typeof params.ladderLevels !== 'number' || params.ladderLevels < 1 || params.ladderLevels > 5) {
          errors.push('래더 레벨은 1-5 사이여야 합니다');
        }

        // Risk parameters
        if (typeof params.driftCutBps !== 'number' || params.driftCutBps <= 0) {
          errors.push('드리프트 컷은 0보다 큰 숫자여야 합니다');
        }

        if (typeof params.sessionDDLimitPct !== 'number' || params.sessionDDLimitPct <= 0 || params.sessionDDLimitPct > 10) {
          errors.push('세션 DD 한도는 0-10% 사이여야 합니다');
        }

        // Symbol validation
        if (!params.symbol || typeof params.symbol !== 'string') {
          errors.push('심볼이 필요합니다');
        }

        if (!params.exchange || typeof params.exchange !== 'string') {
          errors.push('거래소가 필요합니다');
        }
      }
    }

    return errors;
  }

  static getDefaultBotConfig(type: string, id: string, name: string): Partial<BotConfig> {
    const baseConfig = {
      id,
      name,
      type,
      enabled: false,
      exchanges: [],
      symbols: ['BTCUSDT', 'ETHUSDT']
    };

    switch (type) {
      case 'CrossVenueHedge':
        return {
          ...baseConfig,
          parameters: {
            minSpreadPercent: 0.1,
            maxPositionSize: 100,
            hedgeThreshold: 50,
            rebalanceInterval: 30000,
            exchanges: []
          },
          riskLimits: {
            maxPosition: 1000,
            maxDrawdown: 0.05,
            dailyLossLimit: 500
          }
        };

      case 'StoikovBot':
        return {
          ...baseConfig,
          exchanges: [],
          symbols: [],
          parameters: {
            // Core Stoikov parameters
            gamma: 0.6,
            volatilityWindow: 30000, // 30 seconds
            intensityWindow: 60000,  // 60 seconds
            maxInventoryPct: 5,      // 5% of NAV
            
            // Market data parameters
            topNDepth: 5,
            obiWeight: 0,
            micropriceBias: true,
            
            // Execution parameters
            postOnlyOffset: 1,       // 1 tick
            ttlMs: 800,             // 800ms
            repostMs: 200,          // 200ms
            ladderLevels: 2,        // 2 levels
            alphaSizeRatio: 0.8,    // 80%
            
            // Risk parameters
            driftCutBps: 5,         // 5 basis points
            sessionDDLimitPct: 0.5, // 0.5% NAV
            maxConsecutiveFails: 10,
            
            // Regime parameters
            timezoneProfile: 'global' as const,
            volRegimeScaler: 0.5,
            
            // Exchange-specific (to be set by user)
            exchange: '',
            symbol: 'BTCUSDT'
          },
          riskLimits: {
            maxPosition: 1000,
            maxDrawdown: 0.05,
            dailyLossLimit: 500
          }
        };

      default:
        return baseConfig;
    }
  }
}
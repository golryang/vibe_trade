import { BaseBot } from '../core/BaseBot';
import { CrossVenueHedgeBot } from '../bots/CrossVenueHedgeBot';
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
      // 'SimpleMarketMaker',
      // 'ArbitrageBot',
      // 'GridBot'
    ];
  }

  static getBotTypeDescription(type: string): string {
    const descriptions: Record<string, string> = {
      'CrossVenueHedge': 'Cross-Venue Hedge Market Making - 여러 거래소 간 차익거래 및 헤징',
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

      default:
        return baseConfig;
    }
  }
}
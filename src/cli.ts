import 'dotenv/config';
import { BotOrchestrator } from './core/BotOrchestrator';
import { ConfigManager } from './services/ConfigManager';
import { MetricsCollector } from './services/MetricsCollector';
import { HealthMonitor } from './services/HealthMonitor';
import { CLIManager } from './cli/CLIManager';
import { CrossVenueHedgeBot } from './bots/CrossVenueHedgeBot';
import { Logger } from './core/Logger';
import chalk from 'chalk';

async function initializeCLI(): Promise<void> {
  const logger = Logger.getInstance();
  
  try {
    console.log(chalk.blue.bold('🚀 VibeTrade CLI 초기화 중...\n'));

    // Initialize core services
    const configManager = ConfigManager.getInstance();
    const orchestrator = new BotOrchestrator();
    const metricsCollector = MetricsCollector.getInstance();
    const healthMonitor = HealthMonitor.getInstance(orchestrator);

    // Load configuration and initialize bots
    const config = configManager.getConfig();
    console.log(chalk.green(`✓ 설정 로드 완료: ${config.bots.length}개 봇, ${config.exchanges.length}개 거래소`));

    // Initialize existing bots from configuration
    let initializedBots = 0;
    for (const botConfig of config.bots) {
      try {
        if (botConfig.type === 'CrossVenueHedge') {
          // Create mock exchanges for now - in real implementation, initialize actual exchanges
          const exchanges: any[] = [];
          const bot = new CrossVenueHedgeBot(botConfig as any, exchanges);
          await orchestrator.addBot(bot);
          initializedBots++;
        }
      } catch (error) {
        logger.warn(`봇 ${botConfig.id} 초기화 실패: ${error}`);
      }
    }

    console.log(chalk.green(`✓ ${initializedBots}개 봇 초기화 완료`));

    // Auto-start enabled bots
    const enabledBots = config.bots.filter(bot => bot.enabled);
    if (enabledBots.length > 0) {
      console.log(chalk.blue(`📍 ${enabledBots.length}개 활성화된 봇 시작 중...`));
      try {
        await orchestrator.startAllBots();
        console.log(chalk.green('✓ 활성화된 봇들 시작 완료'));
      } catch (error) {
        console.log(chalk.yellow(`⚠️  일부 봇 시작 실패: ${error}`));
      }
    }

    console.log(chalk.green('✓ VibeTrade 시스템 준비 완료\n'));

    // Start CLI interface
    const cliManager = new CLIManager({
      orchestrator,
      configManager,
      metricsCollector,
      healthMonitor
    });

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.log(chalk.yellow('\n\n⏹️  종료 신호 감지, 안전하게 종료 중...'));
      try {
        await orchestrator.stopAllBots();
        console.log(chalk.green('✓ 모든 봇 정지 완료'));
        process.exit(0);
      } catch (error) {
        console.log(chalk.red(`❌ 종료 중 오류: ${error}`));
        process.exit(1);
      }
    });

    await cliManager.start();

  } catch (error) {
    console.log(chalk.red('❌ CLI 초기화 실패:'), error);
    process.exit(1);
  }
}

// Enhanced error handling
process.on('unhandledRejection', (reason, promise) => {
  console.log(chalk.red('❌ Unhandled Rejection at:'), promise, chalk.red('reason:'), reason);
});

process.on('uncaughtException', (error) => {
  console.log(chalk.red('❌ Uncaught Exception:'), error);
  process.exit(1);
});

// Welcome banner
console.clear();
console.log(chalk.blue.bold(`
╔════════════════════════════════════════╗
║           🚀 VibeTrade CLI             ║
║     멀티봇 트레이딩 시스템 관리 인터페이스      ║
╚════════════════════════════════════════╝
`));

// Start CLI
if (require.main === module) {
  initializeCLI().catch(error => {
    console.error(chalk.red('❌ Fatal error:'), error);
    process.exit(1);
  });
}
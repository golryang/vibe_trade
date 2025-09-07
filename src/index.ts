import 'dotenv/config';
import { BotOrchestrator } from './core/BotOrchestrator';
import { ConfigManager } from './services/ConfigManager';
import { MetricsCollector } from './services/MetricsCollector';
import { HealthMonitor } from './services/HealthMonitor';
import { Logger } from './core/Logger';
import { ExchangeFactory } from './exchanges/ExchangeFactory';
import { BotFactory } from './cli/BotFactory';
import chalk from 'chalk';

function parseArguments(): { mode: 'daemon' | 'cli' } {
  const args = process.argv.slice(2);
  const mode = args.includes('--cli') ? 'cli' : 'daemon';
  return { mode };
}

async function startDaemon(): Promise<void> {
  const logger = Logger.getInstance();
  
  try {
    logger.info('Starting VibeTrade System...');

    // Initialize core services
    const configManager = ConfigManager.getInstance();
    const orchestrator = new BotOrchestrator();
    const metricsCollector = MetricsCollector.getInstance();
    const healthMonitor = HealthMonitor.getInstance(orchestrator);

    // Load configuration
    const config = configManager.getConfig();
    logger.info(`Loaded configuration with ${config.bots.length} bot(s) and ${config.exchanges.length} exchange(s)`);

    // Initialize bots from configuration (generic)
    for (const botConfig of config.bots) {
      try {
        const exchanges = await Promise.all(
          config.exchanges
            .filter(ex => botConfig.exchanges.includes(ex.name))
            .map(ex => ExchangeFactory.createExchange(ex))
        );

        const bot = await BotFactory.createBot(botConfig as any, exchanges as any);
        await orchestrator.addBot(bot);
        logger.info(`Added ${botConfig.type} bot: ${botConfig.id}`);
      } catch (error) {
        logger.error(`Failed to initialize bot ${botConfig.id}:`, error);
      }
    }

    // Start enabled bots
    await orchestrator.startAllBots();

    // Setup graceful shutdown
    const gracefulShutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down gracefully...`);
      
      try {
        await orchestrator.stopAllBots();
        logger.info('VibeTrade System shutdown complete');
        process.exit(0);
      } catch (error) {
        logger.error('Error during shutdown:', error);
        process.exit(1);
      }
    };

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    // Log system status
    setInterval(() => {
      const runningBots = orchestrator.getRunningBots();
      const healthStatus = healthMonitor.getHealthStatus();
      
      logger.info(`System Status - Running Bots: ${runningBots.length}, Health: ${healthStatus.overall}`);
    }, 60000); // Every minute

    logger.info('VibeTrade System started successfully');
    logger.info(`System health monitoring active`);
    logger.info(`Metrics collection active`);

  } catch (error) {
    logger.error('Failed to start VibeTrade System:', error);
    process.exit(1);
  }
}

// Handle unhandled rejections and exceptions
process.on('unhandledRejection', (reason, promise) => {
  const logger = Logger.getInstance();
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  const logger = Logger.getInstance();
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

async function startCLI(): Promise<void> {
  const { CLIManager } = await import('./cli/CLIManager');
  
  console.clear();
  console.log(chalk.blue.bold(`
╔════════════════════════════════════════╗
║           🚀 VibeTrade CLI             ║
║     멀티봇 트레이딩 시스템 관리 인터페이스      ║
╚════════════════════════════════════════╝
`));

  console.log(chalk.blue.bold('🚀 VibeTrade CLI 초기화 중...\n'));

  // Initialize core services (same as daemon)
  const configManager = ConfigManager.getInstance();
  const orchestrator = new BotOrchestrator();
  const metricsCollector = MetricsCollector.getInstance();
  const healthMonitor = HealthMonitor.getInstance(orchestrator);

  // Load configuration and initialize bots
  const config = configManager.getConfig();
  console.log(chalk.green(`✓ 설정 로드 완료: ${config.bots.length}개 봇, ${config.exchanges.length}개 거래소`));

  // Initialize existing bots from configuration (generic)
  let initializedBots = 0;
  for (const botConfig of config.bots) {
    try {
      const exchanges = await Promise.all(
        config.exchanges
          .filter(ex => botConfig.exchanges.includes(ex.name))
          .map(ex => ExchangeFactory.createExchange(ex))
      );
      const bot = await BotFactory.createBot(botConfig as any, exchanges as any);
      await orchestrator.addBot(bot);
      initializedBots++;
    } catch (error) {
      console.log(chalk.yellow(`⚠️  봇 ${botConfig.id} 초기화 실패: ${error}`));
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

  await cliManager.start();
}

async function main(): Promise<void> {
  const { mode } = parseArguments();

  if (mode === 'cli') {
    await startCLI();
  } else {
    await startDaemon();
  }
}

// Start the application
if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error starting application:', error);
    process.exit(1);
  });
}
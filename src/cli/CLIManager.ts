import inquirer from 'inquirer';
import chalk from 'chalk';
import Table from 'cli-table3';
import { BotOrchestrator } from '../core/BotOrchestrator';
import { ConfigManager } from '../services/ConfigManager';
import { MetricsCollector } from '../services/MetricsCollector';
import { HealthMonitor } from '../services/HealthMonitor';
import { BotConfig, BotStatus, BotMetrics } from '../types';
import { Logger } from '../core/Logger';
import { ExchangeFactory } from '../exchanges/ExchangeFactory';
import { BotFactory } from './BotFactory';
import winston from 'winston';

interface CLIOptions {
  orchestrator: BotOrchestrator;
  configManager: ConfigManager;
  metricsCollector: MetricsCollector;
  healthMonitor: HealthMonitor;
}

export class CLIManager {
  private orchestrator: BotOrchestrator;
  private configManager: ConfigManager;
  private metricsCollector: MetricsCollector;
  private healthMonitor: HealthMonitor;
  private logger: winston.Logger;
  private isRunning: boolean = false;

  constructor(options: CLIOptions) {
    this.orchestrator = options.orchestrator;
    this.configManager = options.configManager;
    this.metricsCollector = options.metricsCollector;
    this.healthMonitor = options.healthMonitor;
    this.logger = Logger.getInstance();
  }

  async start(): Promise<void> {
    this.isRunning = true;
    console.clear();
    
    console.log(chalk.blue.bold('🚀 VibeTrade - 멀티봇 트레이딩 시스템'));
    console.log(chalk.gray('Interactive CLI Management Interface\n'));

    while (this.isRunning) {
      try {
        await this.showMainMenu();
      } catch (error) {
        console.log(chalk.red('❌ 오류가 발생했습니다:'), error);
        await this.waitForKey();
      }
    }
  }

  private async showMainMenu(): Promise<void> {
    // 화면 지우기
    console.clear();
    
    // 헤더 표시
    console.log(chalk.blue.bold(`
╔════════════════════════════════════════╗
║           🚀 VibeTrade CLI             ║
║     멀티봇 트레이딩 시스템 관리 도구       ║
╚════════════════════════════════════════╝
`));

    const healthStatus = this.healthMonitor.getHealthStatus();
    const config = this.configManager.getConfig();
    const enabledBots = config.bots.filter(bot => bot.enabled);
    
    console.log(`${this.getHealthStatusIcon(healthStatus.overall)} 시스템 상태: ${chalk.bold(this.getHealthStatusText(healthStatus.overall))}`);
    console.log(`🤖 실행중인 봇: ${chalk.yellow(enabledBots.length)}개 / 전체: ${chalk.cyan(config.bots.length)}개`);
    console.log(`💱 연결된 거래소: ${chalk.green(config.exchanges.length)}개\n`);

    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: '원하는 작업을 선택하세요:',
        choices: [
          { name: '📊 봇 상태 보기', value: 'status' },
          new inquirer.Separator('-- 봇 제어 --'),
          { name: '▶️  봇 시작하기', value: 'start' },
          { name: '⏹️  봇 정지하기', value: 'stop' },
          new inquirer.Separator('-- 봇 관리 --'),
          { name: '➕ 새 봇 추가하기', value: 'add' },
          { name: '⚙️  봇 설정 수정', value: 'edit' },
          { name: '🗑️  봇 삭제하기', value: 'delete' },
          new inquirer.Separator('-- 모니터링 --'),
          { name: '📈 성능 보고서', value: 'metrics' },
          { name: '🏥 시스템 헬스', value: 'health' },
          { name: '🔄 실시간 대시보드', value: 'dashboard' },
          new inquirer.Separator(),
          { name: '❌ 종료', value: 'exit' }
        ]
      }
    ]);

    switch (action) {
      case 'status':
        await this.showBotStatus();
        break;
      case 'start':
        await this.startBot();
        break;
      case 'stop':
        await this.stopBot();
        break;
      case 'add':
        await this.addBot();
        break;
      case 'edit':
        await this.editBot();
        break;
      case 'delete':
        await this.deleteBot();
        break;
      case 'metrics':
        await this.showMetrics();
        break;
      case 'health':
        await this.showHealth();
        break;
      case 'dashboard':
        await this.showDashboard();
        break;
      case 'exit':
        this.isRunning = false;
        console.log(chalk.green('👋 VibeTrade CLI를 종료합니다.'));
        return;
    }

    if (this.isRunning) {
      await this.waitForKey();
      console.clear();
    }
  }

  private async showBotStatus(): Promise<void> {
    console.log(chalk.blue.bold('\n📊 봇 상태'));
    console.log('━'.repeat(80));

    const config = this.configManager.getConfig();
    const bots = config.bots;
    
    if (bots.length === 0) {
      console.log(chalk.yellow('등록된 봇이 없습니다.'));
      await this.waitForKey();
      return;
    }

    const table = new Table({
      head: ['ID', '이름', '타입', '상태', '거래소', '심볼', '활성화'],
      colWidths: [15, 20, 18, 12, 15, 15, 8]
    });

    for (const bot of bots) {
      // 오케스트레이터에서 실제 상태 확인
      let actualStatus = 'stopped';
      try {
        const runningBot = this.orchestrator.getBot(bot.id);
        if (runningBot) {
          actualStatus = this.orchestrator.getBotStatus(bot.id) || 'stopped';
        }
      } catch {
        // 봇이 오케스트레이터에 없으면 stopped
        actualStatus = 'stopped';
      }

      const statusColor = this.getStatusColor(actualStatus as BotStatus);
      const enabledStatus = bot.enabled ? 
        (actualStatus === 'running' ? chalk.green('실행중') : chalk.yellow('대기중')) : 
        chalk.gray('비활성');
      
      table.push([
        bot.id,
        bot.name,
        bot.type,
        statusColor(actualStatus),
        bot.exchanges.join(', '),
        bot.symbols.join(', '),
        enabledStatus
      ]);
    }

    console.log(table.toString());
    await this.waitForKey();
  }

  private async startBot(): Promise<void> {
    // 설정 파일에서 봇 목록 가져오기
    const config = this.configManager.getConfig();
    const availableBots = config.bots.filter(bot => !bot.enabled);
    
    if (availableBots.length === 0) {
      console.log(chalk.yellow('시작할 수 있는 봇이 없습니다.'));
      await this.waitForKey();
      return;
    }

    const { botId, goBack } = await inquirer.prompt([
      {
        type: 'list',
        name: 'botId',
        message: '시작할 봇을 선택하세요:',
        choices: [
          ...availableBots.map(bot => ({ 
            name: `${bot.name} (${bot.id}) - ${bot.type}`, 
            value: bot.id 
          })),
          new inquirer.Separator(),
          { name: '⬅️  메인 메뉴로 돌아가기', value: 'back' }
        ]
      }
    ]);

    if (botId === 'back') {
      return;
    }

    try {
      console.log(chalk.blue(`🚀 봇 ${botId} 시작 중...`));
      
      // 봇 인스턴스 생성 및 시작
      await this.createAndStartBot(botId);
      
      console.log(chalk.green(`✅ 봇 ${botId} 시작 완료!`));
      
    } catch (error: any) {
      console.log(chalk.red(`❌ 봇 시작 실패: ${error.message}`));
    }
    
    await this.waitForKey();
  }

  private async createAndStartBot(botId: string): Promise<void> {
    const config = this.configManager.getConfig();
    const botConfig = config.bots.find(bot => bot.id === botId);
    
    if (!botConfig) {
      throw new Error(`봇 설정을 찾을 수 없습니다: ${botId}`);
    }

    // 이미 존재하면 재생성하지 않고 시작만 시도
    const existing = this.orchestrator.getBot(botId);
    if (!existing) {
      // 거래소 인스턴스 생성
      const exchanges = await Promise.all(
        config.exchanges
          .filter(ex => botConfig.exchanges.includes(ex.name))
          .map(ex => ExchangeFactory.createExchange(ex))
      );

      if (exchanges.length === 0) {
        throw new Error('유효한 거래소를 찾을 수 없습니다');
      }

      // 봇 인스턴스 생성 후 등록
      const bot = await BotFactory.createBot(botConfig, exchanges);
      await this.orchestrator.addBot(bot);
    }

    // 시작
    await this.orchestrator.startBot(botId);
    
    // 설정 파일에서 enabled 상태 업데이트
    this.configManager.updateBotConfig(botId, { enabled: true });
    
    this.logger.info(`Bot ${botId} started successfully via CLI`);
  }

  private async stopBot(): Promise<void> {
    const config = this.configManager.getConfig();
    const runningBots = config.bots.filter(bot => bot.enabled);
    
    if (runningBots.length === 0) {
      console.log(chalk.yellow('실행중인 봇이 없습니다.'));
      await this.waitForKey();
      return;
    }

    const { botId } = await inquirer.prompt([
      {
        type: 'list',
        name: 'botId',
        message: '정지할 봇을 선택하세요:',
        choices: [
          ...runningBots.map(bot => ({ 
            name: `${bot.name} (${bot.id}) - ${bot.type}`, 
            value: bot.id 
          })),
          new inquirer.Separator(),
          { name: '⬅️  메인 메뉴로 돌아가기', value: 'back' }
        ]
      }
    ]);

    if (botId === 'back') {
      return;
    }

    try {
      console.log(chalk.blue(`⏹️ 봇 ${botId} 정지 중...`));
      await this.orchestrator.stopBot(botId);
      
      // 설정 파일에서 enabled 상태 업데이트
      this.configManager.updateBotConfig(botId, { enabled: false });
      
      console.log(chalk.green(`✅ 봇 ${botId} 정지 완료!`));
    } catch (error: any) {
      console.log(chalk.red(`❌ 봇 정지 실패: ${error.message}`));
    }
    
    await this.waitForKey();
  }

  private async addBot(): Promise<void> {
    console.log(chalk.blue.bold('\n➕ 새 봇 추가'));
    console.log('━'.repeat(50));

    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'id',
        message: '봇 ID:',
        validate: (input) => {
          if (!input.trim()) return '봇 ID를 입력해주세요.';
          if (this.configManager.getBotConfig(input)) return '이미 존재하는 봇 ID입니다.';
          return true;
        }
      },
      {
        type: 'input',
        name: 'name',
        message: '봇 이름:',
        validate: (input) => input.trim() ? true : '봇 이름을 입력해주세요.'
      },
      {
        type: 'list',
        name: 'type',
        message: '봇 타입:',
        choices: [
          { name: 'Cross-Venue Hedge Market Making - 여러 거래소 간 차익거래 및 헤징', value: 'CrossVenueHedge' },
          { name: 'Stoikov Market Making - 고급 단일 거래소 마켓메이킹', value: 'StoikovBot' },
          new inquirer.Separator(),
          { name: '⬅️  메인 메뉴로 돌아가기', value: 'back' }
        ]
      },
      {
        type: 'checkbox',
        name: 'exchanges',
        message: '사용할 거래소 선택:',
        choices: this.configManager.getAllExchangeConfigs().map(ex => ({
          name: ex.name,
          value: ex.name
        })),
        validate: (input) => input.length > 0 ? true : '최소 한 개의 거래소를 선택해주세요.'
      },
      {
        type: 'input',
        name: 'symbols',
        message: '거래 심볼 (쉼표로 구분):',
        default: 'BTCUSDT,ETHUSDT',
        filter: (input) => input.split(',').map((s: string) => s.trim())
      }
    ]);

    // 뒤로가기 처리
    if (answers.type === 'back') {
      return;
    }

    let botConfig: BotConfig;

    if (answers.type === 'CrossVenueHedge') {
      const params = await inquirer.prompt([
        {
          type: 'number',
          name: 'minSpreadPercent',
          message: '최소 스프레드 (%):',
          default: 0.1
        },
        {
          type: 'number',
          name: 'maxPositionSize',
          message: '최대 포지션 크기:',
          default: 100
        },
        {
          type: 'number',
          name: 'hedgeThreshold',
          message: '헤징 임계값:',
          default: 50
        },
        {
          type: 'number',
          name: 'rebalanceInterval',
          message: '리밸런싱 간격 (ms):',
          default: 30000
        }
      ]);

      const riskLimits = await inquirer.prompt([
        {
          type: 'number',
          name: 'maxPosition',
          message: '최대 포지션 한도:',
          default: 1000
        },
        {
          type: 'number',
          name: 'maxDrawdown',
          message: '최대 손실률:',
          default: 0.05
        },
        {
          type: 'number',
          name: 'dailyLossLimit',
          message: '일일 손실 한도:',
          default: 500
        }
      ]);

      botConfig = {
        id: answers.id,
        type: answers.type,
        name: answers.name,
        enabled: false,
        exchanges: answers.exchanges,
        symbols: answers.symbols,
        parameters: {
          ...params,
          exchanges: answers.exchanges
        },
        riskLimits
      };
    } else if (answers.type === 'StoikovBot') {
      // StoikovBot 전용 파라미터 입력
      console.log(chalk.cyan('\n📊 Stoikov 핵심 파라미터 설정'));
      const stoikovParams = await inquirer.prompt([
        {
          type: 'number',
          name: 'gamma',
          message: '위험회피도 (γ) [0.3-1.2]:',
          default: 0.6,
          validate: (input) => (input >= 0.3 && input <= 1.2) ? true : '0.3-1.2 범위로 입력하세요'
        },
        {
          type: 'number',
          name: 'volatilityWindow',
          message: '변동성 윈도우 (ms):',
          default: 30000
        },
        {
          type: 'number',
          name: 'maxInventoryPct',
          message: '최대 인벤토리 (% NAV):',
          default: 5
        },
        {
          type: 'number',
          name: 'ttlMs',
          message: '주문 TTL (ms):',
          default: 800
        },
        {
          type: 'number',
          name: 'ladderLevels',
          message: '래더 레벨 수:',
          default: 2
        },
        {
          type: 'list',
          name: 'exchange',
          message: '사용할 거래소:',
          choices: answers.exchanges
        },
        {
          type: 'list',
          name: 'symbol',
          message: '거래 심볼:',
          choices: answers.symbols
        }
      ]);

      const riskLimits = await inquirer.prompt([
        {
          type: 'number',
          name: 'maxPosition',
          message: '최대 포지션 한도 (USDT):',
          default: 100
        },
        {
          type: 'number',
          name: 'maxDrawdown',
          message: '최대 손실률:',
          default: 0.05
        },
        {
          type: 'number',
          name: 'dailyLossLimit',
          message: '일일 손실 한도 (USDT):',
          default: 50
        }
      ]);

      botConfig = {
        id: answers.id,
        type: answers.type,
        name: answers.name,
        enabled: false,
        exchanges: [stoikovParams.exchange],
        symbols: [stoikovParams.symbol],
        parameters: {
          // Core Stoikov parameters
          gamma: stoikovParams.gamma,
          volatilityWindow: stoikovParams.volatilityWindow,
          intensityWindow: 60000,
          maxInventoryPct: stoikovParams.maxInventoryPct,
          
          // Market data parameters
          topNDepth: 5,
          obiWeight: 0,
          micropriceBias: true,
          
          // Execution parameters
          postOnlyOffset: 1,
          ttlMs: stoikovParams.ttlMs,
          repostMs: 200,
          ladderLevels: stoikovParams.ladderLevels,
          alphaSizeRatio: 0.8,
          
          // Risk parameters
          driftCutBps: 5,
          sessionDDLimitPct: 0.5,
          maxConsecutiveFails: 10,
          
          // Regime parameters
          timezoneProfile: 'global',
          volRegimeScaler: 0.5,
          
          // Exchange-specific
          exchange: stoikovParams.exchange,
          symbol: stoikovParams.symbol
        },
        riskLimits
      };
    }

    // 공통 봇 추가 처리
    try {
      this.configManager.addBotConfig(botConfig);
      console.log(chalk.green(`✅ 봇 ${answers.id} 추가 완료!`));
      
      const { shouldStart } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'shouldStart',
          message: '지금 봇을 시작하시겠습니까?',
          default: false
        }
      ]);

      if (shouldStart) {
        try {
          console.log(chalk.blue(`🚀 봇 ${answers.id} 시작 중...`));
          await this.createAndStartBot(answers.id);
          console.log(chalk.green(`✅ 봇 ${answers.id} 시작 완료!`));
        } catch (error: any) {
          console.log(chalk.red(`❌ 봇 시작 실패: ${error.message}`));
          console.log(chalk.gray('봇은 추가되었지만 시작되지 않았습니다. 나중에 수동으로 시작하세요.'));
        }
      }
    } catch (error) {
      console.log(chalk.red(`❌ 봇 추가 실패: ${error}`));
    }
    
    await this.waitForKey();
  }

  private async editBot(): Promise<void> {
    console.log(chalk.blue.bold('\n⚙️ 봇 설정 수정'));
    console.log('━'.repeat(50));

    const config = this.configManager.getConfig();
    const bots = config.bots;
    
    if (bots.length === 0) {
      console.log(chalk.yellow('수정할 봇이 없습니다.'));
      await this.waitForKey();
      return;
    }

    const { botId } = await inquirer.prompt([
      {
        type: 'list',
        name: 'botId',
        message: '수정할 봇을 선택하세요:',
        choices: [
          ...bots.map(bot => ({ 
            name: `${bot.name} (${bot.id}) - ${bot.type}`, 
            value: bot.id 
          })),
          new inquirer.Separator(),
          { name: '⬅️  메인 메뉴로 돌아가기', value: 'back' }
        ]
      }
    ]);

    if (botId === 'back') {
      return;
    }

    const bot = bots.find(b => b.id === botId);
    if (!bot) {
      console.log(chalk.red('봇을 찾을 수 없습니다.'));
      await this.waitForKey();
      return;
    }

    console.log(chalk.cyan(`\n📝 ${bot.name} (${bot.type}) 설정 수정`));
    console.log('━'.repeat(50));

    const { field } = await inquirer.prompt([
      {
        type: 'list',
        name: 'field',
        message: '수정할 항목을 선택하세요:',
        choices: [
          { name: '📝 봇 이름', value: 'name' },
          { name: '🔄 활성화 여부', value: 'enabled' },
          { name: '🏢 거래소', value: 'exchanges' },
          { name: '📊 거래 심볼', value: 'symbols' },
          { name: '⚙️  파라미터', value: 'parameters' },
          { name: '🛡️  리스크 한도', value: 'riskLimits' },
          new inquirer.Separator(),
          { name: '⬅️  뒤로가기', value: 'back' }
        ]
      }
    ]);

    if (field === 'back') {
      return this.editBot(); // 봇 선택으로 돌아가기
    }

    let updates: Partial<BotConfig> = {};

    await this.handleFieldEdit(bot, field);
  }

  private async handleFieldEdit(bot: BotConfig, field: string): Promise<void> {
    let updates: Partial<BotConfig> = {};

    switch (field) {
      case 'name':
        const { name } = await inquirer.prompt([
          {
            type: 'input',
            name: 'name',
            message: '새 봇 이름:',
            default: bot.name,
            validate: (input) => input.trim() ? true : '봇 이름을 입력해주세요.'
          }
        ]);
        updates.name = name;
        break;

      case 'enabled':
        const { enabled } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'enabled',
            message: '봇을 활성화하시겠습니까?',
            default: bot.enabled
          }
        ]);
        updates.enabled = enabled;
        break;

      case 'exchanges':
        const config = this.configManager.getConfig();
        const { exchanges } = await inquirer.prompt([
          {
            type: 'checkbox',
            name: 'exchanges',
            message: '사용할 거래소를 선택하세요:',
            choices: config.exchanges.map(ex => ({
              name: ex.name,
              value: ex.name,
              checked: bot.exchanges.includes(ex.name)
            })),
            validate: (input) => input.length > 0 ? true : '최소 한 개의 거래소를 선택해주세요.'
          }
        ]);
        updates.exchanges = exchanges;
        break;

      case 'symbols':
        const { symbols } = await inquirer.prompt([
          {
            type: 'input',
            name: 'symbols',
            message: '거래 심볼 (쉼표로 구분):',
            default: bot.symbols.join(', '),
            filter: (input) => input.split(',').map((s: string) => s.trim())
          }
        ]);
        updates.symbols = symbols;
        break;

      case 'parameters':
        await this.editParameters(bot);
        return; // 파라미터 수정은 별도 처리

      case 'riskLimits':
        await this.editRiskLimits(bot);
        return; // 리스크 한도 수정은 별도 처리
    }

    try {
      this.configManager.updateBotConfig(bot.id, updates);
      console.log(chalk.green(`✅ 봇 ${bot.id} 설정 수정 완료!`));
    } catch (error) {
      console.log(chalk.red(`❌ 봇 설정 수정 실패: ${error}`));
    }
    
    await this.waitForKey();
  }

  private async editParameters(bot: BotConfig): Promise<void> {
    console.log(chalk.blue(`\n⚙️ ${bot.name} 파라미터 수정`));
    console.log('━'.repeat(50));

    if (bot.type === 'StoikovBot') {
      await this.editStoikovParameters(bot);
    } else if (bot.type === 'CrossVenueHedge') {
      await this.editCrossVenueParameters(bot);
    } else {
      console.log(chalk.yellow(`${bot.type} 봇의 파라미터 수정은 아직 지원되지 않습니다.`));
      await this.waitForKey();
    }
  }

  private async editStoikovParameters(bot: BotConfig): Promise<void> {
    const params = bot.parameters;
    
    const { paramField } = await inquirer.prompt([
      {
        type: 'list',
        name: 'paramField',
        message: '수정할 파라미터를 선택하세요:',
        choices: [
          { name: `γ (위험회피도): ${params.gamma}`, value: 'gamma' },
          { name: `변동성 윈도우: ${params.volatilityWindow}ms`, value: 'volatilityWindow' },
          { name: `최대 인벤토리: ${params.maxInventoryPct}%`, value: 'maxInventoryPct' },
          { name: `주문 TTL: ${params.ttlMs}ms`, value: 'ttlMs' },
          { name: `래더 레벨: ${params.ladderLevels}`, value: 'ladderLevels' },
          { name: `드리프트 컷: ${params.driftCutBps}bp`, value: 'driftCutBps' },
          { name: `세션 DD 한도: ${params.sessionDDLimitPct}%`, value: 'sessionDDLimitPct' },
          new inquirer.Separator(),
          { name: '⬅️  뒤로가기', value: 'back' }
        ]
      }
    ]);

    if (paramField === 'back') {
      return;
    }

    let newValue;
    const currentValue = params[paramField];

    switch (paramField) {
      case 'gamma':
        const { gamma } = await inquirer.prompt([
          {
            type: 'number',
            name: 'gamma',
            message: '위험회피도 (γ) [0.3-1.2]:',
            default: currentValue,
            validate: (input) => (input >= 0.3 && input <= 1.2) ? true : '0.3-1.2 범위로 입력하세요'
          }
        ]);
        newValue = gamma;
        break;

      case 'volatilityWindow':
        const { volatilityWindow } = await inquirer.prompt([
          {
            type: 'number',
            name: 'volatilityWindow',
            message: '변동성 윈도우 (ms):',
            default: currentValue,
            validate: (input) => input > 0 ? true : '0보다 큰 값을 입력하세요'
          }
        ]);
        newValue = volatilityWindow;
        break;

      case 'maxInventoryPct':
        const { maxInventoryPct } = await inquirer.prompt([
          {
            type: 'number',
            name: 'maxInventoryPct',
            message: '최대 인벤토리 (% NAV):',
            default: currentValue,
            validate: (input) => (input > 0 && input <= 50) ? true : '0-50% 범위로 입력하세요'
          }
        ]);
        newValue = maxInventoryPct;
        break;

      case 'ttlMs':
        const { ttlMs } = await inquirer.prompt([
          {
            type: 'number',
            name: 'ttlMs',
            message: '주문 TTL (ms):',
            default: currentValue,
            validate: (input) => (input >= 100 && input <= 5000) ? true : '100-5000ms 범위로 입력하세요'
          }
        ]);
        newValue = ttlMs;
        break;

      case 'ladderLevels':
        const { ladderLevels } = await inquirer.prompt([
          {
            type: 'number',
            name: 'ladderLevels',
            message: '래더 레벨 수:',
            default: currentValue,
            validate: (input) => (input >= 1 && input <= 5) ? true : '1-5 범위로 입력하세요'
          }
        ]);
        newValue = ladderLevels;
        break;

      case 'driftCutBps':
        const { driftCutBps } = await inquirer.prompt([
          {
            type: 'number',
            name: 'driftCutBps',
            message: '드리프트 컷 (bp):',
            default: currentValue,
            validate: (input) => input > 0 ? true : '0보다 큰 값을 입력하세요'
          }
        ]);
        newValue = driftCutBps;
        break;

      case 'sessionDDLimitPct':
        const { sessionDDLimitPct } = await inquirer.prompt([
          {
            type: 'number',
            name: 'sessionDDLimitPct',
            message: '세션 DD 한도 (%):',
            default: currentValue,
            validate: (input) => (input > 0 && input <= 10) ? true : '0-10% 범위로 입력하세요'
          }
        ]);
        newValue = sessionDDLimitPct;
        break;
    }

    try {
      const updatedParams = { ...params, [paramField]: newValue };
      this.configManager.updateBotConfig(bot.id, { parameters: updatedParams });
      console.log(chalk.green(`✅ ${paramField} 파라미터가 ${newValue}로 수정되었습니다!`));
    } catch (error) {
      console.log(chalk.red(`❌ 파라미터 수정 실패: ${error}`));
    }
    
    await this.waitForKey();
  }

  private async editCrossVenueParameters(bot: BotConfig): Promise<void> {
    const params = bot.parameters;
    
    const { paramField } = await inquirer.prompt([
      {
        type: 'list',
        name: 'paramField',
        message: '수정할 파라미터를 선택하세요:',
        choices: [
          { name: `최소 스프레드: ${params.minSpreadPercent}%`, value: 'minSpreadPercent' },
          { name: `최대 포지션 크기: ${params.maxPositionSize}`, value: 'maxPositionSize' },
          { name: `헤징 임계값: ${params.hedgeThreshold}`, value: 'hedgeThreshold' },
          { name: `리밸런싱 간격: ${params.rebalanceInterval}ms`, value: 'rebalanceInterval' },
          new inquirer.Separator(),
          { name: '⬅️  뒤로가기', value: 'back' }
        ]
      }
    ]);

    if (paramField === 'back') {
      return;
    }

    let newValue;
    const currentValue = params[paramField];

    switch (paramField) {
      case 'minSpreadPercent':
        const { minSpreadPercent } = await inquirer.prompt([
          {
            type: 'number',
            name: 'minSpreadPercent',
            message: '최소 스프레드 (%):',
            default: currentValue,
            validate: (input) => input > 0 ? true : '0보다 큰 값을 입력하세요'
          }
        ]);
        newValue = minSpreadPercent;
        break;

      case 'maxPositionSize':
        const { maxPositionSize } = await inquirer.prompt([
          {
            type: 'number',
            name: 'maxPositionSize',
            message: '최대 포지션 크기:',
            default: currentValue,
            validate: (input) => input > 0 ? true : '0보다 큰 값을 입력하세요'
          }
        ]);
        newValue = maxPositionSize;
        break;

      case 'hedgeThreshold':
        const { hedgeThreshold } = await inquirer.prompt([
          {
            type: 'number',
            name: 'hedgeThreshold',
            message: '헤징 임계값:',
            default: currentValue,
            validate: (input) => input > 0 ? true : '0보다 큰 값을 입력하세요'
          }
        ]);
        newValue = hedgeThreshold;
        break;

      case 'rebalanceInterval':
        const { rebalanceInterval } = await inquirer.prompt([
          {
            type: 'number',
            name: 'rebalanceInterval',
            message: '리밸런싱 간격 (ms):',
            default: currentValue,
            validate: (input) => input >= 1000 ? true : '1000ms 이상으로 입력하세요'
          }
        ]);
        newValue = rebalanceInterval;
        break;
    }

    try {
      const updatedParams = { ...params, [paramField]: newValue };
      this.configManager.updateBotConfig(bot.id, { parameters: updatedParams });
      console.log(chalk.green(`✅ ${paramField} 파라미터가 ${newValue}로 수정되었습니다!`));
    } catch (error) {
      console.log(chalk.red(`❌ 파라미터 수정 실패: ${error}`));
    }
    
    await this.waitForKey();
  }

  private async editRiskLimits(bot: BotConfig): Promise<void> {
    console.log(chalk.blue(`\n🛡️ ${bot.name} 리스크 한도 수정`));
    console.log('━'.repeat(50));

    const limits = bot.riskLimits;
    
    const { riskField } = await inquirer.prompt([
      {
        type: 'list',
        name: 'riskField',
        message: '수정할 리스크 한도를 선택하세요:',
        choices: [
          { name: `최대 포지션: ${limits.maxPosition} USDT`, value: 'maxPosition' },
          { name: `최대 손실률: ${(limits.maxDrawdown * 100).toFixed(1)}%`, value: 'maxDrawdown' },
          { name: `일일 손실 한도: ${limits.dailyLossLimit} USDT`, value: 'dailyLossLimit' },
          new inquirer.Separator(),
          { name: '⬅️  뒤로가기', value: 'back' }
        ]
      }
    ]);

    if (riskField === 'back') {
      return;
    }

    let newValue;
    const currentValue = limits[riskField];

    switch (riskField) {
      case 'maxPosition':
        const { maxPosition } = await inquirer.prompt([
          {
            type: 'number',
            name: 'maxPosition',
            message: '최대 포지션 (USDT):',
            default: currentValue,
            validate: (input) => input > 0 ? true : '0보다 큰 값을 입력하세요'
          }
        ]);
        newValue = maxPosition;
        break;

      case 'maxDrawdown':
        const { maxDrawdown } = await inquirer.prompt([
          {
            type: 'number',
            name: 'maxDrawdown',
            message: '최대 손실률 (0.01 = 1%):',
            default: currentValue,
            validate: (input) => (input > 0 && input <= 1) ? true : '0과 1 사이의 값을 입력하세요'
          }
        ]);
        newValue = maxDrawdown;
        break;

      case 'dailyLossLimit':
        const { dailyLossLimit } = await inquirer.prompt([
          {
            type: 'number',
            name: 'dailyLossLimit',
            message: '일일 손실 한도 (USDT):',
            default: currentValue,
            validate: (input) => input > 0 ? true : '0보다 큰 값을 입력하세요'
          }
        ]);
        newValue = dailyLossLimit;
        break;
    }

    try {
      const updatedLimits = { ...limits, [riskField]: newValue };
      this.configManager.updateBotConfig(bot.id, { riskLimits: updatedLimits });
      console.log(chalk.green(`✅ ${riskField} 한도가 ${newValue}로 수정되었습니다!`));
    } catch (error) {
      console.log(chalk.red(`❌ 리스크 한도 수정 실패: ${error}`));
    }
    
    await this.waitForKey();
  }

  private async deleteBot(): Promise<void> {
    console.log(chalk.red.bold('\n🗑️ 봇 삭제'));
    console.log('━'.repeat(50));
    console.log(chalk.yellow('⚠️ 주의: 삭제된 봇은 복구할 수 없습니다!'));

    const config = this.configManager.getConfig();
    const bots = config.bots;
    
    if (bots.length === 0) {
      console.log(chalk.yellow('\n삭제할 봇이 없습니다.'));
      await this.waitForKey();
      return;
    }

    const { botId } = await inquirer.prompt([
      {
        type: 'list',
        name: 'botId',
        message: '삭제할 봇을 선택하세요:',
        choices: [
          ...bots.map(bot => ({ 
            name: `${bot.name} (${bot.id}) - ${bot.type}`, 
            value: bot.id 
          })),
          new inquirer.Separator(),
          { name: '⬅️  메인 메뉴로 돌아가기', value: 'back' }
        ]
      }
    ]);

    if (botId === 'back') {
      return;
    }

    const bot = bots.find(b => b.id === botId);
    if (!bot) {
      console.log(chalk.red('봇을 찾을 수 없습니다.'));
      await this.waitForKey();
      return;
    }

    // 봇이 실행중인지 확인
    let isRunning = false;
    try {
      const runningBot = this.orchestrator.getBot(botId);
      if (runningBot) {
        isRunning = true;
      }
    } catch {
      // 봇이 실행중이 아님
    }

    if (isRunning) {
      console.log(chalk.red(`\n❌ 봇 ${botId}가 현재 실행중입니다!`));
      console.log(chalk.yellow('삭제하려면 먼저 봇을 정지해주세요.'));
      
      const { stopAndDelete } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'stopAndDelete',
          message: '봇을 정지하고 삭제하시겠습니까?',
          default: false
        }
      ]);

      if (stopAndDelete) {
        try {
          console.log(chalk.blue(`⏹️ 봇 ${botId} 정지 중...`));
          await this.orchestrator.stopBot(botId);
          await this.orchestrator.removeBot(botId);
        } catch (error) {
          console.log(chalk.red(`❌ 봇 정지 실패: ${error}`));
          await this.waitForKey();
          return;
        }
      } else {
        return;
      }
    }

    // 최종 확인
    console.log(chalk.red(`\n🚨 봇 정보:`));
    console.log(`   ID: ${bot.id}`);
    console.log(`   이름: ${bot.name}`);
    console.log(`   타입: ${bot.type}`);
    console.log(`   거래소: ${bot.exchanges.join(', ')}`);
    console.log(`   심볼: ${bot.symbols.join(', ')}`);

    const { confirm } = await inquirer.prompt([
      {
        type: 'list',
        name: 'confirm',
        message: chalk.red('정말로 이 봇을 삭제하시겠습니까?'),
        choices: [
          { name: '🗑️  네, 삭제합니다', value: 'delete' },
          { name: '❌ 아니오, 취소합니다', value: 'cancel' },
          new inquirer.Separator(),
          { name: '⬅️  봇 선택으로 돌아가기', value: 'back' }
        ]
      }
    ]);

    if (confirm === 'back') {
      return this.deleteBot(); // 봇 선택으로 돌아가기
    }

    if (confirm === 'delete') {
      try {
        // 오케스트레이터에서 봇 제거 (실행중이 아니면 에러 무시)
        try {
          await this.orchestrator.removeBot(botId);
        } catch {
          // 봇이 오케스트레이터에 없으면 무시
        }
        
        // 설정에서 봇 제거
        this.configManager.removeBotConfig(botId);
        
        console.log(chalk.green(`\n✅ 봇 ${botId} 삭제 완료!`));
        console.log(chalk.gray('설정 파일에서 봇 정보가 제거되었습니다.'));
        
      } catch (error) {
        console.log(chalk.red(`\n❌ 봇 삭제 실패: ${error}`));
      }
    } else {
      console.log(chalk.blue('\n취소되었습니다.'));
    }
    
    await this.waitForKey();
  }

  private async showMetrics(): Promise<void> {
    console.log(chalk.blue.bold('\n📈 성능 보고서'));
    console.log('━'.repeat(80));

    const report = this.metricsCollector.getPerformanceReport();
    
    console.log(`총 거래 횟수: ${chalk.yellow(report.totalTrades)}`);
    console.log(`승리 거래: ${chalk.green(report.winningTrades)}`);
    console.log(`패배 거래: ${chalk.red(report.losingTrades)}`);
    console.log(`승률: ${chalk.blue(report.winRate.toFixed(2))}%`);
    console.log(`총 손익: ${this.formatPnL(report.totalPnL)}`);
    console.log(`일일 손익: ${this.formatPnL(report.dailyPnL)}`);
    console.log(`주간 손익: ${this.formatPnL(report.weeklyPnL)}`);
    console.log(`월간 손익: ${this.formatPnL(report.monthlyPnL)}`);

    const botMetrics = this.metricsCollector.getAllBotMetrics();
    if (botMetrics.length > 0) {
      console.log('\n📊 봇별 메트릭:');
      
      const table = new Table({
        head: ['봇 ID', '총 손익', '일일 손익', '활성 포지션', '가동시간'],
        colWidths: [20, 15, 15, 12, 15]
      });

      for (const metrics of botMetrics) {
        table.push([
          metrics.botId,
          this.formatPnL(metrics.totalPnl),
          this.formatPnL(metrics.dailyPnl),
          metrics.activePositions.toString(),
          this.formatUptime(metrics.uptime)
        ]);
      }

      console.log(table.toString());
    }
  }

  private async showHealth(): Promise<void> {
    console.log(chalk.blue.bold('\n🏥 시스템 헬스'));
    console.log('━'.repeat(80));

    const health = this.healthMonitor.getHealthStatus();
    
    console.log(`전체 상태: ${this.getHealthStatusIcon(health.overall)} ${this.getHealthStatusText(health.overall)}`);
    console.log(`마지막 업데이트: ${new Date(health.timestamp).toLocaleString()}`);
    
    console.log(`\n요약:`);
    console.log(`  정상: ${chalk.green(health.summary.healthy)}`);
    console.log(`  경고: ${chalk.yellow(health.summary.warnings)}`);
    console.log(`  치명적: ${chalk.red(health.summary.critical)}`);

    if (health.checks.length > 0) {
      console.log('\n상세 점검 결과:');
      
      const table = new Table({
        head: ['항목', '상태', '메시지', '시간'],
        colWidths: [25, 10, 40, 20]
      });

      for (const check of health.checks.slice(0, 10)) {
        const statusColor = check.status === 'healthy' ? chalk.green : 
                           check.status === 'warning' ? chalk.yellow : chalk.red;
        
        table.push([
          check.name,
          statusColor(check.status),
          check.message,
          new Date(check.timestamp).toLocaleTimeString()
        ]);
      }

      console.log(table.toString());
    }
  }

  private async showDashboard(): Promise<void> {
    console.log(chalk.blue.bold('🔄 실시간 대시보드 시작 중... (Ctrl+C로 종료)'));
    
    const interval = setInterval(() => {
      console.clear();
      console.log(chalk.blue.bold('📊 VibeTrade 실시간 대시보드'));
      console.log('━'.repeat(80));
      console.log(`업데이트 시간: ${new Date().toLocaleString()}\n`);

      // 시스템 상태
      const health = this.healthMonitor.getHealthStatus();
      console.log(`시스템 상태: ${this.getHealthStatusIcon(health.overall)} ${this.getHealthStatusText(health.overall)}`);
      
      // 봇 상태
      const bots = this.orchestrator.getAllBots();
      const runningBots = this.orchestrator.getRunningBots();
      console.log(`총 봇: ${bots.length}개 | 실행중: ${chalk.green(runningBots.length)}개\n`);

      // 성능 요약
      const report = this.metricsCollector.getPerformanceReport();
      console.log(`총 거래: ${report.totalTrades} | 승률: ${report.winRate.toFixed(1)}% | 일일 손익: ${this.formatPnL(report.dailyPnL)}\n`);

      console.log(chalk.gray('Ctrl+C를 눌러 메인 메뉴로 돌아가기'));
    }, 2000);

    // Ctrl+C 핸들러
    const originalHandler = process.listeners('SIGINT');
    process.removeAllListeners('SIGINT');
    process.once('SIGINT', () => {
      clearInterval(interval);
      console.clear();
      // 원래 핸들러 복원
      originalHandler.forEach(handler => {
        process.on('SIGINT', handler as any);
      });
    });

    // 키 입력 대기
    await new Promise(resolve => {
      process.stdin.once('data', () => {
        clearInterval(interval);
        resolve(undefined);
      });
    });
  }

  private getHealthStatusIcon(status: string): string {
    switch (status) {
      case 'healthy': return '🟢';
      case 'warning': return '🟡';
      case 'critical': return '🔴';
      default: return '⚪';
    }
  }

  private getHealthStatusText(status: string): string {
    switch (status) {
      case 'healthy': return chalk.green('정상');
      case 'warning': return chalk.yellow('경고');
      case 'critical': return chalk.red('치명적');
      default: return chalk.gray('알 수 없음');
    }
  }

  private getStatusColor(status: BotStatus | null) {
    switch (status) {
      case BotStatus.RUNNING: return chalk.green;
      case BotStatus.STOPPED: return chalk.gray;
      case BotStatus.ERROR: return chalk.red;
      case BotStatus.STARTING: return chalk.blue;
      case BotStatus.STOPPING: return chalk.yellow;
      default: return chalk.gray;
    }
  }

  private formatPnL(pnl: number): string {
    const color = pnl >= 0 ? chalk.green : chalk.red;
    const sign = pnl >= 0 ? '+' : '';
    return color(`${sign}$${pnl.toFixed(2)}`);
  }

  private formatUptime(uptime: number): string {
    const hours = Math.floor(uptime / (1000 * 60 * 60));
    const minutes = Math.floor((uptime % (1000 * 60 * 60)) / (1000 * 60));
    return `${hours}h ${minutes}m`;
  }

  private async waitForKey(): Promise<void> {
    console.log(chalk.gray('\nEnter 키를 눌러 계속...'));
    await inquirer.prompt([
      {
        type: 'input',
        name: 'continue',
        message: ''
      }
    ]);
  }
}
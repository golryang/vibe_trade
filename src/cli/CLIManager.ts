import inquirer from 'inquirer';
import chalk from 'chalk';
import Table from 'cli-table3';
import { BotOrchestrator } from '../core/BotOrchestrator';
import { ConfigManager } from '../services/ConfigManager';
import { MetricsCollector } from '../services/MetricsCollector';
import { HealthMonitor } from '../services/HealthMonitor';
import { BotConfig, BotStatus, BotMetrics } from '../types';
import { Logger } from '../core/Logger';
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
    const healthStatus = this.healthMonitor.getHealthStatus();
    const runningBots = this.orchestrator.getRunningBots();
    
    console.log(`${this.getHealthStatusIcon(healthStatus.overall)} 시스템 상태: ${chalk.bold(this.getHealthStatusText(healthStatus.overall))}`);
    console.log(`🤖 실행중인 봇: ${chalk.yellow(runningBots.length)}개\n`);

    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: '원하는 작업을 선택하세요:',
        choices: [
          { name: '📊 봇 상태 보기', value: 'status' },
          { name: '▶️  봇 시작하기', value: 'start' },
          { name: '⏹️  봇 정지하기', value: 'stop' },
          { name: '➕ 새 봇 추가하기', value: 'add' },
          { name: '⚙️  봇 설정 수정', value: 'edit' },
          { name: '🗑️  봇 삭제하기', value: 'delete' },
          { name: '📈 성능 보고서', value: 'metrics' },
          { name: '🏥 시스템 헬스', value: 'health' },
          { name: '🔄 실시간 대시보드', value: 'dashboard' },
          { name: '❌  종료', value: 'exit' }
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

    const bots = this.orchestrator.getAllBots();
    
    if (bots.length === 0) {
      console.log(chalk.yellow('등록된 봇이 없습니다.'));
      return;
    }

    const table = new Table({
      head: ['ID', '이름', '타입', '상태', '거래소', '심볼', '활성화'],
      colWidths: [20, 25, 15, 12, 15, 15, 8]
    });

    for (const bot of bots) {
      const status = this.orchestrator.getBotStatus(bot.id);
      const statusColor = this.getStatusColor(status);
      
      table.push([
        bot.id,
        bot.name,
        bot.type,
        statusColor(status || 'unknown'),
        bot.exchanges.join(', '),
        bot.symbols.join(', '),
        bot.enabled ? chalk.green('✓') : chalk.red('✗')
      ]);
    }

    console.log(table.toString());
  }

  private async startBot(): Promise<void> {
    const bots = this.orchestrator.getAllBots()
      .filter(bot => this.orchestrator.getBotStatus(bot.id) === BotStatus.STOPPED);
    
    if (bots.length === 0) {
      console.log(chalk.yellow('시작할 수 있는 봇이 없습니다.'));
      return;
    }

    const { botId } = await inquirer.prompt([
      {
        type: 'list',
        name: 'botId',
        message: '시작할 봇을 선택하세요:',
        choices: bots.map(bot => ({ name: `${bot.name} (${bot.id})`, value: bot.id }))
      }
    ]);

    try {
      console.log(chalk.blue(`🚀 봇 ${botId} 시작 중...`));
      await this.orchestrator.startBot(botId);
      console.log(chalk.green(`✅ 봇 ${botId} 시작 완료!`));
    } catch (error) {
      console.log(chalk.red(`❌ 봇 시작 실패: ${error}`));
    }
  }

  private async stopBot(): Promise<void> {
    const bots = this.orchestrator.getAllBots()
      .filter(bot => this.orchestrator.getBotStatus(bot.id) === BotStatus.RUNNING);
    
    if (bots.length === 0) {
      console.log(chalk.yellow('실행중인 봇이 없습니다.'));
      return;
    }

    const { botId } = await inquirer.prompt([
      {
        type: 'list',
        name: 'botId',
        message: '정지할 봇을 선택하세요:',
        choices: bots.map(bot => ({ name: `${bot.name} (${bot.id})`, value: bot.id }))
      }
    ]);

    try {
      console.log(chalk.blue(`⏹️ 봇 ${botId} 정지 중...`));
      await this.orchestrator.stopBot(botId);
      console.log(chalk.green(`✅ 봇 ${botId} 정지 완료!`));
    } catch (error) {
      console.log(chalk.red(`❌ 봇 정지 실패: ${error}`));
    }
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
          { name: 'Cross-Venue Hedge Market Making', value: 'CrossVenueHedge' }
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

      const botConfig: BotConfig = {
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
          // TODO: 실제 봇 인스턴스를 오케스트레이터에 추가하는 로직 필요
          console.log(chalk.yellow('⚠️ 봇 인스턴스 추가 기능은 아직 구현되지 않았습니다.'));
        }
      } catch (error) {
        console.log(chalk.red(`❌ 봇 추가 실패: ${error}`));
      }
    }
  }

  private async editBot(): Promise<void> {
    const bots = this.orchestrator.getAllBots();
    
    if (bots.length === 0) {
      console.log(chalk.yellow('수정할 봇이 없습니다.'));
      return;
    }

    const { botId } = await inquirer.prompt([
      {
        type: 'list',
        name: 'botId',
        message: '수정할 봇을 선택하세요:',
        choices: bots.map(bot => ({ name: `${bot.name} (${bot.id})`, value: bot.id }))
      }
    ]);

    const bot = this.configManager.getBotConfig(botId);
    if (!bot) {
      console.log(chalk.red('봇을 찾을 수 없습니다.'));
      return;
    }

    console.log(chalk.blue.bold(`\n⚙️ ${bot.name} 설정 수정`));
    console.log('━'.repeat(50));

    const { field } = await inquirer.prompt([
      {
        type: 'list',
        name: 'field',
        message: '수정할 항목을 선택하세요:',
        choices: [
          { name: '봇 이름', value: 'name' },
          { name: '활성화 여부', value: 'enabled' },
          { name: '거래소', value: 'exchanges' },
          { name: '심볼', value: 'symbols' },
          { name: '파라미터', value: 'parameters' },
          { name: '리스크 한도', value: 'riskLimits' }
        ]
      }
    ]);

    let updates: Partial<BotConfig> = {};

    switch (field) {
      case 'name':
        const { name } = await inquirer.prompt([
          {
            type: 'input',
            name: 'name',
            message: '새 봇 이름:',
            default: bot.name
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

      // 다른 필드들도 유사하게 구현...
    }

    try {
      this.configManager.updateBotConfig(botId, updates);
      console.log(chalk.green(`✅ 봇 ${botId} 설정 수정 완료!`));
    } catch (error) {
      console.log(chalk.red(`❌ 봇 설정 수정 실패: ${error}`));
    }
  }

  private async deleteBot(): Promise<void> {
    const bots = this.orchestrator.getAllBots();
    
    if (bots.length === 0) {
      console.log(chalk.yellow('삭제할 봇이 없습니다.'));
      return;
    }

    const { botId } = await inquirer.prompt([
      {
        type: 'list',
        name: 'botId',
        message: '삭제할 봇을 선택하세요:',
        choices: bots.map(bot => ({ name: `${bot.name} (${bot.id})`, value: bot.id }))
      }
    ]);

    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: chalk.red(`정말로 봇 ${botId}를 삭제하시겠습니까?`),
        default: false
      }
    ]);

    if (confirm) {
      try {
        await this.orchestrator.removeBot(botId);
        this.configManager.removeBotConfig(botId);
        console.log(chalk.green(`✅ 봇 ${botId} 삭제 완료!`));
      } catch (error) {
        console.log(chalk.red(`❌ 봇 삭제 실패: ${error}`));
      }
    }
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
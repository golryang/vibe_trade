export interface MarketData {
  symbol: string;
  exchange: string;
  price: number;
  volume: number;
  timestamp: number;
  bid: number;
  ask: number;
  spread: number;
}

export interface OrderBook {
  symbol: string;
  exchange: string;
  bids: [number, number][];
  asks: [number, number][];
  timestamp: number;
}

export interface Order {
  id: string;
  symbol: string;
  exchange: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit' | 'stop';
  amount: number;
  price?: number;
  status: 'pending' | 'open' | 'filled' | 'cancelled' | 'rejected';
  timestamp: number;
  filled?: number;
}

export interface Position {
  symbol: string;
  exchange: string;
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
}

export interface BotConfig {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  exchanges: string[];
  symbols: string[];
  parameters: Record<string, any>;
  riskLimits: {
    maxPosition: number;
    maxDrawdown: number;
    dailyLossLimit: number;
  };
}

export interface BotMetrics {
  botId: string;
  totalPnl: number;
  dailyPnl: number;
  winRate: number;
  totalTrades: number;
  activePositions: number;
  uptime: number;
  lastUpdate: number;
}

export interface ExchangeConfig {
  name: string;
  apiKey: string;
  secret: string;
  passphrase?: string;
  sandbox: boolean;
  rateLimit: number;
}

export enum BotStatus {
  STOPPED = 'stopped',
  STARTING = 'starting',
  RUNNING = 'running',
  STOPPING = 'stopping',
  ERROR = 'error'
}

export enum LogLevel {
  ERROR = 'error',
  WARN = 'warn',
  INFO = 'info',
  DEBUG = 'debug'
}
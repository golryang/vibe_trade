import WebSocket from 'ws';
import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import { BaseExchange } from './BaseExchange';
import { Order, OrderBook, MarketData, Position, ExchangeConfig } from '../types';
import { Logger } from '../core/Logger';
import winston from 'winston';

interface BinanceFuturesConfig extends ExchangeConfig {
  testnet?: boolean;
}

interface BinanceOrder {
  symbol: string;
  orderId: number;
  clientOrderId: string;
  price: string;
  origQty: string;
  executedQty: string;
  cummulativeQuoteQty: string;
  status: string;
  timeInForce: string;
  type: string;
  side: string;
  stopPrice?: string;
  workingType?: string;
  priceProtect?: boolean;
  origType?: string;
  updateTime: number;
}

interface BinancePosition {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  liquidationPrice: string;
  leverage: string;
  maxNotionalValue: string;
  marginType: string;
  isolatedMargin: string;
  isAutoAddMargin: string;
  positionSide: string;
  notional: string;
  isolatedWallet: string;
  updateTime: number;
}

interface WebSocketConnection {
  ws: WebSocket | null;
  reconnectAttempts: number;
  maxReconnectAttempts: number;
  reconnectDelay: number;
  isConnecting: boolean;
  lastPingTime: number;
  streamName: string;
}

export class BinanceFuturesExchange extends BaseExchange {
  private baseUrl: string;
  private wsBaseUrl: string;
  private apiClient: AxiosInstance;
  private symbolFilters: Map<string, any> = new Map();
  
  // WebSocket connections
  private marketDataWs: WebSocketConnection;
  private userDataWs: WebSocketConnection;
  private listenKey: string = '';
  
  // Subscriptions tracking
  private subscribedSymbols: Set<string> = new Set();
  private orderBookSubscriptions: Set<string> = new Set();
  private tradeSubscriptions: Set<string> = new Set();
  
  // Rate limiting
  private requestWeights: Map<string, number> = new Map();
  private lastRequestTime: number = 0;
  private requestCount: number = 0;
  // REST polling fallbacks
  private orderBookPollers: Map<string, NodeJS.Timeout> = new Map();
  private tradePollers: Map<string, NodeJS.Timeout> = new Map();

  constructor(config: BinanceFuturesConfig) {
    super(config);
    
    // Always use mainnet endpoints
    this.baseUrl = 'https://fapi.binance.com';
    this.wsBaseUrl = 'wss://fstream.binance.com';
    
    // Initialize axios client
    this.apiClient = axios.create({
      baseURL: this.baseUrl,
      timeout: 10000,
      headers: {
        'X-MBX-APIKEY': config.apiKey,
        'Content-Type': 'application/json'
      }
    });
    
    // Initialize WebSocket connections
    this.marketDataWs = this.createWSConnection('market_data');
    this.userDataWs = this.createWSConnection('user_data');
    
    // Setup request interceptor for rate limiting
    this.setupRequestInterceptor();
    
    this.logger.info(`BinanceFuturesExchange initialized`, { 
      testnet: config.testnet, 
      baseUrl: this.baseUrl 
    });
  }

  private createWSConnection(streamName: string): WebSocketConnection {
    return {
      ws: null,
      reconnectAttempts: 0,
      maxReconnectAttempts: 10,
      reconnectDelay: 1000,
      isConnecting: false,
      lastPingTime: 0,
      streamName
    };
  }

  private setupRequestInterceptor(): void {
    // Request interceptor for rate limiting and signing
    this.apiClient.interceptors.request.use(
      async (config) => {
        // Check rate limit
        await this.checkRateLimit(config.url || '');
        
        // Sign request if needed
        if (config.url && this.requiresAuthentication(config.url)) {
          this.signRequest(config);
        }
        
        return config;
      },
      (error) => Promise.reject(error)
    );

    // Response interceptor for error handling
    this.apiClient.interceptors.response.use(
      (response) => {
        // Update rate limit info from headers
        this.updateRateLimitInfo(response.headers);
        return response;
      },
      (error) => {
        this.handleApiError(error);
        return Promise.reject(error);
      }
    );
  }

  private requiresAuthentication(url: string): boolean {
    // URLs that require authentication
    const authRequiredPaths = [
      '/fapi/v1/order',
      '/fapi/v2/order', 
      '/fapi/v2/positionRisk',
      '/fapi/v2/balance',
      '/fapi/v1/account'
    ];
    
    return authRequiredPaths.some(path => url.includes(path));
  }

  private signRequest(config: any): void {
    const method = (config.method || 'get').toLowerCase();
    const params: Record<string, any> = {};

    // Merge existing params
    if (config.params && typeof config.params === 'object') {
      Object.assign(params, config.params);
    }

    // For non-GET/DELETE, allow body params to be signed
    if (method !== 'get' && method !== 'delete' && config.data && typeof config.data === 'object') {
      Object.assign(params, config.data);
    }

    // Binance required params
    params.timestamp = Date.now();
    if (!params.recvWindow) {
      params.recvWindow = 5000;
    }

    const queryString = new URLSearchParams(params as any).toString();

    const signature = crypto
      .createHmac('sha256', this.config.secret)
      .update(queryString)
      .digest('hex');

    if (method === 'get' || method === 'delete') {
      config.params = { ...params, signature };
    } else {
      config.data = `${queryString}&signature=${signature}`;
      config.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    // Ensure API key header present
    config.headers['X-MBX-APIKEY'] = (this.config as any).apiKey;
  }

  protected async checkRateLimit(url: string): Promise<void> {
    const now = Date.now();
    const weight = this.getRequestWeight(url);
    
    // Check if we're approaching rate limits
    if (this.requestCount + weight > 1200) { // 1200 requests per minute limit
      const waitTime = this.rateLimitResetTime - now;
      if (waitTime > 0) {
        // this.logger.warn(`Rate limit approached, waiting ${waitTime}ms`);
        await this.sleep(waitTime);
      }
    }
    
    // For order endpoints, check per-second limits
    if (this.isOrderEndpoint(url)) {
      const timeSinceLastRequest = now - this.lastRequestTime;
      if (timeSinceLastRequest < 100) { // Max 10 orders per second
        await this.sleep(100 - timeSinceLastRequest);
      }
    }
    
    this.lastRequestTime = now;
  }

  private getRequestWeight(url: string): number {
    // Define weights for different endpoints based on Binance documentation
    const weights = new Map([
      ['/fapi/v1/order', 1],
      ['/fapi/v1/openOrders', 1],
      ['/fapi/v1/allOrders', 5],
      ['/fapi/v1/depth', 2],
      ['/fapi/v1/trades', 1],
      ['/fapi/v1/historicalTrades', 5],
      ['/fapi/v1/aggTrades', 1],
      ['/fapi/v1/klines', 1],
      ['/fapi/v1/fundingRate', 1],
      ['/fapi/v1/ticker/24hr', 1],
      ['/fapi/v1/ticker/price', 1],
      ['/fapi/v1/ticker/bookTicker', 1],
      ['/fapi/v2/account', 5],
      ['/fapi/v2/balance', 5],
      ['/fapi/v2/positionRisk', 5]
    ]);

    for (const [endpoint, weight] of weights) {
      if (url.includes(endpoint)) {
        return weight;
      }
    }
    
    return 1; // Default weight
  }

  private isOrderEndpoint(url: string): boolean {
    const orderEndpoints = [
      '/fapi/v1/order',
      '/fapi/v1/allOpenOrders',
      '/fapi/v1/batchOrders'
    ];
    
    return orderEndpoints.some(endpoint => url.includes(endpoint));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private updateRateLimitInfo(headers: any): void {
    // Update rate limit counters from response headers
    if (headers['x-mbx-used-weight-1m']) {
      this.requestCount = parseInt(headers['x-mbx-used-weight-1m']);
    }
    
    if (headers['x-mbx-order-count-1s']) {
      // Track order rate limits
    }
    
    // Set rate limit reset time (1 minute from now if not provided)
    if (!this.rateLimitResetTime || this.rateLimitResetTime < Date.now()) {
      this.rateLimitResetTime = Date.now() + 60000; // Reset in 1 minute
    }
  }

  private async getSymbolFilters(symbol: string): Promise<{ tickSize: number; stepSize: number; minNotional?: number }> {
    const upper = symbol.toUpperCase();
    if (this.symbolFilters.has(upper)) {
      return this.symbolFilters.get(upper);
    }
    const info = await this.getExchangeInfo();
    const s = (info.symbols || []).find((x: any) => x.symbol === upper);
    if (!s) {
      throw new Error(`Symbol ${upper} not found in exchangeInfo`);
    }
    const filters = s.filters || [];
    const priceFilter = filters.find((f: any) => f.filterType === 'PRICE_FILTER');
    const lotFilter = filters.find((f: any) => f.filterType === 'LOT_SIZE' || f.filterType === 'MARKET_LOT_SIZE');
    const notionalFilter = filters.find((f: any) => f.filterType === 'MIN_NOTIONAL' || f.filterType === 'NOTIONAL');
    const tickSize = parseFloat(priceFilter?.tickSize ?? '0.01');
    const stepSize = parseFloat(lotFilter?.stepSize ?? '0.001');
    const minNotional = notionalFilter ? parseFloat(notionalFilter.minNotional ?? notionalFilter.notional ?? '0') : undefined;
    const parsed = { tickSize, stepSize, minNotional };
    this.symbolFilters.set(upper, parsed);
    return parsed;
  }

  private roundDown(value: number, step: number): number {
    if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return value;
    const precision = (step.toString().split('.')[1] || '').length;
    const floored = Math.floor(value / step) * step;
    return parseFloat(floored.toFixed(precision));
  }

  private formatByStep(value: number, step: number): string {
    const precision = (step.toString().split('.')[1] || '').length;
    return value.toFixed(precision);
  }

  private handleApiError(error: any): void {
    if (error.response) {
      const { status, data } = error.response;
      this.logger.error('Binance API Error', {
        status,
        code: data?.code,
        message: data?.msg || error?.message,
        method: error?.config?.method,
        url: error?.config?.url
      });
      
      // Handle specific error codes
      switch (status) {
        case 429: // Rate limit exceeded
          this.logger.warn('Rate limit exceeded, backing off');
          break;
        case 418: // IP banned
          this.logger.error('IP banned by Binance');
          this.emitError(new Error('IP banned by Binance'));
          break;
        case -1021: // Timestamp outside recvWindow
          this.logger.warn('Timestamp sync issue');
          break;
      }
    } else {
      this.logger.error('Network error', {
        message: error?.message,
        code: error?.code,
        url: error?.config?.url,
        method: error?.config?.method
      });
    }
  }

  // BaseExchange implementation
  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    this.logger.info('Connecting to Binance Futures...');
    
    try {
      // Test connectivity first
      await this.testConnectivity();
      
      // Get listen key for user data stream
      await this.createListenKey();
      
      // Connect WebSocket streams
      await this.connectMarketDataStream();
      await this.connectUserDataStream();
      
      // Start keep-alive for listen key
      this.startListenKeyKeepAlive();
      
      this.connected = true;
      this.logger.info('Connected to Binance Futures successfully');
      
    } catch (error) {
      this.logger.error('Failed to connect to Binance Futures:', error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.connected) {
      return;
    }

    this.logger.info('Disconnecting from Binance Futures...');
    
    // Close WebSocket connections
    if (this.marketDataWs.ws) {
      this.marketDataWs.ws.close();
      this.marketDataWs.ws = null;
    }
    
    if (this.userDataWs.ws) {
      this.userDataWs.ws.close();
      this.userDataWs.ws = null;
    }
    
    // Delete listen key
    if (this.listenKey) {
      try {
        await this.deleteListenKey();
      } catch (error) {
        this.logger.warn('Failed to delete listen key:', error);
      }
    }
    
    this.connected = false;
    this.subscribedSymbols.clear();
    this.orderBookSubscriptions.clear();
    this.tradeSubscriptions.clear();
    
    this.logger.info('Disconnected from Binance Futures');
  }

  private async testConnectivity(): Promise<void> {
    try {
      const response = await this.apiClient.get('/fapi/v1/ping');
      this.logger.debug('Connectivity test passed');
    } catch (error) {
      throw new Error('Failed connectivity test');
    }
  }

  private async createListenKey(): Promise<void> {
    try {
      const response = await this.apiClient.post('/fapi/v1/listenKey');
      this.listenKey = response.data.listenKey;
      this.logger.debug('Listen key created');
    } catch (error) {
      throw new Error('Failed to create listen key');
    }
  }

  private async deleteListenKey(): Promise<void> {
    if (!this.listenKey) return;
    
    try {
      await this.apiClient.delete('/fapi/v1/listenKey');
      this.listenKey = '';
      this.logger.debug('Listen key deleted');
    } catch (error) {
      this.logger.warn('Failed to delete listen key:', error);
    }
  }

  private startListenKeyKeepAlive(): void {
    // Keep listen key alive by extending it every 30 minutes
    setInterval(async () => {
      if (this.listenKey && this.connected) {
        try {
          await this.apiClient.put('/fapi/v1/listenKey');
          this.logger.debug('Listen key extended');
        } catch (error) {
          this.logger.error('Failed to extend listen key:', error);
          // Try to recreate listen key
          try {
            await this.createListenKey();
            this.reconnectUserDataStream();
          } catch (recreateError) {
            this.logger.error('Failed to recreate listen key:', recreateError);
          }
        }
      }
    }, 30 * 60 * 1000); // 30 minutes
  }

  // Subscription methods (will implement next)
  async subscribeToOrderBook(symbol: string): Promise<void> {
    this.orderBookSubscriptions.add(symbol);
    this.subscribedSymbols.add(symbol);
    
    // Start REST polling fallback
    if (!this.orderBookPollers.has(symbol)) {
      const poller = setInterval(async () => {
        try {
          const ob = await this.getOrderBook(symbol);
          this.emitOrderBook(ob);
        } catch (e) {
          this.logger.warn(`Orderbook poll failed for ${symbol}: ${e}`);
        }
      }, 1000);
      this.orderBookPollers.set(symbol, poller);
    }
    
    // Subscribe to WebSocket depth stream if connected
    if (this.marketDataWs.ws && this.marketDataWs.ws.readyState === WebSocket.OPEN) {
      this.subscribeToStream(`${symbol.toLowerCase()}@depth@100ms`);
    }
    this.logger.debug(`Subscribed to orderbook: ${symbol}`);
  }

  async subscribeToTrades(symbol: string): Promise<void> {
    this.tradeSubscriptions.add(symbol);
    this.subscribedSymbols.add(symbol);
    
    if (this.marketDataWs.ws && this.marketDataWs.ws.readyState === WebSocket.OPEN) {
      this.subscribeToStream(`${symbol.toLowerCase()}@trade`);
    }
    
    this.logger.debug(`Subscribed to trades: ${symbol}`);
  }

  async unsubscribeFromOrderBook(symbol: string): Promise<void> {
    this.orderBookSubscriptions.delete(symbol);
    
    // Stop REST polling fallback
    const poller = this.orderBookPollers.get(symbol);
    if (poller) {
      clearInterval(poller);
      this.orderBookPollers.delete(symbol);
    }
    
    // Unsubscribe from WebSocket depth stream if connected
    if (this.marketDataWs.ws && this.marketDataWs.ws.readyState === WebSocket.OPEN) {
      this.unsubscribeFromStream(`${symbol.toLowerCase()}@depth@100ms`);
    }
    this.logger.debug(`Unsubscribed from orderbook: ${symbol}`);
  }

  async unsubscribeFromTrades(symbol: string): Promise<void> {
    this.tradeSubscriptions.delete(symbol);
    
    if (this.marketDataWs.ws && this.marketDataWs.ws.readyState === WebSocket.OPEN) {
      this.unsubscribeFromStream(`${symbol.toLowerCase()}@trade`);
    }
    
    this.logger.debug(`Unsubscribed from trades: ${symbol}`);
  }

  // REST API methods
  async placeOrder(order: Omit<Order, 'id' | 'timestamp' | 'status'>): Promise<Order> {
    try {
      // Validate amount and optional price before sending
      const amountValid = Number.isFinite(order.amount) && order.amount > 0;
      const priceValid = order.type === 'market' || (Number.isFinite(order.price as number) && (order.price as number) > 0);
      if (!amountValid || !priceValid) {
        this.logger.warn('Rejected invalid order params', {
          amount: order.amount,
          price: order.price,
          type: order.type
        });
        throw new Error('Invalid order parameters');
      }

      // Enforce Binance filters (tick size, step size, min notional)
      const { tickSize, stepSize, minNotional } = await this.getSymbolFilters(order.symbol);
      const normalizedPrice = order.type === 'limit' && order.price
        ? this.roundDown(order.price, tickSize)
        : (order.price as number | undefined);
      let normalizedQtyBase = this.roundDown(order.amount, stepSize);
      const adjustQty = () => {
        // 최소 수량은 stepSize로 보정
        let q = Math.max(normalizedQtyBase, stepSize);
        // 최소 명목가치 충족하도록 추가 보정 (limit 주문만)
        if (order.type === 'limit' && normalizedPrice && minNotional) {
          const needed = minNotional / normalizedPrice;
          if (q * normalizedPrice < minNotional) {
            const steps = Math.ceil(needed / stepSize);
            q = steps * stepSize;
          }
        }
        return q;
      };

      if (!Number.isFinite(normalizedQtyBase) || normalizedQtyBase <= 0) {
        const bumped = adjustQty();
        if (!Number.isFinite(bumped) || bumped <= 0) {
          throw new Error('Quantity after step-size normalization is invalid');
        }
        this.logger.warn('Adjusted quantity to meet stepSize/minNotional', {
          from: order.amount,
          to: bumped,
          stepSize,
          minNotional,
          price: normalizedPrice
        });
        normalizedQtyBase = bumped;
      } else if (order.type === 'limit' && normalizedPrice && minNotional && normalizedQtyBase * normalizedPrice < minNotional) {
        const bumped = adjustQty();
        this.logger.warn('Bumped quantity to satisfy minNotional', {
          from: normalizedQtyBase,
          to: bumped,
          minNotional,
          price: normalizedPrice
        });
        normalizedQtyBase = bumped;
      }

      const params = {
        symbol: order.symbol,
        side: order.side.toUpperCase(),
        type: order.type.toUpperCase(),
        quantity: this.formatByStep(normalizedQtyBase, stepSize)
      };

      // Add price for limit orders
      if (order.type === 'limit' && normalizedPrice) {
        (params as any).price = this.formatByStep(normalizedPrice, tickSize);
        // Respect requested timeInForce if provided (e.g., GTX for post-only)
        const tif = (order as any).timeInForce as string | undefined;
        (params as any).timeInForce = tif && ['GTC','IOC','FOK','GTX'].includes(tif) ? tif : 'GTC';
      }

      // Add client order ID if available
      const clientOrderId = `${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
      (params as any).newClientOrderId = clientOrderId;

      this.logger.info('Submitting order', {
        symbol: order.symbol,
        side: order.side,
        type: order.type,
        quantity: params.quantity,
        price: (params as any).price,
        tif: (params as any).timeInForce
      });
      const response = await this.apiClient.post('/fapi/v1/order', params);
      const binanceOrder: BinanceOrder = response.data;

      return this.mapBinanceOrder(binanceOrder);
    } catch (error) {
      // this.logger.error('Failed to place order:', error);
      throw error;
    }
  }

  async cancelOrder(orderId: string, symbol: string): Promise<boolean> {
    try {
      const parsed = parseInt(orderId);
      if (Number.isNaN(parsed)) {
        this.logger.warn('cancelOrder called with NaN orderId, skipping', { symbol, orderId });
        return false;
      }
      const params = {
        symbol,
        orderId: parsed
      };

      await this.apiClient.delete('/fapi/v1/order', { params });
      return true;
    } catch (error) {
      this.logger.error('Failed to cancel order', {
        message: (error as any)?.message,
        code: (error as any)?.code
      });
      return false;
    }
  }

  async getOrder(orderId: string, symbol: string): Promise<Order> {
    try {
      const params = {
        symbol,
        orderId: parseInt(orderId)
      };

      const response = await this.apiClient.get('/fapi/v1/order', { params });
      const binanceOrder: BinanceOrder = response.data;

      return this.mapBinanceOrder(binanceOrder);
    } catch (error) {
      // this.logger.error('Failed to get order:', error);
      throw error;
    }
  }

  async getOpenOrders(symbol?: string): Promise<Order[]> {
    try {
      const params = symbol ? { symbol } : {};
      const response = await this.apiClient.get('/fapi/v1/openOrders', { params });
      const binanceOrders: BinanceOrder[] = response.data;

      return binanceOrders.map(order => this.mapBinanceOrder(order));
    } catch (error) {
      // this.logger.error('Failed to get open orders:', error);
      throw error;
    }
  }

  async getBalance(): Promise<Record<string, number>> {
    try {
      const response = await this.apiClient.get('/fapi/v2/balance');
      const balances = response.data;

      const result: Record<string, number> = {};
      balances.forEach((balance: any) => {
        if (parseFloat(balance.balance) > 0) {
          result[balance.asset] = parseFloat(balance.balance);
        }
      });

      return result;
    } catch (error) {
      // this.logger.error('Failed to get balance:', error);
      throw error;
    }
  }

  async getPositions(): Promise<Position[]> {
    try {
      const response = await this.apiClient.get('/fapi/v2/positionRisk');
      const binancePositions: BinancePosition[] = response.data;

      return binancePositions
        .filter(pos => parseFloat(pos.positionAmt) !== 0)
        .map(pos => this.mapBinancePosition(pos));
    } catch (error) {
      // this.logger.error('Failed to get positions:', error);
      throw error;
    }
  }

  async getOrderBook(symbol: string): Promise<OrderBook> {
    try {
      const params = {
        symbol,
        limit: 100
      };

      const response = await this.apiClient.get('/fapi/v1/depth', { params });
      const data = response.data;

      return {
        symbol,
        bids: data.bids.map((bid: [string, string]) => [parseFloat(bid[0]), parseFloat(bid[1])]),
        asks: data.asks.map((ask: [string, string]) => [parseFloat(ask[0]), parseFloat(ask[1])]),
        sequence: data.lastUpdateId,
        timestamp: Date.now()
      };
    } catch (error) {
      this.logger.error('Failed to get order book:', error);
      throw error;
    }
  }

  // Utility methods for mapping Binance data to our types
  private mapBinanceOrder(binanceOrder: BinanceOrder): Order {
    return {
      id: binanceOrder.orderId.toString(),
      symbol: binanceOrder.symbol,
      exchange: this.getName(),
      side: binanceOrder.side.toLowerCase() as 'buy' | 'sell',
      type: binanceOrder.type.toLowerCase() as 'market' | 'limit',
      amount: parseFloat(binanceOrder.origQty),
      price: parseFloat(binanceOrder.price),
      status: this.mapOrderStatus(binanceOrder.status),
      timestamp: binanceOrder.updateTime || Date.now(),
      filled: parseFloat(binanceOrder.executedQty)
    };
  }

  private mapBinancePosition(binancePosition: BinancePosition): Position {
    const positionAmt = parseFloat(binancePosition.positionAmt);
    
    return {
      symbol: binancePosition.symbol,
      exchange: this.getName(),
      side: positionAmt > 0 ? 'long' : 'short',
      size: Math.abs(positionAmt),
      entryPrice: parseFloat(binancePosition.entryPrice),
      markPrice: parseFloat(binancePosition.markPrice),
      unrealizedPnl: parseFloat(binancePosition.unRealizedProfit),
      realizedPnl: 0 // Not provided in position endpoint
    };
  }

  // Additional utility methods
  async getServerTime(): Promise<number> {
    try {
      const response = await this.apiClient.get('/fapi/v1/time');
      return response.data.serverTime;
    } catch (error) {
      this.logger.error('Failed to get server time:', error);
      return Date.now();
    }
  }

  async getExchangeInfo(): Promise<any> {
    try {
      const response = await this.apiClient.get('/fapi/v1/exchangeInfo');
      return response.data;
    } catch (error) {
      this.logger.error('Failed to get exchange info:', error);
      throw error;
    }
  }

  async get24hrStats(symbol: string): Promise<any> {
    try {
      const params = { symbol };
      const response = await this.apiClient.get('/fapi/v1/ticker/24hr', { params });
      return response.data;
    } catch (error) {
      this.logger.error('Failed to get 24hr stats:', error);
      throw error;
    }
  }

  // Cancel all open orders (useful for emergency situations)
  async cancelAllOrders(symbol?: string): Promise<boolean> {
    try {
      const params = symbol ? { symbol } : {};
      await this.apiClient.delete('/fapi/v1/allOpenOrders', { params });
      this.logger.info(`All open orders cancelled${symbol ? ` for ${symbol}` : ''}`);
      return true;
    } catch (error) {
      this.logger.error('Failed to cancel all orders:', error);
      return false;
    }
  }

  // Batch cancel orders
  async batchCancelOrders(orders: Array<{orderId: string, symbol: string}>): Promise<boolean[]> {
    const results = await Promise.allSettled(
      orders.map(order => this.cancelOrder(order.orderId, order.symbol))
    );

    return results.map(result => result.status === 'fulfilled' && result.value);
  }

  // Get account information
  async getAccountInfo(): Promise<any> {
    try {
      const response = await this.apiClient.get('/fapi/v2/account');
      return response.data;
    } catch (error) {
      this.logger.error('Failed to get account info:', error);
      throw error;
    }
  }

  // Position management
  async changePositionMode(dualSidePosition: boolean): Promise<boolean> {
    try {
      const params = {
        dualSidePosition: dualSidePosition.toString()
      };
      await this.apiClient.post('/fapi/v1/positionSide/dual', params);
      return true;
    } catch (error) {
      this.logger.error('Failed to change position mode:', error);
      return false;
    }
  }

  async changeInitialLeverage(symbol: string, leverage: number): Promise<boolean> {
    try {
      const params = {
        symbol,
        leverage: leverage.toString()
      };
      await this.apiClient.post('/fapi/v1/leverage', params);
      return true;
    } catch (error) {
      this.logger.error('Failed to change leverage:', error);
      return false;
    }
  }

  async changeMarginType(symbol: string, marginType: 'ISOLATED' | 'CROSSED'): Promise<boolean> {
    try {
      const params = {
        symbol,
        marginType
      };
      await this.apiClient.post('/fapi/v1/marginType', params);
      return true;
    } catch (error) {
      this.logger.error('Failed to change margin type:', error);
      return false;
    }
  }

  // WebSocket methods
  private async connectMarketDataStream(): Promise<void> {
    if (this.marketDataWs.isConnecting || (this.marketDataWs.ws && this.marketDataWs.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this.marketDataWs.isConnecting = true;
    
    try {
      const wsUrl = `${this.wsBaseUrl}/ws/combined`;
      this.marketDataWs.ws = new WebSocket(wsUrl);
      
      this.marketDataWs.ws.on('open', () => {
        this.logger.info('Market data WebSocket connected');
        this.marketDataWs.isConnecting = false;
        this.marketDataWs.reconnectAttempts = 0;
        
        // Subscribe to existing subscriptions
        this.resubscribeMarketData();
        
        // Start ping/pong
        this.startPingPong(this.marketDataWs);
      });
      
      this.marketDataWs.ws.on('message', (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMarketDataMessage(message);
        } catch (error) {
          this.logger.error('Failed to parse market data message:', error);
        }
      });
      
      this.marketDataWs.ws.on('error', (error) => {
        this.logger.error('Market data WebSocket error:', error);
        this.emitError(error);
      });
      
      this.marketDataWs.ws.on('close', (code, reason) => {
        this.logger.warn(`Market data WebSocket closed: ${code} ${reason}`);
        this.marketDataWs.isConnecting = false;
        this.scheduleReconnect(this.marketDataWs, this.connectMarketDataStream.bind(this));
      });
      
      this.marketDataWs.ws.on('pong', () => {
        this.marketDataWs.lastPingTime = Date.now();
      });
      
    } catch (error) {
      this.marketDataWs.isConnecting = false;
      this.logger.error('Failed to connect market data WebSocket:', error);
      this.scheduleReconnect(this.marketDataWs, this.connectMarketDataStream.bind(this));
    }
  }

  private async connectUserDataStream(): Promise<void> {
    if (!this.listenKey) {
      this.logger.error('No listen key available for user data stream');
      return;
    }

    if (this.userDataWs.isConnecting || (this.userDataWs.ws && this.userDataWs.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this.userDataWs.isConnecting = true;
    
    try {
      const wsUrl = `${this.wsBaseUrl}/ws/${this.listenKey}`;
      this.userDataWs.ws = new WebSocket(wsUrl);
      
      this.userDataWs.ws.on('open', () => {
        this.logger.info('User data WebSocket connected');
        this.userDataWs.isConnecting = false;
        this.userDataWs.reconnectAttempts = 0;
        
        // Start ping/pong
        this.startPingPong(this.userDataWs);
      });
      
      this.userDataWs.ws.on('message', (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleUserDataMessage(message);
        } catch (error) {
          this.logger.error('Failed to parse user data message:', error);
        }
      });
      
      this.userDataWs.ws.on('error', (error) => {
        this.logger.error('User data WebSocket error:', error);
        this.emitError(error);
      });
      
      this.userDataWs.ws.on('close', (code, reason) => {
        this.logger.warn(`User data WebSocket closed: ${code} ${reason}`);
        this.userDataWs.isConnecting = false;
        this.scheduleReconnect(this.userDataWs, this.connectUserDataStream.bind(this));
      });
      
      this.userDataWs.ws.on('pong', () => {
        this.userDataWs.lastPingTime = Date.now();
      });
      
    } catch (error) {
      this.userDataWs.isConnecting = false;
      this.logger.error('Failed to connect user data WebSocket:', error);
      this.scheduleReconnect(this.userDataWs, this.connectUserDataStream.bind(this));
    }
  }

  private subscribeToStream(stream: string): void {
    if (!this.marketDataWs.ws || this.marketDataWs.ws.readyState !== WebSocket.OPEN) {
      this.logger.warn(`Cannot subscribe to ${stream}: WebSocket not connected`);
      return;
    }

    const subscribeMessage = {
      method: 'SUBSCRIBE',
      params: [stream],
      id: Date.now()
    };

    this.marketDataWs.ws.send(JSON.stringify(subscribeMessage));
    this.logger.debug(`Subscribed to stream: ${stream}`);
  }

  private unsubscribeFromStream(stream: string): void {
    if (!this.marketDataWs.ws || this.marketDataWs.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const unsubscribeMessage = {
      method: 'UNSUBSCRIBE', 
      params: [stream],
      id: Date.now()
    };

    this.marketDataWs.ws.send(JSON.stringify(unsubscribeMessage));
    this.logger.debug(`Unsubscribed from stream: ${stream}`);
  }

  private resubscribeMarketData(): void {
    // Re-subscribe to all active subscriptions
    this.orderBookSubscriptions.forEach(symbol => {
      this.subscribeToStream(`${symbol.toLowerCase()}@depth@100ms`);
    });

    this.tradeSubscriptions.forEach(symbol => {
      this.subscribeToStream(`${symbol.toLowerCase()}@trade`);
    });
  }

  private startPingPong(connection: WebSocketConnection): void {
    const pingInterval = setInterval(() => {
      if (connection.ws && connection.ws.readyState === WebSocket.OPEN) {
        connection.ws.ping();
        
        // Check if pong was received within timeout
        setTimeout(() => {
          if (Date.now() - connection.lastPingTime > 10000) {
            this.logger.warn(`${connection.streamName} WebSocket ping timeout`);
            if (connection.ws) {
              connection.ws.terminate();
            }
          }
        }, 10000);
      } else {
        clearInterval(pingInterval);
      }
    }, 3 * 60 * 1000); // Ping every 3 minutes
  }

  private scheduleReconnect(connection: WebSocketConnection, reconnectFn: () => Promise<void>): void {
    if (connection.reconnectAttempts >= connection.maxReconnectAttempts) {
      this.logger.error(`Max reconnect attempts reached for ${connection.streamName}`);
      return;
    }

    connection.reconnectAttempts++;
    const delay = Math.min(connection.reconnectDelay * Math.pow(2, connection.reconnectAttempts), 30000);
    
    this.logger.info(`Scheduling ${connection.streamName} reconnect in ${delay}ms (attempt ${connection.reconnectAttempts})`);
    
    setTimeout(async () => {
      if (this.connected) {
        try {
          await reconnectFn();
        } catch (error) {
          this.logger.error(`Reconnect failed for ${connection.streamName}:`, error);
        }
      }
    }, delay);
  }

  private handleMarketDataMessage(message: any): void {
    if (message.stream && message.data) {
      const { stream, data } = message;
      
      if (stream.includes('@depth')) {
        this.handleDepthUpdate(data);
      } else if (stream.includes('@trade')) {
        this.handleTradeUpdate(data);
      }
    } else if (message.result === null && message.id) {
      // Subscription confirmation
      this.logger.debug('Subscription confirmed:', message.id);
    }
  }

  private handleDepthUpdate(data: any): void {
    try {
      // Keep adapter emitting arrays, StoikovBot will normalize to objects
      const orderBook = {
        symbol: data.s,
        bids: data.b.map((bid: [string, string]) => [parseFloat(bid[0]), parseFloat(bid[1])]),
        asks: data.a.map((ask: [string, string]) => [parseFloat(ask[0]), parseFloat(ask[1])]),
        sequence: data.u,
        timestamp: data.E
      };

      this.emit('orderBook', orderBook as any);
    } catch (error) {
      this.logger.error('Failed to process depth update:', error);
    }
  }

  private handleTradeUpdate(data: any): void {
    try {
      const trade: MarketData = {
        symbol: data.s,
        exchange: this.getName(),
        price: parseFloat(data.p),
        volume: parseFloat(data.q),
        timestamp: data.T,
        bid: 0, // Will be filled from orderbook
        ask: 0, // Will be filled from orderbook
        spread: 0
      };

      this.emitTrade(trade);
    } catch (error) {
      this.logger.error('Failed to process trade update:', error);
    }
  }

  private handleUserDataMessage(message: any): void {
    const { e: eventType } = message;
    
    switch (eventType) {
      case 'ORDER_TRADE_UPDATE':
        this.handleOrderUpdate(message.o);
        break;
      case 'ACCOUNT_UPDATE':
        this.handleAccountUpdate(message.a);
        break;
      case 'ACCOUNT_CONFIG_UPDATE':
        this.handleAccountConfigUpdate(message.ac);
        break;
      default:
        this.logger.debug('Unknown user data event:', eventType);
    }
  }

  private handleOrderUpdate(orderData: any): void {
    try {
      const order: Order = {
        id: orderData.i.toString(),
        symbol: orderData.s,
        exchange: this.getName(),
        side: orderData.S.toLowerCase() as 'buy' | 'sell',
        type: orderData.o.toLowerCase() as 'market' | 'limit',
        amount: parseFloat(orderData.q),
        price: parseFloat(orderData.p),
        status: this.mapOrderStatus(orderData.X),
        timestamp: orderData.T,
        filled: parseFloat(orderData.z)
      };

      this.emitOrderUpdate(order);
    } catch (error) {
      this.logger.error('Failed to process order update:', error);
    }
  }

  private handleAccountUpdate(accountData: any): void {
    // Handle balance and position updates
    if (accountData.B) {
      // Balance updates
      this.logger.debug('Balance update received');
    }
    
    if (accountData.P) {
      // Position updates
      this.logger.debug('Position update received');
    }
  }

  private handleAccountConfigUpdate(configData: any): void {
    this.logger.debug('Account config update received');
  }

  private mapOrderStatus(binanceStatus: string): Order['status'] {
    switch (binanceStatus) {
      case 'NEW':
        return 'open';
      case 'FILLED':
        return 'filled';
      case 'PARTIALLY_FILLED':
        return 'open';
      case 'CANCELED':
      case 'REJECTED':
        return 'cancelled';
      case 'EXPIRED':
        return 'cancelled';
      default:
        return 'pending';
    }
  }

  private reconnectUserDataStream(): void {
    if (this.userDataWs.ws) {
      this.userDataWs.ws.close();
      this.userDataWs.ws = null;
    }
    
    setTimeout(() => {
      this.connectUserDataStream();
    }, 1000);
  }
}
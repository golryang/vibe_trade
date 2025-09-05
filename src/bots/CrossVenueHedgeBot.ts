import { BaseBot } from '../core/BaseBot';
import { BaseExchange } from '../exchanges/BaseExchange';
import { BotConfig, OrderBook, Order, Position, MarketData } from '../types';

interface ArbitrageOpportunity {
  symbol: string;
  buyExchange: string;
  sellExchange: string;
  buyPrice: number;
  sellPrice: number;
  spread: number;
  spreadPercent: number;
  maxSize: number;
}

interface CrossVenueConfig extends BotConfig {
  parameters: {
    minSpreadPercent: number;
    maxPositionSize: number;
    hedgeThreshold: number;
    rebalanceInterval: number;
    exchanges: string[];
  };
}

export class CrossVenueHedgeBot extends BaseBot {
  private exchanges: Map<string, BaseExchange> = new Map();
  private orderBooks: Map<string, OrderBook> = new Map();
  private positions: Map<string, Position[]> = new Map();
  private activeOrders: Map<string, Order[]> = new Map();
  private lastRebalanceTime: number = 0;

  constructor(config: CrossVenueConfig, exchanges: BaseExchange[]) {
    super(config);
    
    exchanges.forEach(exchange => {
      this.exchanges.set(exchange.getName(), exchange);
      this.setupExchangeListeners(exchange);
    });
  }

  protected async initialize(): Promise<void> {
    this.logger.info('Initializing Cross-Venue Hedge Market Making Bot');

    for (const [name, exchange] of this.exchanges) {
      if (!exchange.isConnected()) {
        await exchange.connect();
      }

      for (const symbol of this.config.symbols) {
        await exchange.subscribeToOrderBook(symbol);
        await exchange.subscribeToTrades(symbol);
      }

      const positions = await exchange.getPositions();
      this.positions.set(name, positions);

      const orders = await exchange.getOpenOrders();
      this.activeOrders.set(name, orders);
    }

    this.startMarketMaking();
  }

  protected async cleanup(): Promise<void> {
    this.logger.info('Cleaning up Cross-Venue Hedge Bot');

    for (const [name, exchange] of this.exchanges) {
      const orders = this.activeOrders.get(name) || [];
      
      for (const order of orders) {
        try {
          await exchange.cancelOrder(order.id, order.symbol);
        } catch (error) {
          this.logger.warn(`Failed to cancel order ${order.id} on ${name}:`, error);
        }
      }

      for (const symbol of this.config.symbols) {
        await exchange.unsubscribeFromOrderBook(symbol);
        await exchange.unsubscribeFromTrades(symbol);
      }
    }
  }

  protected onMarketData(data: MarketData): void {
    // Market data is handled through orderbook updates
  }

  protected onOrderUpdate(order: Order): void {
    this.updateActiveOrders(order);
    this.checkRebalanceNeeded();
  }

  protected onPositionUpdate(position: Position): void {
    const exchangePositions = this.positions.get(position.exchange) || [];
    const index = exchangePositions.findIndex(p => p.symbol === position.symbol);
    
    if (index >= 0) {
      exchangePositions[index] = position;
    } else {
      exchangePositions.push(position);
    }
    
    this.positions.set(position.exchange, exchangePositions);
    this.checkRebalanceNeeded();
  }

  protected onConfigUpdate(config: Partial<BotConfig>): void {
    this.logger.info('Configuration updated, adjusting strategy parameters');
  }

  private setupExchangeListeners(exchange: BaseExchange): void {
    exchange.on('orderBook', (orderBook: OrderBook) => {
      const key = `${orderBook.exchange}-${orderBook.symbol}`;
      this.orderBooks.set(key, orderBook);
      this.evaluateArbitrageOpportunities(orderBook.symbol);
    });

    exchange.on('orderUpdate', (order: Order) => {
      this.onOrderUpdate(order);
    });

    exchange.on('error', (error: Error) => {
      this.logger.error(`Exchange ${exchange.getName()} error:`, error);
    });
  }

  private startMarketMaking(): void {
    const config = this.config as CrossVenueConfig;
    
    setInterval(() => {
      this.evaluateAllOpportunities();
    }, 1000);

    setInterval(() => {
      this.rebalancePositions();
    }, config.parameters.rebalanceInterval || 30000);
  }

  private evaluateAllOpportunities(): void {
    for (const symbol of this.config.symbols) {
      this.evaluateArbitrageOpportunities(symbol);
    }
  }

  private evaluateArbitrageOpportunities(symbol: string): void {
    const opportunities = this.findArbitrageOpportunities(symbol);
    
    for (const opportunity of opportunities) {
      this.executeArbitrage(opportunity);
    }
  }

  private findArbitrageOpportunities(symbol: string): ArbitrageOpportunity[] {
    const opportunities: ArbitrageOpportunity[] = [];
    const config = this.config as CrossVenueConfig;
    const exchanges = Array.from(this.exchanges.keys());

    for (let i = 0; i < exchanges.length; i++) {
      for (let j = i + 1; j < exchanges.length; j++) {
        const exchange1 = exchanges[i];
        const exchange2 = exchanges[j];

        const orderBook1 = this.orderBooks.get(`${exchange1}-${symbol}`);
        const orderBook2 = this.orderBooks.get(`${exchange2}-${symbol}`);

        if (!orderBook1 || !orderBook2) continue;

        const opportunity1 = this.calculateOpportunity(
          symbol, exchange1, exchange2, orderBook1, orderBook2
        );
        const opportunity2 = this.calculateOpportunity(
          symbol, exchange2, exchange1, orderBook2, orderBook1
        );

        if (opportunity1 && opportunity1.spreadPercent >= config.parameters.minSpreadPercent) {
          opportunities.push(opportunity1);
        }
        if (opportunity2 && opportunity2.spreadPercent >= config.parameters.minSpreadPercent) {
          opportunities.push(opportunity2);
        }
      }
    }

    return opportunities.sort((a, b) => b.spreadPercent - a.spreadPercent);
  }

  private calculateOpportunity(
    symbol: string,
    buyExchange: string,
    sellExchange: string,
    buyOrderBook: OrderBook,
    sellOrderBook: OrderBook
  ): ArbitrageOpportunity | null {
    if (!buyOrderBook.asks[0] || !sellOrderBook.bids[0]) return null;

    const buyPrice = buyOrderBook.asks[0][0];
    const sellPrice = sellOrderBook.bids[0][0];
    const spread = sellPrice - buyPrice;
    const spreadPercent = (spread / buyPrice) * 100;

    if (spread <= 0) return null;

    const buySize = buyOrderBook.asks[0][1];
    const sellSize = sellOrderBook.bids[0][1];
    const maxSize = Math.min(buySize, sellSize);

    return {
      symbol,
      buyExchange,
      sellExchange,
      buyPrice,
      sellPrice,
      spread,
      spreadPercent,
      maxSize
    };
  }

  private async executeArbitrage(opportunity: ArbitrageOpportunity): Promise<void> {
    const config = this.config as CrossVenueConfig;
    const size = Math.min(opportunity.maxSize, config.parameters.maxPositionSize);

    if (size <= 0) return;

    try {
      const buyExchange = this.exchanges.get(opportunity.buyExchange);
      const sellExchange = this.exchanges.get(opportunity.sellExchange);

      if (!buyExchange || !sellExchange) return;

      const [buyOrder, sellOrder] = await Promise.all([
        buyExchange.placeOrder({
          symbol: opportunity.symbol,
          side: 'buy',
          type: 'limit',
          amount: size,
          price: opportunity.buyPrice,
          exchange: opportunity.buyExchange
        }),
        sellExchange.placeOrder({
          symbol: opportunity.symbol,
          side: 'sell',
          type: 'limit',
          amount: size,
          price: opportunity.sellPrice,
          exchange: opportunity.sellExchange
        })
      ]);

      this.logger.info(`Executed arbitrage for ${opportunity.symbol}:`, {
        spread: opportunity.spreadPercent.toFixed(4) + '%',
        size,
        buyPrice: opportunity.buyPrice,
        sellPrice: opportunity.sellPrice,
        buyExchange: opportunity.buyExchange,
        sellExchange: opportunity.sellExchange
      });

      this.metrics.totalTrades += 2;

    } catch (error) {
      this.logger.error('Failed to execute arbitrage:', error);
    }
  }

  private updateActiveOrders(order: Order): void {
    const orders = this.activeOrders.get(order.exchange) || [];
    const index = orders.findIndex(o => o.id === order.id);

    if (order.status === 'filled' || order.status === 'cancelled') {
      if (index >= 0) orders.splice(index, 1);
    } else {
      if (index >= 0) {
        orders[index] = order;
      } else {
        orders.push(order);
      }
    }

    this.activeOrders.set(order.exchange, orders);
  }

  private checkRebalanceNeeded(): void {
    const config = this.config as CrossVenueConfig;
    const now = Date.now();

    if (now - this.lastRebalanceTime > config.parameters.rebalanceInterval) {
      this.rebalancePositions();
    }
  }

  private async rebalancePositions(): Promise<void> {
    this.lastRebalanceTime = Date.now();
    const config = this.config as CrossVenueConfig;

    for (const symbol of this.config.symbols) {
      const totalPosition = this.getTotalPosition(symbol);
      
      if (Math.abs(totalPosition) > config.parameters.hedgeThreshold) {
        await this.hedgePosition(symbol, totalPosition);
      }
    }
  }

  private getTotalPosition(symbol: string): number {
    let total = 0;
    
    for (const positions of this.positions.values()) {
      const position = positions.find(p => p.symbol === symbol);
      if (position) {
        total += position.side === 'long' ? position.size : -position.size;
      }
    }
    
    return total;
  }

  private async hedgePosition(symbol: string, totalPosition: number): Promise<void> {
    if (totalPosition === 0) return;

    const hedgeSize = Math.abs(totalPosition);
    const hedgeSide = totalPosition > 0 ? 'sell' : 'buy';
    
    const exchanges = Array.from(this.exchanges.keys());
    const targetExchange = exchanges[0];
    const exchange = this.exchanges.get(targetExchange);

    if (!exchange) return;

    try {
      await exchange.placeOrder({
        symbol,
        side: hedgeSide,
        type: 'market',
        amount: hedgeSize,
        exchange: targetExchange
      });

      this.logger.info(`Hedged position for ${symbol}:`, {
        size: hedgeSize,
        side: hedgeSide,
        exchange: targetExchange
      });

    } catch (error) {
      this.logger.error(`Failed to hedge position for ${symbol}:`, error);
    }
  }
}
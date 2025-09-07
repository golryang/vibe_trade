import { EventEmitter } from 'events';
import { Logger } from '../core/Logger';
import winston from 'winston';

export interface StoikovParams {
  // Core Stoikov parameters
  gamma: number;           // Risk aversion {0.3, 0.6, 1.0, 1.2}
  volatilityWindow: number; // EWMA window {5s, 30s, 5m} in ms
  intensityWindow: number;  // Intensity calculation window {60s} in ms
  maxInventoryPct: number; // |q|max as % of NAV {2%, 5%, 10%}
  
  // Orderbook/execution parameters  
  obiWeight: number;       // OBI weighting {0, ±w}
  micropriceBias: boolean; // Enable microprice bias
  topNDepth: number;       // Top-N depth {5, 10}
  
  // Execution parameters
  postOnlyOffset: number;  // Offset in ticks {±1, ±2, ±3}
  ttlMs: number;          // Time to live {300, 800, 1200, 2000}ms
  repostMs: number;       // Repost interval {100, 200, 300}ms
  ladderLevels: number;   // Ladder levels {1, 2, 3}
  alphaSizeRatio: number; // Initial size ratio {0.6, 0.8, 1.0}
  
  // Risk cutoffs
  driftCutBps: number;    // Drift cut {3, 5, 8}bp
  sessionDDLimitPct: number; // Session DD limit {0.3, 0.5, 1.0}% NAV
  maxConsecutiveFails: number; // Max consecutive fails {5, 10, 20}
  
  // Regime scaling
  timezoneProfile: 'asia' | 'eu' | 'us' | 'global';
  volRegimeScaler: number; // Volatility regime spread scaler
}

export interface MarketState {
  mid: number;
  microprice: number;
  spread: number;
  volatility: number;     // σ_t
  intensity: number;      // k_t (λ)
  obi: number;           // Order book imbalance
  topBidDepth: number;
  topAskDepth: number;
  timestamp: number;
}

export interface InventoryState {
  position: number;       // q_t (current inventory)
  navPct: number;        // Position as % of NAV
  entryPrice: number;
  unrealizedPnl: number;
  drift: number;         // Price drift since entry (bp)
}

export interface StoikovQuotes {
  reservationPrice: number;  // r_t
  halfSpread: number;        // δ_t  
  bidPrice: number;          // r_t - δ_t
  askPrice: number;          // r_t + δ_t
  bidSize: number;
  askSize: number;
  skewFactor: number;        // Inventory skew adjustment
  regimeAdjustment: number;  // Volatility regime adjustment
  timestamp: number;
}

export class StoikovEngine extends EventEmitter {
  private params: StoikovParams;
  private logger: winston.Logger;
  
  // Market data buffers for calculations
  private priceHistory: Array<{price: number, timestamp: number}> = [];
  private tradeHistory: Array<{price: number, size: number, side: 'buy' | 'sell', timestamp: number}> = [];
  private volatilityBuffer: number[] = [];
  private intensityBuffer: number[] = [];
  
  // Current state
  private currentMarketState: MarketState | null = null;
  private currentInventory: InventoryState | null = null;
  private lastQuotes: StoikovQuotes | null = null;

  constructor(params: StoikovParams) {
    super();
    this.params = params;
    this.logger = Logger.getInstance().child({ module: 'StoikovEngine' });
    
    this.validateParams();
    this.logger.info('Stoikov engine initialized', { params: this.params });
  }

  private validateParams(): void {
    const { gamma, volatilityWindow, maxInventoryPct, ttlMs, repostMs } = this.params;
    
    if (gamma <= 0 || gamma > 5) {
      throw new Error(`Invalid gamma: ${gamma}. Must be > 0 and <= 5`);
    }
    
    if (volatilityWindow < 1000 || volatilityWindow > 600000) {
      throw new Error(`Invalid volatility window: ${volatilityWindow}ms. Must be 1s-10m`);
    }
    
    if (maxInventoryPct <= 0 || maxInventoryPct > 50) {
      throw new Error(`Invalid max inventory: ${maxInventoryPct}%. Must be 0-50%`);
    }
    
    if (ttlMs < 100 || ttlMs > 5000) {
      throw new Error(`Invalid TTL: ${ttlMs}ms. Must be 100ms-5s`);
    }
    
    if (repostMs < 50 || repostMs > 1000) {
      throw new Error(`Invalid repost interval: ${repostMs}ms. Must be 50ms-1s`);
    }
  }

  public updateMarketState(state: MarketState): void {
    this.currentMarketState = state;
    
    // Update price history for volatility calculation
    this.priceHistory.push({ price: state.mid, timestamp: state.timestamp });
    this.cleanOldData(this.priceHistory, this.params.volatilityWindow);
    
    // Calculate and update volatility
    this.updateVolatility();
    
    // Emit updated state
    this.emit('marketStateUpdated', state);
  }

  public updateInventory(inventory: InventoryState): void {
    this.currentInventory = inventory;
    this.emit('inventoryUpdated', inventory);
  }

  public addTrade(price: number, size: number, side: 'buy' | 'sell', timestamp: number): void {
    this.tradeHistory.push({ price, size, side, timestamp });
    this.cleanOldData(this.tradeHistory, this.params.intensityWindow);
    
    // Update intensity (λ)
    this.updateIntensity();
  }

  private updateVolatility(): void {
    if (this.priceHistory.length < 2) return;

    const returns: number[] = [];
    for (let i = 1; i < this.priceHistory.length; i++) {
      const ret = Math.log(this.priceHistory[i].price / this.priceHistory[i-1].price);
      returns.push(ret * ret); // Squared returns for variance
    }

    if (returns.length === 0) return;

    // EWMA calculation
    const alpha = 2 / (this.params.volatilityWindow / 1000 + 1); // Convert to seconds
    let ewmaVar = returns[0];
    
    for (let i = 1; i < returns.length; i++) {
      ewmaVar = alpha * returns[i] + (1 - alpha) * ewmaVar;
    }

    const volatility = Math.sqrt(ewmaVar * Math.sqrt(252 * 24 * 60 * 60)); // Annualized
    
    if (this.currentMarketState) {
      this.currentMarketState.volatility = volatility;
    }
  }

  private updateIntensity(): void {
    if (this.tradeHistory.length === 0) return;

    const now = Date.now();
    const windowStart = now - this.params.intensityWindow;
    const recentTrades = this.tradeHistory.filter(t => t.timestamp >= windowStart);
    
    // Calculate trade arrival intensity (λ)
    const tradeCount = recentTrades.length;
    const windowSeconds = this.params.intensityWindow / 1000;
    const intensity = tradeCount / windowSeconds;
    
    if (this.currentMarketState) {
      this.currentMarketState.intensity = intensity;
    }
  }

  public calculateQuotes(): StoikovQuotes | null {
    if (!this.currentMarketState || !this.currentInventory) {
      return null;
    }

    const market = this.currentMarketState;
    const inventory = this.currentInventory;

    // Calculate reservation price (r_t)
    const reservationPrice = this.calculateReservationPrice(market, inventory);
    
    // Calculate optimal half-spread (δ_t)
    const halfSpread = this.calculateOptimalSpread(market, inventory);
    
    // Apply inventory skew
    const skewFactor = this.calculateInventorySkew(inventory);
    
    // Apply regime adjustment
    const regimeAdjustment = this.calculateRegimeAdjustment(market);
    
    // Final spread with adjustments
    const adjustedHalfSpread = halfSpread * regimeAdjustment;
    
    // Calculate bid/ask prices
    const skewedReservationPrice = reservationPrice + skewFactor;
    const bidPrice = skewedReservationPrice - adjustedHalfSpread;
    const askPrice = skewedReservationPrice + adjustedHalfSpread;
    
    // Calculate order sizes
    const { bidSize, askSize } = this.calculateOrderSizes(market, inventory);

    const quotes: StoikovQuotes = {
      reservationPrice: skewedReservationPrice,
      halfSpread: adjustedHalfSpread,
      bidPrice,
      askPrice,
      bidSize,
      askSize,
      skewFactor,
      regimeAdjustment,
      timestamp: Date.now()
    };

    this.lastQuotes = quotes;
    this.emit('quotesCalculated', quotes);
    
    return quotes;
  }

  private calculateReservationPrice(market: MarketState, inventory: InventoryState): number {
    // Base reservation price with microprice bias
    let reservationPrice = market.mid;
    
    if (this.params.micropriceBias) {
      reservationPrice = market.microprice;
    }
    
    // Adjust for inventory (Stoikov formula component)
    const inventoryAdjustment = -this.params.gamma * market.volatility * market.volatility * inventory.position;
    reservationPrice += inventoryAdjustment;
    
    return reservationPrice;
  }

  private calculateOptimalSpread(market: MarketState, inventory: InventoryState): number {
    const { gamma, volatilityWindow } = this.params;
    const { volatility, intensity } = market;
    
    // Classic Stoikov optimal spread formula
    // δ_t = γσ²/2k + ln(1 + γ/k)/γ
    
    const k = Math.max(intensity, 0.1); // Avoid division by zero
    const term1 = (gamma * volatility * volatility) / (2 * k);
    const term2 = Math.log(1 + gamma / k) / gamma;
    
    let optimalSpread = term1 + term2;
    
    // Apply minimum spread based on tick size and market spread
    const minSpread = Math.max(
      market.spread * 0.3, // At least 30% of market spread
      this.params.postOnlyOffset * 0.0001 // Minimum based on offset
    );
    
    optimalSpread = Math.max(optimalSpread, minSpread);
    
    return optimalSpread / 2; // Return half-spread
  }

  private calculateInventorySkew(inventory: InventoryState): number {
    if (!inventory.position) return 0;
    
    // Inventory-based skew (shift reservation price)
    const maxInventory = this.params.maxInventoryPct / 100;
    const inventoryRatio = inventory.navPct / 100 / maxInventory;
    
    // Exponential skew function
    const skewIntensity = 2.0; // How aggressively to skew
    const skew = -Math.tanh(inventoryRatio * skewIntensity) * 0.001; // Max 10bp skew
    
    return skew * inventory.position > 0 ? 1 : -1; // Direction based on position sign
  }

  private calculateRegimeAdjustment(market: MarketState): number {
    const { volRegimeScaler, timezoneProfile } = this.params;
    
    // Volatility regime adjustment
    const avgVolatility = 0.3; // Historical average (should be dynamic)
    const volRatio = market.volatility / avgVolatility;
    let regimeMultiplier = 1.0 + (volRatio - 1.0) * volRegimeScaler;
    
    // Timezone adjustment
    const timezoneMultiplier = this.getTimezoneMultiplier(timezoneProfile);
    
    return regimeMultiplier * timezoneMultiplier;
  }

  private getTimezoneMultiplier(profile: string): number {
    const hour = new Date().getUTCHours();
    
    switch (profile) {
      case 'asia':
        // Active during Asian hours (UTC 0-8)
        return (hour >= 0 && hour <= 8) ? 1.0 : 1.2;
      case 'eu':  
        // Active during European hours (UTC 7-16)
        return (hour >= 7 && hour <= 16) ? 1.0 : 1.2;
      case 'us':
        // Active during US hours (UTC 13-22)
        return (hour >= 13 && hour <= 22) ? 1.0 : 1.2;
      default:
        return 1.0;
    }
  }

  private calculateOrderSizes(market: MarketState, inventory: InventoryState): { bidSize: number, askSize: number } {
    const { alphaSizeRatio, ladderLevels, maxInventoryPct } = this.params;
    
    // Base size calculation
    const baseSize = 100 * alphaSizeRatio; // Base in quote currency
    
    // Adjust size based on inventory
    const maxInventory = maxInventoryPct / 100;
    const inventoryRatio = Math.abs(inventory.navPct / 100) / maxInventory;
    const sizeMultiplier = Math.max(0.1, 1.0 - inventoryRatio * 0.5); // Reduce size as inventory grows
    
    let bidSize = baseSize * sizeMultiplier;
    let askSize = baseSize * sizeMultiplier;
    
    // Skew sizes based on inventory
    if (inventory.position > 0) {
      // Long inventory - prefer selling
      bidSize *= 0.7;
      askSize *= 1.3;
    } else if (inventory.position < 0) {
      // Short inventory - prefer buying  
      bidSize *= 1.3;
      askSize *= 0.7;
    }
    
    // Apply ladder levels (split orders if > 1)
    bidSize /= ladderLevels;
    askSize /= ladderLevels;
    
    return { bidSize, askSize };
  }

  private cleanOldData<T extends { timestamp: number }>(buffer: T[], windowMs: number): void {
    const cutoffTime = Date.now() - windowMs;
    const startIndex = buffer.findIndex(item => item.timestamp >= cutoffTime);
    
    if (startIndex > 0) {
      buffer.splice(0, startIndex);
    }
  }

  public getLastQuotes(): StoikovQuotes | null {
    return this.lastQuotes;
  }

  public getParams(): StoikovParams {
    return { ...this.params };
  }

  public updateParams(updates: Partial<StoikovParams>): void {
    this.params = { ...this.params, ...updates };
    this.validateParams();
    this.logger.info('Stoikov parameters updated', { updates });
    this.emit('paramsUpdated', this.params);
  }

  public getMarketState(): MarketState | null {
    return this.currentMarketState;
  }

  public getInventoryState(): InventoryState | null {
    return this.currentInventory;
  }

  public calculateKPIs(): any {
    if (!this.currentMarketState || !this.currentInventory || !this.lastQuotes) {
      return null;
    }

    const market = this.currentMarketState;
    const inventory = this.currentInventory;
    const quotes = this.lastQuotes;

    return {
      effectiveSpreadBps: (quotes.askPrice - quotes.bidPrice) / market.mid * 10000,
      inventoryRatio: Math.abs(inventory.navPct / 100) / (this.params.maxInventoryPct / 100),
      driftBps: Math.abs(inventory.drift),
      volatilityPct: market.volatility * 100,
      intensityPerSec: market.intensity,
      skewBps: Math.abs(quotes.skewFactor) * 10000,
      regimeMultiplier: quotes.regimeAdjustment,
      riskUtilization: Math.abs(inventory.navPct / 100) / (this.params.maxInventoryPct / 100)
    };
  }
}
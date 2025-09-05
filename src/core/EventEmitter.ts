import { EventEmitter as NodeEventEmitter } from 'events';

export class EventBus extends NodeEventEmitter {
  private static instance: EventBus;

  private constructor() {
    super();
    this.setMaxListeners(100);
  }

  static getInstance(): EventBus {
    if (!EventBus.instance) {
      EventBus.instance = new EventBus();
    }
    return EventBus.instance;
  }

  emitMarketData(data: any): void {
    this.emit('marketData', data);
  }

  emitOrderUpdate(data: any): void {
    this.emit('orderUpdate', data);
  }

  emitPositionUpdate(data: any): void {
    this.emit('positionUpdate', data);
  }

  emitBotStatusChange(data: any): void {
    this.emit('botStatusChange', data);
  }

  emitError(error: Error, context?: string): void {
    this.emit('error', { error, context, timestamp: Date.now() });
  }
}
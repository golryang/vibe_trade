import winston from 'winston';
import { LogLevel } from '../types';

export class Logger {
  private static instance: winston.Logger;

  static getInstance(): winston.Logger {
    if (!Logger.instance) {
      Logger.instance = winston.createLogger({
        level: process.env.LOG_LEVEL || 'info',
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.errors({ stack: true }),
          winston.format.json(),
          winston.format.colorize({ all: true })
        ),
        defaultMeta: { service: 'vibe-trade' },
        transports: [
          new winston.transports.File({ 
            filename: 'logs/error.log', 
            level: 'error',
            maxsize: 10485760, // 10MB
            maxFiles: 5
          }),
          new winston.transports.File({ 
            filename: 'logs/combined.log',
            maxsize: 10485760, // 10MB
            maxFiles: 5
          }),
          new winston.transports.Console({
            format: winston.format.combine(
              winston.format.colorize(),
              winston.format.simple()
            )
          })
        ]
      });
    }
    return Logger.instance;
  }

  static createBotLogger(botId: string): winston.Logger {
    return Logger.getInstance().child({ botId });
  }
}
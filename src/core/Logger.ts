import winston from 'winston';
import { LogLevel } from '../types';

export class Logger {
  private static instance: winston.Logger;

  static getInstance(): winston.Logger {
    if (!Logger.instance) {
      const isSilent = (process.env.LOG_LEVEL || '').toLowerCase() === 'silent' || process.env.DISABLE_LOGS === '1';

      if (isSilent) {
        Logger.instance = winston.createLogger({
          level: 'silent',
          silent: true,
          transports: []
        });
      } else {
        const SPLAT = Symbol.for('splat');

        const truncate = (input: string, max = 400): string => {
          if (!input) return '';
          return input.length > max ? input.slice(0, max) + '…' : input;
        };

        const sanitizeAxios = (err: any) => ({
          name: err?.name || 'AxiosError',
          message: truncate(String(err?.message || '')),
          code: err?.code,
          status: err?.response?.status,
          statusText: err?.response?.statusText,
          method: err?.config?.method,
          url: err?.config?.url || err?.config?.baseURL,
          data: err?.response?.data && typeof err.response.data === 'object' 
            ? { code: err.response.data.code, msg: truncate(String(err.response.data.msg || '')) }
            : undefined
        });

        const errorSanitizer = winston.format((info) => {
          const splat = (info as any)[SPLAT];
          if (Array.isArray(splat) && splat.length > 0) {
            (info as any)[SPLAT] = splat.map((v: any) => {
              if (v && v.isAxiosError) return sanitizeAxios(v);
              if (v instanceof Error) return { name: v.name, message: truncate(v.message), stack: truncate(String(v.stack || ''), 400) };
              if (typeof v === 'object') return undefined; // drop bulky objects
              return v;
            }).filter((v: any) => v !== undefined);
          }
          if ((info as any).isAxiosError) {
            Object.assign(info, sanitizeAxios(info));
            info.message = truncate(String(info.message || ''));
          }
          if (info.stack) info.stack = truncate(String(info.stack), 400);
          return info;
        });

        Logger.instance = winston.createLogger({
          level: process.env.LOG_LEVEL || 'info',
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.errors({ stack: true }),
            errorSanitizer(),
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
    }
    return Logger.instance;
  }

  static createBotLogger(botId: string): winston.Logger {
    return Logger.getInstance().child({ botId });
  }
}
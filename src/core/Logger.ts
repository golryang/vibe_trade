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
          // Drop bulky axios fields if present at root
          delete (info as any).config;
          delete (info as any).request;
          delete (info as any).response;
          if ((info as any).stack) (info as any).stack = truncate(String((info as any).stack), 400);
          return info;
        });

        const dropHeavy = winston.format((info) => {
          delete (info as any).config;
          delete (info as any).request;
          delete (info as any).response;
          return info;
        });

        const conciseConsole = winston.format.printf((info) => {
          const ts = info.timestamp;
          const lvl = info.level;
          const msg = typeof info.message === 'string' ? info.message : JSON.stringify(info.message);
          const parts: string[] = [];
          const code = (info as any).code ?? (info as any).data?.code;
          const status = (info as any).status;
          const statusText = (info as any).statusText;
          const apiMsg = (info as any).data?.msg;
          const method = (info as any).method;
          const url = (info as any).url;
          if (code !== undefined) parts.push(`code=${code}`);
          if (status !== undefined) parts.push(`status=${status}`);
          if (statusText) parts.push(`statusText=${statusText}`);
          if (apiMsg) parts.push(`msg=${apiMsg}`);
          if (method) parts.push(`method=${String(method).toUpperCase()}`);
          if (url) parts.push(`url=${url}`);
          return `${ts} ${lvl}: ${msg}${parts.length ? ' ' + parts.join(' ') : ''}`;
        });

        Logger.instance = winston.createLogger({
          level: process.env.LOG_LEVEL || 'info',
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.errors({ stack: true }),
            errorSanitizer(),
            dropHeavy(),
            winston.format.json()
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
                winston.format.timestamp(),
                errorSanitizer(),
                dropHeavy(),
                winston.format.colorize({ all: true }),
                conciseConsole
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
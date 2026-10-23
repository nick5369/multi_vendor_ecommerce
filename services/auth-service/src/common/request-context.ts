import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

const SERVICE = 'auth-service';

export function logJson(level: string, fields: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, service: SERVICE, ...fields }) + '\n');
}

/** Assigns/propagates X-Request-Id and writes one structured access-log line per request. */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.header('x-request-id');
    const requestId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    (req as Request & { requestId: string }).requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      if (req.path === '/health' || req.path === '/metrics') return;
      logJson('info', {
        requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Number(process.hrtime.bigint() - started) / 1e6,
        userId: (req as Request & { user?: { id: string } }).user?.id,
      });
    });
    next();
  }
}

/** Consistent error envelope. Never leaks stack traces or internals. */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request & { requestId?: string }>();
    const res = http.getResponse<Response>();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'Unexpected error';
    let details: unknown;
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse() as string | { message?: string | string[]; error?: string };
      code = typeof body === 'object' && body.error ? body.error.toUpperCase().replace(/\s+/g, '_') : HttpStatus[status];
      if (typeof body === 'string') message = body;
      else if (Array.isArray(body.message)) {
        message = 'Validation failed';
        details = body.message;
      } else message = body.message ?? exception.message;
    } else {
      logJson('error', { requestId: req.requestId, message: exception instanceof Error ? exception.message : 'unknown' });
    }
    res.status(status).json({ error: { code, message, details, requestId: req.requestId } });
  }
}

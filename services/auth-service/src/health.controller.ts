import { Controller, Get, Header, ServiceUnavailableException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { collectDefaultMetrics, register } from 'prom-client';

collectDefaultMetrics();

@Controller()
export class HealthController {
  constructor(@InjectConnection() private readonly db: Connection) {}

  @Get('health')
  async health(): Promise<{ status: string; service: string; db: string }> {
    try {
      await this.db.db!.admin().ping();
    } catch {
      throw new ServiceUnavailableException({ status: 'DOWN', service: 'auth-service', db: 'down' });
    }
    return { status: 'UP', service: 'auth-service', db: 'up' };
  }

  @Get('metrics')
  @Header('Content-Type', register.contentType)
  metrics(): Promise<string> {
    return register.metrics();
  }
}

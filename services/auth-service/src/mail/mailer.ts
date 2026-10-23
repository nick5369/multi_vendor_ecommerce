import { Injectable } from '@nestjs/common';
import { config } from '../config';
import { logJson } from '../common/request-context';

/** Development mail adapter: writes the message to the service log. No real email is ever sent. */
@Injectable()
export class Mailer {
  send(to: string, subject: string, body: string): void {
    if (config.mailMode !== 'log') return;
    logJson('info', { event: 'DEV_MAIL', to, subject, body });
  }
}

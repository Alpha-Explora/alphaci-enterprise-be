import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../../config/app.config';
import { NotificationsRepository } from '../infra/notifications.repository';

export interface NotificationEventInput {
  userId: string;
  projectId?: string | null;
  eventCode: string;
  title: string;
  body: string;
}

@Injectable()
export class NotificationEventsService {
  constructor(
    private readonly repository: NotificationsRepository,
    private readonly configService: ConfigService,
  ) {}

  async record(input: NotificationEventInput): Promise<void> {
    const config = this.configService.getOrThrow<AppConfig>('app');
    if (!config.notifications.enabled) {
      return;
    }

    const preferences = await this.repository.getPreferences(input.userId);
    if (!preferences.inAppEnabled) {
      return;
    }

    await this.repository.createForUser(input);
  }
}

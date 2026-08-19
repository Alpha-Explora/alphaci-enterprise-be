import { Injectable } from '@nestjs/common';

import {
  NotificationsRepository,
  type NotificationPreferences,
  type NotificationsResponse,
} from '../infra/notifications.repository';

@Injectable()
export class NotificationsService {
  constructor(private readonly repository: NotificationsRepository) {}

  listForUser(userId: string): Promise<NotificationsResponse> {
    return this.repository.listForUser(userId);
  }

  markRead(userId: string, id: string): Promise<{ id: string; read: true }> {
    return this.repository.markRead(userId, id);
  }

  getPreferences(userId: string): Promise<NotificationPreferences> {
    return this.repository.getPreferences(userId);
  }

  updatePreferences(
    userId: string,
    input: { inAppEnabled?: boolean; emailEnabled?: boolean },
  ): Promise<NotificationPreferences> {
    return this.repository.updatePreferences(userId, input);
  }
}

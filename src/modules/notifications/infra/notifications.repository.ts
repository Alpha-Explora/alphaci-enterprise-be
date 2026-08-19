import { Injectable, NotFoundException } from '@nestjs/common';

import { DatabaseService } from '../../database/database.service';

export interface NotificationItem {
  id: string;
  title: string;
  body: string;
  eventCode: string;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationsResponse {
  enabled: true;
  items: NotificationItem[];
  unreadCount: number;
}

export interface NotificationPreferences {
  userId: string;
  inAppEnabled: boolean;
  emailEnabled: boolean;
  updatedAt: string;
}

export interface CreateNotificationInput {
  userId: string;
  projectId?: string | null;
  eventCode: string;
  title: string;
  body: string;
}

interface NotificationRow {
  id: string;
  title: string;
  body: string;
  event_code: string;
  read_at: string | Date | null;
  created_at: string | Date;
}

interface NotificationPreferencesRow {
  user_id: string;
  in_app_enabled: boolean;
  email_enabled: boolean;
  updated_at: string | Date;
}

@Injectable()
export class NotificationsRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async listForUser(userId: string): Promise<NotificationsResponse> {
    const result = await this.databaseService.query<NotificationRow>(
      `
        SELECT id, title, body, event_code, read_at, created_at
        FROM notifications.notifications
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 50;
      `,
      [userId],
    );

    const items = result.rows.map((row) => this.toItem(row));
    return {
      enabled: true,
      items,
      unreadCount: items.filter((item) => item.readAt === null).length,
    };
  }

  async markRead(
    userId: string,
    id: string,
  ): Promise<{ id: string; read: true }> {
    const result = await this.databaseService.query<{ id: string }>(
      `
        UPDATE notifications.notifications
        SET read_at = COALESCE(read_at, NOW())
        WHERE id = $1
          AND user_id = $2
        RETURNING id;
      `,
      [id, userId],
    );

    if (!result.rows[0]) {
      throw new NotFoundException('Notification not found');
    }

    return { id: result.rows[0].id, read: true };
  }

  async createForUser(
    input: CreateNotificationInput,
  ): Promise<NotificationItem> {
    const result = await this.databaseService.query<NotificationRow>(
      `
        INSERT INTO notifications.notifications (
          user_id,
          project_id,
          event_code,
          title,
          body
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, title, body, event_code, read_at, created_at;
      `,
      [
        input.userId,
        input.projectId ?? null,
        input.eventCode,
        input.title,
        input.body,
      ],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error('Notification insert did not return a row');
    }
    return this.toItem(row);
  }

  async getPreferences(userId: string): Promise<NotificationPreferences> {
    await this.databaseService.query(
      `
        INSERT INTO notifications.notification_preferences (user_id)
        VALUES ($1)
        ON CONFLICT (user_id) DO NOTHING;
      `,
      [userId],
    );

    const result = await this.databaseService.query<NotificationPreferencesRow>(
      `
        SELECT user_id, in_app_enabled, email_enabled, updated_at
        FROM notifications.notification_preferences
        WHERE user_id = $1;
      `,
      [userId],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error('Notification preferences query did not return a row');
    }
    return this.toPreferences(row);
  }

  async updatePreferences(
    userId: string,
    input: { inAppEnabled?: boolean; emailEnabled?: boolean },
  ): Promise<NotificationPreferences> {
    const current = await this.getPreferences(userId);
    const result = await this.databaseService.query<NotificationPreferencesRow>(
      `
        INSERT INTO notifications.notification_preferences (
          user_id,
          in_app_enabled,
          email_enabled
        )
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id)
        DO UPDATE SET
          in_app_enabled = EXCLUDED.in_app_enabled,
          email_enabled = EXCLUDED.email_enabled,
          updated_at = NOW()
        RETURNING user_id, in_app_enabled, email_enabled, updated_at;
      `,
      [
        userId,
        input.inAppEnabled ?? current.inAppEnabled,
        input.emailEnabled ?? current.emailEnabled,
      ],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error('Notification preferences update did not return a row');
    }
    return this.toPreferences(row);
  }

  private toItem(row: NotificationRow): NotificationItem {
    return {
      id: row.id,
      title: row.title,
      body: row.body,
      eventCode: row.event_code,
      readAt: this.toIsoStringOrNull(row.read_at),
      createdAt: this.toIsoString(row.created_at),
    };
  }

  private toIsoString(value: string | Date): string {
    return value instanceof Date ? value.toISOString() : value;
  }

  private toIsoStringOrNull(value: string | Date | null): string | null {
    return value === null ? null : this.toIsoString(value);
  }

  private toPreferences(
    row: NotificationPreferencesRow,
  ): NotificationPreferences {
    return {
      userId: row.user_id,
      inAppEnabled: row.in_app_enabled,
      emailEnabled: row.email_enabled,
      updatedAt: this.toIsoString(row.updated_at),
    };
  }
}

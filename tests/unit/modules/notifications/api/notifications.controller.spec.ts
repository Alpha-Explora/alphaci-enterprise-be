import { BadRequestException, UnauthorizedException } from '@nestjs/common';

import { NotificationsController } from '../../../../../src/modules/notifications/api/notifications.controller';
import { NotificationsService } from '../../../../../src/modules/notifications/domain/notifications.service';

describe('NotificationsController', () => {
  const makeConfigService = (enabled = true) =>
    ({
      getOrThrow: jest.fn().mockReturnValue({
        notifications: { enabled },
      }),
    }) as never;
  const makeService = () =>
    ({
      listForUser: jest.fn().mockResolvedValue({
        enabled: true,
        items: [
          {
            id: 'notification-1',
            title: 'Workflow update',
            body: 'A workflow update PR was created.',
            eventCode: 'workflow_pr_created',
            readAt: null,
            createdAt: '2026-06-14T00:00:00.000Z',
          },
        ],
        unreadCount: 1,
      }),
      markRead: jest
        .fn()
        .mockResolvedValue({ id: 'notification-1', read: true }),
      getPreferences: jest.fn().mockResolvedValue({
        userId: 'user-1',
        inAppEnabled: true,
        emailEnabled: false,
        updatedAt: '2026-06-15T00:00:00.000Z',
      }),
      updatePreferences: jest.fn().mockResolvedValue({
        userId: 'user-1',
        inAppEnabled: false,
        emailEnabled: false,
        updatedAt: '2026-06-15T00:01:00.000Z',
      }),
    }) as unknown as jest.Mocked<NotificationsService>;

  it('returns persisted notifications for the current user', async () => {
    const service = makeService();
    const controller = new NotificationsController(
      makeConfigService(),
      service,
    );

    await expect(
      controller.list({ session: { user: { id: 'user-1' } } } as never),
    ).resolves.toEqual({
      enabled: true,
      items: [
        {
          id: 'notification-1',
          title: 'Workflow update',
          body: 'A workflow update PR was created.',
          eventCode: 'workflow_pr_created',
          readAt: null,
          createdAt: '2026-06-14T00:00:00.000Z',
        },
      ],
      unreadCount: 1,
    });
    expect(service.listForUser).toHaveBeenCalledWith('user-1');
  });

  it('marks a notification read for an authenticated user', async () => {
    const service = makeService();
    const controller = new NotificationsController(
      makeConfigService(),
      service,
    );

    await expect(
      controller.markRead(
        { session: { user: { id: 'user-1' } } } as never,
        'notification-1',
      ),
    ).resolves.toEqual({ id: 'notification-1', read: true });
    expect(service.markRead).toHaveBeenCalledWith('user-1', 'notification-1');
  });

  it('rejects unauthenticated notification requests', () => {
    const controller = new NotificationsController(
      makeConfigService(),
      makeService(),
    );

    expect(() => controller.list({ session: {} } as never)).toThrow(
      UnauthorizedException,
    );
  });

  it('returns disabled notification contract when notifications are disabled', () => {
    const service = makeService();
    const controller = new NotificationsController(
      makeConfigService(false),
      service,
    );

    expect(
      controller.list({
        session: { userId: 'user-1' },
      } as never),
    ).toEqual({ enabled: false, items: [], unreadCount: 0 });
    expect(service.listForUser).not.toHaveBeenCalled();
  });

  it('rejects marking notifications read when notifications are disabled', () => {
    const service = makeService();
    const controller = new NotificationsController(
      makeConfigService(false),
      service,
    );

    expect(() =>
      controller.markRead(
        { session: { userId: 'user-1' } } as never,
        'notification-1',
      ),
    ).toThrow(BadRequestException);
    expect(service.markRead).not.toHaveBeenCalled();
  });

  it('returns notification preferences for the current user', async () => {
    const service = makeService();
    const controller = new NotificationsController(
      makeConfigService(),
      service,
    );

    await expect(
      controller.getPreferences({ session: { userId: 'user-1' } } as never),
    ).resolves.toMatchObject({
      userId: 'user-1',
      inAppEnabled: true,
    });
    expect(service.getPreferences).toHaveBeenCalledWith('user-1');
  });

  it('updates notification preferences for the current user', async () => {
    const service = makeService();
    const controller = new NotificationsController(
      makeConfigService(),
      service,
    );

    await expect(
      controller.updatePreferences({ session: { userId: 'user-1' } } as never, {
        inAppEnabled: false,
      }),
    ).resolves.toMatchObject({
      userId: 'user-1',
      inAppEnabled: false,
    });
    expect(service.updatePreferences).toHaveBeenCalledWith('user-1', {
      inAppEnabled: false,
    });
  });
});

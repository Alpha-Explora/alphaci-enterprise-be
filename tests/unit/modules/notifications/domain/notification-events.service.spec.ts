import { NotificationEventsService } from '../../../../../src/modules/notifications/domain/notification-events.service';
import type { NotificationsRepository } from '../../../../../src/modules/notifications/infra/notifications.repository';

describe('NotificationEventsService', () => {
  const repository = {
    getPreferences: jest.fn(),
    createForUser: jest.fn(),
  } as unknown as jest.Mocked<NotificationsRepository>;
  const configService = {
    getOrThrow: jest.fn(),
  };

  beforeEach(() => {
    jest.resetAllMocks();
    configService.getOrThrow.mockReturnValue({
      notifications: { enabled: true },
    });
    repository.getPreferences.mockResolvedValue({
      userId: 'user-1',
      inAppEnabled: true,
      emailEnabled: false,
      updatedAt: '2026-06-15T00:00:00.000Z',
    });
  });

  it('does not create notifications when disabled', async () => {
    configService.getOrThrow.mockReturnValue({
      notifications: { enabled: false },
    });
    const service = new NotificationEventsService(
      repository,
      configService as never,
    );

    await service.record({
      userId: 'user-1',
      projectId: 'project-1',
      eventCode: 'quota_reached',
      title: 'Quota reached',
      body: 'Project quota reached.',
    });

    expect(repository.createForUser).not.toHaveBeenCalled();
  });

  it('does not create notifications when in-app preferences are disabled', async () => {
    repository.getPreferences.mockResolvedValueOnce({
      userId: 'user-1',
      inAppEnabled: false,
      emailEnabled: false,
      updatedAt: '2026-06-15T00:00:00.000Z',
    });
    const service = new NotificationEventsService(
      repository,
      configService as never,
    );

    await service.record({
      userId: 'user-1',
      eventCode: 'quota_reached',
      title: 'Quota reached',
      body: 'Project quota reached.',
    });

    expect(repository.createForUser).not.toHaveBeenCalled();
  });

  it('creates notifications when enabled', async () => {
    const service = new NotificationEventsService(
      repository,
      configService as never,
    );

    await service.record({
      userId: 'user-1',
      projectId: 'project-1',
      eventCode: 'quota_reached',
      title: 'Quota reached',
      body: 'Project quota reached.',
    });

    expect(repository.createForUser).toHaveBeenCalledWith({
      userId: 'user-1',
      projectId: 'project-1',
      eventCode: 'quota_reached',
      title: 'Quota reached',
      body: 'Project quota reached.',
    });
  });
});

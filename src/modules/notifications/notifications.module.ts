import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '../../common/guards/session-auth.guard';
import { DatabaseModule } from '../database/database.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { NotificationsController } from './api/notifications.controller';
import { NotificationEventsService } from './domain/notification-events.service';
import { NotificationsRepository } from './infra/notifications.repository';
import { NotificationsService } from './domain/notifications.service';

@Module({
  imports: [DatabaseModule, PersistenceModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsRepository,
    NotificationsService,
    NotificationEventsService,
    SessionAuthGuard,
  ],
  exports: [NotificationsService, NotificationEventsService],
})
export class NotificationsModule {}

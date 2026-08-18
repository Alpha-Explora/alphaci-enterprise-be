import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { SessionAuthGuard } from '../../../common/guards/session-auth.guard';
import { PlatformAdminGuard } from '../../admin/guards/platform-admin.guard';
import { CreateGroupDto } from '../dto/create-group.dto';
import { QueryActivityDto } from '../dto/query-activity.dto';
import { RemoveMemberDto } from '../dto/remove-member.dto';
import { TransferGroupDto } from '../dto/transfer-group.dto';
import { UpdateGroupDto } from '../dto/update-group.dto';
import { UpdateMemberRoleDto } from '../dto/update-member-role.dto';
import { GroupActivityService } from '../group-activity.service';
import { AddGroupMemberDto } from '../dto/add-group-member.dto';
import { GroupMembersService } from './group-members.service';
import { GroupsService } from './groups.service';

@Controller('groups')
@UseGuards(SessionAuthGuard)
export class GroupsController {
  constructor(
    private readonly groupsService: GroupsService,
    private readonly membersService: GroupMembersService,
    private readonly activityService: GroupActivityService,
  ) {}

  @Post()
  createGroup(@Req() req: Request, @Body() body: CreateGroupDto) {
    const userId = this.requireUserId(req);
    // Plan §2.4: "any authenticated internal user" — is_internal is already
    // stamped on the session at sign-in (session-user.interface.ts).
    if (req.session.user?.isInternal !== true) {
      throw new ForbiddenException(
        'Group creation requires an internal account',
      );
    }
    return this.groupsService.createGroup(userId, body);
  }

  @Get()
  getMyGroups(@Req() req: Request) {
    return this.groupsService.getMyGroups(this.requireUserId(req));
  }

  @Get(':groupId')
  getGroup(@Req() req: Request, @Param('groupId') groupId: string) {
    return this.groupsService.getGroup(groupId, this.requireUserId(req));
  }

  @Patch(':groupId')
  updateGroup(
    @Req() req: Request,
    @Param('groupId') groupId: string,
    @Body() body: UpdateGroupDto,
  ) {
    return this.groupsService.updateGroup(
      groupId,
      this.requireUserId(req),
      body,
    );
  }

  @Post(':groupId/archive')
  archiveGroup(@Req() req: Request, @Param('groupId') groupId: string) {
    return this.groupsService.archiveGroup(groupId, this.requireUserId(req));
  }

  @Delete(':groupId')
  deleteGroup(@Req() req: Request, @Param('groupId') groupId: string) {
    return this.groupsService.deleteGroup(groupId, this.requireUserId(req));
  }

  @Post(':groupId/reopen')
  reopenGroup(@Req() req: Request, @Param('groupId') groupId: string) {
    return this.groupsService.reopenGroup(groupId, this.requireUserId(req));
  }

  // Platform-admin-only (plan §2.4) — method-level guard override, tighter
  // than the class-level SessionAuthGuard-only default.
  @Post(':groupId/transfer')
  @UseGuards(SessionAuthGuard, PlatformAdminGuard)
  transferGroup(
    @Req() req: Request,
    @Param('groupId') groupId: string,
    @Body() body: TransferGroupDto,
  ) {
    return this.groupsService.transferManager(
      groupId,
      this.requireUserId(req),
      body.newManagerUserId,
    );
  }

  /**
   * Teams inside a workspace. Distinct from GET /groups, which lists every team
   * the caller belongs to regardless of which workspace holds it.
   */
  @Get(':groupId/teams')
  listTeams(@Req() req: Request, @Param('groupId') groupId: string) {
    return this.groupsService.listTeams(groupId, this.requireUserId(req));
  }

  @Get(':groupId/members')
  listMembers(@Req() req: Request, @Param('groupId') groupId: string) {
    return this.groupsService.listMembers(groupId, this.requireUserId(req));
  }

  /**
   * Adds a member directly — no invitation, no pending state. The user is a
   * member as soon as a lead calls this.
   */
  @Post(':groupId/members')
  addMember(
    @Req() req: Request,
    @Param('groupId') groupId: string,
    @Body() body: AddGroupMemberDto,
  ) {
    return this.membersService.addMember(groupId, this.requireUserId(req), {
      userId: body.userId,
      ...(body.role !== undefined && { role: body.role }),
    });
  }

  @Get(':groupId/eligible-users')
  searchEligibleUsers(
    @Req() req: Request,
    @Param('groupId') groupId: string,
    @Query('search') search = '',
  ) {
    return this.groupsService.searchEligibleInternalUsers(
      groupId,
      this.requireUserId(req),
      search,
    );
  }

  @Patch(':groupId/members/:memberId')
  updateMemberRole(
    @Req() req: Request,
    @Param('groupId') groupId: string,
    @Param('memberId') memberId: string,
    @Body() body: UpdateMemberRoleDto,
  ) {
    return this.groupsService.updateMemberRole(
      groupId,
      this.requireUserId(req),
      memberId,
      body,
    );
  }

  @Delete(':groupId/members/:memberId')
  removeMember(
    @Req() req: Request,
    @Param('groupId') groupId: string,
    @Param('memberId') memberId: string,
    @Body() body?: RemoveMemberDto,
  ) {
    return this.groupsService.removeMember(
      groupId,
      this.requireUserId(req),
      memberId,
      body?.reason,
    );
  }

  @Get(':groupId/activity')
  listActivity(
    @Req() req: Request,
    @Param('groupId') groupId: string,
    @Query() query: QueryActivityDto,
  ) {
    return this.activityService.listActivity(
      groupId,
      this.requireUserId(req),
      query,
    );
  }

  private requireUserId(req: Request): string {
    const user = req.session.user;
    const userId = user?.id ?? req.session.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }
    return userId;
  }
}

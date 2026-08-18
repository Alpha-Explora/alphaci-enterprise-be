import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateGroupDto {
  /**
   * Set to create a TEAM inside that workspace. Omitted creates a top-level
   * workspace. Nesting is capped at two levels — the database enforces it, so
   * a team id here is rejected rather than silently accepted.
   */
  @IsOptional()
  @IsString()
  parentWorkspaceId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string = '';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  businessUnit?: string;
}

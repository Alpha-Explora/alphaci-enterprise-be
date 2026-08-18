import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';

import { DatabaseService } from '../database/database.service.js';
import {
  ProjectsRepository,
  type ProvisionedProjectRow,
} from './projects.repository.js';

const fakeRow: ProvisionedProjectRow = {
  id: 'project-1',
  user_id: 'user-1',
  repo_full_name: 'tone/orders-api',
  template_id: 'be-nestjs',
  service_name: 'orders-api',
  workflow_path: '.github/workflows/ci.yml',
  status: 'provisioned',
  github_commit_sha: 'commit-sha',
  github_commit_url: 'https://github.com/tone/orders-api/commit/commit-sha',
  failure_reason: null,
  repo_url: 'https://github.com/tone/orders-api',
  visibility: 'private',
  repo_shape: 'single-app',
  project_type_id: 'nestjs-api',
  workflow_recipe_id: 'backend-api-ci',
  project_options: { lint: true },
  created_at: '2026-06-05T00:00:00.000Z',
  updated_at: '2026-06-05T00:00:00.000Z',
};

const makeDatabaseService = (rows: ProvisionedProjectRow[] = [fakeRow]) =>
  ({
    query: jest.fn().mockResolvedValue({ rows }),
  }) as unknown as DatabaseService;

describe('ProjectsRepository', () => {
  let repo: ProjectsRepository;
  let db: DatabaseService;

  beforeEach(async () => {
    db = makeDatabaseService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProjectsRepository,
        { provide: DatabaseService, useValue: db },
      ],
    }).compile();

    repo = module.get(ProjectsRepository);
  });

  it('creates a provisioned project row', async () => {
    const result = await repo.create({
      userId: 'user-1',
      repoFullName: 'tone/orders-api',
      templateId: 'be-nestjs',
      serviceName: 'orders-api',
      workflowPath: '.github/workflows/ci.yml',
      status: 'provisioned',
      githubCommitSha: 'commit-sha',
      githubCommitUrl: 'https://github.com/tone/orders-api/commit/commit-sha',
      repoUrl: 'https://github.com/tone/orders-api',
      visibility: 'private',
      repoShape: 'single-app',
      projectTypeId: 'nestjs-api',
      workflowRecipeId: 'backend-api-ci',
      projectOptions: { lint: true },
    });

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO projects.provisioned_projects'),
      expect.arrayContaining([
        'user-1',
        'tone/orders-api',
        'be-nestjs',
        'orders-api',
        '.github/workflows/ci.yml',
        expect.stringMatching(/^[a-f0-9]{64}$/),
        'commit-sha',
        'provisioned',
        'commit-sha',
        'https://github.com/tone/orders-api/commit/commit-sha',
        null,
        expect.stringContaining(
          '"repoUrl":"https://github.com/tone/orders-api"',
        ),
        expect.any(String),
        null,
        'tone',
        'orders-api',
        'https://github.com/tone/orders-api',
        'private',
        'single-app',
        'nestjs-api',
        'backend-api-ci',
        'be-nestjs',
        JSON.stringify({ lint: true }),
        null,
      ]),
    );
    const [query, values] = (db.query as jest.Mock).mock.calls[0] as [
      string,
      unknown[],
    ];
    const columnsMatch = query.match(
      /INSERT INTO projects\.provisioned_projects \(([\s\S]*?)\)\s*VALUES/,
    );
    const placeholdersMatch = query.match(/VALUES \(([\s\S]*?)\)\s*RETURNING/);

    if (!columnsMatch?.[1] || !placeholdersMatch?.[1]) {
      throw new Error('Project insert query shape changed unexpectedly');
    }

    const columns =
      columnsMatch[1]
        .split(',')
        .map((column) => column.trim())
        .filter(Boolean) ?? [];
    const placeholders = placeholdersMatch[1].match(/\$\d+/g) ?? [];

    expect(columns).toHaveLength(values.length);
    expect(placeholders).toHaveLength(values.length);
    expect(result).toEqual(fakeRow);
  });

  it('throws when insert returns no row', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

    await expect(
      repo.create({
        userId: 'user-1',
        repoFullName: 'tone/orders-api',
        templateId: 'be-nestjs',
        serviceName: 'orders-api',
        workflowPath: '.github/workflows/ci.yml',
        status: 'provisioned',
      }),
    ).rejects.toThrow('provisioned_projects INSERT returned no row');
  });

  it('lists project rows for a user', async () => {
    const result = await repo.listByUser('user-1', 10);

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM projects.provisioned_projects'),
      ['user-1', 10],
    );
    expect(result).toEqual([fakeRow]);
  });

  it('lists project rows through workspace membership and selected workspace', async () => {
    await repo.listByUser('user-2', 10, 'workspace-1');

    const [query, values] = (db.query as jest.Mock).mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(query).toContain('orgs.workspace_members');
    expect(query).toContain('workspace_id = $3');
    expect(values).toEqual(['user-2', 10, 'workspace-1']);
  });

  it('clamps list limit to 100', async () => {
    await repo.listByUser('user-1', 999);

    expect(db.query).toHaveBeenCalledWith(expect.any(String), ['user-1', 100]);
  });

  it('defaults list limit to 25 for invalid input', async () => {
    await repo.listByUser('user-1', NaN);

    expect(db.query).toHaveBeenCalledWith(expect.any(String), ['user-1', 25]);
  });

  it('computes a viewer-relative is_owner column against the same viewer param used by the visibility predicate', async () => {
    await repo.listByUser('user-1', 10);

    const [query] = (db.query as jest.Mock).mock.calls[0] as [
      string,
      unknown[],
    ];
    // Must compare against $1 (the viewer), not just select the raw column —
    // otherwise every row (including ones only visible via admin/manager
    // oversight) would be misreported as owned by the viewer.
    expect(query).toContain('(pp.user_id = $1) AS is_owner');
  });

  it('finds a project by id scoped to user, unrestricted by role when allowedRoles is omitted', async () => {
    const result = await repo.findByIdAndUser('project-1', 'user-1');

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE pp.id = $1'),
      ['project-1', 'user-1', null],
    );
    expect(result).toEqual(fakeRow);
  });

  it('finds a project by id through workspace membership', async () => {
    await repo.findByIdAndUser('project-1', 'user-2');

    const [query] = (db.query as jest.Mock).mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(query).toContain('orgs.workspace_members');
    expect(query).toContain('member.workspace_id');
  });

  it('scopes findByIdAndUser to an allowedRoles list when provided', async () => {
    await repo.findByIdAndUser('project-1', 'user-1', ['admin', 'delegated_lead']);

    expect(db.query).toHaveBeenCalledWith(expect.any(String), [
      'project-1',
      'user-1',
      ['admin', 'delegated_lead'],
    ]);
  });

  it('deletes a project row with the default permissive role list', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({ rowCount: 1 });

    const result = await repo.deleteByIdAndUser('project-1', 'user-1');

    expect(result).toBe(true);
    expect(db.query).toHaveBeenCalledWith(expect.any(String), [
      'project-1',
      'user-1',
      ['admin', 'delegated_lead', 'member'],
    ]);
  });

  it('deletes a project row scoped to a tightened allowedRoles list', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({ rowCount: 1 });

    await repo.deleteByIdAndUser('project-1', 'user-1', ['admin', 'delegated_lead']);

    expect(db.query).toHaveBeenCalledWith(expect.any(String), [
      'project-1',
      'user-1',
      ['admin', 'delegated_lead'],
    ]);
  });

  it('returns false when deleteByIdAndUser deletes no row', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({ rowCount: 0 });

    const result = await repo.deleteByIdAndUser('project-1', 'user-1');

    expect(result).toBe(false);
  });

  it('hard-deletes projects by repo_full_name across all owners, case-insensitively', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({
      rows: [
        { id: 'project-1', user_id: 'user-1' },
        { id: 'project-9', user_id: 'user-2' },
      ],
    });

    const result = await repo.deleteByRepoFullName('Alpha-Explora/Some-Repo');

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('lower(repo_full_name) = lower($1)'),
      ['Alpha-Explora/Some-Repo'],
    );
    const [query] = (db.query as jest.Mock).mock.calls[0] as [string];
    expect(query).toContain('DELETE FROM projects.provisioned_projects');
    expect(query).not.toContain('user_id = $');
    expect(result).toEqual([
      { id: 'project-1', user_id: 'user-1' },
      { id: 'project-9', user_id: 'user-2' },
    ]);
  });

  it('returns an empty array when no project matches the deleted repo', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

    const result = await repo.deleteByRepoFullName('tone/gone-repo');

    expect(result).toEqual([]);
  });

  it('lists every tracked project system-wide, unscoped by user', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({
      rows: [
        {
          id: 'project-1',
          repo_full_name: 'tone/orders-api',
          user_id: 'user-1',
        },
        {
          id: 'project-2',
          repo_full_name: 'tone/gone-api',
          user_id: 'user-2',
        },
      ],
    });

    const result = await repo.listAllRepoFullNames();

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM projects.provisioned_projects'),
    );
    const [query] = (db.query as jest.Mock).mock.calls[0] as [string];
    expect(query).not.toContain('WHERE');
    expect(result).toEqual([
      { id: 'project-1', repo_full_name: 'tone/orders-api', user_id: 'user-1' },
      { id: 'project-2', repo_full_name: 'tone/gone-api', user_id: 'user-2' },
    ]);
  });

  it('marks every created project as non-example', async () => {
    await repo.create({
      userId: 'user-1',
      repoFullName: 'tone/orders-api',
      templateId: 'be-nestjs',
      serviceName: 'orders-api',
      workflowPath: '.github/workflows/ci.yml',
      status: 'provisioned',
    });

    const [query, values] = (db.query as jest.Mock).mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(query).toContain('is_example');
    expect(values[values.length - 1]).toBe(false);
  });

  /**
   * Guards the 2026-08-18 change: being in a team is enough to SEE that team's
   * projects. The old rule required the manager tier, so a developer added to a
   * team saw an empty Repositories section and adding them looked broken.
   *
   * The second test is the one that matters most — widening what a member can
   * READ must not widen what they can DELETE.
   */
  describe('project visibility', () => {
    it('lets any ACTIVE workspace member see the project, not just managers', async () => {
      await repo.listByUser('user-1');
      const [query] = (db.query as jest.Mock).mock.calls[0] as [string];

      expect(query).toContain('orgs.workspace_members');
      expect(query).toContain("vm.member_status = 'active'");
      // The manager-tier restriction is gone from the READ predicate.
      expect(query).not.toContain(
        "vm.role IN ('admin', 'delegated_lead')",
      );
    });

    it('still requires an explicit role list for destructive paths', async () => {
      await repo.deleteByIdAndUser('project-1', 'user-1', [
        'admin',
        'delegated_lead',
      ]);
      const [query, values] = (db.query as jest.Mock).mock.calls[0] as [
        string,
        unknown[],
      ];

      // Delete is gated on a role array passed by the caller — untouched by the
      // read-visibility change.
      expect(query).toContain('member.role = ANY($3::text[])');
      expect(values).toContain('user-1');
      expect(values[2]).toEqual(['admin', 'delegated_lead']);
    });

    it('keeps assignment as a separate route in, for members of no workspace', async () => {
      await repo.listByUser('user-1');
      const [query] = (db.query as jest.Mock).mock.calls[0] as [string];

      expect(query).toContain('hierarchy.repository_assignments');
      expect(query).toContain("vra.status IN ('active', 'pending')");
    });
  });
});

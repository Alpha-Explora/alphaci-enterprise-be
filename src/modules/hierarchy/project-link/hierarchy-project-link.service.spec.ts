import { HierarchyProjectLinkService } from './hierarchy-project-link.service';
import type { HierarchyProjectLinkRepository } from './hierarchy-project-link.repository';

function build(overrides: Partial<HierarchyProjectLinkRepository> = {}) {
  const link = jest.fn(() => Promise.resolve('repo-1'));
  const repository = {
    isTeamWorkspace: jest.fn(() => Promise.resolve(true)),
    findLinkedRepositoryId: jest.fn(() => Promise.resolve(null)),
    link,
    ...overrides,
  } as unknown as HierarchyProjectLinkRepository;

  return {
    service: new HierarchyProjectLinkService(repository),
    repository,
    link: repository.link as unknown as jest.Mock,
  };
}

const BASE = {
  projectId: 'p1',
  workspaceId: 'w1',
  name: 'payments-api',
  repoFullName: 'Alpha-Explora/payments-api',
  visibility: 'private',
  createdBy: 'u1',
  projectStatus: 'provisioned',
};

describe('HierarchyProjectLinkService', () => {
  it('skips projects with no workspace', async () => {
    const { service, link } = build();
    await expect(
      service.ensureLink({ ...BASE, workspaceId: null }),
    ).resolves.toBeNull();
    expect(link).not.toHaveBeenCalled();
  });

  it('skips personal workspaces — they have no hierarchy tree', async () => {
    const { service, link } = build({
      isTeamWorkspace: jest.fn(() => Promise.resolve(false)),
    });
    await expect(service.ensureLink(BASE)).resolves.toBeNull();
    expect(link).not.toHaveBeenCalled();
  });

  it('is idempotent — an already-linked project is not linked twice', async () => {
    const { service, link } = build({
      findLinkedRepositoryId: jest.fn(() => Promise.resolve('existing')),
    });
    await expect(service.ensureLink(BASE)).resolves.toBe('existing');
    expect(link).not.toHaveBeenCalled();
  });

  it('links a group project and maps provisioned status', async () => {
    const { service, link } = build();
    await expect(service.ensureLink(BASE)).resolves.toBe('repo-1');
    expect(link).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'p1',
        workspaceId: 'w1',
        name: 'payments-api',
        visibility: 'private',
        projectStatus: 'provisioned',
      }),
    );
  });

  it('records public visibility rather than forcing private', async () => {
    const { service, link } = build();
    await service.ensureLink({ ...BASE, visibility: 'public' });
    expect(link).toHaveBeenCalledWith(
      expect.objectContaining({ visibility: 'public' }),
    );
  });

  it('falls back to the repo name when the service name is blank', async () => {
    const { service, link } = build();
    await service.ensureLink({ ...BASE, name: '   ' });
    expect(link).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'payments-api' }),
    );
  });

  describe('getLinkedRepositoryId', () => {
    it('returns the linked repository id', async () => {
      const { service } = build({
        findLinkedRepositoryId: jest.fn(() => Promise.resolve('repo-9')),
      });
      await expect(service.getLinkedRepositoryId('p1')).resolves.toBe('repo-9');
    });

    it('returns null for an unlinked project so the UI hides the entry point', async () => {
      const { service } = build();
      await expect(service.getLinkedRepositoryId('p1')).resolves.toBeNull();
    });

    it('never throws — the project overview must render without the link', async () => {
      const { service } = build({
        findLinkedRepositoryId: jest.fn(() =>
          Promise.reject(new Error('db down')),
        ),
      });
      await expect(service.getLinkedRepositoryId('p1')).resolves.toBeNull();
    });

    it('is READ-ONLY — looking up a link never creates one', async () => {
      const { service, link } = build();
      await service.getLinkedRepositoryId('p1');
      expect(link).not.toHaveBeenCalled();
    });
  });

  it('never throws — a failed link must not fail an already-provisioned project', async () => {
    // By the time this runs the GitHub repo, branches, secrets and workflow
    // commit have all succeeded. Throwing here would report a working project
    // as a failure and let the compensation path delete it.
    const { service } = build({
      link: jest.fn(() => Promise.reject(new Error('db down'))),
    });
    await expect(service.ensureLink(BASE)).resolves.toBeNull();
  });
});

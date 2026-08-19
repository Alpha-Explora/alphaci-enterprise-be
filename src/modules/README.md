# modules

One directory per feature. Each is self-contained and exposes exactly one
public entrance.

```
<feature>/
  api/       controllers, DTOs — the entire HTTP surface
  domain/    services, business rules, domain types
  infra/     repositories, provider clients
  <feature>.module.ts
  index.ts   the ONLY path another module may import
```

## Rules

1. A module may import another module **only** through its `index.ts`.
   `../deployments/env-vars.repository` is a build failure.
2. A module may import `@kernel/*` freely.
3. `kernel/` may never import a module.
4. No circular dependencies between modules.

Enforced by `.dependency-cruiser.cjs` in CI, not by convention.

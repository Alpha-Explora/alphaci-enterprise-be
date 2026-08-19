# kernel

Cross-cutting infrastructure with no feature owner. Every module may import
from here; **this directory may never import from `src/modules/`.**

| Folder    | Holds                                                        |
|-----------|--------------------------------------------------------------|
| `config/` | `app.config.ts`, `env.validation.ts`                          |
| `db/`     | `database.service`, `postgres-ssl.config`, Supabase client    |
| `http/`   | exception filters, correlation-id middleware                  |
| `auth/`   | `SessionAuthGuard`, session/user interfaces                   |
| `events/` | `outbox.repository` — the only genuinely shared repository    |
| `types/`  | ambient and shared type declarations                          |

## Admission rule

Something belongs here only when a **second** module needs it. One consumer
means it lives inside that module. This rule is what stops `kernel/` becoming
the next `persistence/`.

Migration status: skeleton only — see `docs/restructure.md` phase 03.

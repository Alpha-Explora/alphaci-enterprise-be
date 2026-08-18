import type { ConnectionOptions } from 'node:tls';

const LOCAL_DATABASE_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export function postgresSslConfig(
  databaseUrl: string,
  caCert?: string,
): boolean | ConnectionOptions {
  if (isLocalDatabase(databaseUrl)) {
    return false;
  }

  const normalizedCa = normalizeCaCert(caCert);
  if (normalizedCa) {
    return { ca: normalizedCa };
  }

  return true;
}

function isLocalDatabase(databaseUrl: string): boolean {
  try {
    const hostname = new URL(databaseUrl).hostname.replace(/^\[|\]$/g, '');
    return LOCAL_DATABASE_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

/**
 * Rebuilds a PEM from however the environment mangled it.
 *
 * Host env panels and .env files disagree about newlines, and the two
 * conventions can end up combined: a value stored across real lines whose
 * lines ALSO end in a literal `\n`. Expanding the escapes then doubles every
 * break, producing a PEM with a blank line between each body line. OpenSSL
 * rejects that with "PEM routines::bad end line", which surfaces from pg as
 * "self-signed certificate in certificate chain" — pointing at the database
 * instead of at the malformed variable, which is a long way to walk for a
 * formatting problem.
 *
 * Expanding escapes, trimming each line and dropping the blanks reconstructs
 * the canonical form from any of those shapes.
 */
function normalizeCaCert(caCert?: string): string | undefined {
  const trimmed = caCert?.trim();
  if (!trimmed) return undefined;

  const normalized = trimmed
    .replace(/\\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');

  return normalized || undefined;
}

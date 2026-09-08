// Pure persisted routing-authority codec; no settings/runtime dependencies.
export interface AuditorRoutingContract {
  version: 1;
  fingerprint: string;
  routes: string[];
  extensions: string[];
}

/** Reject malformed persisted authority instead of interpreting it as fresh. */
export function normalizeAuditorRoutingContract(value: unknown): AuditorRoutingContract | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as AuditorRoutingContract;
  if (v.version !== 1 || typeof v.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(v.fingerprint)
    || !Array.isArray(v.routes) || !v.routes.length || v.routes.length > 12 || v.routes.some((ref) => typeof ref !== "string" || !/^[^/\s]+\/\S+$/.test(ref))
    || !Array.isArray(v.extensions) || v.extensions.length > 32 || v.extensions.some((ref) => typeof ref !== "string" || !ref)) return undefined;
  return { version: 1, fingerprint: v.fingerprint, routes: [...v.routes], extensions: [...v.extensions] };
}

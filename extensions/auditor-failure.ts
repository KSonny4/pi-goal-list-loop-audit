// Auditor-only permanent denial classification. Ambiguous status codes alone
// are not provider-wide policy; this decision consumes just the current route.
export function isTerminalAuditorDenial(error: string): boolean {
  return /\b(?:insufficient (?:balance|funds|credits)|billing (?:disabled|denied)|payment required|invalid (?:api|access) key|authentication failed|account (?:suspended|disabled))\b/i.test(error)
    || /\b401\b[^\n]*(?:unauthori[sz]ed|authentication|invalid.*(?:key|token))/i.test(error);
}

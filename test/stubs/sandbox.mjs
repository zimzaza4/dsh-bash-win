export function approveEscalation() {
  throw new Error('approveEscalation is not exercised by this test')
}
export function validateEscalationArgs() {}
export function sandboxDenialMarker(mode) {
  return `[sandbox: file access denied under ${mode} mode]`
}
export function escalationHintMarker() {
  return '[sandbox: retry with sandbox_permissions]'
}

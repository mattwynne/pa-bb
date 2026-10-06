import { InsufficientScopeError, ProtocolError, SdkError, SdkErrorCode, SdkHttpError, UnauthorizedError } from '@modelcontextprotocol/client';

// Provider error messages, causes, data, URLs and response bodies may contain private
// account content or OAuth credentials. Log only fixed categories and bounded codes.
export function failureCategory(error) {
  if (error instanceof SdkHttpError) {
    const status = error.status;
    return Number.isInteger(status) && status >= 100 && status <= 599 ? `http_status=${status}` : 'http_error';
  }
  if (error instanceof UnauthorizedError) return 'unauthorized';
  if (error instanceof InsufficientScopeError) return 'insufficient_scope';
  if (error instanceof SdkError) return Object.values(SdkErrorCode).includes(error.code) ? error.code : 'sdk_error';
  if (error instanceof ProtocolError) return Number.isInteger(error.code) && error.code >= -32768 && error.code <= 32767
    ? `protocol_code=${error.code}` : 'protocol_error';
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'timeout';
  if (error instanceof DOMException && error.name === 'AbortError') return 'aborted';
  if (error instanceof TypeError) return 'type_error';
  return 'unknown';
}

// A Fastmail 500 may carry a support trace ID. Discard all other response
// fields, including messages, and never record the MCP session ID itself.
export function connectionFailureContext(error, { openedAt, now = Date.now(), sessionIdPresent, protocolVersion }) {
  const ageMs = typeof openedAt === 'number' && openedAt > 0 && Number.isFinite(now) && now >= openedAt ? now - openedAt : null;
  const age = ageMs === null ? 'unknown' : ageMs < 5 * 60_000 ? 'under_5m'
    : ageMs < 30 * 60_000 ? '5-30m' : ageMs < 60 * 60_000 ? '30-60m' : 'over_60m';
  const session = sessionIdPresent === true ? 'present' : sessionIdPresent === false ? 'absent' : 'unknown';
  const protocol = ['2025-06-18', '2025-11-25', '2026-07-28'].includes(protocolVersion) ? protocolVersion : 'unknown';
  let trace = 'none';
  const text = error instanceof SdkHttpError ? error.data?.text : null;
  if (typeof text === 'string' && text.length <= 4096) {
    try {
      const id = JSON.parse(text)?.trace_id;
      if (typeof id === 'string' && /^ti_[0-9a-f]{32}$/.test(id)) trace = id;
    } catch { /* Never log provider text. */ }
  }
  return `age=${age} session=${session} protocol=${protocol} trace=${trace}`;
}

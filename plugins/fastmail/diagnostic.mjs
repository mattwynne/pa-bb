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

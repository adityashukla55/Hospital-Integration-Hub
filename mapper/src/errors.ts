/**
 * Error codes are stable strings: they are stored in the dead-letter table,
 * shown in the ops console and used in Grafana panels.
 */
export type MappingErrorCode =
  | 'PARSE_ERROR'
  | 'UNSUPPORTED_MESSAGE'
  | 'MISSING_REQUIRED_FIELD'
  | 'INVALID_VALUE'
  | 'TERMINOLOGY_UNMAPPED'
  | 'TERMINOLOGY_UNAVAILABLE';

export class MappingError {
  name = 'MappingError';
  code: MappingErrorCode;
  message: string;
  /** HL7 v2 location such as "PID-3" or "OBX[2]-6" */
  location?: string;
  /** true when retrying later can succeed (e.g. terminology server down) */
  retryable: boolean;

  constructor(code: MappingErrorCode, message: string, location?: string, retryable?: boolean) {
    this.code = code;
    this.message = location ? location + ': ' + message : message;
    this.location = location;
    this.retryable = !!retryable;
  }

  toString(): string {
    return this.name + ' [' + this.code + '] ' + this.message;
  }
}

export function isMappingError(e: unknown): e is MappingError {
  return !!e && typeof e === 'object' && (e as MappingError).name === 'MappingError';
}

export interface MappingIssue {
  severity: 'warning' | 'information';
  code: string;
  message: string;
  location?: string;
}

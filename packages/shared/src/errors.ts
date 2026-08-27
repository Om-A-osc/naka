export class TerminalError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = "TerminalError";
  }
}

export class RetryableError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = "RetryableError";
  }
}

export class GateDeniedError extends Error {
  ruleId: string;
  constructor(ruleId: string, message: string) {
    super(message);
    this.ruleId = ruleId;
    this.name = "GateDeniedError";
  }
}

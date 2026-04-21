/**
 * Canonical Lace validation error codes and helpers.
 *
 * The code set must match `specs/error-codes.json` in the lacelang repo.
 * Every validator and executor emit the same code for the same condition
 * so conformance vectors are implementation-independent.
 */

export interface Diagnostic {
  code: string;
  callIndex?: number | null;
  chainMethod?: string | null;
  field?: string | null;
  line?: number | null;
  detail?: string | null;
}

export interface DiagnosticDict {
  code: string;
  callIndex?: number;
  chainMethod?: string;
  field?: string;
  line?: number;
  detail?: string;
}

function diagnosticToDict(d: Diagnostic): DiagnosticDict {
  const out: DiagnosticDict = { code: d.code };
  if (d.callIndex != null) out.callIndex = d.callIndex;
  if (d.chainMethod != null) out.chainMethod = d.chainMethod;
  if (d.field != null) out.field = d.field;
  if (d.line != null) out.line = d.line;
  if (d.detail != null) out.detail = d.detail;
  return out;
}

export class DiagnosticSink {
  errors: Diagnostic[] = [];
  warnings: Diagnostic[] = [];

  error(code: string, opts?: Partial<Omit<Diagnostic, "code">>): void {
    const d: Diagnostic = { code, ...opts };
    this.errors.push(d);
  }

  warning(code: string, opts?: Partial<Omit<Diagnostic, "code">>): void {
    const d: Diagnostic = { code, ...opts };
    this.warnings.push(d);
  }

  toDict(): { errors: DiagnosticDict[]; warnings: DiagnosticDict[] } {
    return {
      errors: this.errors.map(diagnosticToDict),
      warnings: this.warnings.map(diagnosticToDict),
    };
  }
}

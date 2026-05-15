import { describe, it, expect } from "vitest";
import { parse } from "../parser.js";
import { validate } from "../validator.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function _validate(source: string, opts: Record<string, any> = {}) {
  return validate(
    parse(source),
    opts.variables ?? null,
    opts.context ?? null,
    opts.prev_results_available ?? false,
    opts.active_extensions ?? null,
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function errorCodes(source: string, opts: Record<string, any> = {}): string[] {
  return _validate(source, opts).errors.map(d => d.code);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function warningCodes(source: string, opts: Record<string, any> = {}): string[] {
  return _validate(source, opts).warnings.map(d => d.code);
}

describe("StructuralRules", () => {
  it("AT_LEAST_ONE_CALL", () => {
    const sink = validate({ version: "0.9.2", calls: [] });
    expect(sink.errors.map(e => e.code)).toContain("AT_LEAST_ONE_CALL");
  });

  it("empty script parse error", () => {
    expect(() => parse("")).toThrow();
  });

  it("EMPTY_CHAIN", () => {
    const sink = validate({ version: "0.9.2", calls: [{ method: "get", url: "$u", chain: {} }] });
    expect(sink.errors.map(e => e.code)).toContain("EMPTY_CHAIN");
  });

  it("valid chain no error", () => {
    expect(errorCodes('get("$u")\n    .expect(status: 200)\n')).toEqual([]);
  });
});

describe("ChainOrder", () => {
  it("store before assert", () => {
    const src = 'get("$u")\n    .store({ a: this.body.x })\n    .assert({ expect: [this.status eq 200] })\n';
    expect(errorCodes(src)).toContain("CHAIN_ORDER");
  });
  it("correct order", () => {
    const src = 'get("$u")\n    .expect(status: 200)\n    .store({ a: this.body.x })\n';
    expect(errorCodes(src)).not.toContain("CHAIN_ORDER");
  });
});

describe("ChainDuplicate", () => {
  it("duplicate expect", () => {
    const src = 'get("$u")\n    .expect(status: 200)\n    .expect(body: "ok")\n';
    expect(errorCodes(src)).toContain("CHAIN_DUPLICATE");
  });
  it("no duplicate", () => {
    const src = 'get("$u")\n    .expect(status: 200)\n    .check(body: "ok")\n';
    expect(errorCodes(src)).not.toContain("CHAIN_DUPLICATE");
  });
});

describe("EmptyBlocks", () => {
  it("empty scope block", () => {
    expect(errorCodes('get("$u")\n    .expect()\n')).toContain("EMPTY_SCOPE_BLOCK");
  });
  it("empty assert block", () => {
    expect(errorCodes('get("$u")\n    .assert({})\n')).toContain("EMPTY_ASSERT_BLOCK");
  });
  it("empty store block", () => {
    expect(errorCodes('get("$u")\n    .store({})\n')).toContain("EMPTY_STORE_BLOCK");
  });
});

describe("VariableChecks", () => {
  it("unknown variable with registry", () => {
    const src = 'get("$u")\n    .assert({ expect: [$unknown eq 1] })\n';
    expect(errorCodes(src, { variables: ["u"] })).toContain("VARIABLE_UNKNOWN");
  });
  it("known variable", () => {
    const src = 'get("$u")\n    .assert({ expect: [$host eq 1] })\n';
    expect(errorCodes(src, { variables: ["u", "host"] })).not.toContain("VARIABLE_UNKNOWN");
  });
  it("no registry no error", () => {
    const src = 'get("$u")\n    .assert({ expect: [$anything eq 1] })\n';
    expect(errorCodes(src)).not.toContain("VARIABLE_UNKNOWN");
  });
  it("run var reassigned", () => {
    const src =
      'get("$u")\n    .expect(status: 200)\n    .store({ $$x: this.status })\n'
      + 'get("$u")\n    .expect(status: 200)\n    .store({ $$x: this.status })\n';
    expect(errorCodes(src)).toContain("RUN_VAR_REASSIGNED");
  });
  it("run var single assignment", () => {
    const src = 'get("$u")\n    .expect(status: 200)\n    .store({ $$x: this.status })\n';
    expect(errorCodes(src)).not.toContain("RUN_VAR_REASSIGNED");
  });
});

describe("ExpressionChecks", () => {
  it("unknown function", () => {
    const src = 'get("$u")\n    .assert({ expect: [random() gt 5] })\n';
    expect(errorCodes(src)).toContain("UNKNOWN_FUNCTION");
  });
  it("known function json", () => {
    const src = 'post("$u", { body: json({ a: 1 }) })\n    .expect(status: 200)\n';
    expect(errorCodes(src)).not.toContain("UNKNOWN_FUNCTION");
  });
  it("schema var unknown", () => {
    const src = 'get("$u")\n    .expect(body: schema($missing))\n';
    expect(errorCodes(src, { variables: ["u"] })).toContain("SCHEMA_VAR_UNKNOWN");
  });
  it("schema var known", () => {
    const src = 'get("$u")\n    .expect(body: schema($s))\n';
    expect(errorCodes(src, { variables: ["u", "s"] })).not.toContain("SCHEMA_VAR_UNKNOWN");
  });
  it("wait valid", () => {
    const src = 'get("$u")\n    .expect(status: 200)\n    .wait(1000)\n';
    expect(errorCodes(src)).not.toContain("EXPRESSION_SYNTAX");
  });
});

describe("ConfigLimits", () => {
  it("redirects max limit", () => {
    const src = 'get("$u", { redirects: { max: 999 } })\n    .expect(status: 200)\n';
    expect(errorCodes(src, { context: { maxRedirects: 10 } })).toContain("REDIRECTS_MAX_LIMIT");
  });
  it("redirects within limit", () => {
    const src = 'get("$u", { redirects: { max: 5 } })\n    .expect(status: 200)\n';
    expect(errorCodes(src, { context: { maxRedirects: 10 } })).not.toContain("REDIRECTS_MAX_LIMIT");
  });
  it("timeout ms limit", () => {
    const src = 'get("$u", { timeout: { ms: 999999 } })\n    .expect(status: 200)\n';
    expect(errorCodes(src, { context: { maxTimeoutMs: 300000 } })).toContain("TIMEOUT_MS_LIMIT");
  });
  it("timeout action invalid", () => {
    const src = 'get("$u", { timeout: { ms: 5000, action: "explode" } })\n    .expect(status: 200)\n';
    expect(errorCodes(src)).toContain("TIMEOUT_ACTION_INVALID");
  });
  it("timeout retries requires retry", () => {
    const src = 'get("$u", { timeout: { ms: 5000, action: "fail", retries: 3 } })\n    .expect(status: 200)\n';
    expect(errorCodes(src)).toContain("TIMEOUT_RETRIES_REQUIRES_RETRY");
  });
  it("timeout retries with retry ok", () => {
    const src = 'get("$u", { timeout: { ms: 5000, action: "retry", retries: 3 } })\n    .expect(status: 200)\n';
    expect(errorCodes(src)).not.toContain("TIMEOUT_RETRIES_REQUIRES_RETRY");
  });
});

describe("CookieJar", () => {
  it("clear cookies wrong jar", () => {
    const src = 'get("$u", { cookieJar: "inherit", clearCookies: ["a"] })\n    .expect(status: 200)\n';
    expect(errorCodes(src)).toContain("CLEAR_COOKIES_WRONG_JAR");
  });
  it("clear cookies selective ok", () => {
    const src = 'get("$u", { cookieJar: "selective_clear", clearCookies: ["a"] })\n    .expect(status: 200)\n';
    expect(errorCodes(src)).not.toContain("CLEAR_COOKIES_WRONG_JAR");
  });
  it("named empty", () => {
    const src = 'get("$u", { cookieJar: "named:" })\n    .expect(status: 200)\n';
    expect(errorCodes(src)).toContain("COOKIE_JAR_NAMED_EMPTY");
  });
  it("jar format invalid", () => {
    const src = 'get("$u", { cookieJar: "invalid_mode" })\n    .expect(status: 200)\n';
    expect(errorCodes(src)).toContain("COOKIE_JAR_FORMAT");
  });
  it("jar format named ok", () => {
    const src = 'get("$u", { cookieJar: "named:session" })\n    .expect(status: 200)\n';
    expect(errorCodes(src)).not.toContain("COOKIE_JAR_FORMAT");
  });
});

describe("ScopeChecks", () => {
  it("op value invalid", () => {
    const src = 'get("$u")\n    .expect(status: { value: 200, op: "nope" })\n';
    expect(errorCodes(src)).toContain("OP_VALUE_INVALID");
  });
  it("op value valid", () => {
    for (const op of ["lt", "lte", "eq", "neq", "gte", "gt"]) {
      const src = `get("$u")\n    .expect(status: { value: 200, op: "${op}" })\n`;
      expect(errorCodes(src)).not.toContain("OP_VALUE_INVALID");
    }
  });
  it("body size format invalid", () => {
    const src = 'get("$u")\n    .expect(bodySize: "invalid")\n';
    expect(errorCodes(src)).toContain("MAX_BODY_FORMAT");
  });
  it("body size format valid", () => {
    for (const s of ["500", "10k", "2kb", "1mb", "5GB"]) {
      const src = `get("$u")\n    .expect(bodySize: "${s}")\n`;
      expect(errorCodes(src)).not.toContain("MAX_BODY_FORMAT");
    }
  });
});

describe("Warnings", () => {
  it("prev without results", () => {
    const src = 'get("$u")\n    .assert({ expect: [prev.outcome eq "success"] })\n';
    expect(warningCodes(src)).toContain("PREV_WITHOUT_RESULTS");
  });
  it("prev with results", () => {
    const src = 'get("$u")\n    .assert({ expect: [prev.outcome eq "success"] })\n';
    expect(warningCodes(src, { prev_results_available: true })).not.toContain("PREV_WITHOUT_RESULTS");
  });
  it("high call count", () => {
    const calls = Array.from({ length: 11 }, () => 'get("$u")\n    .expect(status: 200)').join("\n");
    expect(warningCodes(calls)).toContain("HIGH_CALL_COUNT");
  });
  it("normal call count", () => {
    const calls = Array.from({ length: 5 }, () => 'get("$u")\n    .expect(status: 200)').join("\n");
    expect(warningCodes(calls)).not.toContain("HIGH_CALL_COUNT");
  });
  it("ext field inactive", () => {
    const src = 'get("$u", { timeout: { ms: 5000 }, myExtField: 42 })\n    .expect(status: 200)\n';
    expect(warningCodes(src)).toContain("EXT_FIELD_INACTIVE");
  });
  it("ext field active", () => {
    const src = 'get("$u", { timeout: { ms: 5000 }, myExtField: 42 })\n    .expect(status: 200)\n';
    expect(warningCodes(src, { active_extensions: ["someExt"] })).not.toContain("EXT_FIELD_INACTIVE");
  });
});

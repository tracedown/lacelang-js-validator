/**
 * Semantic validator for Lace ASTs.
 *
 * Emits canonical error codes from `specs/error-codes.json` via DiagnosticSink.
 * Strict by default: the parser is permissive and the validator rejects anything
 * that violates spec §12. Context (maxRedirects, maxTimeoutMs) gates
 * system-limit checks; when absent, reasonable spec defaults are used.
 */

import { DiagnosticSink } from "./errors.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AstNode = Record<string, any>;

const CHAIN_ORDER: readonly string[] = ["expect", "check", "assert", "store", "wait"];
const CORE_FUNCS: ReadonlySet<string> = new Set(["json", "form", "schema"]);
const OP_VALUES: ReadonlySet<string> = new Set(["lt", "lte", "eq", "neq", "gte", "gt"]);
const TIMEOUT_ACTIONS: ReadonlySet<string> = new Set(["fail", "warn", "retry"]);

const MAX_BODY_RE = /^\d+(k|kb|m|mb|g|gb)?$/i;
const COOKIE_JAR_FIXED: ReadonlySet<string> = new Set(["inherit", "fresh", "selective_clear"]);
const COOKIE_JAR_NAMED_RE = /^named:([A-Za-z0-9_\-]+)$/;
const COOKIE_JAR_NAMED_SELECTIVE_RE = /^([A-Za-z0-9_\-]+):selective_clear$/;

interface ExprCtx {
  callIndex: number;
  chainMethod: string | null;
  allowThis: boolean;
  allowExtensionFuncs: boolean;
}

export function validate(
  ast: AstNode,
  variables?: string[] | null,
  context?: { maxRedirects?: number; maxTimeoutMs?: number; extensions?: string[] } | null,
  prevResultsAvailable?: boolean,
  activeExtensions?: string[] | null,
): DiagnosticSink {
  const sink = new DiagnosticSink();
  const ctx = context ?? {};
  const varsSet = new Set(variables ?? []);
  const extensionsActive = Boolean(activeExtensions && activeExtensions.length > 0);

  const calls: AstNode[] = ast.calls ?? [];
  if (calls.length === 0) {
    sink.error("AT_LEAST_ONE_CALL");
    return sink;
  }
  if (calls.length > 10) {
    sink.warning("HIGH_CALL_COUNT");
  }

  // Run-var tracking for RUN_VAR_REASSIGNED.
  const runVarAssigned: Map<string, number> = new Map();

  for (let i = 0; i < calls.length; i++) {
    validateCall(
      calls[i], i, sink, varsSet, ctx, prevResultsAvailable ?? false,
      runVarAssigned, extensionsActive,
    );
  }

  return sink;
}

function validateCall(
  call: AstNode,
  idx: number,
  sink: DiagnosticSink,
  varsSet: Set<string>,
  ctx: AstNode,
  prevAvailable: boolean,
  runVarAssigned: Map<string, number>,
  extensionsActive: boolean,
): void {
  const cfg: AstNode = call.config ?? {};
  validateCallConfig(cfg, idx, sink, varsSet, ctx, prevAvailable, extensionsActive);

  const chain: AstNode = call.chain ?? {};
  const order: string[] = chain.__order ?? [];
  const dupes: string[] = chain.__duplicates ?? [];

  if (dupes.length > 0) {
    sink.error("CHAIN_DUPLICATE", { callIndex: idx, detail: dupes.join(",") });
  }

  // Order check on the de-duplicated observed sequence.
  const seen: string[] = [];
  for (const m of order) {
    if (!seen.includes(m)) {
      seen.push(m);
    }
  }
  const expectedOrder = CHAIN_ORDER.filter(m => seen.includes(m));
  if (seen.length !== expectedOrder.length || seen.some((m, i) => m !== expectedOrder[i])) {
    sink.error("CHAIN_ORDER", { callIndex: idx });
  }

  if (order.length === 0) {
    sink.error("EMPTY_CHAIN", { callIndex: idx });
    return;
  }

  for (const method of ["expect", "check"] as const) {
    if (method in chain) {
      validateScopeBlock(chain[method], call, idx, method, sink, varsSet, prevAvailable);
    }
  }

  if ("assert" in chain) {
    validateAssertBlock(chain.assert, call, idx, sink, varsSet, prevAvailable);
  }

  if ("store" in chain) {
    validateStoreBlock(chain.store, call, idx, sink, varsSet, prevAvailable, runVarAssigned);
  }

  if ("wait" in chain) {
    const w = chain.wait;
    if (typeof w !== "number" || !Number.isInteger(w) || w < 0) {
      sink.error("EXPRESSION_SYNTAX", { callIndex: idx, chainMethod: "wait" });
    }
  }
}

// -- call config --

function validateCallConfig(
  cfg: AstNode,
  idx: number,
  sink: DiagnosticSink,
  varsSet: Set<string>,
  ctx: AstNode,
  prevAvailable: boolean,
  extensionsActive: boolean,
): void {
  // cookieJar / clearCookies
  const jar = cfg.cookieJar;
  if (jar != null) {
    validateCookieJar(jar, cfg, idx, sink);
  } else {
    if (cfg.clearCookies) {
      sink.error("CLEAR_COOKIES_WRONG_JAR", { callIndex: idx });
    }
  }

  // redirects
  const red: AstNode = cfg.redirects ?? {};
  if ("max" in red) {
    const limit = ctx.maxRedirects;
    if (typeof limit === "number" && red.max > limit) {
      sink.error("REDIRECTS_MAX_LIMIT", { callIndex: idx, field: "redirects.max" });
    }
  }

  // timeout
  const to: AstNode = cfg.timeout ?? {};
  if ("action" in to && !TIMEOUT_ACTIONS.has(to.action)) {
    sink.error("TIMEOUT_ACTION_INVALID", { callIndex: idx, field: "timeout.action" });
  }
  if ("retries" in to && to.action !== "retry") {
    sink.error("TIMEOUT_RETRIES_REQUIRES_RETRY", { callIndex: idx });
  }
  if ("ms" in to) {
    const limit = ctx.maxTimeoutMs;
    if (typeof limit === "number" && to.ms > limit) {
      sink.error("TIMEOUT_MS_LIMIT", { callIndex: idx, field: "timeout.ms" });
    }
  }

  // Walk expressions in config for variable/function/this checks.
  const ctxInfo: ExprCtx = {
    callIndex: idx, chainMethod: null, allowThis: false, allowExtensionFuncs: false,
  };
  walkAny(cfg.headers, sink, varsSet, ctxInfo, prevAvailable);
  walkBody(cfg.body, sink, varsSet, ctxInfo, prevAvailable);
  walkAny(cfg.cookies, sink, varsSet, ctxInfo, prevAvailable);

  // extensions passthrough
  const ctxExt: ExprCtx = {
    callIndex: idx, chainMethod: null, allowThis: false, allowExtensionFuncs: true,
  };
  const extensions = cfg.extensions;
  if (extensions) {
    for (const name of Object.keys(extensions)) {
      if (!extensionsActive) {
        sink.warning("EXT_FIELD_INACTIVE", { callIndex: idx, field: name });
      }
    }
  }
  walkAny(extensions, sink, varsSet, ctxExt, prevAvailable);

  for (const sub of ["redirects", "security", "timeout"] as const) {
    const ext = (cfg[sub] ?? {}).extensions;
    if (ext) {
      if (!extensionsActive) {
        for (const name of Object.keys(ext)) {
          sink.warning("EXT_FIELD_INACTIVE", { callIndex: idx, field: `${sub}.${name}` });
        }
      }
      walkAny(ext, sink, varsSet, ctxExt, prevAvailable);
    }
  }
}

function validateCookieJar(jar: string, cfg: AstNode, idx: number, sink: DiagnosticSink): void {
  if (COOKIE_JAR_FIXED.has(jar)) {
    if (cfg.clearCookies && jar !== "selective_clear") {
      sink.error("CLEAR_COOKIES_WRONG_JAR", { callIndex: idx });
    }
    return;
  }
  if (jar.startsWith("named:")) {
    if (jar === "named:") {
      sink.error("COOKIE_JAR_NAMED_EMPTY", { callIndex: idx });
      return;
    }
    if (!COOKIE_JAR_NAMED_RE.test(jar)) {
      sink.error("COOKIE_JAR_FORMAT", { callIndex: idx, field: "cookieJar" });
      return;
    }
    if (cfg.clearCookies) {
      sink.error("CLEAR_COOKIES_WRONG_JAR", { callIndex: idx });
    }
    return;
  }
  const m = COOKIE_JAR_NAMED_SELECTIVE_RE.exec(jar);
  if (m) {
    return;
  }
  sink.error("COOKIE_JAR_FORMAT", { callIndex: idx, field: "cookieJar" });
}

// -- scope / assert / store --

function validateScopeBlock(
  block: AstNode,
  _call: AstNode,
  idx: number,
  method: string,
  sink: DiagnosticSink,
  varsSet: Set<string>,
  prevAvailable: boolean,
): void {
  const realKeys = Object.keys(block).filter(k => !k.startsWith("__"));
  if (realKeys.length === 0) {
    sink.error("EMPTY_SCOPE_BLOCK", { callIndex: idx, chainMethod: method });
    return;
  }

  const ctxInfo: ExprCtx = {
    callIndex: idx, chainMethod: method, allowThis: true, allowExtensionFuncs: false,
  };
  const ctxOpts: ExprCtx = {
    callIndex: idx, chainMethod: method, allowThis: true, allowExtensionFuncs: true,
  };

  for (const field of realKeys) {
    const sv = block[field];
    if ("op" in sv && !OP_VALUES.has(sv.op)) {
      sink.error("OP_VALUE_INVALID", { callIndex: idx, chainMethod: method, field });
    }
    if (field === "bodySize") {
      const val = sv.value;
      if (
        val != null && typeof val === "object" && val.kind === "literal"
        && val.valueType === "string"
      ) {
        if (!MAX_BODY_RE.test(String(val.value))) {
          sink.error("MAX_BODY_FORMAT", { callIndex: idx, chainMethod: method, field });
        }
      }
    }
    walkAny(sv.value, sink, varsSet, ctxInfo, prevAvailable);
    walkAny(sv.options, sink, varsSet, ctxOpts, prevAvailable);
  }
}

function validateAssertBlock(
  block: AstNode,
  _call: AstNode,
  idx: number,
  sink: DiagnosticSink,
  varsSet: Set<string>,
  prevAvailable: boolean,
): void {
  const clauses = ["expect", "check"].filter(c => c in block);
  const ctxInfo: ExprCtx = {
    callIndex: idx, chainMethod: "assert", allowThis: true, allowExtensionFuncs: false,
  };
  const ctxOpts: ExprCtx = {
    callIndex: idx, chainMethod: "assert", allowThis: true, allowExtensionFuncs: true,
  };
  let total = 0;
  for (const c of clauses) {
    const items: AstNode[] = block[c] ?? [];
    total += items.length;
    for (const it of items) {
      walkAny(it.condition, sink, varsSet, ctxInfo, prevAvailable);
      walkAny(it.options, sink, varsSet, ctxOpts, prevAvailable);
    }
  }
  if (clauses.length === 0 || total === 0) {
    sink.error("EMPTY_ASSERT_BLOCK", { callIndex: idx, chainMethod: "assert" });
    return;
  }
}

function validateStoreBlock(
  block: AstNode,
  _call: AstNode,
  idx: number,
  sink: DiagnosticSink,
  varsSet: Set<string>,
  prevAvailable: boolean,
  runVarAssigned: Map<string, number>,
): void {
  const keys = Object.keys(block).filter(k => !k.startsWith("__"));
  if (keys.length === 0) {
    sink.error("EMPTY_STORE_BLOCK", { callIndex: idx, chainMethod: "store" });
    return;
  }
  const ctxInfo: ExprCtx = {
    callIndex: idx, chainMethod: "store", allowThis: true, allowExtensionFuncs: false,
  };
  for (const key of keys) {
    const entry = block[key];
    // RUN_VAR write-once enforcement.
    if (entry.scope === "run") {
      const bare = key.startsWith("$$") ? key.slice(2) : key;
      if (runVarAssigned.has(bare)) {
        sink.error("RUN_VAR_REASSIGNED", { callIndex: idx, chainMethod: "store" });
      } else {
        runVarAssigned.set(bare, idx);
      }
    }
    walkAny(entry.value, sink, varsSet, ctxInfo, prevAvailable);
  }
}

// -- expression walking --

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function walkBody(
  body: unknown,
  sink: DiagnosticSink,
  varsSet: Set<string>,
  ctx: ExprCtx,
  prevAvailable: boolean,
): void {
  if (body == null || typeof body !== "object") return;
  const b = body as AstNode;
  if (b.type === "json" || b.type === "form") {
    walkAny(b.value, sink, varsSet, ctx, prevAvailable);
  }
}

function walkAny(
  node: unknown,
  sink: DiagnosticSink,
  varsSet: Set<string>,
  ctx: ExprCtx,
  prevAvailable: boolean,
): void {
  if (node == null) return;
  if (Array.isArray(node)) {
    for (const item of node) {
      walkAny(item, sink, varsSet, ctx, prevAvailable);
    }
    return;
  }
  if (typeof node === "object") {
    const n = node as AstNode;
    const kind = n.kind;
    if (kind == null) {
      // container/map -- recurse into all values
      for (const v of Object.values(n)) {
        walkAny(v, sink, varsSet, ctx, prevAvailable);
      }
      return;
    }
    walkExpr(n, sink, varsSet, ctx, prevAvailable);
  }
}

function walkExpr(
  expr: AstNode,
  sink: DiagnosticSink,
  varsSet: Set<string>,
  ctx: ExprCtx,
  prevAvailable: boolean,
): void {
  const kind = expr.kind;
  if (kind === "binary") {
    walkExpr(expr.left, sink, varsSet, ctx, prevAvailable);
    walkExpr(expr.right, sink, varsSet, ctx, prevAvailable);
  } else if (kind === "unary") {
    walkExpr(expr.operand, sink, varsSet, ctx, prevAvailable);
  } else if (kind === "thisRef") {
    if (!ctx.allowThis) {
      sink.error("THIS_OUT_OF_SCOPE", { callIndex: ctx.callIndex, chainMethod: ctx.chainMethod });
    }
  } else if (kind === "prevRef") {
    if (!prevAvailable) {
      sink.warning("PREV_WITHOUT_RESULTS", { callIndex: ctx.callIndex, chainMethod: ctx.chainMethod });
    }
  } else if (kind === "funcCall") {
    const name: string = expr.name;
    const args: unknown[] = expr.args ?? [];
    if (CORE_FUNCS.has(name)) {
      checkCoreFuncArgs(name, args as AstNode[], sink, ctx, varsSet);
    } else if (ctx.allowExtensionFuncs) {
      // extension contexts accept anything
    } else {
      sink.error("UNKNOWN_FUNCTION", { callIndex: ctx.callIndex, chainMethod: ctx.chainMethod, field: name });
    }
    for (const a of args) {
      walkAny(a, sink, varsSet, ctx, prevAvailable);
    }
  } else if (kind === "scriptVar") {
    const name: string = expr.name ?? "";
    if (varsSet.size > 0 && !varsSet.has(name)) {
      sink.error("VARIABLE_UNKNOWN", { callIndex: ctx.callIndex, chainMethod: ctx.chainMethod, field: name });
    }
  } else if (kind === "runVar" || kind === "literal") {
    return;
  } else if (kind === "objectLit") {
    for (const e of expr.entries ?? []) {
      walkAny(e.value, sink, varsSet, ctx, prevAvailable);
    }
  } else if (kind === "arrayLit") {
    for (const it of expr.items ?? []) {
      walkAny(it, sink, varsSet, ctx, prevAvailable);
    }
  }
}

function checkCoreFuncArgs(
  name: string,
  args: AstNode[],
  sink: DiagnosticSink,
  ctx: ExprCtx,
  varsSet: Set<string>,
): void {
  if (name === "json" || name === "form") {
    if (args.length !== 1 || typeof args[0] !== "object" || args[0]?.kind !== "objectLit") {
      sink.error("FUNC_ARG_TYPE", { callIndex: ctx.callIndex, chainMethod: ctx.chainMethod, field: name });
    }
  } else if (name === "schema") {
    if (args.length !== 1 || typeof args[0] !== "object" || args[0]?.kind !== "scriptVar") {
      sink.error("FUNC_ARG_TYPE", { callIndex: ctx.callIndex, chainMethod: ctx.chainMethod, field: name });
    } else if (varsSet.size > 0 && !varsSet.has(args[0].name)) {
      sink.error("SCHEMA_VAR_UNKNOWN", { callIndex: ctx.callIndex, chainMethod: ctx.chainMethod, field: args[0].name });
    }
  }
}

/**
 * Recursive descent parser for Lace -- emits AST objects matching `ast.json`.
 *
 * The parser is permissive: it accepts any syntactically well-formed script,
 * including calls to unknown identifiers and extension-shaped fields. The
 * validator (spec §12) is responsible for rejecting semantic errors.
 *
 * Grammar reference: `lacelang.g4`.
 */

import { Token, tokenize } from "./lexer.js";

// A string literal whose content is *exactly* one of:
//   $$ident        -> run_var
//   $ident         -> script_var
// collapses to the corresponding expression node at parse time.
const PURE_RUN_RE = /^\$\$([a-zA-Z_][a-zA-Z0-9_]*)$/;
const PURE_VAR_RE = /^\$([a-zA-Z_][a-zA-Z0-9_]*)$/;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AstNode = Record<string, any>;

function stringToExpr(s: string): AstNode {
  let m = PURE_RUN_RE.exec(s);
  if (m) {
    return { kind: "runVar", name: m[1] };
  }
  m = PURE_VAR_RE.exec(s);
  if (m) {
    return { kind: "scriptVar", name: m[1] };
  }
  return { kind: "literal", valueType: "string", value: s };
}

export const AST_VERSION = "0.9.2";

const SCOPE_NAMES: ReadonlySet<string> = new Set([
  "status", "body", "headers", "bodySize", "totalDelayMs",
  "dns", "connect", "tls", "ttfb", "transfer", "size",
  "redirects",
]);

const CALL_FIELD_KEYWORDS: ReadonlySet<string> = new Set([
  "headers", "body", "cookies", "cookieJar", "clearCookies",
  "redirects", "security", "timeout",
]);

export class ParseError extends Error {
  message: string;
  line: number;

  constructor(message: string, line: number) {
    super(`line ${line}: ${message}`);
    this.message = message;
    this.line = line;
  }
}

const EQ_OPS: ReadonlySet<string> = new Set(["eq", "neq"]);
const ORD_OPS: ReadonlySet<string> = new Set(["lt", "lte", "gt", "gte"]);

class Parser {
  private tokens: Token[];
  private pos: number = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  // -- token helpers --

  private get tok(): Token {
    return this.tokens[this.pos];
  }

  private peek(offset: number = 0): Token {
    return this.tokens[this.pos + offset];
  }

  private advance(): Token {
    const t = this.tokens[this.pos];
    if (this.pos < this.tokens.length - 1) {
      this.pos++;
    }
    return t;
  }

  private check(ttype: string, value?: string): boolean {
    const t = this.tok;
    if (t.type !== ttype) return false;
    if (value !== undefined && t.value !== value) return false;
    return true;
  }

  private match(ttype: string, value?: string): Token | null {
    if (this.check(ttype, value)) {
      return this.advance();
    }
    return null;
  }

  private expect(ttype: string, value?: string): Token {
    if (this.check(ttype, value)) {
      return this.advance();
    }
    const want = value !== undefined ? value : ttype;
    const got = this.tok.value || this.tok.type;
    throw new ParseError(`expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`, this.tok.line);
  }

  private expectKw(...kws: string[]): Token {
    if (this.tok.type === "KEYWORD" && kws.includes(this.tok.value)) {
      return this.advance();
    }
    const got = this.tok.value || this.tok.type;
    throw new ParseError(`expected keyword one of ${JSON.stringify(kws)}, got ${JSON.stringify(got)}`, this.tok.line);
  }

  private isIdentKey(): boolean {
    return this.tok.type === "IDENT" || this.tok.type === "KEYWORD";
  }

  // -- script --

  parseScript(): AstNode {
    const calls: AstNode[] = [this.parseCall()];
    while (!this.check("EOF")) {
      calls.push(this.parseCall());
    }
    this.expect("EOF");
    return { version: AST_VERSION, calls };
  }

  // -- call --

  private parseCall(): AstNode {
    const methodTok = this.expectKw("get", "post", "put", "patch", "delete");
    this.expect("LPAREN");
    const urlTok = this.expect("STRING");
    const call: AstNode = { method: methodTok.value, url: urlTok.value };
    if (this.match("COMMA")) {
      call.config = this.parseCallConfig();
    }
    this.expect("RPAREN");
    call.chain = this.parseChain();
    return call;
  }

  // -- call config --

  private parseCallConfig(): AstNode {
    this.expect("LBRACE");
    const config: AstNode = {};
    const extensions: AstNode = {};
    while (!this.check("RBRACE")) {
      const key = this.tok;
      if (key.type === "KEYWORD" && CALL_FIELD_KEYWORDS.has(key.value)) {
        this.advance();
        this.expect("COLON");
        this.parseCallField(key.value, config);
      } else if (key.type === "IDENT") {
        this.advance();
        this.expect("COLON");
        extensions[key.value] = this.parseOptionsValue();
      } else {
        throw new ParseError(`unexpected call config field ${JSON.stringify(key.value)}`, key.line);
      }
      if (!this.match("COMMA")) break;
    }
    this.expect("RBRACE");
    if (Object.keys(extensions).length > 0) {
      config.extensions = extensions;
    }
    return config;
  }

  private parseCallField(name: string, config: AstNode): void {
    if (name === "headers") {
      config.headers = this.objLitToMap(this.parseObjectLit());
    } else if (name === "body") {
      config.body = this.parseBodyValue();
    } else if (name === "cookies") {
      config.cookies = this.objLitToMap(this.parseObjectLit());
    } else if (name === "cookieJar") {
      const tok = this.expect("STRING");
      config.cookieJar = tok.value;
    } else if (name === "clearCookies") {
      this.expect("LBRACK");
      const vals: string[] = [this.expect("STRING").value];
      while (this.match("COMMA")) {
        if (this.check("RBRACK")) break;
        vals.push(this.expect("STRING").value);
      }
      this.expect("RBRACK");
      config.clearCookies = vals;
    } else if (name === "redirects") {
      config.redirects = this.parseTypedObj({ follow: "BOOL", max: "INT" });
    } else if (name === "security") {
      config.security = this.parseTypedObj({ rejectInvalidCerts: "BOOL" });
    } else if (name === "timeout") {
      config.timeout = this.parseTypedObj({ ms: "INT", action: "STRING", retries: "INT" });
    }
  }

  private parseTypedObj(fields: Record<string, string>): AstNode {
    this.expect("LBRACE");
    const obj: AstNode = {};
    const extensions: AstNode = {};
    while (!this.check("RBRACE")) {
      const key = this.tok;
      if (key.type === "KEYWORD" && key.value in fields) {
        this.advance();
        this.expect("COLON");
        const expected = fields[key.value];
        if (expected === "BOOL") {
          const t = this.expect("BOOL");
          obj[key.value] = t.value === "true";
        } else if (expected === "INT") {
          const t = this.expect("INT");
          obj[key.value] = parseInt(t.value, 10);
        } else if (expected === "STRING") {
          const t = this.expect("STRING");
          obj[key.value] = t.value;
        }
      } else if (key.type === "IDENT") {
        this.advance();
        this.expect("COLON");
        extensions[key.value] = this.parseOptionsValue();
      } else {
        throw new ParseError(`unexpected field ${JSON.stringify(key.value)}`, key.line);
      }
      if (!this.match("COMMA")) break;
    }
    this.expect("RBRACE");
    if (Object.keys(extensions).length > 0) {
      obj.extensions = extensions;
    }
    return obj;
  }

  private parseBodyValue(): AstNode {
    if (this.check("KEYWORD", "json")) {
      this.advance();
      this.expect("LPAREN");
      const val = this.parseObjectLit();
      this.expect("RPAREN");
      return { type: "json", value: val };
    }
    if (this.check("KEYWORD", "form")) {
      this.advance();
      this.expect("LPAREN");
      const val = this.parseObjectLit();
      this.expect("RPAREN");
      return { type: "form", value: val };
    }
    if (this.check("STRING")) {
      return { type: "raw", value: this.advance().value };
    }
    throw new ParseError(`expected body value, got ${JSON.stringify(this.tok.value)}`, this.tok.line);
  }

  // -- chain --

  private parseChain(): AstNode {
    const chain: AstNode = {};
    const order: string[] = [];
    const duplicates: string[] = [];

    if (!this.check("DOT")) {
      throw new ParseError("expected chain method after call arguments", this.tok.line);
    }

    while (this.match("DOT")) {
      const nameTok = this.expectKw("expect", "check", "assert", "store", "wait");
      const name = nameTok.value;
      if (name in chain) {
        duplicates.push(name);
      }
      order.push(name);
      this.expect("LPAREN");
      if (name === "expect" || name === "check") {
        chain[name] = this.parseScopeList();
      } else if (name === "assert") {
        chain[name] = this.parseAssertBlock();
      } else if (name === "store") {
        chain[name] = this.parseStoreBlock();
      } else if (name === "wait") {
        const t = this.expect("INT");
        chain[name] = parseInt(t.value, 10);
      }
      this.expect("RPAREN");
    }

    chain.__order = order;
    if (duplicates.length > 0) {
      chain.__duplicates = duplicates;
    }
    return chain;
  }

  // -- scope blocks --

  private parseScopeList(): AstNode {
    const block: AstNode = {};
    const duplicates: string[] = [];
    if (this.check("RPAREN")) {
      block.__order = [];
      return block;
    }
    const order: string[] = [];
    while (true) {
      const name = this.parseScopeName();
      this.expect("COLON");
      const val = this.parseScopeVal();
      if (name in block) {
        duplicates.push(name);
      }
      block[name] = val;
      order.push(name);
      if (!this.match("COMMA")) break;
      if (this.check("RPAREN")) break;
    }
    block.__order = order;
    if (duplicates.length > 0) {
      block.__duplicates = duplicates;
    }
    return block;
  }

  private parseScopeName(): string {
    if (this.tok.type === "KEYWORD" && SCOPE_NAMES.has(this.tok.value)) {
      return this.advance().value;
    }
    throw new ParseError(`expected scope name, got ${JSON.stringify(this.tok.value)}`, this.tok.line);
  }

  private parseScopeVal(): AstNode {
    // Full form: { value:, op:, options: }
    if (this.check("LBRACE")) {
      return this.parseScopeFullForm();
    }
    // Array shorthand: [ expr, ... ]
    if (this.check("LBRACK")) {
      return { value: this.parseArrayLit() };
    }
    // Scalar shorthand: single expression
    return { value: this.parseExpr() };
  }

  private parseScopeFullForm(): AstNode {
    this.expect("LBRACE");
    const out: AstNode = {};
    while (!this.check("RBRACE")) {
      const k = this.tok;
      if (k.type === "KEYWORD" && k.value === "value") {
        this.advance();
        this.expect("COLON");
        if (this.check("LBRACK")) {
          out.value = this.parseArrayLit();
        } else {
          out.value = this.parseExpr();
        }
      } else if (k.type === "KEYWORD" && k.value === "op") {
        this.advance();
        this.expect("COLON");
        const t = this.expect("STRING");
        out.op = t.value;
      } else if (k.type === "KEYWORD" && k.value === "match") {
        this.advance();
        this.expect("COLON");
        const t = this.expect("STRING");
        out.match = t.value;
      } else if (k.type === "KEYWORD" && k.value === "mode") {
        this.advance();
        this.expect("COLON");
        const t = this.expect("STRING");
        out.mode = t.value;
      } else if (k.type === "KEYWORD" && k.value === "options") {
        this.advance();
        this.expect("COLON");
        out.options = this.parseOptionsObj();
      } else {
        throw new ParseError(`unexpected scope field ${JSON.stringify(k.value)}`, k.line);
      }
      if (!this.match("COMMA")) break;
    }
    this.expect("RBRACE");
    if (!("value" in out)) {
      throw new ParseError("scope full form requires 'value'", this.tok.line);
    }
    return out;
  }

  // -- options (extension passthrough) --

  private parseOptionsObj(): AstNode {
    this.expect("LBRACE");
    const out: AstNode = {};
    if (this.match("RBRACE")) {
      return out;
    }
    while (true) {
      const key = this.expect("IDENT");
      this.expect("COLON");
      out[key.value] = this.parseOptionsValue();
      if (!this.match("COMMA")) break;
      if (this.check("RBRACE")) break;
    }
    this.expect("RBRACE");
    return out;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private parseOptionsValue(): any {
    if (this.check("LBRACE")) {
      return this.parseObjectLit();
    }
    if (this.check("LBRACK")) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const items: any[] = [];
      this.expect("LBRACK");
      if (!this.check("RBRACK")) {
        while (true) {
          items.push(this.parseOptionsValue());
          if (!this.match("COMMA")) break;
          if (this.check("RBRACK")) break;
        }
      }
      this.expect("RBRACK");
      return { kind: "arrayLit", items };
    }
    return this.parseExpr();
  }

  // -- assert / store --

  private parseAssertBlock(): AstNode {
    this.expect("LBRACE");
    const out: AstNode = {};
    while (!this.check("RBRACE")) {
      const k = this.tok;
      if (k.type === "KEYWORD" && (k.value === "expect" || k.value === "check")) {
        this.advance();
        this.expect("COLON");
        this.expect("LBRACK");
        const items: AstNode[] = [];
        if (!this.check("RBRACK")) {
          while (true) {
            items.push(this.parseConditionItem());
            if (!this.match("COMMA")) break;
            if (this.check("RBRACK")) break;
          }
        }
        this.expect("RBRACK");
        out[k.value] = items;
      } else {
        throw new ParseError(`unexpected assert clause ${JSON.stringify(k.value)}`, k.line);
      }
      if (!this.match("COMMA")) break;
    }
    this.expect("RBRACE");
    return out;
  }

  private parseConditionItem(): AstNode {
    if (this.check("LBRACE")) {
      // full form -- but only if a known field appears; peek ahead.
      const save = this.pos;
      this.advance();
      const first = this.tok;
      this.pos = save;
      if (first.type === "KEYWORD" && (first.value === "condition" || first.value === "options")) {
        return this.parseConditionFullForm();
      }
    }
    return { condition: this.parseExpr() };
  }

  private parseConditionFullForm(): AstNode {
    this.expect("LBRACE");
    const out: AstNode = {};
    while (!this.check("RBRACE")) {
      const k = this.tok;
      if (k.type === "KEYWORD" && k.value === "condition") {
        this.advance();
        this.expect("COLON");
        out.condition = this.parseExpr();
      } else if (k.type === "KEYWORD" && k.value === "options") {
        this.advance();
        this.expect("COLON");
        out.options = this.parseOptionsObj();
      } else {
        throw new ParseError(`unexpected condition field ${JSON.stringify(k.value)}`, k.line);
      }
      if (!this.match("COMMA")) break;
    }
    this.expect("RBRACE");
    if (!("condition" in out)) {
      throw new ParseError("condition full form requires 'condition'", this.tok.line);
    }
    return out;
  }

  private parseStoreBlock(): AstNode {
    this.expect("LBRACE");
    const out: AstNode = {};
    if (this.match("RBRACE")) {
      return out;
    }
    while (true) {
      const [key, srcKey] = this.parseStoreKey();
      this.expect("COLON");
      const val = this.parseExpr();
      const scope = srcKey.startsWith("$$") ? "run" : "writeback";
      out[key] = { scope, value: val };
      if (!this.match("COMMA")) break;
      if (this.check("RBRACE")) break;
    }
    this.expect("RBRACE");
    return out;
  }

  private parseStoreKey(): [string, string] {
    const t = this.tok;
    if (t.type === "RUN_VAR") {
      this.advance();
      return [t.value, t.value];
    }
    if (t.type === "SCRIPT_VAR") {
      this.advance();
      return [t.value, t.value];
    }
    if (t.type === "STRING") {
      this.advance();
      return [t.value, t.value];
    }
    if (this.isIdentKey()) {
      this.advance();
      return [t.value, t.value];
    }
    throw new ParseError(`unexpected store key ${JSON.stringify(t.value)}`, t.line);
  }

  // -- expressions --
  // Precedence climb: or < and < eq < ord < addsub < muldiv < unary < primary

  parseExpr(): AstNode {
    return this.parseOr();
  }

  private parseOr(): AstNode {
    let left = this.parseAnd();
    while (this.tok.type === "KEYWORD" && this.tok.value === "or") {
      this.advance();
      const right = this.parseAnd();
      left = { kind: "binary", op: "or", left, right };
    }
    return left;
  }

  private parseAnd(): AstNode {
    let left = this.parseEq();
    while (this.tok.type === "KEYWORD" && this.tok.value === "and") {
      this.advance();
      const right = this.parseEq();
      left = { kind: "binary", op: "and", left, right };
    }
    return left;
  }

  private parseEq(): AstNode {
    let left = this.parseOrd();
    if (this.tok.type === "KEYWORD" && EQ_OPS.has(this.tok.value)) {
      const op = this.advance().value;
      const right = this.parseOrd();
      left = { kind: "binary", op, left, right };
      if (this.tok.type === "KEYWORD" && EQ_OPS.has(this.tok.value)) {
        throw new ParseError(
          `chained comparison ${JSON.stringify(op)}: comparisons do not associate; ` +
          "use `and`/`or` with parentheses to combine",
          this.tok.line,
        );
      }
    }
    return left;
  }

  private parseOrd(): AstNode {
    let left = this.parseAddsub();
    if (this.tok.type === "KEYWORD" && ORD_OPS.has(this.tok.value)) {
      const op = this.advance().value;
      const right = this.parseAddsub();
      left = { kind: "binary", op, left, right };
      if (this.tok.type === "KEYWORD" && ORD_OPS.has(this.tok.value)) {
        throw new ParseError(
          `chained comparison ${JSON.stringify(op)}: comparisons do not associate; ` +
          "use `and`/`or` with parentheses to combine",
          this.tok.line,
        );
      }
    }
    return left;
  }

  private parseAddsub(): AstNode {
    let left = this.parseMuldiv();
    while (this.tok.type === "PLUS" || this.tok.type === "MINUS") {
      const op = this.advance().value;
      const right = this.parseMuldiv();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  private parseMuldiv(): AstNode {
    let left = this.parseUnary();
    while (this.tok.type === "STAR" || this.tok.type === "SLASH" || this.tok.type === "PERCENT") {
      const op = this.advance().value;
      const right = this.parseUnary();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  private parseUnary(): AstNode {
    if (this.tok.type === "KEYWORD" && this.tok.value === "not") {
      this.advance();
      return { kind: "unary", op: "not", operand: this.parseUnary() };
    }
    if (this.tok.type === "MINUS") {
      this.advance();
      return { kind: "unary", op: "-", operand: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): AstNode {
    const t = this.tok;
    if (t.type === "LPAREN") {
      this.advance();
      const e = this.parseExpr();
      this.expect("RPAREN");
      return e;
    }
    if (t.type === "LBRACK") {
      return this.parseArrayLit();
    }
    if (t.type === "LBRACE") {
      return this.parseObjectLit();
    }
    if (t.type === "KEYWORD" && t.value === "this") {
      return this.parseThisRef();
    }
    if (t.type === "KEYWORD" && t.value === "prev") {
      return this.parsePrevRef();
    }
    if (t.type === "RUN_VAR") {
      this.advance();
      return this.parseVarTail({ kind: "runVar", name: t.value.slice(2), path: [] });
    }
    if (t.type === "SCRIPT_VAR") {
      this.advance();
      return this.parseVarTail({ kind: "scriptVar", name: t.value.slice(1), path: [] });
    }
    if (t.type === "STRING") {
      this.advance();
      return stringToExpr(t.value);
    }
    if (t.type === "INT") {
      this.advance();
      return { kind: "literal", valueType: "int", value: parseInt(t.value, 10) };
    }
    if (t.type === "FLOAT") {
      this.advance();
      return { kind: "literal", valueType: "float", value: parseFloat(t.value) };
    }
    if (t.type === "BOOL") {
      this.advance();
      return { kind: "literal", valueType: "bool", value: t.value === "true" };
    }
    if (t.type === "KEYWORD" && t.value === "null") {
      this.advance();
      return { kind: "literal", valueType: "null", value: null };
    }
    // function call: IDENT or keyword in {json, form, schema} followed by (
    if (
      (t.type === "IDENT" || (t.type === "KEYWORD" && (t.value === "json" || t.value === "form" || t.value === "schema")))
      && this.peek(1).type === "LPAREN"
    ) {
      return this.parseFuncCall();
    }
    throw new ParseError(`unexpected token ${JSON.stringify(t.value)}`, t.line);
  }

  private parseVarTail(node: AstNode): AstNode {
    const path: AstNode[] = [];
    while (true) {
      if (this.match("DOT")) {
        if (!this.isIdentKey()) {
          throw new ParseError("expected field name after '.'", this.tok.line);
        }
        path.push({ type: "field", name: this.advance().value });
      } else if (this.match("LBRACK")) {
        const idx = this.expect("INT");
        this.expect("RBRACK");
        path.push({ type: "index", index: parseInt(idx.value, 10) });
      } else {
        break;
      }
    }
    if (path.length > 0) {
      node.path = path;
    } else {
      delete node.path;
    }
    return node;
  }

  private parseThisRef(): AstNode {
    this.advance(); // this
    const path: string[] = [];
    while (this.match("DOT")) {
      if (!this.isIdentKey()) {
        throw new ParseError("expected field name after '.'", this.tok.line);
      }
      path.push(this.advance().value);
    }
    if (path.length === 0) {
      throw new ParseError("'this' requires at least one '.field'", this.tok.line);
    }
    return { kind: "thisRef", path };
  }

  private parsePrevRef(): AstNode {
    this.advance(); // prev
    const path: AstNode[] = [];
    while (true) {
      if (this.match("DOT")) {
        if (!this.isIdentKey()) {
          throw new ParseError("expected field name after '.'", this.tok.line);
        }
        path.push({ type: "field", name: this.advance().value });
      } else if (this.match("LBRACK")) {
        const t = this.expect("INT");
        this.expect("RBRACK");
        path.push({ type: "index", index: parseInt(t.value, 10) });
      } else {
        break;
      }
    }
    return { kind: "prevRef", path };
  }

  private parseFuncCall(): AstNode {
    const name = this.advance().value;
    this.expect("LPAREN");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const args: any[] = [];
    if (!this.check("RPAREN")) {
      while (true) {
        if (this.check("LBRACE")) {
          args.push(this.parseObjectLit());
        } else {
          args.push(this.parseExpr());
        }
        if (!this.match("COMMA")) break;
        if (this.check("RPAREN")) break;
      }
    }
    this.expect("RPAREN");
    return { kind: "funcCall", name, args };
  }

  // -- object / array literals --

  parseObjectLit(): AstNode {
    this.expect("LBRACE");
    const entries: AstNode[] = [];
    if (this.match("RBRACE")) {
      return { kind: "objectLit", entries };
    }
    while (true) {
      const k = this.tok;
      let key: string;
      if (k.type === "STRING") {
        key = this.advance().value;
      } else if (this.isIdentKey()) {
        key = this.advance().value;
      } else {
        throw new ParseError(`expected object key, got ${JSON.stringify(k.value)}`, k.line);
      }
      this.expect("COLON");
      entries.push({ key, value: this.parseExpr() });
      if (!this.match("COMMA")) break;
      if (this.check("RBRACE")) break;
    }
    this.expect("RBRACE");
    return { kind: "objectLit", entries };
  }

  parseArrayLit(): AstNode {
    this.expect("LBRACK");
    const items: AstNode[] = [];
    if (this.match("RBRACK")) {
      return { kind: "arrayLit", items };
    }
    while (true) {
      items.push(this.parseExpr());
      if (!this.match("COMMA")) break;
      if (this.check("RBRACK")) break;
    }
    this.expect("RBRACK");
    return { kind: "arrayLit", items };
  }

  // -- small helpers --

  private objLitToMap(lit: AstNode): AstNode {
    const out: AstNode = {};
    for (const e of lit.entries) {
      out[e.key] = e.value;
    }
    return out;
  }
}

export function parse(source: string): AstNode {
  const tokens = tokenize(source);
  return new Parser(tokens).parseScript();
}

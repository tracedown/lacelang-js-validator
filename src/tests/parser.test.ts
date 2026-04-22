import { describe, it, expect } from "vitest";
import { parse, ParseError } from "../parser.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stripAstMetadata(node: any): any {
  if (Array.isArray(node)) return node.map(stripAstMetadata);
  if (node != null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (!k.startsWith("__")) out[k] = stripAstMetadata(v);
    }
    return out;
  }
  return node;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function _parse(src: string): any {
  return stripAstMetadata(parse(src));
}

describe("CallParsing", () => {
  it("get", () => {
    const ast = _parse('get("https://example.com")\n    .expect(status: 200)\n');
    expect(ast.version).toBe("0.9.1");
    expect(ast.calls.length).toBe(1);
    expect(ast.calls[0].method).toBe("get");
    expect(ast.calls[0].url).toBe("https://example.com");
  });

  it("all methods", () => {
    for (const m of ["get", "post", "put", "patch", "delete"]) {
      const ast = _parse(`${m}("$u")\n    .expect(status: 200)\n`);
      expect(ast.calls[0].method).toBe(m);
    }
  });

  it("multiple calls", () => {
    const ast = _parse(
      'get("$a")\n    .expect(status: 200)\n'
      + 'post("$b")\n    .expect(status: 201)\n'
    );
    expect(ast.calls.length).toBe(2);
    expect(ast.calls[0].method).toBe("get");
    expect(ast.calls[1].method).toBe("post");
  });
});

describe("CallConfig", () => {
  it("headers", () => {
    const ast = _parse(
      'get("$u", {\n    headers: { "X-Token": "abc" }\n})\n    .expect(status: 200)\n'
    );
    expect("X-Token" in ast.calls[0].config.headers).toBe(true);
  });

  it("body json", () => {
    const ast = _parse(
      'post("$u", {\n    body: json({ key: "val" })\n})\n    .expect(status: 200)\n'
    );
    expect(ast.calls[0].config.body.type).toBe("json");
  });

  it("body form", () => {
    const ast = _parse(
      'post("$u", {\n    body: form({ key: "val" })\n})\n    .expect(status: 200)\n'
    );
    expect(ast.calls[0].config.body.type).toBe("form");
  });

  it("body raw string", () => {
    const ast = _parse(
      'post("$u", {\n    body: "raw data"\n})\n    .expect(status: 200)\n'
    );
    expect(ast.calls[0].config.body.type).toBe("raw");
  });

  it("timeout", () => {
    const ast = _parse(
      'get("$u", {\n    timeout: { ms: 5000, action: "fail" }\n})\n    .expect(status: 200)\n'
    );
    expect(ast.calls[0].config.timeout.ms).toBe(5000);
    expect(ast.calls[0].config.timeout.action).toBe("fail");
  });

  it("redirects", () => {
    const ast = _parse(
      'get("$u", {\n    redirects: { follow: true, max: 3 }\n})\n    .expect(status: 200)\n'
    );
    expect(ast.calls[0].config.redirects.follow).toBe(true);
    expect(ast.calls[0].config.redirects.max).toBe(3);
  });

  it("security", () => {
    const ast = _parse(
      'get("$u", {\n    security: { rejectInvalidCerts: false }\n})\n    .expect(status: 200)\n'
    );
    expect(ast.calls[0].config.security.rejectInvalidCerts).toBe(false);
  });

  it("cookie jar", () => {
    const ast = _parse(
      'get("$u", {\n    cookieJar: "fresh"\n})\n    .expect(status: 200)\n'
    );
    expect(ast.calls[0].config.cookieJar).toBe("fresh");
  });
});

describe("ChainMethods", () => {
  it("expect", () => {
    const ast = _parse('get("$u")\n    .expect(status: 200)\n');
    expect("status" in ast.calls[0].chain.expect).toBe(true);
  });

  it("check", () => {
    const ast = _parse('get("$u")\n    .check(status: 200)\n');
    expect("check" in ast.calls[0].chain).toBe(true);
  });

  it("store run var", () => {
    const ast = _parse('get("$u")\n    .expect(status: 200)\n    .store({ $$x: this.status })\n');
    expect("$$x" in ast.calls[0].chain.store).toBe(true);
  });

  it("store script var", () => {
    const ast = _parse('get("$u")\n    .expect(status: 200)\n    .store({ $x: this.status })\n');
    expect("$x" in ast.calls[0].chain.store).toBe(true);
  });

  it("store plain key", () => {
    const ast = _parse('get("$u")\n    .expect(status: 200)\n    .store({ mykey: this.status })\n');
    expect("mykey" in ast.calls[0].chain.store).toBe(true);
  });

  it("assert expect", () => {
    const ast = _parse('get("$u")\n    .assert({ expect: [this.status eq 200] })\n');
    expect(ast.calls[0].chain.assert.expect.length).toBe(1);
  });

  it("assert check", () => {
    const ast = _parse('get("$u")\n    .assert({ check: [this.status eq 200] })\n');
    expect(ast.calls[0].chain.assert.check.length).toBe(1);
  });

  it("wait", () => {
    const ast = _parse('get("$u")\n    .expect(status: 200)\n    .wait(1000)\n');
    expect(ast.calls[0].chain.wait).toBe(1000);
  });
});

describe("ScopeNames", () => {
  for (const scope of [
    "status", "body", "headers", "bodySize", "totalDelayMs",
    "dns", "connect", "tls", "ttfb", "transfer", "size", "redirects",
  ]) {
    it(`scope ${scope} accepted`, () => {
      const ast = _parse(`get("$u")\n    .expect(${scope}: 200)\n`);
      expect(scope in ast.calls[0].chain.expect).toBe(true);
    });
  }
});

describe("Expressions", () => {
  it("int literal", () => {
    const ast = _parse('get("$u")\n    .assert({ expect: [this.status eq 200] })\n');
    const cond = ast.calls[0].chain.assert.expect[0].condition;
    expect(cond.right.value).toBe(200);
  });

  it("string literal", () => {
    const ast = _parse('get("$u")\n    .assert({ expect: [this.body eq "ok"] })\n');
    const cond = ast.calls[0].chain.assert.expect[0].condition;
    expect(cond.right.value).toBe("ok");
  });

  it("bool literal", () => {
    const ast = _parse('get("$u")\n    .assert({ expect: [this.body.valid eq true] })\n');
    const cond = ast.calls[0].chain.assert.expect[0].condition;
    expect(cond.right.value).toBe(true);
  });

  it("null literal", () => {
    const ast = _parse('get("$u")\n    .assert({ expect: [this.body.x eq null] })\n');
    const cond = ast.calls[0].chain.assert.expect[0].condition;
    expect(cond.right.value).toBe(null);
  });

  it("script var", () => {
    const ast = _parse('get("$u")\n    .assert({ expect: [$x eq 1] })\n');
    const cond = ast.calls[0].chain.assert.expect[0].condition;
    expect(cond.left.kind).toBe("scriptVar");
    expect(cond.left.name).toBe("x");
  });

  it("run var", () => {
    const ast = _parse('get("$u")\n    .assert({ expect: [$$x eq 1] })\n');
    const cond = ast.calls[0].chain.assert.expect[0].condition;
    expect(cond.left.kind).toBe("runVar");
  });

  it("this ref", () => {
    const ast = _parse('get("$u")\n    .assert({ expect: [this.status eq 200] })\n');
    const cond = ast.calls[0].chain.assert.expect[0].condition;
    expect(cond.left.kind).toBe("thisRef");
    expect(cond.left.path).toEqual(["status"]);
  });

  it("this nested", () => {
    const ast = _parse('get("$u")\n    .assert({ expect: [this.body.data.id eq 1] })\n');
    const cond = ast.calls[0].chain.assert.expect[0].condition;
    expect(cond.left.path).toEqual(["body", "data", "id"]);
  });

  it("prev ref", () => {
    const ast = _parse('get("$u")\n    .assert({ expect: [prev.outcome eq "success"] })\n');
    const cond = ast.calls[0].chain.assert.expect[0].condition;
    expect(cond.left.kind).toBe("prevRef");
  });

  it("binary ops", () => {
    for (const op of ["eq", "neq", "lt", "lte", "gt", "gte"]) {
      const ast = _parse(`get("$u")\n    .assert({ expect: [this.status ${op} 200] })\n`);
      const cond = ast.calls[0].chain.assert.expect[0].condition;
      expect(cond.op).toBe(op);
    }
  });

  it("arithmetic", () => {
    for (const opSym of ["+", "-", "*", "/", "%"]) {
      const ast = _parse(`get("$u")\n    .assert({ expect: [this.x ${opSym} 1 eq 0] })\n`);
      const cond = ast.calls[0].chain.assert.expect[0].condition;
      expect(cond.left.kind).toBe("binary");
      expect(cond.left.op).toBe(opSym);
    }
  });

  it("logical and", () => {
    const ast = _parse('get("$u")\n    .assert({ expect: [this.a eq 1 and this.b eq 2] })\n');
    const cond = ast.calls[0].chain.assert.expect[0].condition;
    expect(cond.op).toBe("and");
  });

  it("logical or", () => {
    const ast = _parse('get("$u")\n    .assert({ expect: [this.a eq 1 or this.b eq 2] })\n');
    const cond = ast.calls[0].chain.assert.expect[0].condition;
    expect(cond.op).toBe("or");
  });

  it("not", () => {
    const ast = _parse('get("$u")\n    .assert({ expect: [not this.body.disabled] })\n');
    const cond = ast.calls[0].chain.assert.expect[0].condition;
    expect(cond.kind).toBe("unary");
    expect(cond.op).toBe("not");
  });

  it("unary minus", () => {
    const ast = _parse('get("$u")\n    .assert({ expect: [-1 eq this.x] })\n');
    const cond = ast.calls[0].chain.assert.expect[0].condition;
    expect(cond.left.kind).toBe("unary");
    expect(cond.left.op).toBe("-");
  });

  it("array literal", () => {
    const ast = _parse('get("$u")\n    .expect(status: [200, 201, 202])\n');
    const val = ast.calls[0].chain.expect.status.value;
    expect(val.kind).toBe("arrayLit");
    expect(val.items.length).toBe(3);
  });

  it("object literal in store", () => {
    const ast = _parse('get("$u")\n    .expect(status: 200)\n    .store({ $$data: this.body })\n');
    expect("$$data" in ast.calls[0].chain.store).toBe(true);
  });

  it("func call schema", () => {
    const ast = _parse('get("$u")\n    .expect(body: schema($s))\n');
    const val = ast.calls[0].chain.expect.body.value;
    expect(val.kind).toBe("funcCall");
    expect(val.name).toBe("schema");
  });
});

describe("Comments", () => {
  it("comment before call", () => {
    const ast = _parse('// a comment\nget("$u")\n    .expect(status: 200)\n');
    expect(ast.calls.length).toBe(1);
  });

  it("comment between calls", () => {
    const ast = _parse(
      'get("$a")\n    .expect(status: 200)\n// gap\nget("$b")\n    .expect(status: 200)\n'
    );
    expect(ast.calls.length).toBe(2);
  });
});

describe("ParseErrors", () => {
  it("no method", () => {
    expect(() => parse('"https://example.com"\n')).toThrow(ParseError);
  });
  it("unclosed paren", () => {
    expect(() => parse('get("url"\n')).toThrow(ParseError);
  });
  it("invalid keyword as method", () => {
    expect(() => parse('headers("url")\n')).toThrow(ParseError);
  });
});

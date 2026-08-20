import { describe, it, expect } from "vitest";
import { parse } from "../parser.js";
import { fmt } from "../ast-fmt.js";

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

/** Parse `expr` as the sole `.assert({ expect: [...] })` condition and return its AST. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseExpr(expr: string): any {
  const ast = parse(`get("$u")\n    .assert({ expect: [${expr}] })\n`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return stripAstMetadata((ast as any).calls[0].chain.assert.expect[0].condition);
}

describe("fmt object literal keys", () => {
  it("leaves bare identifier keys unquoted", () => {
    expect(fmt(parseExpr("count([{ ok: true, _x1: 2 }]) eq 1")))
      .toBe("count([{ok: true, _x1: 2}]) eq 1");
  });

  it("quotes numeric keys", () => {
    expect(fmt(parseExpr('count([{ "404": 2 }]) eq 1')))
      .toBe('count([{"404": 2}]) eq 1');
  });

  it("quotes hyphenated keys", () => {
    expect(fmt(parseExpr('count([{ "content-type": 1 }]) eq 1')))
      .toBe('count([{"content-type": 1}]) eq 1');
  });

  it("matches the canonical conformance expression", () => {
    const src = 'count([{ "content-type": 1, "404": 2, ok: true }]) eq 1';
    expect(fmt(parseExpr(src)))
      .toBe('count([{"content-type": 1, "404": 2, ok: true}]) eq 1');
  });

  it("round-trips: printed output re-parses to an equal AST", () => {
    const src = 'count([{ "content-type": 1, "404": 2, ok: true }]) eq 1';
    const original = parseExpr(src);
    const printed = fmt(original);
    expect(parseExpr(printed)).toEqual(original);
    // and is stable under a second print
    expect(fmt(parseExpr(printed))).toBe(printed);
  });
});

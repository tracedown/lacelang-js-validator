import { describe, it, expect } from "vitest";
import { parse } from "../parser.js";
import { validate } from "../validator.js";

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

describe("Smoke", () => {
  it("minimal get parses", () => {
    const ast = stripAstMetadata(parse('get("$u").expect(status: 200)\n'));
    expect(ast.version).toBe("0.9.2");
    const [call] = ast.calls;
    expect(call.method).toBe("get");
    expect(call.url).toBe("$u");
    expect(call.chain.expect.status.value.value).toBe(200);
  });

  it("chain order violation", () => {
    const ast = parse('get("$u").store({ a: this.body.x }).assert({ expect: [this.status eq 200] })\n');
    const sink = validate(ast, ["u"]);
    expect(sink.errors.map(e => e.code)).toContain("CHAIN_ORDER");
  });

  it("unknown function", () => {
    const ast = parse('get("$x").assert({ expect: [random() gt 5] })\n');
    const sink = validate(ast, ["x"]);
    expect(sink.errors.map(e => e.code)).toContain("UNKNOWN_FUNCTION");
  });

  it("emit roundtrip matches schema shape", () => {
    const ast = stripAstMetadata(parse(
      'post("$url", { body: json({ a: "$x" }) }).expect(status: 200)\n'
    ));
    const txt = JSON.stringify(ast);
    expect(txt).toContain("objectLit");
    expect(txt).not.toContain("__order");
  });
});

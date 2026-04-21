/**
 * Render AST expressions back to source-form Lace text.
 *
 * Used by the executor to populate the `expression` field on assert-type
 * assertion records (spec §9.2, `assertions[].expression`). The output
 * should round-trip: it parses back to an equivalent AST (modulo whitespace).
 * Operator precedence is preserved by always parenthesising binary
 * sub-expressions that could be ambiguous.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AstNode = Record<string, any>;

const BINARY_PRIORITY: Record<string, number> = {
  "or": 1, "and": 2,
  "eq": 3, "neq": 3,
  "lt": 4, "lte": 4, "gt": 4, "gte": 4,
  "+": 5, "-": 5,
  "*": 6, "/": 6, "%": 6,
};

export function fmt(expr: unknown): string {
  if (expr == null || typeof expr !== "object") {
    return JSON.stringify(expr);
  }
  const node = expr as AstNode;
  const k = node.kind;

  if (k === "literal") {
    const vt = node.valueType;
    const v = node.value;
    if (vt === "string") return JSON.stringify(v);
    if (vt === "null") return "null";
    if (vt === "bool") return v ? "true" : "false";
    return String(v);
  }
  if (k === "scriptVar") {
    return `$${node.name}${fmtVarPath(node.path)}`;
  }
  if (k === "runVar") {
    return `$$${node.name}${fmtVarPath(node.path)}`;
  }
  if (k === "thisRef") {
    return "this" + (node.path ?? []).map((p: string) => `.${p}`).join("");
  }
  if (k === "prevRef") {
    let out = "prev";
    for (const seg of node.path ?? []) {
      out += seg.type === "field" ? `.${seg.name}` : `[${seg.index}]`;
    }
    return out;
  }
  if (k === "unary") {
    const op: string = node.op;
    if (op === "not") {
      return `not ${fmt(node.operand)}`;
    }
    return `${op}${fmt(node.operand)}`;
  }
  if (k === "binary") {
    const op: string = node.op;
    return `${paren(node.left, op)} ${op} ${paren(node.right, op)}`;
  }
  if (k === "funcCall") {
    const args = (node.args ?? []).map((a: unknown) => fmt(a)).join(", ");
    return `${node.name}(${args})`;
  }
  if (k === "objectLit") {
    const entries = (node.entries ?? [])
      .map((e: AstNode) => `${e.key}: ${fmt(e.value)}`)
      .join(", ");
    return `{${entries}}`;
  }
  if (k === "arrayLit") {
    return "[" + (node.items ?? []).map((i: unknown) => fmt(i)).join(", ") + "]";
  }
  return "<unknown>";
}

function fmtVarPath(path: unknown): string {
  if (!path || !Array.isArray(path)) return "";
  let out = "";
  for (const seg of path) {
    if (seg.type === "field") {
      out += `.${seg.name}`;
    } else {
      out += `[${seg.index}]`;
    }
  }
  return out;
}

function paren(sub: unknown, outerOp: string): string {
  if (sub != null && typeof sub === "object" && (sub as AstNode).kind === "binary") {
    const inner = (sub as AstNode).op;
    if ((BINARY_PRIORITY[inner] ?? 99) < (BINARY_PRIORITY[outerOp] ?? 99)) {
      return `(${fmt(sub)})`;
    }
  }
  return fmt(sub);
}

import { describe, it, expect } from "vitest";
import { tokenize, LexError } from "../lexer.js";

function tokens(src: string): [string, string][] {
  return tokenize(src)
    .filter(t => t.type !== "EOF")
    .map(t => [t.type, t.value]);
}

describe("BasicTokens", () => {
  it("string", () => {
    expect(tokens('"hello"')).toEqual([["STRING", "hello"]]);
  });
  it("int", () => {
    expect(tokens("42")).toEqual([["INT", "42"]]);
  });
  it("float", () => {
    expect(tokens("3.14")).toEqual([["FLOAT", "3.14"]]);
  });
  it("bool", () => {
    expect(tokens("true false")).toEqual([["BOOL", "true"], ["BOOL", "false"]]);
  });
  it("ident", () => {
    expect(tokens("myVar")).toEqual([["IDENT", "myVar"]]);
  });
  it("keyword", () => {
    expect(tokens("get")).toEqual([["KEYWORD", "get"]]);
  });
  it("run_var", () => {
    expect(tokens("$$token")[0][0]).toBe("RUN_VAR");
  });
  it("script_var", () => {
    expect(tokens("$host")[0][0]).toBe("SCRIPT_VAR");
  });
});

describe("EscapeSequences", () => {
  it("newline", () => {
    expect(tokens(String.raw`"line\n"`)).toEqual([["STRING", "line\n"]]);
  });
  it("tab", () => {
    expect(tokens(String.raw`"col\t"`)).toEqual([["STRING", "col\t"]]);
  });
  it("backslash", () => {
    expect(tokens(String.raw`"path\\"`)).toEqual([["STRING", "path\\"]]);
  });
  it("quote", () => {
    expect(tokens(String.raw`"say\"hi\""`)).toEqual([["STRING", 'say"hi"']]);
  });
  it("dollar", () => {
    expect(tokens(String.raw`"price\$100"`)).toEqual([["STRING", "price$100"]]);
  });
  it("carriage return", () => {
    expect(tokens(String.raw`"cr\r"`)).toEqual([["STRING", "cr\r"]]);
  });
  it("invalid escape", () => {
    expect(() => tokenize(String.raw`"\z"`)).toThrow(LexError);
  });
});

describe("Punctuation", () => {
  it("all punctuation", () => {
    const types = tokens("(){}[],:.")!.map(([t]) => t);
    expect(types).toEqual(["LPAREN", "RPAREN", "LBRACE", "RBRACE", "LBRACK", "RBRACK", "COMMA", "COLON", "DOT"]);
  });
  it("arithmetic", () => {
    const types = tokens("+ - * / %").map(([t]) => t);
    expect(types).toEqual(["PLUS", "MINUS", "STAR", "SLASH", "PERCENT"]);
  });
});

describe("Comments", () => {
  it("line comment skipped", () => {
    expect(tokens("// this is a comment\nget")).toEqual([["KEYWORD", "get"]]);
  });
  it("inline comment", () => {
    expect(tokens('get // comment\n"url"')).toEqual([["KEYWORD", "get"], ["STRING", "url"]]);
  });
});

describe("EdgeCases", () => {
  it("empty string", () => {
    expect(tokens('""')).toEqual([["STRING", ""]]);
  });
  it("unterminated string", () => {
    expect(() => tokenize('"hello')).toThrow(LexError);
  });
  it("whitespace ignored", () => {
    expect(tokens("   get   ")).toEqual([["KEYWORD", "get"]]);
  });
  it("unknown char", () => {
    expect(() => tokenize("#")).toThrow(LexError);
  });
});

/**
 * Tokenizer matching lacelang.g4 lexer rules.
 *
 * Longest-match with lookahead order:
 *     RUN_VAR > SCRIPT_VAR > keyword > IDENT > numbers > punctuation
 */

export type TokenType =
  // literal / identifier classes
  | "STRING" | "INT" | "FLOAT" | "BOOL" | "IDENT"
  | "RUN_VAR" | "SCRIPT_VAR"
  // keywords — single kind tag; the lexeme carries the specific word
  | "KEYWORD"
  // punctuation
  | "LPAREN" | "RPAREN" | "LBRACE" | "RBRACE" | "LBRACK" | "RBRACK"
  | "COMMA" | "COLON" | "DOT" | "SEMI"
  // arithmetic operators (logical/comparison use keyword tokens)
  | "PLUS" | "MINUS" | "STAR" | "SLASH" | "PERCENT"
  // end
  | "EOF";

export const KEYWORDS: ReadonlySet<string> = new Set([
  "get", "post", "put", "patch", "delete",
  "expect", "check", "assert", "store", "wait",
  "headers", "body", "cookies", "cookieJar", "clearCookies",
  "redirects", "security", "timeout",
  "follow", "max",
  "rejectInvalidCerts",
  "ms", "action", "retries",
  "status", "bodySize", "totalDelayMs", "dns", "connect", "tls",
  "ttfb", "transfer", "size",
  "value", "op", "match", "mode", "options", "condition",
  "json", "form", "schema",
  "this", "prev", "null",
  // comparison operator keywords
  "eq", "neq", "lt", "lte", "gt", "gte",
  // logical connective keywords
  "and", "or", "not",
]);

const BOOLS: ReadonlySet<string> = new Set(["true", "false"]);

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  col: number;
}

export class LexError extends Error {
  message: string;
  line: number;
  col: number;

  constructor(message: string, line: number, col: number) {
    super(`${message} at line ${line}, col ${col}`);
    this.message = message;
    this.line = line;
    this.col = col;
  }
}

const ESCAPE_MAP: Record<string, string> = {
  "\\": "\\",
  '"': '"',
  "n": "\n",
  "r": "\r",
  "t": "\t",
  "$": "$",
};

const PUNCT_MAP: Record<string, TokenType> = {
  "(": "LPAREN", ")": "RPAREN",
  "{": "LBRACE", "}": "RBRACE",
  "[": "LBRACK", "]": "RBRACK",
  ",": "COMMA", ":": "COLON", ".": "DOT", ";": "SEMI",
  "+": "PLUS", "-": "MINUS",
  "*": "STAR", "/": "SLASH", "%": "PERCENT",
};

export class Lexer {
  private src: string;
  private pos: number = 0;
  private line: number = 1;
  private col: number = 1;

  constructor(source: string) {
    this.src = source;
  }

  private peek(offset: number = 0): string {
    const p = this.pos + offset;
    return p < this.src.length ? this.src[p] : "";
  }

  private advance(n: number = 1): string {
    const chunk = this.src.slice(this.pos, this.pos + n);
    for (const ch of chunk) {
      if (ch === "\n") {
        this.line++;
        this.col = 1;
      } else {
        this.col++;
      }
    }
    this.pos += n;
    return chunk;
  }

  private skipTrivia(): void {
    while (this.pos < this.src.length) {
      const ch = this.peek();
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
        this.advance();
      } else if (ch === "/" && this.peek(1) === "/") {
        while (this.pos < this.src.length && this.peek() !== "\n") {
          this.advance();
        }
      } else {
        break;
      }
    }
  }

  private readString(): Token {
    const startLine = this.line;
    const startCol = this.col;
    this.advance(); // opening quote
    const chars: string[] = [];
    while (this.pos < this.src.length) {
      const ch = this.peek();
      if (ch === '"') {
        this.advance();
        return { type: "STRING", value: chars.join(""), line: startLine, col: startCol };
      }
      if (ch === "\\") {
        const nxt = this.peek(1);
        if (nxt in ESCAPE_MAP) {
          this.advance(2);
          chars.push(ESCAPE_MAP[nxt]);
          continue;
        }
        throw new LexError(`invalid escape \\${nxt}`, this.line, this.col);
      }
      if (ch === "\n") {
        throw new LexError("unterminated string literal", startLine, startCol);
      }
      chars.push(ch);
      this.advance();
    }
    throw new LexError("unterminated string literal", startLine, startCol);
  }

  private readNumber(): Token {
    const startLine = this.line;
    const startCol = this.col;
    const startPos = this.pos;
    while (this.pos < this.src.length && isDigit(this.peek())) {
      this.advance();
    }
    if (this.peek() === "." && isDigit(this.peek(1))) {
      this.advance();
      while (this.pos < this.src.length && isDigit(this.peek())) {
        this.advance();
      }
      return { type: "FLOAT", value: this.src.slice(startPos, this.pos), line: startLine, col: startCol };
    }
    return { type: "INT", value: this.src.slice(startPos, this.pos), line: startLine, col: startCol };
  }

  private readIdentLike(): Token {
    const startLine = this.line;
    const startCol = this.col;
    const startPos = this.pos;
    this.advance(); // first [a-zA-Z_]
    while (this.pos < this.src.length) {
      const ch = this.peek();
      if (isAlnum(ch) || ch === "_") {
        this.advance();
      } else {
        break;
      }
    }
    const lex = this.src.slice(startPos, this.pos);
    if (BOOLS.has(lex)) {
      return { type: "BOOL", value: lex, line: startLine, col: startCol };
    }
    if (KEYWORDS.has(lex)) {
      return { type: "KEYWORD", value: lex, line: startLine, col: startCol };
    }
    return { type: "IDENT", value: lex, line: startLine, col: startCol };
  }

  private readDollar(): Token {
    const startLine = this.line;
    const startCol = this.col;
    const startPos = this.pos;

    if (this.peek(1) === "$") {
      this.advance(2); // $$
      if (!(isAlpha(this.peek()) || this.peek() === "_")) {
        throw new LexError("expected identifier after $$", this.line, this.col);
      }
      while (this.pos < this.src.length && (isAlnum(this.peek()) || this.peek() === "_")) {
        this.advance();
      }
      return { type: "RUN_VAR", value: this.src.slice(startPos, this.pos), line: startLine, col: startCol };
    }

    this.advance(); // $
    if (!(isAlpha(this.peek()) || this.peek() === "_")) {
      throw new LexError("expected identifier after $", this.line, this.col);
    }
    while (this.pos < this.src.length && (isAlnum(this.peek()) || this.peek() === "_")) {
      this.advance();
    }
    return { type: "SCRIPT_VAR", value: this.src.slice(startPos, this.pos), line: startLine, col: startCol };
  }

  private readPunct(): Token {
    const startLine = this.line;
    const startCol = this.col;
    const ch = this.peek();

    const tt = PUNCT_MAP[ch];
    if (tt) {
      this.advance();
      return { type: tt, value: ch, line: startLine, col: startCol };
    }
    throw new LexError(`unexpected character ${JSON.stringify(ch)}`, startLine, startCol);
  }

  tokenize(): Token[] {
    const tokens: Token[] = [];
    while (true) {
      this.skipTrivia();
      if (this.pos >= this.src.length) {
        tokens.push({ type: "EOF", value: "", line: this.line, col: this.col });
        return tokens;
      }
      const ch = this.peek();
      if (ch === '"') {
        tokens.push(this.readString());
      } else if (ch === "$") {
        tokens.push(this.readDollar());
      } else if (isDigit(ch)) {
        tokens.push(this.readNumber());
      } else if (isAlpha(ch) || ch === "_") {
        tokens.push(this.readIdentLike());
      } else {
        tokens.push(this.readPunct());
      }
    }
  }
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isAlpha(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
}

function isAlnum(ch: string): boolean {
  return isDigit(ch) || isAlpha(ch);
}

export function tokenize(source: string): Token[] {
  return new Lexer(source).tokenize();
}

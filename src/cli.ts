#!/usr/bin/env node
/**
 * CLI for lacelang-validator -- parse + validate only.
 *
 * Subcommands:
 *   parse <script>                                    -> { "ast": ... } | { "errors": [...] }
 *   validate <script> [--vars-list P] [--context P]   -> { "errors": [...], "warnings": [...] }
 *
 * Exit codes:
 *   0 on processed request (parse/validate errors are in the JSON body)
 *   2 on tool/arg errors
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parse, ParseError } from "./parser.js";
import { validate } from "./validator.js";

const require = createRequire(import.meta.url);
const { version: VERSION } = require("../package.json");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

function stripAstMetadata(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(stripAstMetadata);
  }
  if (node != null && typeof node === "object") {
    const out: AnyObj = {};
    for (const [k, v] of Object.entries(node as AnyObj)) {
      if (!k.startsWith("__")) {
        out[k] = stripAstMetadata(v);
      }
    }
    return out;
  }
  return node;
}

function readText(path: string): string {
  return readFileSync(path, "utf-8");
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function emit(obj: unknown, pretty: boolean): void {
  if (pretty) {
    process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
  } else {
    process.stdout.write(JSON.stringify(obj) + "\n");
  }
}

function cmdParse(scriptPath: string, pretty: boolean): number {
  let source: string;
  try {
    source = readText(scriptPath);
  } catch (e) {
    process.stderr.write(`error reading script: ${e}\n`);
    return 2;
  }
  try {
    const ast = parse(source);
    emit({ ast: stripAstMetadata(ast) }, pretty);
  } catch (e) {
    if (e instanceof ParseError) {
      emit({ errors: [{ code: "PARSE_ERROR", line: e.line }] }, pretty);
      return 0;
    }
    throw e;
  }
  return 0;
}

function cmdValidate(
  scriptPath: string,
  pretty: boolean,
  varsListPath: string | null,
  contextPath: string | null,
  enableExtensions: string[],
): number {
  let source: string;
  try {
    source = readText(scriptPath);
  } catch (e) {
    process.stderr.write(`error reading script: ${e}\n`);
    return 2;
  }

  let variables: string[] | null = null;
  let context: AnyObj | null = null;
  try {
    if (varsListPath) {
      variables = readJson(varsListPath) as string[];
    }
    if (contextPath) {
      context = readJson(contextPath) as AnyObj;
    }
  } catch (e) {
    process.stderr.write(`error reading aux input: ${e}\n`);
    return 2;
  }

  try {
    const ast = parse(source);
    let activeExtensions: string[] | null = [...enableExtensions];
    if (context && Array.isArray(context.extensions)) {
      for (const name of context.extensions) {
        if (!activeExtensions.includes(name as string)) {
          activeExtensions.push(name as string);
        }
      }
    }
    if (activeExtensions.length === 0) {
      activeExtensions = null;
    }
    const sink = validate(ast, variables, context, false, activeExtensions);
    emit(sink.toDict(), pretty);
  } catch (e) {
    if (e instanceof ParseError) {
      emit({ errors: [{ code: "PARSE_ERROR", line: e.line }], warnings: [] }, pretty);
      return 0;
    }
    throw e;
  }
  return 0;
}

function printUsage(): void {
  process.stderr.write(
    `Usage: lacelang-validate <command> [options] <script>

Commands:
  parse     Parse a script; emit AST or parse errors.
  validate  Validate a script; emit errors/warnings.

Options:
  --pretty                  Emit indented JSON instead of a single line.
  --enable-extension NAME   Activate a Lace extension (may be repeated).
  --vars-list PATH          JSON array of declared variable names (validate only).
  --context PATH            JSON object with validator context (validate only).
  --version                 Show version.
  --help                    Show this help.
`
  );
}

export function main(argv?: string[]): number {
  const args = argv ?? process.argv.slice(2);

  if (args.includes("--version")) {
    process.stdout.write(`lacelang-validator ${VERSION}\n`);
    return 0;
  }
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    printUsage();
    return 2;
  }

  const command = args[0];
  if (command !== "parse" && command !== "validate") {
    process.stderr.write(`unknown command: ${command}\n`);
    printUsage();
    return 2;
  }

  let pretty = false;
  let varsListPath: string | null = null;
  let contextPath: string | null = null;
  const enableExtensions: string[] = [];
  let scriptPath: string | null = null;

  let i = 1;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--pretty") {
      pretty = true;
    } else if (arg === "--enable-extension") {
      i++;
      if (i >= args.length) {
        process.stderr.write("--enable-extension requires a value\n");
        return 2;
      }
      enableExtensions.push(args[i]);
    } else if (arg === "--vars-list") {
      i++;
      if (i >= args.length) {
        process.stderr.write("--vars-list requires a value\n");
        return 2;
      }
      varsListPath = args[i];
    } else if (arg === "--context") {
      i++;
      if (i >= args.length) {
        process.stderr.write("--context requires a value\n");
        return 2;
      }
      contextPath = args[i];
    } else if (arg.startsWith("-")) {
      process.stderr.write(`unknown option: ${arg}\n`);
      return 2;
    } else {
      scriptPath = arg;
    }
    i++;
  }

  if (!scriptPath) {
    process.stderr.write("missing script argument\n");
    return 2;
  }

  if (command === "parse") {
    return cmdParse(scriptPath, pretty);
  }
  return cmdValidate(scriptPath, pretty, varsListPath, contextPath, enableExtensions);
}

// Run if invoked directly
const isMainModule = process.argv[1]?.endsWith("cli.js") ||
  process.argv[1]?.endsWith("cli.ts");
if (isMainModule) {
  process.exit(main());
}

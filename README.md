# lacelang-validator (TypeScript)

Reference TypeScript validator for [Lace](https://github.com/tracedown/lacelang) --
parser and semantic checks with **100% spec conformance** (v0.9.1). Zero
runtime dependencies.

Parsing and semantic validation only -- no HTTP runtime, no network
dependencies. See
[`@lacelang/executor`](https://github.com/tracedown/lacelang-js-executor)
for the execution runtime. See `lace-spec.md` section 15 for the validator / executor
package separation rule.

## Install

```bash
npm install @lacelang/validator
```

Or from source:

```bash
npm install git+https://github.com/tracedown/lacelang-js-validator.git
```

## CLI

```bash
# Parse -- check syntax, emit AST
lacelang-validate parse script.lace

# Validate -- check syntax + semantic rules
lacelang-validate validate script.lace --vars-list vars.json --context context.json
```

Both subcommands support `--pretty` for indented JSON.

## Library

```typescript
import { parse, validate, fmt } from "@lacelang/validator";

// Parse a .lace script to AST
const ast = parse('get("https://example.com").expect(status: 200)');

// Validate the AST
const sink = validate(ast, ["base_url"], { maxRedirects: 10, maxTimeoutMs: 300000 });
console.log(sink.errors);   // Diagnostic[]
console.log(sink.warnings); // Diagnostic[]

// Format an AST expression back to source text
const expr = ast.calls[0].chain.expect.status.value;
console.log(fmt(expr)); // "200"
```

## Responsible use

This software is designed for monitoring endpoints you **own or have
explicit authorization to probe**. See `NOTICE` for the full statement.

## License

Apache License 2.0

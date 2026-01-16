import path from "node:path";
import process from "node:process";
import fs from "node:fs";
import * as ts from "typescript";

export type FixerArgs = {
  project: string;
  dir?: string;
  dry: boolean;
  codes: Set<number>;
  maxPasses: number;
};

export function parseArgs(argv: string[]): FixerArgs {
  const args: FixerArgs = {
    project: "./tsconfig.json",
    dir: undefined,
    dry: false,
    // Keep defaults narrow: null/undefined access + optional call
    codes: new Set([2531, 2532, 2533, 18048, 2722]),
    maxPasses: 10,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--project" && next) args.project = next, i++;
    else if (a === "--dir" && next) args.dir = path.resolve(next), i++;
    else if (a === "--dry") args.dry = true;
    else if (a === "--codes" && next) {
      args.codes = new Set(next.split(",").map((s) => Number(s.trim())));
      i++;
    } else if (a === "--maxPasses" && next) {
      args.maxPasses = Number(next);
      i++;
    }
  }

  return args;
}

type TextEdit = {
  start: number;
  end: number;
  newText: string;
};

function applyEdits(text: string, edits: TextEdit[]): string {
  if (edits.length === 0) return text;

  // Apply from right-to-left so offsets don’t shift.
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of sorted) {
    out = out.slice(0, e.start) + e.newText + out.slice(e.end);
  }
  return out;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function isWriteContext(node: ts.Node): boolean {
  // We treat anything *inside* the left-hand side of an assignment as a write.
  // This prevents producing invalid syntax like `a?.b.c = 1`.
  for (let cur: ts.Node | undefined = node; cur && cur.parent; cur = cur.parent) {
    const parent = cur.parent;

    if (ts.isBinaryExpression(parent) && isAssignmentOperator(parent.operatorToken.kind)) {
      const lhs = parent.left;
      if (cur.pos >= lhs.pos && cur.end <= lhs.end) return true;
    }

    if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) {
      if (
        parent.operator === ts.SyntaxKind.PlusPlusToken ||
        parent.operator === ts.SyntaxKind.MinusMinusToken
      ) {
        const operand = parent.operand;
        if (cur.pos >= operand.pos && cur.end <= operand.end) return true;
      }
    }

    if (ts.isDeleteExpression(parent)) {
      const operand = parent.expression;
      if (cur.pos >= operand.pos && cur.end <= operand.end) return true;
    }
  }

  return false;
}

function isAccessLike(node: ts.Node): node is ts.PropertyAccessExpression | ts.ElementAccessExpression | ts.CallExpression {
  return ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isCallExpression(node);
}

function hasOptionalChainToken(node: ts.Node): boolean {
  // Used for broad checks only; segment-level decisions should use
  // `segmentHasQuestionDot`.
  return Boolean((node as any).questionDotToken) || ts.isOptionalChain(node as any);
}

function findNearestAccessLike(from: ts.Node): ts.Node | undefined {
  for (let n: ts.Node | undefined = from; n; n = n.parent) {
    if (isAccessLike(n)) return n;
  }
  return undefined;
}

function segmentHasQuestionDot(node: ts.Node): boolean {
  return Boolean((node as any).questionDotToken);
}

function findFixTargetForNullishAccess(from: ts.Node): ts.Node | undefined {
  const nearest = findNearestAccessLike(from);
  if (!nearest) return undefined;

  // If the nearest segment is already optional (has `?.`), we need to
  // propagate the safety to the *next* segment.
  // Example: `a?.b.c` diagnostic typically points at `a?.b`.
  if (segmentHasQuestionDot(nearest)) {
    const parent = nearest.parent;
    if (
      parent &&
      isAccessLike(parent) &&
      ((ts.isPropertyAccessExpression(parent) && parent.expression === nearest) ||
        (ts.isElementAccessExpression(parent) && parent.expression === nearest) ||
        (ts.isCallExpression(parent) && parent.expression === nearest))
    ) {
      return parent;
    }
  }

  return nearest;
}

function findFixTargetForOptionalCall(from: ts.Node): ts.CallExpression | undefined {
  for (let n: ts.Node | undefined = from; n; n = n.parent) {
    if (ts.isCallExpression(n)) return n;
  }
  return undefined;
}

function pickFixTarget(from: ts.Node, diagnosticCode: number): ts.Node | undefined {
  // TS2722: Cannot invoke an object which is possibly 'undefined'.
  // This should usually become an optional call: `fn?.()`.
  if (diagnosticCode === 2722) return findFixTargetForOptionalCall(from);

  return findFixTargetForNullishAccess(from);
}

function hasNonNullInExpressionChain(expr: ts.Expression): boolean {
  let cur: ts.Expression = expr;
  while (true) {
    if (ts.isNonNullExpression(cur) || (ts as any).isNonNullChain?.(cur)) return true;

    if (ts.isParenthesizedExpression(cur)) {
      cur = cur.expression;
      continue;
    }

    if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur) || ts.isCallExpression(cur)) {
      cur = cur.expression;
      continue;
    }

    return false;
  }
}

function editForPropertyAccess(sf: ts.SourceFile, node: ts.PropertyAccessExpression): TextEdit | undefined {
  if (isWriteContext(node)) return undefined;

  // Human intent: if someone used `!` anywhere in the left chain,
  // don't try to be clever.
  if (hasNonNullInExpressionChain(node.expression)) return undefined;

  // Don’t optional-chain `super`.
  if (node.expression.kind === ts.SyntaxKind.SuperKeyword) return undefined;

  const text = sf.text;
  const exprEnd = node.expression.end;
  const nameStart = node.name.getStart(sf);
  const between = text.slice(exprEnd, nameStart);

  // For `a . b`, we want the dot closest to `b`.
  const relDot = between.lastIndexOf(".");
  if (relDot === -1) return undefined;

  const dotIndex = exprEnd + relDot;
  if (text.slice(dotIndex - 1, dotIndex + 1) === "?.") return undefined;

  return {
    start: dotIndex,
    end: dotIndex + 1,
    newText: "?.",
  };
}

function editForElementAccess(sf: ts.SourceFile, node: ts.ElementAccessExpression): TextEdit | undefined {
  if (isWriteContext(node)) return undefined;

  // Human intent: if someone used `!` anywhere in the left chain,
  // don't try to be clever.
  if (hasNonNullInExpressionChain(node.expression)) return undefined;

  // Don’t optional-chain `super`.
  if (node.expression.kind === ts.SyntaxKind.SuperKeyword) return undefined;

  const text = sf.text;
  const exprEnd = node.expression.end;

  // Insert `?.` right before the `[`.
  const bracketIndex = text.indexOf("[", exprEnd);
  if (bracketIndex === -1) return undefined;

  // Avoid `a?.[x]` becoming `a??.[x]` in weird cases.
  if (text.slice(bracketIndex - 2, bracketIndex) === "?.") return undefined;

  return {
    start: bracketIndex,
    end: bracketIndex,
    newText: "?.",
  };
}

function editForCall(sf: ts.SourceFile, node: ts.CallExpression): TextEdit | undefined {
  // optional call is invalid with `new foo?.()`.
  if (node.parent && ts.isNewExpression(node.parent)) return undefined;

  // Only handle safe mechanical cases.
  const callee = node.expression;

  // Human intent: if someone used `!` anywhere in the callee chain,
  // don't try to be clever.
  if (hasNonNullInExpressionChain(callee)) return undefined;
  if (
    !ts.isIdentifier(callee) &&
    !ts.isPropertyAccessExpression(callee) &&
    !ts.isElementAccessExpression(callee)
  ) {
    return undefined;
  }

  // Don’t optional-chain `super()`.
  if ((callee as ts.Node).kind === ts.SyntaxKind.SuperKeyword) return undefined;

  const insertionPos = callee.end;
  const text = sf.text;

  // If it already looks like an optional call, don’t touch.
  // Example: `fn?.()` or `obj?.fn()` (call node will include `?.` already).
  // This is a quick text check: safe and fast.
  const maybeAlready = text.slice(Math.max(0, insertionPos - 2), insertionPos + 2);
  if (maybeAlready.includes("?.")) return undefined;

  return {
    start: insertionPos,
    end: insertionPos,
    newText: "?.",
  };
}

function editForTarget(sf: ts.SourceFile, target: ts.Node): TextEdit | undefined {
  if (ts.isPropertyAccessExpression(target)) return editForPropertyAccess(sf, target);
  if (ts.isElementAccessExpression(target)) return editForElementAccess(sf, target);
  if (ts.isCallExpression(target)) return editForCall(sf, target);
  return undefined;
}

function getDiagnosticNode(sf: ts.SourceFile, start: number): ts.Node | undefined {
  // Use token-at-position for a stable anchor; then we climb.
  // (This API exists in TS and is stable enough for this use.)
  // `getTokenAtPosition` lives under TS internal utilities and is available
  // in the installed TypeScript, but not always in the public typings.
  const token = (ts as any).getTokenAtPosition?.(sf, start) as ts.Node | undefined;
  if (token) return token;

  // Fallback: token on left of position.
  return (ts as any).findTokenOnLeftOfPosition?.(sf, start) as ts.Node | undefined;
}

export type FixInMemoryResult = {
  files: Record<string, string>;
  totalChanges: number;
  passes: number;
};

export function fixInMemoryProject(params: {
  files: Record<string, string>;
  rootNames: string[];
  compilerOptions: ts.CompilerOptions;
  codes?: Set<number>;
  maxPasses?: number;
}): FixInMemoryResult {
  const codes = params.codes ?? new Set([2531, 2532, 2533, 18048, 2722]);
  const maxPasses = params.maxPasses ?? 10;

  let files: Record<string, string> = { ...params.files };
  let totalChanges = 0;
  let passes = 0;

  const makeHost = (): ts.CompilerHost => {
    const host = ts.createCompilerHost(params.compilerOptions, true);

    host.fileExists = (fileName) => {
      if (fileName in files) return true;
      return ts.sys.fileExists(fileName);
    };

    host.readFile = (fileName) => {
      if (fileName in files) return files[fileName];
      return ts.sys.readFile(fileName);
    };

    host.writeFile = () => {
      // no-op (we’re in-memory)
    };

    host.getSourceFile = (fileName, languageVersion) => {
      const text = host.readFile(fileName);
      if (text == null) return undefined;
      const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
      return ts.createSourceFile(fileName, text, languageVersion, true, kind);
    };

    return host;
  };

  for (let pass = 1; pass <= maxPasses; pass++) {
    const program = ts.createProgram({
      rootNames: params.rootNames,
      options: params.compilerOptions,
      host: makeHost(),
    });

    const diags = ts.getPreEmitDiagnostics(program).filter((d) => {
      if (!codes.has(d.code)) return false;
      return Boolean(d.file) && typeof d.start === "number";
    });

    if (diags.length === 0) break;

    const editsByFile = new Map<string, TextEdit[]>();

    for (const d of diags) {
      const sf = d.file!;
      const start = d.start!;
      const node = getDiagnosticNode(sf, start);
      if (!node) continue;

      const target = pickFixTarget(node, d.code);
      if (!target) continue;

      const edit = editForTarget(sf, target);
      if (!edit) continue;

      const fileName = sf.fileName;
      const edits = editsByFile.get(fileName) ?? [];
      edits.push(edit);
      editsByFile.set(fileName, edits);
    }

    let passChanges = 0;
    for (const [fileName, edits] of editsByFile) {
      // De-dupe exact edits (can happen if multiple diags point to same node)
      const uniqKey = (e: TextEdit) => `${e.start}:${e.end}:${e.newText}`;
      const uniq = new Map<string, TextEdit>();
      for (const e of edits) uniq.set(uniqKey(e), e);

      const before = files[fileName];
      if (before == null) continue;
      const uniqEdits = [...uniq.values()];
      const after = applyEdits(before, uniqEdits);
      if (after !== before) {
        files[fileName] = after;
        passChanges += uniqEdits.length;
      }
    }

    passes = pass;
    totalChanges += passChanges;
    if (passChanges === 0) break;
  }

  return { files, totalChanges, passes };
}

export function fixSourceText(params: {
  fileName?: string;
  text: string;
  compilerOptions?: ts.CompilerOptions;
  codes?: Set<number>;
  maxPasses?: number;
}): { text: string; totalChanges: number; passes: number } {
  const fileName = params.fileName ?? "/input.ts";
  const compilerOptions: ts.CompilerOptions = {
    strict: true,
    noUncheckedIndexedAccess: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    // Make sure the in-memory program can find lib.d.ts
    lib: ["lib.esnext.full.d.ts"],
    // Include default libs (so tests can use built-ins)
    noLib: false,
    types: [],
    ...params.compilerOptions,
  };

  const result = fixInMemoryProject({
    files: { [fileName]: params.text },
    rootNames: [fileName],
    compilerOptions,
    codes: params.codes,
    maxPasses: params.maxPasses,
  });

  return {
    text: result.files[fileName] ?? params.text,
    totalChanges: result.totalChanges,
    passes: result.passes,
  };
}

function loadTsConfig(tsconfigPath: string): {
  options: ts.CompilerOptions;
  fileNames: string[];
  errors: ts.Diagnostic[];
} {
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error) {
    return { options: {}, fileNames: [], errors: [configFile.error] };
  }

  const configDir = path.dirname(tsconfigPath);
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, configDir);
  return {
    options: parsed.options,
    fileNames: parsed.fileNames,
    errors: parsed.errors,
  };
}

export function fixProject(args: FixerArgs): { totalChanges: number; passes: number } {
  const resolvedProject = path.resolve(args.project);
  const config = loadTsConfig(resolvedProject);

  if (config.errors.length > 0) {
    const formatted = ts.formatDiagnosticsWithColorAndContext(config.errors, {
      getCurrentDirectory: ts.sys.getCurrentDirectory,
      getCanonicalFileName: (f) => f,
      getNewLine: () => ts.sys.newLine,
    });
    throw new Error(formatted);
  }

  const dirPrefix = args.dir ? path.resolve(args.dir) : undefined;
  const rootNames = dirPrefix
    ? config.fileNames.filter((f) => path.resolve(f).startsWith(dirPrefix))
    : config.fileNames;

  const files: Record<string, string> = {};
  for (const f of rootNames) {
    try {
      files[f] = fs.readFileSync(f, "utf8");
    } catch {
      // ignore unreadable files
    }
  }

  const result = fixInMemoryProject({
    files,
    rootNames,
    compilerOptions: config.options,
    codes: args.codes,
    maxPasses: args.maxPasses,
  });

  if (!args.dry) {
    for (const [fileName, text] of Object.entries(result.files)) {
      if (files[fileName] !== text) fs.writeFileSync(fileName, text, "utf8");
    }
  }

  return { totalChanges: result.totalChanges, passes: result.passes };
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const { totalChanges } = fixProject(args);

  console.log(
    args.dry ? `DRY RUN: would apply ${totalChanges} edits` : `DONE: applied ${totalChanges} edits`,
  );
}


import { describe, expect, test } from "bun:test";
import { fixSourceText } from "./index";

describe("ts-safe-access fixer", () => {
  test("adds optional chaining for simple property access", () => {
    const input = `
      type A = { b?: { c: number } };
      declare const a: A | undefined;
      const x = a.b.c;
    `;

    const out = fixSourceText({ text: input }).text;
    expect(out).toContain("a?.b?.c");
  });

  test("propagates optional chaining on already-optional root: a?.b.c -> a?.b?.c", () => {
    const input = `
      type A = { b?: { c: number } };
      declare const a: A | undefined;
      const x = a?.b.c;
    `;

    const out = fixSourceText({ text: input }).text;
    expect(out).toContain("a?.b?.c");
  });

  test("adds optional chaining for element access", () => {
    const input = `
      type A = { b?: { [k: string]: { c: number } | undefined } };
      declare const a: A | undefined;
      const x = a.b["k"].c;
    `;

    const out = fixSourceText({ text: input }).text;
    // We always guard the base and the element access.
    // Guarding `.c` depends on type info: with a plain index signature it may be `{ c: number }`.
    expect(out).toContain("a?.b?.[\"k\"]");
  });

  test("adds optional chaining for calls", () => {
    const input = `
      type A = { fn?: () => { c: number } | undefined };
      declare const a: A | undefined;
      const x = a.fn().c;
    `;

    const out = fixSourceText({ text: input }).text;
    expect(out).toContain("a?.fn?.().c");
  });

  test("does not touch write contexts", () => {
    const input = `
      type A = { b?: { c: number } };
      declare const a: A | undefined;
      a.b.c = 1;
    `;

    const out = fixSourceText({ text: input }).text;
    // We intentionally do not rewrite assignments. A human must decide what to do.
    expect(out).toContain("a.b.c = 1");
  });

  test("does not add optional chaining when non-null assertion exists", () => {
    const input = `
      type A = { b?: { c: number } };
      declare const a: A | undefined;
      const x = a!.b.c;
    `;

    const out = fixSourceText({ text: input }).text;
    expect(out).toContain("a!.b.c");
  });
});

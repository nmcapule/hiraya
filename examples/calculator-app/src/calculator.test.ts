import { describe, expect, test } from "bun:test";
import { calculate, formatNumber } from "./calculator";

describe("calculate", () => {
  test("applies precedence and parentheses", () => {
    expect(calculate("2 + 3 * 4")).toBe(14);
    expect(calculate("(2 + 3) * 4")).toBe(20);
  });

  test("supports unary signs, decimals, and percentages", () => {
    expect(calculate("-1.5 + +2")).toBe(0.5);
    expect(calculate("250 * 12%")).toBe(30);
  });

  test("normalizes common floating point artifacts", () => {
    expect(calculate("0.1 + 0.2")).toBe(0.3);
    expect(formatNumber(calculate("1 / 3"))).toBe("0.333333333333");
  });

  test("rejects invalid and unsafe expressions", () => {
    expect(() => calculate("1 / 0")).toThrow("divide by zero");
    expect(() => calculate("2 +")).toThrow("incomplete");
    expect(() => calculate("globalThis.alert(1)")).toThrow();
    expect(() => calculate("1".repeat(257))).toThrow("too long");
  });
});

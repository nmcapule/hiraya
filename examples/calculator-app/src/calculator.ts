const MAX_EXPRESSION_LENGTH = 256;

export function calculate(source: string): number {
  if (source.length > MAX_EXPRESSION_LENGTH) throw new Error("Expression is too long");
  const parser = new Parser(source);
  const result = parser.parseExpression();
  parser.skipSpaces();
  if (!parser.done()) throw new Error(`Unexpected character at position ${parser.position + 1}`);
  if (!Number.isFinite(result)) throw new Error("Result is outside the supported range");
  return normalize(result);
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "Error";
  const normalized = normalize(value);
  const absolute = Math.abs(normalized);
  if (absolute !== 0 && (absolute >= 1e12 || absolute < 1e-9)) {
    return normalized.toExponential(9).replace(/\.?0+e/, "e");
  }
  return String(normalized);
}

function normalize(value: number): number {
  if (Object.is(value, -0)) return 0;
  return Number.parseFloat(value.toPrecision(12));
}

class Parser {
  position = 0;

  constructor(private readonly source: string) {}

  done(): boolean {
    return this.position >= this.source.length;
  }

  skipSpaces(): void {
    while (/\s/.test(this.source[this.position] ?? "")) this.position += 1;
  }

  parseExpression(): number {
    let value = this.parseTerm();
    while (true) {
      if (this.consume("+")) value += this.parseTerm();
      else if (this.consume("-")) value -= this.parseTerm();
      else return value;
    }
  }

  private parseTerm(): number {
    let value = this.parseUnary();
    while (true) {
      if (this.consume("*")) value *= this.parseUnary();
      else if (this.consume("/")) {
        const divisor = this.parseUnary();
        if (divisor === 0) throw new Error("Cannot divide by zero");
        value /= divisor;
      } else return value;
    }
  }

  private parseUnary(): number {
    if (this.consume("+")) return this.parseUnary();
    if (this.consume("-")) return -this.parseUnary();
    let value = this.parsePrimary();
    while (this.consume("%")) value /= 100;
    return value;
  }

  private parsePrimary(): number {
    if (this.consume("(")) {
      const value = this.parseExpression();
      if (!this.consume(")")) throw new Error("Missing closing parenthesis");
      return value;
    }
    this.skipSpaces();
    const remaining = this.source.slice(this.position);
    const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(remaining);
    if (!match) throw new Error(this.done() ? "Expression is incomplete" : `Expected a number at position ${this.position + 1}`);
    this.position += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new Error("Number is outside the supported range");
    return value;
  }

  private consume(character: string): boolean {
    this.skipSpaces();
    if (this.source[this.position] !== character) return false;
    this.position += 1;
    return true;
  }
}

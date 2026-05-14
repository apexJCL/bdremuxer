// Thin wrapper around node:readline/promises for interactive prompts.
// One Prompter per CLI invocation; close() releases stdin so the process
// can exit.

import { createInterface, type Interface } from "node:readline/promises";

export class Prompter {
  private rl: Interface;

  constructor() {
    this.rl = createInterface({ input: process.stdin, output: process.stdout });
  }

  async ask(question: string, defaultValue?: string): Promise<string> {
    const display =
      defaultValue !== undefined && defaultValue !== ""
        ? `${question} [${defaultValue}]: `
        : `${question}: `;
    const raw = await this.rl.question(display);
    const answer = raw.trim();
    if (answer === "" && defaultValue !== undefined) return defaultValue;
    return answer;
  }

  async askChoice<T extends string>(
    question: string,
    choices: readonly T[],
    defaultValue: T,
  ): Promise<T> {
    const hint = `${question} (${choices.join("/")})`;
    while (true) {
      const a = (await this.ask(hint, defaultValue)) as T;
      if (choices.includes(a)) return a;
      process.stdout.write(`  Not a valid choice. Try one of: ${choices.join(", ")}\n`);
    }
  }

  async askBool(question: string, defaultValue: boolean): Promise<boolean> {
    const a = await this.ask(question, defaultValue ? "y" : "n");
    return /^y(es)?$/i.test(a);
  }

  // Returns null on empty when no default is supplied.
  async askInt(
    question: string,
    defaultValue?: number,
  ): Promise<number | null> {
    while (true) {
      const a = await this.ask(question, defaultValue?.toString());
      if (a === "" && defaultValue === undefined) return null;
      const n = Number(a);
      if (Number.isInteger(n) && n > 0) return n;
      process.stdout.write(`  Expected a positive integer.\n`);
    }
  }

  close(): void {
    this.rl.close();
  }
}

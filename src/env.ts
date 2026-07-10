import { readFileSync } from "node:fs";

/**
 * Resolve an environment variable with support for the Docker secrets
 * convention: `NAME_FILE` points at a file whose contents are the value.
 *
 * Precedence: if both `NAME` and `NAME_FILE` are set, `NAME_FILE` wins so a
 * mounted secret always overrides a plain (often placeholder) env value. The
 * file's contents are read once and trailing newlines trimmed, since secret
 * files commonly end with one.
 */
export function env(name: string): string | undefined {
  const filePath = process.env[`${name}_FILE`];
  if (filePath && filePath.trim()) {
    try {
      return readFileSync(filePath.trim(), "utf8").replace(/\r?\n$/, "");
    } catch (err) {
      throw new Error(
        `Failed to read ${name}_FILE at "${filePath.trim()}": ${(err as Error).message}`,
      );
    }
  }
  return process.env[name];
}

import { readFileSync, existsSync } from "fs";
import { parse } from "yaml";
import type { Config } from "../types/index.js";

const CONFIG_PATH = new URL("../../config.yaml", import.meta.url).pathname;

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) {
    console.error(
      "config.yaml not found. Run `bun run setup` to initialize your configuration."
    );
    process.exit(1);
  }

  const raw = readFileSync(CONFIG_PATH, "utf-8");
  const parsed = parse(raw) as Config;
  return parsed;
}

export function getEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    console.error(
      `Missing environment variable: ${key}. Check your .env file.`
    );
    process.exit(1);
  }
  return value;
}

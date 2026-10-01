// brain.ts – file access to the "second brain" knowledge base (see brain/CLAUDE.md):
//   raw/     original sources, written once and never modified (only the X sync writes here)
//   wiki/    linked knowledge pages maintained by the model
//   output/  reports and other deliverables built from the wiki
// All paths are relative to the brain root and cannot escape it.

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "./logger.ts";

const log = createLogger("brain");

export const DEFAULT_BRAIN_DIR = fileURLToPath(new URL("./brain/", import.meta.url));

// Folders the model may write through MCP; raw/ is append-only and filled by the sync jobs.
const WRITABLE = ["wiki", "output"];
const MAX_READ_BYTES = 200_000;

export interface BrainEntry {
  path: string; // relative, forward slashes
  type: "file" | "dir";
  bytes?: number;
  modified?: string; // ISO
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export class Brain {
  readonly root: string;

  constructor(root = process.env.BRAIN_DIR ?? DEFAULT_BRAIN_DIR) {
    this.root = resolve(root);
  }

  // Resolves a relative path inside the brain; rejects anything that would escape the root.
  resolvePath(path: string): string {
    const full = resolve(this.root, path.replace(/^[/\\]+/, ""));
    if (full !== this.root && !full.startsWith(this.root + sep)) throw new Error(`Path outside the brain: ${path}`);
    return full;
  }

  private rel(full: string): string {
    return relative(this.root, full).split(sep).join("/");
  }

  async list(dir = "", recursive = false): Promise<BrainEntry[]> {
    const out: BrainEntry[] = [];
    const walk = async (full: string) => {
      const entries = await readdir(full, { withFileTypes: true });
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.name.startsWith(".")) continue; // sync state, .gitkeep
        const child = join(full, e.name);
        if (e.isDirectory()) {
          out.push({ path: this.rel(child), type: "dir" });
          if (recursive) await walk(child);
        } else {
          const s = await stat(child);
          out.push({ path: this.rel(child), type: "file", bytes: s.size, modified: s.mtime.toISOString() });
        }
      }
    };
    await walk(this.resolvePath(dir));
    return out;
  }

  async read(path: string): Promise<string> {
    const text = await readFile(this.resolvePath(path), "utf8");
    return text.length > MAX_READ_BYTES ? `${text.slice(0, MAX_READ_BYTES)}\n\n[truncated at ${MAX_READ_BYTES} chars]` : text;
  }

  // Creates or replaces a page in wiki/ or output/.
  async write(path: string, content: string): Promise<{ path: string; created: boolean }> {
    const full = this.resolvePath(path);
    const top = this.rel(full).split("/")[0] ?? "";
    if (!WRITABLE.includes(top)) throw new Error(`Only ${WRITABLE.map((d) => `${d}/`).join(" and ")} are writable`);
    if (!full.endsWith(".md")) throw new Error("Only .md files can be written");
    const created = !existsSync(full);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
    log.info("page written", { path: this.rel(full), created, bytes: content.length });
    return { path: this.rel(full), created };
  }

  // Writes a raw source unless it already exists (raw files are never modified). Returns true if written.
  async writeRawOnce(path: string, content: string): Promise<boolean> {
    const full = this.resolvePath(join("raw", path));
    if (existsSync(full)) return false;
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, { encoding: "utf8", flag: "wx" });
    return true;
  }

  // Case-insensitive search of all terms (AND) per line, in .md files under `dir`.
  async search(query: string, dir = "wiki", limit = 50): Promise<SearchHit[]> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const hits: SearchHit[] = [];
    for (const e of await this.list(dir, true)) {
      if (e.type !== "file" || !e.path.endsWith(".md")) continue;
      const lines = (await readFile(this.resolvePath(e.path), "utf8")).split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i]!.toLowerCase();
        if (terms.every((t) => l.includes(t))) {
          hits.push({ path: e.path, line: i + 1, text: lines[i]!.trim().slice(0, 300) });
          if (hits.length >= limit) return hits;
        }
      }
    }
    return hits;
  }

  // Small JSON state files (e.g. sync cursors) stored as hidden files in the brain root.
  async readState<T>(name: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(this.resolvePath(`.${name}.json`), "utf8")) as T;
    } catch {
      return fallback;
    }
  }

  async writeState(name: string, value: unknown) {
    await writeFile(this.resolvePath(`.${name}.json`), JSON.stringify(value, null, 2), "utf8");
  }
}

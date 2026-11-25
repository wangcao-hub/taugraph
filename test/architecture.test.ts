// Enforces the kernel rules from the README so they cannot erode silently.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

function sources(dir: string): { file: string; imports: string[] }[] {
  return readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts"))
    .map((file) => {
      const text = readFileSync(join(root, dir, file), "utf8");
      const imports = [
        ...text.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)";|^\s*import\s+"([^"]+)";/gm),
      ].map((m) => (m[1] ?? m[2]) as string);
      return { file: join(dir, file), imports };
    });
}

describe("architecture", () => {
  it("has zero runtime dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.peerDependencies ?? {}).toEqual({});
  });

  it("keeps the kernel free of plugins and platform modules", () => {
    for (const { file, imports } of sources("src/core")) {
      for (const spec of imports) {
        expect(spec, `${file} imports ${spec}`).toMatch(/^\.\/[\w-]+\.js$/);
      }
    }
  });

  it("builds the agent on the public API only", () => {
    for (const { file, imports } of sources("src/agent")) {
      for (const spec of imports) {
        expect(spec, `${file} imports ${spec}`).toMatch(/^(\.\.\/index\.js|\.\.\/nodes\/index\.js|\.\/[\w-]+\.js)$/);
      }
    }
  });

  it("builds the OpenAI-compatible adapter on the public API only", () => {
    for (const { file, imports } of sources("src/openai")) {
      for (const spec of imports) {
        expect(spec, `${file} imports ${spec}`).toMatch(/^(\.\.\/index\.js|\.\.\/nodes\/index\.js|\.\/[\w-]+\.js)$/);
      }
    }
  });

  it("builds plugin nodes on the public API only", () => {
    for (const { file, imports } of sources("src/nodes")) {
      for (const spec of imports) {
        expect(spec, `${file} imports ${spec}`).toMatch(/^(\.\.\/index\.js|\.\/[\w-]+\.js)$/);
      }
    }
  });
});

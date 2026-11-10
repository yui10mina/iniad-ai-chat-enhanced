import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createRequire } from "module";

const moduleRequire = createRequire(path.resolve("package.json"));
const {
  MIN_MCP_RUNTIME_NODE_VERSION,
  buildMcpRuntime,
  computeRuntimeTreeHash,
  isSupportedMcpRuntimeNodeVersion,
} = moduleRequire("./scripts/copy-mcp-runtime.cjs") as {
  MIN_MCP_RUNTIME_NODE_VERSION: string;
  buildMcpRuntime(projectDir: string): string;
  computeRuntimeTreeHash(runtimeRoot: string): string;
  isSupportedMcpRuntimeNodeVersion(version: string): boolean;
};
const packageMetadata = moduleRequire("./package.json") as { engines?: { node?: string } };
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  );
});

describe("bundled MCP runtime Node.js version", () => {
  it("rejects Node.js releases older than 22.12", () => {
    for (const version of ["20.17.0", "v20.19.5", "21.7.3", "22.11.0", "v22.11.99"]) {
      expect(isSupportedMcpRuntimeNodeVersion(version)).toBe(false);
    }
  });

  it("accepts Node.js 22.12 and later", () => {
    for (const version of ["22.12.0", "v22.23.4", "23.0.0", "24.1.0", "v100.0.0"]) {
      expect(isSupportedMcpRuntimeNodeVersion(version)).toBe(true);
    }
  });

  it("refuses versions it cannot parse", () => {
    expect(() => isSupportedMcpRuntimeNodeVersion("not-a-version")).toThrow(
      "Unable to parse Node.js version"
    );
  });

  it("matches the engines requirement in package.json", () => {
    expect(packageMetadata.engines?.node).toBe(`>=${MIN_MCP_RUNTIME_NODE_VERSION}`);
  });

  it("stops before deleting or copying anything on an older Node.js", () => {
    const nodeFs = moduleRequire("node:fs") as typeof import("node:fs");
    // If the version check were removed, the build would reach rmSync and fail here instead of
    // deleting and rebuilding the real .mcp-runtime.
    const rmSync = vi.spyOn(nodeFs, "rmSync").mockImplementation(() => {
      throw new Error("rmSync reached");
    });
    const original = Object.getOwnPropertyDescriptor(process.versions, "node");
    if (!original) throw new Error("process.versions.node is missing");
    Object.defineProperty(process.versions, "node", { ...original, value: "20.17.0" });
    try {
      expect(() => buildMcpRuntime(path.resolve("."))).toThrow("requires Node.js 22.12.0 or later");
      expect(rmSync).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process.versions, "node", original);
      rmSync.mockRestore();
    }
  });
});

describe("packaged MCP runtime integrity", () => {
  it("refuses to write a runtime outside the project that owns the build script", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "mcp-runtime-wrong-project-"));
    temporaryDirectories.push(directory);

    expect(() => buildMcpRuntime(directory)).toThrow(
      "Refusing to write MCP runtime outside this project"
    );
    await expect(fs.access(path.join(directory, ".mcp-runtime"))).rejects.toThrow();
  });

  it("is deterministic and changes when runtime code is modified", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "mcp-runtime-integrity-"));
    temporaryDirectories.push(directory);
    await fs.mkdir(path.join(directory, "node_modules"));
    await fs.writeFile(path.join(directory, "runtime.json"), "runtime", "utf8");
    await fs.writeFile(path.join(directory, "node_modules", "entry.js"), "version-one", "utf8");

    const original = computeRuntimeTreeHash(directory);
    expect(computeRuntimeTreeHash(directory)).toBe(original);

    await fs.writeFile(path.join(directory, "integrity.json"), "ignored metadata", "utf8");
    expect(computeRuntimeTreeHash(directory)).toBe(original);

    await fs.writeFile(path.join(directory, "node_modules", "entry.js"), "version-two", "utf8");
    expect(computeRuntimeTreeHash(directory)).not.toBe(original);
  });
});

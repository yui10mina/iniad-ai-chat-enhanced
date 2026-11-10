/** Verify the exact MCP runtime used by development or a packaged application. */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const sourceRequire = createRequire(import.meta.url);
const { MIN_MCP_RUNTIME_NODE_VERSION, computeRuntimeTreeHash, isSupportedMcpRuntimeNodeVersion } =
  sourceRequire(path.join(scriptDirectory, "copy-mcp-runtime.cjs"));
const { extractFile: extractAsarFile } = sourceRequire("@electron/asar");
const usePackagedRuntime = process.argv.includes("--packaged");
const expectedTools = [
  "loginToIniadMoocsWithIniadAccount",
  "listCourses",
  "browser_navigate",
  "listLectureLinks",
  "listSlideLinks",
  "browser_snapshot",
  "loginToGoogleWithIniadAccount",
  "expandSlideTab",
  "extractGoogleSlideText",
];

function resolveRuntimeFile(runtimeRoot, relativePath) {
  if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath)) {
    throw new Error("Invalid MCP runtime manifest path");
  }
  const realRoot = fs.realpathSync(runtimeRoot);
  const candidate = fs.realpathSync(path.resolve(realRoot, relativePath));
  const relative = path.relative(realRoot, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("MCP runtime manifest path escapes the runtime directory");
  }
  if (!fs.statSync(candidate).isFile()) throw new Error("MCP runtime entry is not a file");
  return candidate;
}

function loadPackagedRuntime() {
  const runtimeRoot = path.join(
    projectRoot,
    "out",
    `iniad-ai-chat-enhanced-${process.platform}-${process.arch}`,
    "resources",
    ".mcp-runtime"
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(runtimeRoot, "runtime.json"), "utf8")
  );
  const integrity = JSON.parse(
    fs.readFileSync(path.join(runtimeRoot, "integrity.json"), "utf8")
  );
  if (
    manifest.schemaVersion !== 1 ||
    [
      manifest.nodeExecutable,
      manifest.entryScript,
      manifest.mcpCli,
      manifest.chromiumExecutable,
    ].some((value) => typeof value !== "string")
  ) {
    throw new Error("Invalid MCP runtime manifest");
  }
  if (
    integrity.schemaVersion !== 1 ||
    integrity.algorithm !== "sha256" ||
    !/^[a-f0-9]{64}$/.test(integrity.treeSha256)
  ) {
    throw new Error("Invalid MCP runtime integrity metadata");
  }
  return {
    runtimeRoot,
    appAsar: path.join(path.dirname(runtimeRoot), "app.asar"),
    expectedTreeHash: integrity.treeSha256,
    moduleRequire: createRequire(path.join(runtimeRoot, "runtime.json")),
    nodeExecutable: resolveRuntimeFile(runtimeRoot, manifest.nodeExecutable),
    entryScript: resolveRuntimeFile(runtimeRoot, manifest.entryScript),
    mcpCli: resolveRuntimeFile(runtimeRoot, manifest.mcpCli),
    chromiumExecutable: resolveRuntimeFile(runtimeRoot, manifest.chromiumExecutable),
  };
}

function loadDevelopmentRuntime() {
  const mcpPackageDirectory = path.dirname(
    sourceRequire.resolve("@rarandeyo/iniad-moocs-mcp/package.json")
  );
  const { chromium } = sourceRequire("playwright");
  return {
    moduleRequire: sourceRequire,
    nodeExecutable: fs.realpathSync(process.execPath),
    entryScript: fs.realpathSync(path.join(scriptDirectory, "mcp-runtime-entry.cjs")),
    mcpCli: fs.realpathSync(path.join(mcpPackageDirectory, "cli.js")),
    chromiumExecutable: fs.realpathSync(chromium.executablePath()),
    dataRoot: path.join(projectRoot, "data"),
  };
}

function verifyPackagedRuntimeIntegrity(runtime) {
  const packagedMain = extractAsarFile(
    runtime.appAsar,
    path.join(".webpack", "main", "index.js")
  );
  if (!packagedMain.includes(Buffer.from(runtime.expectedTreeHash))) {
    throw new Error("Trusted MCP runtime hash is not embedded in app.asar");
  }
  if (computeRuntimeTreeHash(runtime.runtimeRoot) !== runtime.expectedTreeHash) {
    throw new Error("Packaged MCP runtime tree hash does not match");
  }
}

function verifyLectureIndexes(runtime) {
  const readIndex = (fileName) =>
    usePackagedRuntime
      ? extractAsarFile(
          runtime.appAsar,
          path.join(".webpack", "main", "data", fileName)
        ).toString("utf8")
      : fs.readFileSync(path.join(runtime.dataRoot, fileName), "utf8");
  const slides = JSON.parse(readIndex("slides-index.json"));
  const syllabus = JSON.parse(readIndex("syllabus-index.json"));
  if (!Array.isArray(slides.entries) || !Array.isArray(syllabus.courses)) {
    throw new Error("Lecture index schema is invalid");
  }
  return { slides: slides.entries.length, courses: syllabus.courses.length };
}

let passed = 0;
let failed = 0;
function result(section, message, status = "pass") {
  const marker = status === "pass" ? "PASS" : status === "fail" ? "FAIL" : "INFO";
  console.log(`  [${marker}] ${section}: ${message}`);
  if (status === "pass") passed += 1;
  if (status === "fail") failed += 1;
}

console.log(`\nMCP runtime verification (${usePackagedRuntime ? "packaged" : "development"})`);
console.log("=".repeat(60));

let runtime;
try {
  runtime = usePackagedRuntime ? loadPackagedRuntime() : loadDevelopmentRuntime();
  if (usePackagedRuntime) {
    verifyPackagedRuntimeIntegrity(runtime);
    result("Integrity", "runtime tree matches the hash embedded in app.asar");
  }
  const indexes = verifyLectureIndexes(runtime);
  result("Data", `${indexes.slides} slide entries and ${indexes.courses} courses are available`);
} catch (error) {
  result("Integrity", error instanceof Error ? error.message : String(error), "fail");
  console.log("=".repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed\n`);
  process.exit(1);
}

if (usePackagedRuntime) {
  try {
    const bundledNodeVersion = execFileSync(runtime.nodeExecutable, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    }).trim();
    if (isSupportedMcpRuntimeNodeVersion(bundledNodeVersion)) {
      result(
        "Node",
        `bundled Node.js ${bundledNodeVersion} meets >=${MIN_MCP_RUNTIME_NODE_VERSION}`
      );
    } else {
      result(
        "Node",
        `bundled Node.js ${bundledNodeVersion} is older than ${MIN_MCP_RUNTIME_NODE_VERSION}`,
        "fail"
      );
    }
  } catch (error) {
    result("Node", error instanceof Error ? error.message : String(error), "fail");
  }
}

const { Client } = runtime.moduleRequire("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = runtime.moduleRequire(
  "@modelcontextprotocol/sdk/client/stdio.js"
);
const { z } = runtime.moduleRequire("zod");
const { chromium } = runtime.moduleRequire("playwright");

const childEnvironment = Object.fromEntries(
  [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "XDG_CACHE_HOME",
    "PLAYWRIGHT_BROWSERS_PATH",
    "LANG",
    "LC_ALL",
    "TZ",
  ]
    .filter((key) => typeof process.env[key] === "string" && process.env[key].length > 0)
    .map((key) => [key, process.env[key]])
);

function packageVersion(moduleRequire, entrySpecifier, packageName) {
  let current = path.dirname(moduleRequire.resolve(entrySpecifier));
  while (current !== path.dirname(current)) {
    const metadataPath = path.join(current, "package.json");
    if (fs.existsSync(metadataPath)) {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
      if (metadata.name === packageName) return metadata.version;
    }
    current = path.dirname(current);
  }
  throw new Error(`Unable to read ${packageName} metadata`);
}

try {
  result(
    "SDK",
    `version ${packageVersion(
      runtime.moduleRequire,
      "@modelcontextprotocol/sdk/client/index.js",
      "@modelcontextprotocol/sdk"
    )}`
  );
  new Client({ name: "verify-constructor", version: "1.0.0" }, { capabilities: {} });
  result("SDK", "Client can be instantiated");

  const mcpMetadata = runtime.moduleRequire("@rarandeyo/iniad-moocs-mcp/package.json");
  result("MCP", `version ${mcpMetadata.version}`);
  result("Runtime", "Node, credential guard, MCP CLI, and Chromium are present");

  let browser;
  try {
    browser = await chromium.launch({
      executablePath: runtime.chromiumExecutable,
      headless: true,
      timeout: 10_000,
    });
    result("Chromium", "bundled executable launched successfully");
  } finally {
    await browser?.close().catch(() => undefined);
  }
} catch (error) {
  result("Runtime", error instanceof Error ? error.message : String(error), "fail");
}

let transport;
let client;
const verificationProfileDirectory = path.join(
  os.tmpdir(),
  `iniad-ai-chat-mcp-verify-${process.pid}-${randomUUID()}`
);
try {
  transport = new StdioClientTransport({
    command: runtime.nodeExecutable,
    args: [
      runtime.entryScript,
      runtime.mcpCli,
      "--headless",
      "--browser",
      "chromium",
      "--executable-path",
      runtime.chromiumExecutable,
      "--user-data-dir",
      verificationProfileDirectory,
    ],
    env: {
      ...childEnvironment,
      INIAD_USERNAME: "test_verify_user",
      INIAD_PASSWORD: "test_verify_password",
    },
    stderr: "ignore",
  });
  client = new Client({ name: "verify-runtime", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport, { timeout: 30_000, maxTotalTimeout: 30_000 });
  result("Server", "stdio initialization succeeded");

  let toolNames;
  try {
    const listed = await client.listTools({}, { timeout: 10_000, maxTotalTimeout: 10_000 });
    toolNames = listed.tools.map((tool) => tool.name);
  } catch {
    const listed = await client.request(
      { method: "tools/list", params: {} },
      z.object({ tools: z.array(z.object({ name: z.string() }).passthrough()) }).passthrough(),
      { timeout: 10_000, maxTotalTimeout: 10_000 }
    );
    toolNames = listed.tools.map((tool) => tool.name);
  }
  result("Tools", `discovered ${toolNames.length} tools`);
  for (const expected of expectedTools) {
    if (toolNames.includes(expected)) result("Tools", `found ${expected}`);
    else result("Tools", `missing ${expected}`, "fail");
  }

  const blockedNavigation = await client.request(
    {
      method: "tools/call",
      params: { name: "browser_navigate", arguments: { url: "https://example.com/" } },
    },
    z
      .object({ content: z.array(z.unknown()).optional(), isError: z.boolean().optional() })
      .passthrough(),
    { timeout: 20_000, maxTotalTimeout: 20_000 }
  );
  if (!blockedNavigation.isError) {
    throw new Error("MCP browser network policy did not block an untrusted origin");
  }
  result("Network policy", "untrusted browser origin was blocked");

  const browserToolResult = await client.request(
    {
      method: "tools/call",
      params: { name: "browser_navigate", arguments: { url: "about:blank" } },
    },
    z
      .object({ content: z.array(z.unknown()).optional(), isError: z.boolean().optional() })
      .passthrough(),
    { timeout: 20_000, maxTotalTimeout: 20_000 }
  );
  if (browserToolResult.isError) {
    const diagnostic = browserToolResult.content
      ?.map((item) => (item && typeof item === "object" && "text" in item ? item.text : ""))
      .filter(Boolean)
      .join(" ")
      .slice(0, 500);
    throw new Error(`browser_navigate returned an MCP tool error: ${diagnostic || "unknown"}`);
  }
  result("Browser tool", "browser_navigate launched the configured Chromium");
} catch (error) {
  result("Server", error instanceof Error ? error.message : String(error), "fail");
} finally {
  let cleanupSucceeded = true;
  try {
    await client?.close();
  } catch {
    cleanupSucceeded = false;
  }
  try {
    transport?.process?.kill?.();
  } catch {
    cleanupSucceeded = false;
  }
  try {
    fs.rmSync(verificationProfileDirectory, { recursive: true, force: true });
  } catch {
    cleanupSucceeded = false;
  }
  result(
    "Server",
    cleanupSucceeded ? "disconnected cleanly" : "cleanup failed",
    cleanupSucceeded ? "pass" : "fail"
  );
}

console.log("=".repeat(60));
console.log(`Results: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);

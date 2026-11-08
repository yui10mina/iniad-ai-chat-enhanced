const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { createHash } = require("node:crypto");

const RUNTIME_INTEGRITY_FILE = "integrity.json";
const HASH_BUFFER_BYTES = 1024 * 1024;
// The Node.js that runs `npm run package` is copied into the packaged MCP runtime, so
// packaging with an older (end-of-life) Node.js would silently ship it to users.
// Keep in sync with `engines.node` in package.json.
const MIN_MCP_RUNTIME_NODE_VERSION = "22.12.0";

function parseNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim());
  if (!match) throw new Error(`Unable to parse Node.js version: ${version}`);
  return match.slice(1, 4).map(Number);
}

function isSupportedMcpRuntimeNodeVersion(version) {
  const actual = parseNodeVersion(version);
  const minimum = parseNodeVersion(MIN_MCP_RUNTIME_NODE_VERSION);
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}

function compareNames(left, right) {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function computeRuntimeTreeHash(runtimeRoot) {
  const resolvedRoot = fs.realpathSync(runtimeRoot);
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);

  function visit(directory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort(compareNames);
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(resolvedRoot, absolutePath).replaceAll(path.sep, "/");
      if (relativePath === RUNTIME_INTEGRITY_FILE) continue;
      if (entry.isSymbolicLink()) {
        throw new Error(`MCP runtime must not contain symbolic links: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Unsupported MCP runtime entry: ${relativePath}`);
      }

      const size = fs.statSync(absolutePath).size;
      hash.update("file\0");
      hash.update(relativePath);
      hash.update("\0");
      hash.update(String(size));
      hash.update("\0");
      const descriptor = fs.openSync(absolutePath, "r");
      try {
        let bytesRead;
        do {
          bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
          if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
        } while (bytesRead > 0);
      } finally {
        fs.closeSync(descriptor);
      }
      hash.update("\0");
    }
  }

  visit(resolvedRoot);
  return hash.digest("hex");
}

function resolvePackageJson(packageName, basedir) {
  const packageRequire = createRequire(path.join(basedir, "package.json"));
  let current;
  try {
    const exportedCandidate = packageRequire.resolve(`${packageName}/package.json`);
    const exportedMetadata = JSON.parse(fs.readFileSync(exportedCandidate, "utf8"));
    if (exportedMetadata.name === packageName) return exportedCandidate;
    current = path.dirname(exportedCandidate);
  } catch {
    // Some packages do not export their root package.json.
  }

  if (!current) current = path.dirname(packageRequire.resolve(packageName));
  while (current !== path.dirname(current)) {
    const candidate = path.join(current, "package.json");
    if (fs.existsSync(candidate)) {
      const metadata = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (metadata.name === packageName) return candidate;
    }
    current = path.dirname(current);
  }
  throw new Error(`Unable to resolve runtime package: ${packageName}`);
}

function copyPackageClosure(
  packageName,
  basedir,
  projectNodeModules,
  targetNodeModules,
  seen,
  optional = false
) {
  let packageJsonPath;
  try {
    packageJsonPath = resolvePackageJson(packageName, basedir);
  } catch (error) {
    if (optional) return;
    throw error;
  }

  const packageDir = path.dirname(packageJsonPath);
  const realPackageDir = fs.realpathSync(packageDir);
  if (seen.has(realPackageDir)) return;
  seen.add(realPackageDir);

  const relativeDir = path.relative(projectNodeModules, packageDir);
  if (relativeDir.startsWith("..") || path.isAbsolute(relativeDir)) {
    throw new Error(`MCP runtime package resolved outside node_modules: ${packageName}`);
  }

  fs.cpSync(packageDir, path.join(targetNodeModules, relativeDir), {
    recursive: true,
    force: true,
    dereference: true,
  });

  const metadata = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  for (const dependency of Object.keys(metadata.dependencies || {})) {
    copyPackageClosure(dependency, packageDir, projectNodeModules, targetNodeModules, seen);
  }
  for (const dependency of Object.keys(metadata.optionalDependencies || {})) {
    copyPackageClosure(dependency, packageDir, projectNodeModules, targetNodeModules, seen, true);
  }
}

function buildMcpRuntime(projectDir) {
  const scriptProjectDir = fs.realpathSync(path.resolve(__dirname, ".."));
  let resolvedProjectDir;
  try {
    resolvedProjectDir = fs.realpathSync(path.resolve(projectDir));
  } catch {
    throw new Error("Refusing to write MCP runtime outside this project");
  }
  if (resolvedProjectDir !== scriptProjectDir) {
    throw new Error("Refusing to write MCP runtime outside this project");
  }
  const nodeVersion = process.versions.node;
  if (!isSupportedMcpRuntimeNodeVersion(nodeVersion)) {
    throw new Error(
      `Building the MCP runtime (npm start, npm run package) requires Node.js ` +
        `${MIN_MCP_RUNTIME_NODE_VERSION} or later because the running Node.js is copied into ` +
        `the runtime, but this is Node.js ${nodeVersion}. ` +
        "Switch to Node.js 22.12 or later and run the command again."
    );
  }
  const targetRoot = path.join(resolvedProjectDir, ".mcp-runtime");

  fs.rmSync(targetRoot, { recursive: true, force: true });
  const projectNodeModules = path.join(resolvedProjectDir, "node_modules");
  const targetNodeModules = path.join(targetRoot, "node_modules");
  fs.mkdirSync(targetNodeModules, { recursive: true });
  copyPackageClosure(
    "@rarandeyo/iniad-moocs-mcp",
    resolvedProjectDir,
    projectNodeModules,
    targetNodeModules,
    new Set()
  );
  const mcpCliTarget = path.join(targetNodeModules, "@rarandeyo", "iniad-moocs-mcp", "cli.js");
  if (!fs.existsSync(mcpCliTarget) || !fs.statSync(mcpCliTarget).isFile()) {
    throw new Error("MCP CLI entry point was not found in the packaged runtime");
  }

  const projectRequire = createRequire(path.join(resolvedProjectDir, "package.json"));
  const { chromium } = projectRequire("playwright");
  const chromiumExecutable = chromium.executablePath();
  if (!chromiumExecutable || !fs.existsSync(chromiumExecutable)) {
    throw new Error(
      "Playwright Chromium is not installed. Run `npm exec playwright install chromium` before packaging."
    );
  }

  let chromiumRoot = path.dirname(chromiumExecutable);
  while (
    chromiumRoot !== path.dirname(chromiumRoot) &&
    !/^chromium-\d+$/i.test(path.basename(chromiumRoot))
  ) {
    chromiumRoot = path.dirname(chromiumRoot);
  }
  if (!/^chromium-\d+$/i.test(path.basename(chromiumRoot))) {
    throw new Error("Unable to locate the installed Playwright Chromium runtime directory");
  }

  const nodeTarget = path.join(targetRoot, "bin", path.basename(process.execPath));
  const browserTarget = path.join(targetRoot, "browser");
  const entryTarget = path.join(targetRoot, "mcp-runtime-entry.cjs");
  fs.mkdirSync(path.dirname(nodeTarget), { recursive: true });
  fs.copyFileSync(process.execPath, nodeTarget);
  fs.chmodSync(nodeTarget, 0o755);
  fs.cpSync(chromiumRoot, browserTarget, {
    recursive: true,
    force: true,
    dereference: true,
  });
  fs.copyFileSync(path.join(resolvedProjectDir, "scripts", "mcp-runtime-entry.cjs"), entryTarget);
  fs.copyFileSync(
    path.join(resolvedProjectDir, "scripts", "mcp-network-policy.cjs"),
    path.join(targetRoot, "mcp-network-policy.cjs")
  );

  const runtimeManifest = {
    schemaVersion: 1,
    nodeExecutable: path.relative(targetRoot, nodeTarget),
    entryScript: path.relative(targetRoot, entryTarget),
    mcpCli: path.relative(targetRoot, mcpCliTarget),
    chromiumExecutable: path.join("browser", path.relative(chromiumRoot, chromiumExecutable)),
  };
  fs.writeFileSync(
    path.join(targetRoot, "runtime.json"),
    `${JSON.stringify(runtimeManifest, null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(targetRoot, RUNTIME_INTEGRITY_FILE),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        algorithm: "sha256",
        treeSha256: computeRuntimeTreeHash(targetRoot),
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return targetRoot;
}

module.exports = {
  MIN_MCP_RUNTIME_NODE_VERSION,
  buildMcpRuntime,
  computeRuntimeTreeHash,
  isSupportedMcpRuntimeNodeVersion,
};

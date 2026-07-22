import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const keycloakVersion = process.env.KEYCLOAK_VERSION ?? "23.0.4";
const targetPlatform = process.env.TARGET_PLATFORM ?? process.platform;

const targets = {
  win32: { archiveType: "zip" },
  linux: { archiveType: "tar.gz" },
  darwin: { archiveType: "tar.gz" },
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function versionedAssetName(version, platform, archiveType) {
  return `lasso-keycloak-${version}-${platform}.${archiveType === "zip" ? "zip" : "tar.gz"}`;
}

async function download(url, destination) {
  if (existsSync(destination)) {
    return;
  }

  const response = await fetch(url, {
    headers: {
      "user-agent": "service-lasso-lasso-keycloak-packager",
    },
  });

  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(destination, bytes);
}

async function compressPackage(packageRoot, outputPath, archiveType) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await rm(outputPath, { force: true });

  if (archiveType === "zip") {
    run("powershell", [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path ${JSON.stringify(path.join(packageRoot, "*"))} -DestinationPath ${JSON.stringify(outputPath)} -Force`,
    ]);
    return outputPath;
  }

  run("tar", ["-czf", outputPath, "-C", packageRoot, "."]);
  return outputPath;
}

async function findKeycloakRoot(extractRoot, version) {
  const expected = path.join(extractRoot, `keycloak-${version}`);
  if (existsSync(expected)) {
    return expected;
  }

  const entries = await readdir(extractRoot, { withFileTypes: true });
  const found = entries.find((entry) => entry.isDirectory() && entry.name.startsWith("keycloak-"));
  if (!found) {
    throw new Error(`Could not find extracted keycloak-${version} under ${extractRoot}`);
  }

  return path.join(extractRoot, found.name);
}

export async function packageKeycloak(platform = targetPlatform, version = keycloakVersion) {
  const target = targets[platform];
  if (!target) {
    throw new Error(`Unsupported target platform: ${platform}`);
  }

  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Expected Keycloak version like "23.0.4", got "${version}".`);
  }

  const upstreamAsset = `keycloak-${version}.tar.gz`;
  const upstreamUrl = `https://github.com/keycloak/keycloak/releases/download/${version}/${upstreamAsset}`;
  const vendorRoot = path.join(repoRoot, "vendor", version);
  const outputRoot = path.join(repoRoot, "output", "package", version, platform);
  const extractRoot = path.join(outputRoot, "extract");
  const packageRoot = path.join(outputRoot, "payload");
  const upstreamArchive = path.join(vendorRoot, upstreamAsset);
  const assetName = versionedAssetName(version, platform, target.archiveType);
  const outputPath = path.join(repoRoot, "dist", assetName);

  await mkdir(vendorRoot, { recursive: true });
  await download(upstreamUrl, upstreamArchive);

  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(extractRoot, { recursive: true });
  await mkdir(packageRoot, { recursive: true });

  run("tar", ["-xzf", upstreamArchive, "-C", extractRoot]);

  const keycloakRoot = await findKeycloakRoot(extractRoot, version);
  await cp(keycloakRoot, path.join(packageRoot, "keycloak"), { recursive: true });
  await mkdir(path.join(packageRoot, "scripts"), { recursive: true });
  await cp(path.join(repoRoot, "scripts", "lasso-keycloak.mjs"), path.join(packageRoot, "scripts", "lasso-keycloak.mjs"));

  if (platform !== "win32") {
    await chmod(path.join(packageRoot, "keycloak", "bin", "kc.sh"), 0o755);
    await chmod(path.join(packageRoot, "keycloak", "bin", "kcadm.sh"), 0o755);
    await chmod(path.join(packageRoot, "keycloak", "bin", "kcreg.sh"), 0o755);
    await chmod(path.join(packageRoot, "scripts", "lasso-keycloak.mjs"), 0o755);
  }

  await writeFile(
    path.join(packageRoot, "README.service-lasso.txt"),
    `Service Lasso Keycloak package\n\nUpstream: Keycloak ${version}\nSource: ${upstreamUrl}\n`,
  );

  await compressPackage(packageRoot, outputPath, target.archiveType);
  return {
    outputPath,
    assetName,
    archiveType: target.archiveType,
    platform,
    version,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await packageKeycloak();
  console.log(`Created ${result.outputPath}`);
}

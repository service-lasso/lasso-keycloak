import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageKeycloak } from "./package.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platform = process.env.TARGET_PLATFORM ?? process.platform;
const version = process.env.KEYCLOAK_VERSION ?? "23.0.4";

const target = {
  win32: {
    archiveType: "zip",
    startupScript: "kc.bat",
  },
  linux: {
    archiveType: "tar.gz",
    startupScript: "kc.sh",
  },
  darwin: {
    archiveType: "tar.gz",
    startupScript: "kc.sh",
  },
}[platform];

if (!target) {
  throw new Error(`Unsupported target platform: ${platform}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }

  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}

async function extractArchive(archivePath, destination, archiveType) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });

  if (archiveType === "zip") {
    run("powershell", [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      `Expand-Archive -Path ${JSON.stringify(archivePath)} -DestinationPath ${JSON.stringify(destination)} -Force`,
    ]);
    return;
  }

  run("tar", ["-xzf", archivePath, "-C", destination]);
}

function expect(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const manifest = JSON.parse(await readFile(path.join(repoRoot, "service.json"), "utf8"));
const requiredProviderIds = ["@java", "@node", "postgres"];

function expectDependency(container, dependencyId, label) {
  expect(
    container?.includes(dependencyId),
    `${label} must depend on concrete provider id "${dependencyId}" until provider capability aliases are available. Required ids: ${requiredProviderIds.join(", ")}.`,
  );
}

function expectNoLegacyProviderIds(container, label) {
  for (const legacyId of ["postgredb"]) {
    expect(
      !container?.includes(legacyId),
      `${label} must not use legacy provider id "${legacyId}". Use concrete provider id "postgres".`,
    );
  }
}

expect(manifest.id === "keycloak", `Expected service id "keycloak", got "${manifest.id}".`);
expect(manifest.version === version, `Expected manifest version ${version}, got ${manifest.version}.`);
expect(manifest.enabled === false, "Keycloak should be disabled by default so apps opt in explicitly.");
expect(manifest.execservice === "@java", "Keycloak must run through the Java provider.");
expect(manifest.artifact?.source?.repo === "service-lasso/lasso-keycloak", "Manifest artifact source must point at service-lasso/lasso-keycloak.");
expect(!Object.hasOwn(manifest, "ports"), "Keycloak manifest must author network interfaces through canonical endpoints[] instead of top-level ports.");
expect(!Object.hasOwn(manifest, "urls"), "Keycloak manifest must author operator links through canonical url endpoints instead of top-level urls.");
expect(Array.isArray(manifest.endpoints), "Keycloak manifest must declare canonical endpoints[].");
const endpointById = new Map(manifest.endpoints.map((endpoint) => [endpoint.id, endpoint]));
for (const endpointId of ["http", "https", "base_url", "admin_console", "health", "ready", "live", "metrics"]) {
  expect(endpointById.has(endpointId), `Keycloak manifest is missing endpoint ${endpointId}.`);
}
expect(endpointById.get("http").kind === "network", "Keycloak http endpoint must be a network endpoint.");
expect(endpointById.get("http").protocol === "http", "Keycloak http endpoint must use http protocol.");
expect(endpointById.get("http").port?.default === 8116, "Keycloak http endpoint must preserve preferred port 8116.");
expect(endpointById.get("http").port?.strategy === "preferred", "Keycloak http endpoint must use preferred port strategy.");
expect(endpointById.get("https").kind === "network", "Keycloak https endpoint must be a network endpoint.");
expect(endpointById.get("https").protocol === "https", "Keycloak https endpoint must use https protocol.");
expect(endpointById.get("https").port?.default === 8117, "Keycloak https endpoint must preserve preferred port 8117.");
expect(endpointById.get("https").port?.strategy === "preferred", "Keycloak https endpoint must use preferred port strategy.");
expect(endpointById.get("base_url").url === "http://${endpoint.http.bind}:${endpoint.http.port}", "Keycloak base URL endpoint must preserve the slashless KEYCLOAK_URL shape.");
expect(endpointById.get("ready").kind === "url", "Keycloak ready endpoint must be a url endpoint.");
expect(endpointById.get("ready").target === "http", "Keycloak ready endpoint must target the http endpoint.");
expect(endpointById.get("ready").url === "${endpoint.base_url.url}/health/ready", "Keycloak ready endpoint must use endpoint selectors.");
expect(manifest.env.KEYCLOAK_PORT === "${endpoint.http.port}", "KEYCLOAK_PORT must be a compatibility alias for endpoint.http.port.");
expect(manifest.env.KEYCLOAK_HTTPS_PORT === "${endpoint.https.port}", "KEYCLOAK_HTTPS_PORT must be a compatibility alias for endpoint.https.port.");
expect(!JSON.stringify(manifest).includes("${SERVICE_PORT}"), "Manifest must not author against legacy ${SERVICE_PORT} selectors.");
expect(!JSON.stringify(manifest).includes("${HTTPS_PORT}"), "Manifest must not author against legacy ${HTTPS_PORT} selectors.");
for (const providerId of requiredProviderIds) {
  expectDependency(manifest.depend_on, providerId, "Top-level depend_on");
}
expectNoLegacyProviderIds(manifest.depend_on, "Top-level depend_on");
expect(manifest.setup?.steps?.["generate-keystore"], "Keycloak must declare generate-keystore setup.");
expect(manifest.setup?.steps?.["ensure-database"], "Keycloak must declare ensure-database setup.");
expect(manifest.setup?.steps?.["build-keycloak"], "Keycloak must declare build-keycloak setup.");
expect(!Object.hasOwn(manifest, "healthcheck"), "Keycloak manifest must use canonical healthchecks[] instead of singular healthcheck.");
expect(Array.isArray(manifest.healthchecks), "Keycloak manifest must declare canonical healthchecks[].");
expect(manifest.healthchecks.length === 1, "Keycloak should declare one required readiness healthcheck.");
const [readyHealthcheck] = manifest.healthchecks;
expect(readyHealthcheck.id === "keycloak-ready", "Keycloak ready healthcheck must use stable id keycloak-ready.");
expect(readyHealthcheck.type === "http", "Keycloak ready healthcheck should be an HTTP check.");
expect(readyHealthcheck.url === "${endpoint.ready.url}", "Keycloak healthcheck should use the canonical ready endpoint selector.");
expect(readyHealthcheck.expected_status === 200, "Keycloak ready healthcheck should expect HTTP 200.");

for (const [stepId, helperCommand] of [
  ["generate-keystore", "generate-keystore"],
  ["ensure-database", "ensure-database"],
  ["build-keycloak", "build"],
]) {
  const step = manifest.setup.steps[stepId];
  expect(step.execservice === "@node", `Setup step ${stepId} must run through @node.`);
  expectDependency(step.depend_on, "@node", `Setup step ${stepId}`);
  expectNoLegacyProviderIds(step.depend_on, `Setup step ${stepId}`);
  expect(
    step.commandline?.default === `"${"${SERVICE_ARTIFACT_ROOT}"}/scripts/lasso-keycloak.mjs" ${helperCommand}`,
    `Setup step ${stepId} should call the packaged lasso-keycloak helper.`,
  );
}

expectDependency(manifest.setup.steps["generate-keystore"].depend_on, "@java", "Setup step generate-keystore");
expectDependency(manifest.setup.steps["ensure-database"].depend_on, "postgres", "Setup step ensure-database");
expectDependency(manifest.setup.steps["build-keycloak"].depend_on, "@java", "Setup step build-keycloak");

const artifact = manifest.artifact.platforms[platform];
expect(Boolean(artifact), `Manifest is missing artifact platform ${platform}.`);
expect(
  artifact.assetName === `lasso-keycloak-${version}-${platform}.${target.archiveType === "zip" ? "zip" : "tar.gz"}`,
  "Manifest artifact name does not match versioned output.",
);
expect(artifact.archiveType === target.archiveType, `Expected ${target.archiveType} archive type.`);

const packaged = await packageKeycloak(platform, version);
expect(packaged.assetName === artifact.assetName, "Packaged asset does not match manifest asset name.");
expect(existsSync(packaged.outputPath), `Packaged archive missing at ${packaged.outputPath}.`);

const extractRoot = path.join(repoRoot, "output", "verify", platform, "extract");
await extractArchive(packaged.outputPath, extractRoot, target.archiveType);

const payloadRoot = path.join(extractRoot, "keycloak");
expect(existsSync(payloadRoot), "Package must contain keycloak/ at archive root.");
expect(existsSync(path.join(extractRoot, "scripts", "lasso-keycloak.mjs")), "Package must contain scripts/lasso-keycloak.mjs.");
expect(existsSync(path.join(payloadRoot, "bin", target.startupScript)), `Package must contain bin/${target.startupScript}.`);
expect(existsSync(path.join(payloadRoot, "lib", "quarkus-run.jar")), "Package must contain lib/quarkus-run.jar.");
expect(existsSync(path.join(payloadRoot, "conf", "keycloak.conf")), "Package must contain conf/keycloak.conf.");

const versionText = await readFile(path.join(payloadRoot, "version.txt"), "utf8");
expect(versionText.includes(version), `version.txt should mention ${version}.`);

console.log(`lasso-keycloak ${version} package verification passed for ${platform}.`);

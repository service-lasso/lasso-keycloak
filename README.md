# lasso-keycloak

Release-backed Keycloak service for Service Lasso.

This repo packages upstream Keycloak `23.0.4` into Service Lasso release archives and publishes the service manifest as `service.json`.

## Service Shape

- Service ID: `keycloak`
- Upstream: Keycloak `23.0.4`
- Runtime: `@java`
- Required dependency: `postgres`
- Default HTTP port: `8116`
- Default HTTPS port: `8117`
- Health endpoint: `http://127.0.0.1:8116/health/ready`
- Metrics endpoint: `http://127.0.0.1:8116/metrics`
- Enabled by default: `false`

Keycloak is disabled by default because consuming apps must intentionally own identity data, admin credentials, PostgreSQL retention, and any production-grade secret policy.

## Release Assets

Every push to `main` packages and releases:

- `lasso-keycloak-23.0.4-win32.zip`
- `lasso-keycloak-23.0.4-linux.tar.gz`
- `lasso-keycloak-23.0.4-darwin.tar.gz`
- `service.json`
- `SHA256SUMS.txt`

Release tags use the Service Lasso pattern `yyyy.m.d-<shortsha>`.

## Service Lasso Manifest

The manifest declares:

- `execservice: "@java"` for startup/build.
- `depend_on: ["@java", "postgres"]`.
- `setup.steps.generate-keystore` for local PKCS12 keystore generation.
- `setup.steps.ensure-database` for creating the `keycloak` PostgreSQL database when needed.
- `setup.steps.build-keycloak` for the Keycloak optimized build.
- `globalenv` outputs for URL, ports, admin credentials, health, metrics, data path, and log path.

The default admin values are local-development defaults:

```text
KEYCLOAK_ADMIN=kadmin
KEYCLOAK_ADMIN_PASSWORD=kadmin
```

Apps should override these when they include the service.

## Local Verification

Run the package verification for the current platform:

```powershell
npm test
```

Run a specific platform target:

```powershell
$env:TARGET_PLATFORM = "win32"
npm test
```

The verifier downloads the official Keycloak archive, creates the Service Lasso release archive, extracts it, and checks the expected Keycloak runtime files and manifest contract.

Full live startup requires Service Lasso with `@java` and `postgres` installed/configured, then:

```powershell
service-lasso install keycloak
service-lasso setup run keycloak --include-manual
service-lasso start keycloak
```

#!/usr/bin/env bash
set -euo pipefail

# Download the official CLI archive and verify it before execution.
version=0.76.2
checksum=bc0fc726e017b8927a62b2d3531d7a84ee01769daf5c99ed866dced54089fdbf
work="$(mktemp -d "${RUNNER_TEMP:?}/atelier-trivy.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
reports="$RUNNER_TEMP/atelier-image-reports"
mkdir -p "$reports"
curl --fail --silent --show-error --location --retry 3 --max-time 90 \
  "https://github.com/aquasecurity/trivy/releases/download/v$version/trivy_${version}_Linux-64bit.tar.gz" \
  -o "$work/trivy.tar.gz"
printf '%s  %s\n' "$checksum" "$work/trivy.tar.gz" | sha256sum --check
tar -xf "$work/trivy.tar.gz" -C "$work" trivy

result=0
for image in "$@"; do
  report="$reports/${image/:/-}.json"
  raw="$work/report.json"
  rm -f -- "$raw"
  "$work/trivy" image --cache-dir "$work/cache" --image-src docker --no-progress \
    --scanners vuln,secret --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 \
    --format json --output "$raw" "$image" || result=1

  if [[ ! -s "$raw" ]]; then
    echo "::error::Trivy did not produce a report for $image."
    result=1
    continue
  fi

  # Raw secret matches and image configuration stay out of the artifact and logs.
  jq '{
    ArtifactName,
    ArtifactType,
    Results: [
      .Results[]? | {
        Target, Type,
        Vulnerabilities: [
          .Vulnerabilities[]? | {
            VulnerabilityID, PkgName, InstalledVersion, FixedVersion, Severity, PrimaryURL
          }
        ],
        SecretCount: ([.Secrets[]?] | length)
      }
    ]
  }' "$raw" >"$report"
  jq -r '
    .ArtifactName,
    (.Results[] | "\(.Target): \(.Vulnerabilities | length) vulnerabilities, \(.SecretCount) secret findings"),
    (.Results[].Vulnerabilities[] | "  \(.Severity) \(.VulnerabilityID) \(.PkgName) \(.InstalledVersion) -> \(.FixedVersion)")
  ' "$report"
done
exit "$result"

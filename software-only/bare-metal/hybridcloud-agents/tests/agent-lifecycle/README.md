# Agent Lifecycle & Removal Verification Suite (`tests/agent-lifecycle/`)

This directory contains an optional, self-pruning `FleetPackage`
(`hybridcloud-agents-agent-lifecycle`) that verifies end-to-end GitOps agent
onboarding, per-agent Envoy SDS consumer-key injection, and automated
credential/workload removal across Apigee hybrid, Secret Manager, Agent
Registry, and Config Sync.

## Fork-Only Test Tag Convention (`v0.99.x`)

Config Delivery's `ResourceBundle` release publisher converts `.` to `-` in
`cloudBuildRepository.tag` and requires the resulting release name to strictly
match `v<major>-<minor>-<patch>` (three numeric SemVer segments, with no
pre-release suffix).

To keep lifecycle verification isolated from production release tags (`v0.5.x`),
this suite uses fork-only `v0.99.x` test tags:

- **`v0.99.1` (State A — Onboarded):** Adds
  `registry/agents/adk-e2e-delete-test/agent.yaml`,
  `registry/cards/adk-e2e-delete-test.json`, the throwaway `adk-e2e-delete-test`
  workload, and its dedicated `e2e-delete-test-egress-envoy` proxy
  (`ExternalSecret/e2e-delete-test-apigee-api-key` with inline SDS key injection
  and dedicated `NetworkPolicy` objects).
- **`v0.99.2` (State B — Pruned):** Removes the throwaway agent from `registry/`
  and prunes both the agent workload and its dedicated egress proxy from
  `tests/agent-lifecycle/environments/agents/manifests.yaml` while retaining
  `ConfigMap/agent-lifecycle-suite` so Config Sync prunes all removed objects
  cleanly.

## Per-Agent Egress Proxy Requirement

Every onboarded agent workload that authenticates to Apigee hybrid with its own
`DeveloperApp` consumer key and projected Kubernetes ServiceAccount JWT
(`X-Agent-KSA-JWT`) requires its own dedicated Envoy egress proxy (or equivalent
per-agent SDS key injection) so that outbound requests carry that agent's
`x-api-key` rather than sharing another agent's consumer key.

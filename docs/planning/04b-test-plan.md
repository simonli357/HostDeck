# Test Plan

Owns active-version validation strategy, regression coverage, and release checks.

## Commands

| Purpose | Command | Required for |
| --- | --- | --- |
| Unit |  | PR/task |
| Integration |  | Module hardening |
| Build/package |  | Release |

## Coverage Matrix

| Requirement/flow | Automated | Manual | Evidence |
| --- | --- | --- | --- |
|  |  |  |  |

## Block Coverage

Use this as the overall validation map. Block-specific validation details live in `docs/planning/05-blocks/`.

| Block ID | Automated coverage | Manual/device coverage | Release evidence |
| --- | --- | --- | --- |
| BLK-V1-01 |  |  |  |

## Validation Layers

Choose layers that match the product risk; not every project needs every row.

| Layer | Applies to | Purpose | Evidence |
| --- | --- | --- | --- |
| Unit | All projects | Test isolated functions/modules | Command output |
| Integration | All projects | Test modules together and adapter boundaries | Command output |
| System / E2E | Apps/tools | Test complete user workflows | Artifact/screenshot/log |
| Visual fidelity | UI apps | Compare implementation against approved mockups/design system | Screenshot/visual diff |
| Performance | Games, realtime, web, desktop, mobile | Test latency, FPS, memory, throughput, loading | Benchmark artifact |
| Security/privacy | Web, desktop, mobile, data tools | Test auth, permissions, secrets, redaction | Checklist/test output |
| Simulation | Robotics, games, risk-heavy workflows | Test behavior without real-world risk | Sim logs/video |
| Hardware-in-the-loop | Robotics/hardware projects | Test software against real hardware | HIL artifact |
| Playtest | Games | Test usability, difficulty, fun, clarity | Notes/video |
| Packaging | Mobile/desktop/CLI/apps | Test clean install/run/update | Release checklist |

## Manual Inspection

| Area | What to inspect | Evidence |
| --- | --- | --- |
| UI | Screens, states, drift | Screenshot/visual diff |
| Failure paths | Errors and recovery | Notes/artifact |
| Release | Install/run/support path | Checklist/artifact |

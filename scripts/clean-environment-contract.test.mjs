import assert from "node:assert/strict";
import test from "node:test";

import {
  assertTailscaleSnapshotsEqual,
  classifyCleanInstallWarnings,
  collectCleanupErrors,
  createCleanEnvironmentDockerfile,
  createCleanEnvironmentDockerRunArgs,
  createTailscaleSnapshot,
  loadCleanEnvironmentManifest,
  parseCleanEnvironmentManifest,
  parseCleanGitStatus,
  parseCleanUserEvidence,
  parseDockerImageIdentity,
  redactCleanDiagnostic
} from "./clean-environment-contract.mjs";

const manifest = loadCleanEnvironmentManifest();
const commit = "a".repeat(40);

test("loads one frozen exact clean-environment manifest", () => {
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.contracts.package_manifest_schema, 5);
  assert.equal(manifest.base_image.version, "24.04");
  assert.equal(manifest.node.version, "22.22.2");
  assert.equal(manifest.pnpm_version, "10.29.2");
  assert.equal(manifest.codex.version, "0.147.0");
  assert.equal(manifest.tailscale.version, "1.98.8");
  assert(Object.isFrozen(manifest));
  assert(Object.isFrozen(manifest.bounds));
});

test("rejects manifest field, pin, path, version, and bound drift", () => {
  const mutations = [
    (value) => {
      value.extra = true;
    },
    (value) => {
      delete value.task_id;
    },
    (value) => {
      value.contracts.required_user_commands.reverse();
    },
    (value) => {
      value.base_image.reference = "ubuntu:24.04";
    },
    (value) => {
      value.base_image.architecture = "arm64";
    },
    (value) => {
      value.node.archive_url = "http://nodejs.org/archive";
    },
    (value) => {
      value.codex.integrity = "sha512-invalid";
    },
    (value) => {
      value.tailscale.deb_sha256 = "0";
    },
    (value) => {
      value.package_versions = ["1.0.0", "1.0.0"];
    },
    (value) => {
      value.container.checkout = "/home/ubuntu/../root";
    },
    (value) => {
      value.bounds.poll_ms = value.bounds.readiness_ms + 1;
    },
    (value) => {
      value.evidence_fields.reverse();
    }
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(manifest);
    mutate(candidate);
    assert.throws(() => parseCleanEnvironmentManifest(candidate), TypeError);
  }
});

test("renders a pinned root-bootstrap Dockerfile with no product command", () => {
  const dockerfile = createCleanEnvironmentDockerfile(manifest);
  assert.match(dockerfile, new RegExp(`^FROM ${manifest.base_image.reference}`));
  assert.match(dockerfile, new RegExp(manifest.node.archive_sha256));
  assert.match(dockerfile, new RegExp(manifest.tailscale.deb_sha256));
  assert.match(dockerfile, /systemctl disable tailscaled\.service/u);
  assert.doesNotMatch(
    dockerfile,
    /pnpm install|git clone|codexdeck|service (?:install|start)|remote (?:enable|disable)/u
  );
});

test("constructs fixed isolated Docker arguments without host networking", () => {
  const args = createCleanEnvironmentDockerRunArgs(manifest, {
    source_root: "/tmp/hostdeck-source",
    evidence_root: "/tmp/hostdeck-evidence",
    tailscale_root: "/run/tailscale",
    image_tag: "hostdeck-ifc-v1-058:aaaaaaaaaaaa"
  });
  assert.deepEqual(args.slice(0, 7), [
    "run",
    "--rm",
    "--detach",
    "--name",
    manifest.container.name,
    "--privileged",
    "--cgroupns=private"
  ]);
  assert.equal(args.includes("--network=host"), false);
  assert.equal(args.some((value) => value.includes("node_modules")), false);
  assert.equal(args.at(-1), "hostdeck-ifc-v1-058:aaaaaaaaaaaa");
  assert.throws(
    () =>
      createCleanEnvironmentDockerRunArgs(manifest, {
        source_root: "/workspace/../private",
        evidence_root: "/tmp/evidence",
        tailscale_root: "/run/tailscale",
        image_tag: "hostdeck-ifc-v1-058:aaaaaaaaaaaa"
      }),
    TypeError
  );
});

test("accepts only modified artifact PNGs outside committed runtime inputs", () => {
  const status = " M artifacts/one.png\0M  artifacts/two.png\0";
  assert.deepEqual(parseCleanGitStatus(status), { excluded_png_count: 2 });
  for (const invalid of [
    "?? scripts/runtime.mjs\0",
    " M package.json\0",
    " M artifacts/../scripts/runtime.png\0",
    "R  artifacts/old.png\0artifacts/new.png\0",
    " M artifacts/private\nname.png\0"
  ]) {
    assert.throws(() => parseCleanGitStatus(invalid), TypeError);
  }
});

test("parses one exact Docker image identity and rejects ambiguous output", () => {
  const hash = "b".repeat(64);
  const identity = parseDockerImageIdentity(
    JSON.stringify([{ Id: `sha256:${hash}`, RepoDigests: [`ubuntu@sha256:${hash}`] }])
  );
  assert.equal(identity.id, `sha256:${hash}`);
  assert(Object.isFrozen(identity));
  for (const invalid of [
    "not-json",
    "[]",
    JSON.stringify([{ Id: "sha256:short", RepoDigests: [] }]),
    JSON.stringify([
      { Id: `sha256:${hash}`, RepoDigests: [] },
      { Id: `sha256:${hash}`, RepoDigests: [] }
    ])
  ]) {
    assert.throws(() => parseDockerImageIdentity(invalid), TypeError);
  }
});

test("bounds and redacts command diagnostics", () => {
  const privatePath = "/private/checkout";
  const output = redactCleanDiagnostic(
    `${privatePath}\n${"x".repeat(4_000)}`,
    `failed in ${privatePath}`,
    [privatePath]
  );
  assert.equal(output.includes(privatePath), false);
  assert(output.length <= 2_000);
  assert.match(output, /<private-path>/u);
  assert.throws(() => redactCleanDiagnostic("", "", []), TypeError);
});

test("classifies only exact pnpm HTTPS download telemetry as allowed", () => {
  const warning =
    "\u2009WARN\u2009 Tarball download average speed 40 KiB/s (size 43 KiB) is below 50 KiB/s: https://registry.npmjs.org/bidi-js/-/bidi-js-1.0.3.tgz (GET)";
  assert.deepEqual(classifyCleanInstallWarnings(warning, "", true), {
    allowed_network_warning_count: 1,
    install_warning_count: 1,
    unsupported_warning_count: 0
  });
  assert.deepEqual(classifyCleanInstallWarnings("normal output", "progress", false), {
    allowed_network_warning_count: 0,
    install_warning_count: 0,
    unsupported_warning_count: 0
  });
  for (const [output, allowed] of [
    [warning, false],
    ["warning: native compiler drift", true],
    [warning.replace("https:", "http:"), true],
    [warning.replace("registry.npmjs.org", "example.com"), true]
  ]) {
    assert.throws(
      () => classifyCleanInstallWarnings(output, "", allowed),
      TypeError
    );
  }
});

test("hashes Tailscale observations and rejects identity drift", () => {
  const outputs = new Map([
    ["version", { status: 0, stdout: "1.98.8\n", stderr: "" }],
    ["status\u0000--json", { status: 0, stdout: '{"BackendState":"Running"}\n', stderr: "" }],
    ["switch\u0000--list", { status: 0, stdout: "profile list private\n", stderr: "" }],
    ["serve\u0000status\u0000--json", { status: 1, stdout: "", stderr: "no serve config\n" }]
  ]);
  const snapshot = createTailscaleSnapshot((args) => outputs.get(args.join("\0")));
  assert.equal(snapshot.schema_version, 1);
  assert.equal(JSON.stringify(snapshot).includes("profile list private"), false);
  assertTailscaleSnapshotsEqual(snapshot, structuredClone(snapshot));
  const volatileOutputs = new Map(outputs);
  volatileOutputs.set("status\u0000--json", {
    status: 0,
    stdout:
      '{"BackendState":"Running","Self":{"Online":true},"Peer":{"dynamic":{"Online":false}}}\n',
    stderr: ""
  });
  const baselineOutputs = new Map(outputs);
  baselineOutputs.set("status\u0000--json", {
    status: 0,
    stdout: '{"BackendState":"Running","Self":{"Online":false}}\n',
    stderr: ""
  });
  assertTailscaleSnapshotsEqual(
    createTailscaleSnapshot((args) => baselineOutputs.get(args.join("\0"))),
    createTailscaleSnapshot((args) => volatileOutputs.get(args.join("\0")))
  );
  const changed = structuredClone(snapshot);
  changed.commands[2].stdout_sha256 = "0".repeat(64);
  assert.throws(
    () => assertTailscaleSnapshotsEqual(snapshot, changed),
    /Tailscale profile or Serve identity changed/u
  );
});

test("accepts strict sanitized complete evidence and rejects gaps or secrets", () => {
  const evidence = validEvidence();
  assert.equal(
    parseCleanUserEvidence(evidence, manifest, {
      criteria_commit: commit,
      source_commit: commit
    }).cleanup.complete,
    true
  );
  const missing = structuredClone(evidence);
  delete missing.service;
  assert.throws(
    () =>
      parseCleanUserEvidence(missing, manifest, {
        criteria_commit: commit,
        source_commit: commit
      }),
    TypeError
  );
  const secret = structuredClone(evidence);
  secret.host.os = "person@example.com";
  assert.throws(
    () =>
      parseCleanUserEvidence(secret, manifest, {
        criteria_commit: commit,
        source_commit: commit
      }),
    /private or host-specific data at \$\.host\.os \(email\)/u
  );
  const hostSpecificCgroup = structuredClone(evidence);
  hostSpecificCgroup.service.unit_inventory.codex_control_group =
    "/user.slice/user-1000.slice/user@1000.service/app.slice/hostdeck-codex.service";
  assert.throws(
    () =>
      parseCleanUserEvidence(hostSpecificCgroup, manifest, {
        criteria_commit: commit,
        source_commit: commit
      }),
    /private or host-specific data at \$\.service\.unit_inventory\.codex_control_group \(email\)/u
  );
  const falseSuccess = structuredClone(evidence);
  falseSuccess.service.active_upgrade = false;
  assert.throws(
    () =>
      parseCleanUserEvidence(falseSuccess, manifest, {
        criteria_commit: commit,
        source_commit: commit
      }),
    TypeError
  );
  const nestedExtra = structuredClone(evidence);
  nestedExtra.cleanup.unproven = true;
  assert.throws(
    () =>
      parseCleanUserEvidence(nestedExtra, manifest, {
        criteria_commit: commit,
        source_commit: commit
      }),
    TypeError
  );
});

test("continues bounded cleanup after failures and returns every error", async () => {
  const calls = [];
  const errors = await collectCleanupErrors([
    () => {
      calls.push("container");
      throw new Error("container cleanup failed");
    },
    () => {
      calls.push("image");
    },
    () => {
      calls.push("temporary inputs");
      throw new Error("temporary cleanup failed");
    }
  ]);
  assert.deepEqual(calls, ["container", "image", "temporary inputs"]);
  assert.deepEqual(
    errors.map((error) => error.message),
    ["container cleanup failed", "temporary cleanup failed"]
  );
  assert(Object.isFrozen(errors));
  await assert.rejects(() => collectCleanupErrors([]), TypeError);
});

function validEvidence() {
  const hash = "b".repeat(64);
  const primaryHttp = httpEvidence("1.0.0", hash);
  const upgradeHttp = httpEvidence("1.1.0", hash);
  return {
    schema_version: 1,
    task_id: manifest.task_id,
    criteria_commit: commit,
    source_commit: commit,
    host: {
      architecture: "x64",
      docker_server_version: "29.6.2",
      excluded_uncommitted_png_count: 18,
      kernel_shared: true,
      os: "ubuntu",
      os_version: "24.04"
    },
    container: {
      architecture: "amd64",
      base_digest: manifest.base_image.digest,
      cgroup_namespace: "private",
      image_id: `sha256:${hash}`,
      mounts: [
        { destination: "/evidence", read_only: false, type: "bind" },
        { destination: "/host-tailscale", read_only: true, type: "bind" },
        { destination: "/source", read_only: true, type: "bind" }
      ],
      network_mode: "default_bridge",
      os: "ubuntu",
      os_version: "24.04",
      pid_namespace: "private",
      privileged_validation_infrastructure: true,
      root_bootstrap: {
        actions: [
          "install_os_prerequisites",
          "verify_node_archive",
          "install_tailscale_client",
          "disable_tailscale_daemon",
          "start_uid_1000_manager"
        ],
        node_archive_sha256: manifest.node.archive_sha256,
        product_lifecycle_actions: 0,
        tailscale_daemon: "disabled_inactive",
        tailscale_package_version: "1.98.8",
        uid: 1000
      },
      system_manager: "running",
      systemd_version: "systemd 255",
      uid: 1000,
      user_manager: "running"
    },
    toolchain: {
      codex: "0.147.0",
      codex_integrity_verified: true,
      corepack: "0.34.5",
      git: "2.43.0",
      native_modules_loaded: true,
      node: "22.22.2",
      npm: "10.9.4",
      pnpm: "10.29.2",
      systemd: "systemd 255",
      tailscale: "1.98.8"
    },
    clean_source: {
      bootstrap: {
        allowed_network_warning_count: 2,
        codex_install_ms: 1,
        corepack_ms: 1,
        direct_contract_test_ms: 1,
        frozen_install_ms: 1,
        install_warning_count: 2,
        node_extract_ms: 1,
        source_clone_ms: 1,
        total_ms: 7,
        unsupported_warning_count: 0
      },
      commit,
      dist_preexisting: false,
      frozen_install: true,
      git_tracked_clean: true,
      host_build_output_mounted: false,
      host_dependency_tree_mounted: false,
      lockfile_sha256: hash,
      node_modules_preexisting: false,
      source_bundle_bytes: 1024,
      source_bundle_sha256: hash
    },
    packages: {
      deterministic_primary: true,
      primary: packageEvidence("1.0.0", hash),
      upgrade: packageEvidence("1.1.0", hash)
    },
    foreground: {
      duration_ms: 1,
      http: primaryHttp,
      local_ready: true,
      package_version: "1.0.0",
      processes: {
        app_server_launcher_trees: 1,
        app_server_processes: 2,
        app_server_tree_processes: 2,
        arguments_verified: true,
        hostdeck_main_pid: 100,
        hostdeck_main_processes: 1,
        uid: 1000,
        zero_capabilities: true
      },
      remote_unavailable: true,
      socket_mode: "0600",
      tcp_listener: "127.0.0.1",
      web_manifest_sha256: hash,
      web_sha256: hash
    },
    service: serviceEvidence(hash, upgradeHttp),
    tailscale: {
      client_version: "1.98.8",
      host_after_sha256: hash,
      host_before_sha256: hash,
      host_identity_unchanged: true,
      initial_daemon_unavailable: true,
      observation_only: true,
      observed_identity_sha256: hash,
      profile_switch_calls: 0,
      raw_profile_data_recorded: false,
      serve_mutation_calls: 0
    },
    cleanup: {
      complete: true,
      installed_command_absent: true,
      lifecycle_coordination_retained: true,
      processes_absent: true,
      product_complete: true,
      runtime_absent: true,
      units_not_found: true
    },
    limits: {
      independent_kernel_or_vm: false,
      phone_tested: false,
      release_ready: false,
      shared_kernel: true
    }
  };
}

function packageEvidence(version, hash) {
  return {
    content_sha256: hash,
    deferrals: [],
    duration_ms: 1,
    entry_count: 10,
    manifest_sha256: hash,
    output_count: 2,
    package_version: version,
    source_count: 8,
    verified_entry_count: 10,
    web_file_count: 3,
    web_manifest_sha256: hash,
    web_sha256: hash
  };
}

function httpEvidence(version, hash) {
  return {
    compatibility: "supported",
    index_sha256: hash,
    local_ready: true,
    no_store_status: true,
    package_version: version,
    remote_ready: false,
    security_headers: true,
    web_identity_sha256: hash,
    web_manifest_sha256: hash
  };
}

function serviceEvidence(hash, upgradedHttp) {
  return {
    active_checkpoint: true,
    active_upgrade: true,
    active_upgrade_hostdeck_restarted: true,
    active_upgrade_preserved_codex: true,
    active_upgrade_preserved_socket: true,
    codex_loss_reported_not_ready: true,
    codex_pid_after_restart: 201,
    codex_pid_initial: 200,
    codex_restart_changed_pid: true,
    duration_ms: 1,
    exact_install_inventory: true,
    foreground_service_http_parity: true,
    hostdeck_pid_after_restart: 101,
    hostdeck_pid_initial: 100,
    hostdeck_restart_preserved_codex: true,
    idempotent_install_start_stop: true,
    install_initially_inactive: true,
    installed_command_used_for_uninstall: true,
    invalid_lifecycle_order_rejected: true,
    observed_phase_ms: 1,
    observed_restart_preserved_codex: true,
    package_version: "1.0.0",
    release_retention_count: 2,
    repeated_uninstall_unchanged: true,
    root_install_absent: true,
    socket_changed_on_codex_restart: true,
    socket_preserved_on_hostdeck_restart: true,
    state_config_codex_preserved: true,
    tailscale_observation_restart_ready: true,
    unavailable_phase_ms: 1,
    uninstall_not_found_units: true,
    uninstall_product_residue: 0,
    unit_inventory: {
      codex_cgroup_processes: 2,
      codex_control_group: "/app.slice/hostdeck-codex.service",
      codex_main_pid: 200,
      hostdeck_cgroup_processes: 1,
      hostdeck_control_group: "/app.slice/hostdeck.service",
      hostdeck_main_pid: 100,
      listener_count: 1,
      socket_owner_uid: 1000,
      zero_capabilities: true
    },
    upgrade_package_version: "1.1.0",
    upgrade_web_sha256: hash,
    upgraded_http: upgradedHttp,
    user_manager: "running"
  };
}

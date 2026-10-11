# Progress (Docker hosting build)

- docker/Dockerfile + japa-novnc-forward.service: system container image (systemd, dockerd, Node 24, bwrap, socat 16080->127.0.0.1:6080).
- install.sh: --mode/--instance/--desktop-port/--install-sysbox; docker mode functions + embedded host launcher (docker_launcher_text).
- Decisions:
  - Docker mode requires a URL --repo (git build context + clone inside the container can't use host paths).
  - Container publishes 127.0.0.1:<port> -> 16080 (socat in image) -> inner desktop noVNC 127.0.0.1:6080.
  - Inner install = clone install.sh at --branch inside container (tmp), run `--mode native --skip-setup`; rerun = same (native rerun -> japa update).
  - Native over a Docker launcher: ask in a tty (default no), else native launcher goes to ~/.local/bin/japa-native.
  - Docker over a native launcher: ask (default no), else ~/.local/bin/japa-docker.
  - systemd wait accepts running or degraded.
  - Existing install-sh tests now set JAPA_INSTALL_MODE=native (fresh default became docker per spec).
- Tests: test/install-docker.test.ts, test/docker-launcher.test.ts (fake docker in test/fake-docker.ts), gated test/sysbox.test.ts (JAPA_SYSBOX_TESTS=1). Full suite + typecheck green.
- docker/Dockerfile builds locally (verified with legacy builder; Sysbox not available here, so e2e not run).
- README + docs/spec.md Outcome written; AGENTS.md, scripts/setup.sh, scripts/run.sh added.
- --non-interactive in Docker mode skips setup (as §4.3 step 5); --no-service is passed to the inner setup.

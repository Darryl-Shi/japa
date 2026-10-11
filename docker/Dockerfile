# japa-host: the system container a Docker-hosted japa instance runs in (docs/spec.md "Docker hosting").
# Run only under Sysbox (--runtime=sysbox-runc): systemd is PID 1, dockerd runs as a system service, and the
# non-root user `japa` (uid 1000, lingering) gets the native install and its systemd user service.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 container=docker

RUN userdel -r ubuntu \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
    systemd systemd-sysv libpam-systemd dbus dbus-user-session ca-certificates curl gnupg git tar gzip \
    bubblewrap socat iproute2 iptables kmod less locales procps \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && . /etc/os-release \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list \
 && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
 && apt-get install -y --no-install-recommends \
    nodejs docker-ce docker-ce-cli containerd.io docker-buildx-plugin \
 && rm -rf /var/lib/apt/lists/*

# systemd inside a Sysbox container: no udev, no consoles, no kernel log; journald mustn't read /dev/kmsg.
RUN systemctl mask systemd-udevd.service systemd-udevd-kernel.socket systemd-udevd-control.socket \
    systemd-modules-load.service sys-kernel-debug.mount sys-kernel-tracing.mount sys-kernel-config.mount \
    systemd-journald-audit.socket getty.target console-getty.service systemd-firstboot.service \
 && mkdir -p /etc/systemd/journald.conf.d \
 && printf '[Journal]\nReadKMsg=no\n' > /etc/systemd/journald.conf.d/japa.conf \
 && systemctl enable docker.service containerd.service

# The user japa runs as: uid 1000, in the inner docker group, with lingering so its user manager (and japa's
# user service) starts at boot without a login. Its home is the instance's japa-<name>-home volume.
RUN useradd -m -u 1000 -s /bin/bash -G docker japa \
 && mkdir -p /var/lib/systemd/linger \
 && touch /var/lib/systemd/linger/japa \
 && install -d -o japa -g japa /home/japa/.local /home/japa/.local/bin /home/japa/.config

# The desktop's noVNC is published by the inner dockerd on this container's loopback (127.0.0.1:6080, japa's
# default); this forwards the port the host publishes (16080) to it.
COPY japa-novnc-forward.service /etc/systemd/system/japa-novnc-forward.service
RUN systemctl enable japa-novnc-forward.service

ENV PATH=/home/japa/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EXPOSE 16080
STOPSIGNAL SIGRTMIN+3
ENTRYPOINT ["/sbin/init"]

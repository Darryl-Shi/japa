FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 DISPLAY=:1

RUN userdel -r ubuntu \
 && apt-get update \
 && apt-get install -y --no-install-recommends software-properties-common gpg-agent curl ca-certificates gnupg \
 && add-apt-repository -y ppa:xtradeb/apps \
 && printf 'Package: *\nPin: release o=LP-PPA-xtradeb-apps\nPin-Priority: 100\n\nPackage: chromium*\nPin: release o=LP-PPA-xtradeb-apps\nPin-Priority: 700\n' \
    > /etc/apt/preferences.d/xtradeb \
 && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
 && apt-get install -y --no-install-recommends \
    xvfb xfce4 xfce4-terminal dbus-x11 x11vnc novnc websockify supervisor socat chromium xdotool xclip imagemagick \
    libreoffice atril python3 nodejs git curl unzip ffmpeg sudo fonts-noto fonts-noto-cjk fonts-noto-color-emoji \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1000 -s /bin/bash japa \
 && echo 'japa ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/japa \
 && chmod 0440 /etc/sudoers.d/japa \
 && install -d -o japa -g japa /home/japa/Downloads /home/japa/.config \
 && mkdir -p /opt/japa \
 && echo '{"type":"module"}' > /opt/japa/package.json

COPY supervisord.conf /etc/supervisor/conf.d/japa.conf
CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]

#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ] || [ "$#" -ne 2 ]; then
    printf '%s\n' 'Usage: sudo sh install-linux.sh /absolute/path/to/octopus-linux-process-authority operator-user' >&2
    exit 2
fi

authority_binary=$1
operator_user=$2
case "$authority_binary" in
    /*) ;;
    *) printf '%s\n' 'The service binary path must be absolute.' >&2; exit 2 ;;
esac
test -f "$authority_binary"
test -x "$authority_binary"
case "$operator_user" in
    ''|-*) printf '%s\n' 'The operator must be an ordinary Unix login.' >&2; exit 2 ;;
esac
test "$(id -u -- "$operator_user")" -ne 0
if [ -x /usr/sbin/apparmor_parser ] && [ ! -L /usr/sbin/apparmor_parser ]; then
    apparmor_parser=/usr/sbin/apparmor_parser
elif [ -x /sbin/apparmor_parser ] && [ ! -L /sbin/apparmor_parser ]; then
    apparmor_parser=/sbin/apparmor_parser
else
    printf '%s\n' 'apparmor_parser was not found as a regular executable at /usr/sbin/apparmor_parser or /sbin/apparmor_parser.' >&2
    exit 1
fi
test -x "$apparmor_parser"
test -f /etc/apparmor.d/abi/4.0
test "$(cat /sys/module/apparmor/parameters/enabled)" = Y
test -f /sys/fs/cgroup/cgroup.controllers

authority_source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if ! getent group octopus-process >/dev/null 2>&1; then
    if command -v groupadd >/dev/null 2>&1; then
        groupadd --system octopus-process
    elif command -v addgroup >/dev/null 2>&1; then
        addgroup -S octopus-process
    else
        printf '%s\n' 'Neither groupadd nor addgroup is available to create octopus-process.' >&2
        exit 1
    fi
fi
if command -v usermod >/dev/null 2>&1; then
    usermod -a -G octopus-process "$operator_user"
elif command -v addgroup >/dev/null 2>&1; then
    addgroup "$operator_user" octopus-process
else
    printf '%s\n' 'Neither usermod nor addgroup is available to add the operator to octopus-process.' >&2
    exit 1
fi
install -d -o root -g root -m 0755 /usr/libexec/octopus
install -o root -g root -m 0755 "$authority_binary" /usr/libexec/octopus/octopus-linux-process-authority

if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
    install -o root -g root -m 0644 "$authority_source_dir/octopus-process-authority.service" /etc/systemd/system/octopus-process-authority.service
    systemctl daemon-reload
    systemctl enable octopus-process-authority.service
    systemctl restart octopus-process-authority.service
elif command -v rc-service >/dev/null 2>&1 && command -v rc-update >/dev/null 2>&1; then
    install -o root -g root -m 0755 "$authority_source_dir/octopus-process-authority.openrc" /etc/init.d/octopus-process-authority
    if [ ! -f /etc/conf.d/octopus-process-authority ]; then
        install -d -o root -g root -m 0755 /etc/conf.d
        install -o root -g root -m 0644 "$authority_source_dir/octopus-process-authority.openrc.confd" /etc/conf.d/octopus-process-authority
    fi
    rc-update add octopus-process-authority default
    rc-service octopus-process-authority restart
else
    printf '%s\n' 'Supported init system not detected (requires systemd or OpenRC).' >&2
    exit 1
fi
printf '%s\n' 'Process authority installed. Start a new login session for the operator user before starting Octopus.'

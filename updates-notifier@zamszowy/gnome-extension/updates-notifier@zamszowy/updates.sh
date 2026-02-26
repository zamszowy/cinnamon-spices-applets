#!/usr/bin/env bash
# updates.sh – PackageKit helper script for the Updates Notifier GNOME extension.
# Called by extension.js with one of: check | view | error | command <cmd>

set -u

DIR=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
readonly DIR

# ---------------------------------------------------------------------------
# Detect the best available PackageKit CLI tool.
# ---------------------------------------------------------------------------
PKG_TOOL=""
if   command -v pkgcli &>/dev/null; then PKG_TOOL=pkgcli
elif command -v pkgctl &>/dev/null; then PKG_TOOL=pkgctl
elif command -v pkcon  &>/dev/null; then PKG_TOOL=pkcon
else
    echo "No suitable package manager found (pkgcli, pkgctl, pkcon)" > "$DIR/error"
    echo "ERROR"
    exit 0
fi
readonly PKG_TOOL

pkg_refresh() {
    case "$PKG_TOOL" in
        pkgcli|pkgctl) pkgcli -q refresh ;;
        pkcon)         pkcon refresh ;;
    esac
}

pkg_list_updates() {
    case "$PKG_TOOL" in
        pkgcli|pkgctl) pkgcli -q list-updates ;;
        pkcon)
            pkcon get-updates
            local ret=$?
            [[ $ret -eq 5 ]] && ret=0   # exit 5 = "no updates" is not an error
            return $ret
            ;;
    esac
}

pkg_list_installed() {
    case "$PKG_TOOL" in
        pkgcli|pkgctl) pkgcli -q -f installed list ;;
        pkcon)         pkcon get-packages --filter installed ;;
    esac
}

# ---------------------------------------------------------------------------
# Open a terminal and run an arbitrary shell command inside it.
# Tries (in order): xdg-terminal-exec, ptyxis, gnome-terminal, xterm.
# ---------------------------------------------------------------------------
open_terminal() {
    local cmd="$1"
    if   command -v xdg-terminal-exec &>/dev/null; then
        xdg-terminal-exec bash -c "$cmd"
    elif command -v ptyxis &>/dev/null; then
        ptyxis -- bash -c "$cmd"
    elif command -v gnome-terminal &>/dev/null; then
        gnome-terminal -- bash -c "$cmd"
    elif command -v xterm &>/dev/null; then
        xterm -e bash -c "$cmd"
    else
        notify-send "Updates Notifier" \
            "No supported terminal found.  Please install ptyxis or gnome-terminal." \
            --icon=dialog-error 2>/dev/null || true
    fi
}

# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------
case "$1" in

check)
    refreshMode="${2:-updates}"

    # Full refresh: tell PackageKit to re-download metadata first.
    if [[ "$refreshMode" == "updates" ]]; then
        pkg_refresh &>/dev/null
    fi

    if ! out=$(pkg_list_updates 2>&1); then
        printf '%s\n' "$out" > "$DIR/error"
        echo "ERROR"
        exit 0
    fi

    # Also query installed packages so the D-Bus signal stream includes the
    # local-version rows (PkInfoEnum.INSTALLED) for each pending update.
    pkg_list_installed &>/dev/null &

    # Optional firmware updates via fwupdmgr + jq.
    if command -v fwupdmgr &>/dev/null && command -v jq &>/dev/null; then
        if [[ "$refreshMode" == "updates" ]]; then
            fwupdmgr refresh --no-authenticate &>/dev/null
        fi
        fwupdmgr get-updates --no-authenticate --json 2>/dev/null \
            | jq -r '
                .Devices[]?
                | select((.Releases | length) > 0)
                | . as $d
                | $d.Releases[]
                | "\($d.Name)#\($d.DeviceId)#\($d.Version)#\(.Version)#\($d.Summary // "")"
            ' 2>/dev/null
    fi

    # Small delay to let PackageKit finish emitting its D-Bus transaction
    # signals before the extension marks checkingInProgress = false.
    sleep 1
    ;;

view)
    /usr/bin/gjs -m "$DIR/info-window.js" "$DIR" "$DIR/updates"
    ;;

error)
    /usr/bin/gjs -m "$DIR/error-window.js" "$DIR/error"
    ;;

command)
    open_terminal "$2"
    ;;

*)
    echo "Usage: $0 check [updates|packages] | view | error | command <cmd>" >&2
    exit 1
    ;;

esac

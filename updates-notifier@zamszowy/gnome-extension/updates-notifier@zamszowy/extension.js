// GNOME Shell 45+ extension – Updates Notifier
// Monitors pending updates via PackageKit D-Bus and renders a panel indicator.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Updates} from './updates.js';

const UUID = 'updates-notifier@zamszowy';

const RefreshMode = Object.freeze({
    UPDATES:  'updates',   // full: refresh cache then list
    PACKAGES: 'packages',  // fast: list only (triggered externally)
});

// ---------------------------------------------------------------------------
// Helper – unpack a raw PackageKit Package / Packages D-Bus signal params
// Returns an array of [info, pkgid, summary] tuples.
// ---------------------------------------------------------------------------
function unpackPackageSignal(params) {
    let unpacked;
    try {
        unpacked = params.deep_unpack();
    } catch (e) {
        console.warn(`${UUID}: deep_unpack failed: ${e}`);
        return [];
    }

    // Case 1: single package  → [info, pkgid, summary]
    if (unpacked.length === 3 &&
            typeof unpacked[0] === 'number' &&
            typeof unpacked[1] === 'string')
        return [unpacked];

    // Case 2: batched list wrapped  → [[ [info, pkgid, summary], ... ]]
    if (unpacked.length === 1 &&
            Array.isArray(unpacked[0]) &&
            Array.isArray(unpacked[0][0]))
        return unpacked[0];

    // Case 3: flat array of tuples → [ [info, pkgid, summary], ... ]
    if (unpacked.length && Array.isArray(unpacked[0]) && unpacked[0].length === 3)
        return unpacked;

    console.warn(`${UUID}: Unrecognised Package(s) D-Bus payload: ${JSON.stringify(unpacked)}`);
    return [];
}

// ---------------------------------------------------------------------------
// Panel indicator (PanelMenu.Button subclass)
// ---------------------------------------------------------------------------
const UpdatesIndicator = GObject.registerClass(
class UpdatesIndicator extends PanelMenu.Button {

    _init(extension) {
        super._init(0.0, _('Updates Notifier'));

        this._ext  = extension;
        this._settings = extension.getSettings();
        this._extPath  = extension.path;

        // ── Panel widget layout ───────────────────────────────────────────
        const box = new St.BoxLayout({ style_class: 'panel-status-menu-box' });

        this._icon = new St.Icon({ style_class: 'system-status-icon' });
        this._iconSizeSignals = [];
        this._connectIconSizeSync();
        box.add_child(this._icon);

        this._label = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
            text: '',
        });
        box.add_child(this._label);

        this.add_child(box);

        // ── State ─────────────────────────────────────────────────────────
        this._updates          = new Updates();
        this._checkingInProgress = false;
        this._pendingUpdate    = false;
        this._lastRefreshTime  = 0;
        this._hasFirmwareUpdates = false;
        this._hasError         = false;

        this._packageSubscription      = null;
        this._updateChangedSubscription = null;
        this._refreshTimeoutId         = null;
        this._settingsConnIds          = [];

        this._bus = Gio.DBus.system;

        // ── Initialise ────────────────────────────────────────────────────
        this._setIcon('update-notifier-settings-symbolic');
        this._label.hide();

        this._connectSettings();
        this._watchDbus();
        this._setCheckInterval();
        this._refreshUpdatesInfo();
    }

    // ── Settings wiring ────────────────────────────────────────────────────

    _connectSettings() {
        const s = this._settings;
        const refresh  = () => this._update();
        const fullRefresh = () => this._refreshUpdatesInfo(RefreshMode.UPDATES, true);

        this._settingsConnIds = [
            s.connect('changed::update-refresh',        () => this._setCheckInterval()),
            s.connect('changed::show-firmware',         fullRefresh),
            s.connect('changed::hide-applet',           refresh),
            s.connect('changed::different-levels',      refresh),
            s.connect('changed::level-1',               refresh),
            s.connect('changed::level-2',               refresh),
            s.connect('changed::refresh-when-no-updates', refresh),
            s.connect('changed::show-window-on-click',  refresh),
            s.connect('changed::command-update-show',   refresh),
            s.connect('changed::command-upgrade-show',  refresh),
            s.connect('changed::icon-style',            refresh),
            s.connect('changed::show-label',            refresh),
            s.connect('changed::label-font-size',       refresh),
            s.connect('changed::label-font-weight',     refresh),
            s.connect('changed::label-vertical-position', refresh),
        ];
    }

    // ── D-Bus subscriptions ────────────────────────────────────────────────

    _watchDbus() {
        // Listen to all PackageKit transaction signals (Package, Packages, Finished).
        this._packageSubscription = this._bus.signal_subscribe(
            'org.freedesktop.PackageKit',
            'org.freedesktop.PackageKit.Transaction',
            null, null, null,
            Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, signal, params) => {
                if (!this._checkingInProgress) return;

                if (signal === 'Package' || signal === 'Packages') {
                    for (const [info, pkgid, summary] of unpackPackageSignal(params)) {
                        if (this._updates.add(info, pkgid, summary))
                            this._pendingUpdate = true;
                    }
                } else if (signal === 'Finished') {
                    if (!this._pendingUpdate) return;
                    this._pendingUpdate = false;
                    console.log(`${UUID}: D-Bus Finished – ${this._updates.map.size} updates`);
                    this._update();
                    this._saveUpdates();
                }
            }
        );

        // React to external package operations changing the update set.
        this._updateChangedSubscription = this._bus.signal_subscribe(
            'org.freedesktop.PackageKit',
            'org.freedesktop.PackageKit',
            'UpdatesChanged',
            '/org/freedesktop/PackageKit',
            null,
            Gio.DBusSignalFlags.NONE,
            () => this._refreshUpdatesInfo(RefreshMode.PACKAGES)
        );
    }

    // ── Icon helpers ───────────────────────────────────────────────────────

    _connectIconSizeSync() {
        this._syncIconSize();

        // Keep icon proportional when panel height/theme changes.
        this._iconSizeSignals.push([
            this._icon,
            this._icon.connect('style-changed', () => this._syncIconSize()),
        ]);

        this._iconSizeSignals.push([
            Main.panel,
            Main.panel.connect('notify::height', () => this._syncIconSize()),
        ]);
    }

    _syncIconSize() {
        // GNOME top bar default: 24px panel with ~16px status icons.
        // Keep a constant padding so taller panels produce visibly larger icons
        // (e.g. 32px panel -> 24px icon).
        const panelHeight = Math.max(24, Main.panel?.height ?? 24);
        const iconSize = Math.max(16, panelHeight - 8);
        this._icon.icon_size = iconSize;
        this._icon.set_style(`icon-size: ${iconSize}px;`);
    }

    /**
     * Set the panel icon by base name (without style suffix).
     * Appends the firmware variant and icon-style suffix.
     * Uses Gio.FileIcon for direct SVG loading (viewBox ensures scaling).
     */
    _applyIcon(baseName) {
        const style        = this._settings.get_string('icon-style');
        const showFirmware = this._settings.get_boolean('show-firmware');

        let name = baseName;
        if (!this._hasError && showFirmware && this._hasFirmwareUpdates)
            name += '-fw';

        if      (style === 'dark')     name += '-dark';
        else if (style === 'light')    name += '-light';
        else if (style === 'symbolic') name += '-symbolic';
        else                           name += '-dark';

        this._loadFileIcon(`${name}.svg`);
    }

    /** Load a settings-independent icon by full name (e.g. the spinner icon). */
    _setIcon(iconName) {
        this._loadFileIcon(`${iconName}.svg`);
    }

    _loadFileIcon(filename) {
        const path = `${this._extPath}/icons/${filename}`;
        const file = Gio.File.new_for_path(path);
        this._icon.gicon = new Gio.FileIcon({ file });
    }

    // ── Refresh interval ───────────────────────────────────────────────────

    _setCheckInterval() {
        if (this._refreshTimeoutId) {
            GLib.source_remove(this._refreshTimeoutId);
            this._refreshTimeoutId = null;
        }

        let minutes = this._settings.get_int('update-refresh');
        if (!minutes || minutes < 1) minutes = 60;

        this._refreshTimeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            minutes * 60,
            () => {
                this._refreshUpdatesInfo();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    // ── Menu ───────────────────────────────────────────────────────────────

    _buildMenu() {
        this.menu.removeAll();
        const count             = this._updates.map.size;
        const showWindowOnClick = this._settings.get_boolean('show-window-on-click');
        const cmdUpdateShow     = this._settings.get_boolean('command-update-show');
        const cmdUpgradeShow    = this._settings.get_boolean('command-upgrade-show');
        const cmdUpgrade        = this._settings.get_string('command-upgrade');

        if (this._hasError) {
            const item = new PopupMenu.PopupImageMenuItem(
                _('View error details'), 'dialog-error-symbolic');
            item.connect('activate', () =>
                this._spawnScript('error'));
            this.menu.addMenuItem(item);
        }

        if (cmdUpdateShow) {
            const item = new PopupMenu.PopupImageMenuItem(
                _('Check for new updates'), 'view-refresh-symbolic');
            item.connect('activate', () => this._refreshUpdatesInfo());
            this.menu.addMenuItem(item);
        }

        // "View updates" entry is only meaningful when the menu is the primary
        // interaction mode (i.e. show-window-on-click is false).
        if (!showWindowOnClick) {
            const label = count > 0
                ? _('View %d updates').format(count)
                : _('No updates to view');
            const item = new PopupMenu.PopupImageMenuItem(
                label, 'view-list-bullet-symbolic');
            item.reactive = count > 0;
            item.connect('activate', () => this._spawnScript('view'));
            this.menu.addMenuItem(item);
        }

        if (cmdUpgradeShow) {
            const label = count > 0
                ? _('Upgrade %d packages').format(count)
                : _('No packages to upgrade');
            const item = new PopupMenu.PopupImageMenuItem(
                label, 'system-run-symbolic');
            item.reactive = count > 0;
            item.connect('activate', () =>
                this._spawnScript('command', cmdUpgrade));
            this.menu.addMenuItem(item);
        }
    }

    // ── Click handling ──────────────────────────────────────────────────────
    // Override vfunc_event so we can intercept a left-click before the
    // PanelMenu.Button's own handler opens the popup menu.

    vfunc_event(event) {
        if (event.type() === Clutter.EventType.BUTTON_PRESS &&
                event.get_button() === 1 &&
                this._settings.get_boolean('show-window-on-click')) {

            const refreshWhenNoUpdates = this._settings.get_boolean('refresh-when-no-updates');
            if (this._updates.map.size > 0 || !refreshWhenNoUpdates)
                this._spawnScript('view');
            else
                this._refreshUpdatesInfo();

            return Clutter.EVENT_STOP;
        }
        return super.vfunc_event(event);
    }

    // ── UI update ──────────────────────────────────────────────────────────

    _update() {
        const count           = this._updates.map.size;
        const hideApplet      = this._settings.get_boolean('hide-applet');
        const differentLevels = this._settings.get_boolean('different-levels');
        const level1          = this._settings.get_int('level-1');
        const level2          = this._settings.get_int('level-2');
        const showLabel       = this._settings.get_boolean('show-label');

        // Visibility
        if (hideApplet && count === 0 && !this._hasError)
            this.hide();
        else
            this.show();

        if (this._hasError) {
            this._applyIcon('update-notifier-error');
            this._label.hide();
            this._buildMenu();
            return;
        }

        // Icon
        if (differentLevels) {
            if      (count <= 0)      this._applyIcon('update-notifier-none');
            else if (count < level1)  this._applyIcon('update-notifier-low');
            else if (count < level2)  this._applyIcon('update-notifier-medium');
            else                      this._applyIcon('update-notifier-high');
        } else {
            this._applyIcon(count <= 0 ? 'update-notifier-none' : 'update-notifier-low');
        }

        // Label
        if (showLabel && count > 0) {
            const size     = this._settings.get_int('label-font-size');
            const weight   = this._settings.get_int('label-font-weight');
            const vertPos  = this._settings.get_int('label-vertical-position');
            const side     = vertPos >= 0 ? 'margin-top' : 'margin-bottom';
            this._label.set_style(
                `font-size: ${size}%; font-weight: ${weight}; ${side}: ${Math.abs(vertPos)}px`);
            this._label.text = `${count}`;
            this._label.show();
        } else {
            this._label.hide();
        }

        this._buildMenu();
    }

    // ── Subprocess helpers ────────────────────────────────────────────────

    /** Spawn updates.sh with the given subcommand + optional extra args. */
    _spawnScript(subcmd, ...extra) {
        this._spawnAsync(
            ['/usr/bin/bash', `${this._extPath}/updates.sh`, subcmd, ...extra]);
    }

    _spawnAsync(argv, callback) {
        try {
            const flags = callback
                ? Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE
                : Gio.SubprocessFlags.NONE;
            const proc = new Gio.Subprocess({ argv, flags });
            proc.init(null);
            if (callback) {
                proc.communicate_utf8_async(null, null, (_proc, res) => {
                    try {
                        const [, stdout] = _proc.communicate_utf8_finish(res);
                        callback(stdout ?? '');
                    } catch (e) {
                        console.error(`${UUID}: spawn read error: ${e}`);
                        callback('');
                    }
                });
            }
        } catch (e) {
            console.error(`${UUID}: spawn error: ${e}`);
            if (callback) callback('');
        }
    }

    /** Persist current update map to disk for info-window.js to display. */
    _saveUpdates() {
        try {
            GLib.file_set_contents(
                `${this._extPath}/updates`, this._updates.toStr());
        } catch (e) {
            console.error(`${UUID}: failed to save updates file: ${e}`);
        }
    }

    // ── Core refresh ──────────────────────────────────────────────────────

    _refreshUpdatesInfo(refreshMode = RefreshMode.UPDATES, force = false) {
        if (this._checkingInProgress) return;

        if (!force && this._lastRefreshTime &&
                (GLib.get_monotonic_time() - this._lastRefreshTime) < 5 * GLib.USEC_PER_SEC) {
            console.log(`${UUID}: Skipping refresh – too frequent`);
            return;
        }

        console.log(`${UUID}: Refreshing (${refreshMode})…`);
        this._setIcon('update-notifier-settings-symbolic');
        this._label.hide();
        this._updates  = new Updates();
        this._hasError = false;
        this._checkingInProgress = true;

        this._spawnAsync(
            ['/usr/bin/bash', `${this._extPath}/updates.sh`, 'check', refreshMode],
            (stdout) => {
                this._lastRefreshTime    = GLib.get_monotonic_time();
                this._checkingInProgress = false;

                // The script prints "ERROR" on the first line when something went wrong.
                if (stdout.trimStart().startsWith('ERROR')) {
                    console.error(`${UUID}: update check failed`);
                    this._hasError = true;
                    this._update();
                    return;
                }

                // Remaining output is optional firmware update lines.
                const showFirmware = this._settings.get_boolean('show-firmware');
                if (showFirmware && stdout.trim()) {
                    let fwCount = 0;
                    for (const line of stdout.trim().split('\n')) {
                        // Skip any stray "ERROR" lines from fwupdmgr
                        if (!line.trim() || line.trimStart().startsWith('ERROR')) continue;
                        const tokens = line.split('#');
                        if (tokens.length < 5) continue;
                        const [name, deviceid, localVersion, version, description]
                            = tokens.map(t => t.trim());
                        this._updates.addFirmware(name, deviceid, localVersion, version, description);
                        fwCount++;
                    }
                    this._hasFirmwareUpdates = fwCount > 0;
                    if (this._hasFirmwareUpdates) this._saveUpdates();
                }

                // D-Bus Finished signal may never fire when there are 0 updates.
                if (this._updates.map.size === 0)
                    this._update();
            }
        );
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────

    destroy() {
        if (this._refreshTimeoutId) {
            GLib.source_remove(this._refreshTimeoutId);
            this._refreshTimeoutId = null;
        }

        for (const [obj, id] of this._iconSizeSignals) {
            if (id)
                obj.disconnect(id);
        }
        this._iconSizeSignals = [];

        if (this._packageSubscription !== null)
            this._bus.signal_unsubscribe(this._packageSubscription);

        if (this._updateChangedSubscription !== null)
            this._bus.signal_unsubscribe(this._updateChangedSubscription);

        for (const id of this._settingsConnIds)
            this._settings.disconnect(id);

        super.destroy();
    }
});

// ---------------------------------------------------------------------------
// Extension entry-point
// ---------------------------------------------------------------------------
export default class UpdatesNotifierExtension extends Extension {
    enable() {
        this._indicator = new UpdatesIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}

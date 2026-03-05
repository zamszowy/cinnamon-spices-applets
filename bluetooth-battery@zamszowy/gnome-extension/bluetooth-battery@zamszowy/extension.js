import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import UPowerGlib from 'gi://UPowerGlib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const UUID = 'bluetooth-battery@zamszowy';

const POWER_DEVICE_XML = `<node>
   <interface name="org.freedesktop.UPower.Device">
      <property name="Type" type="u" access="read" />
      <property name="State" type="u" access="read" />
      <property name="Percentage" type="d" access="read" />
      <property name="IsPresent" type="b" access="read" />
      <property name="IconName" type="s" access="read" />
   </interface>
</node>`;

const PowerDeviceProxy = Gio.DBusProxy.makeProxyWrapper(POWER_DEVICE_XML);

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(extension, instanceIndex = 0) {
        super._init(0.0, _('Bluetooth Battery'));

        this._ext = extension;
        this._settings = extension.getSettings();
        this._extPath = extension.path;
        this._instanceIndex = instanceIndex;

        this._settingsSignals = [];
        this._dbusSignals = [];
        this._dbusMap = new Map();
        this._monitoredDevices = [];
        this._availableDevices = [];
        this._notifiedDevices = new Map();
        this._refreshing = false;
        this._refreshPending = false;
        this._queuedRefreshId = null;
        this._iconSizeSignals = [];
        this._panelIconSize = 16;
        this._tooltipSignals = [];
        this._tooltipShowTimeoutId = null;
        this._hoverTooltipText = '';
        this._customTooltip = null;

        this._indicatorBox = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({style_class: 'system-status-icon'});
        this._label = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
            text: '',
        });
        this._indicatorBox.add_child(this._icon);
        this._indicatorBox.add_child(this._label);
        this.add_child(this._indicatorBox);

        this._connectIconSizeSync();
        this._initCustomTooltip();
        this._connectSettings();
        this._connectDbus();
        this._queueRefresh();
    }

    _initCustomTooltip() {
        this._customTooltip = new St.Label({
            style_class: 'dash-label',
            text: '',
            visible: false,
            opacity: 0,
        });
        Main.layoutManager.addChrome(this._customTooltip);

        this._tooltipSignals.push([
            this,
            this.connect('enter-event', () => this._scheduleTooltipShow()),
        ]);

        this._tooltipSignals.push([
            this,
            this.connect('leave-event', () => this._hideCustomTooltip()),
        ]);

        this._tooltipSignals.push([
            this.menu,
            this.menu.connect('open-state-changed', (_menu, isOpen) => {
                if (isOpen)
                    this._hideCustomTooltip();
            }),
        ]);
    }

    _scheduleTooltipShow() {
        this._hideCustomTooltip(false);

        if (!this._hoverTooltipText)
            return;

        this._tooltipShowTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            250,
            () => {
                this._tooltipShowTimeoutId = null;
                this._showCustomTooltip();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _showCustomTooltip() {
        if (!this._customTooltip || !this._hoverTooltipText || this.menu?.isOpen)
            return;

        this._customTooltip.text = this._hoverTooltipText;
        this._customTooltip.show();
        this._customTooltip.opacity = 255;

        const [stageX, stageY] = this.get_transformed_position();
        const actorWidth = this.width;
        const [minWidth, natWidth] = this._customTooltip.get_preferred_width(-1);
        const [, natHeight] = this._customTooltip.get_preferred_height(-1);
        const tooltipWidth = Math.max(minWidth, natWidth);
        const stageWidth = global.stage.width;

        let x = Math.round(stageX + actorWidth / 2 - tooltipWidth / 2);
        x = Math.max(4, Math.min(x, stageWidth - tooltipWidth - 4));

        const panelBottom = Math.round(stageY + this.height);
        const y = panelBottom + 6;

        this._customTooltip.set_position(x, y);
    }

    _hideCustomTooltip(removeTimeout = true) {
        if (removeTimeout && this._tooltipShowTimeoutId) {
            GLib.source_remove(this._tooltipShowTimeoutId);
            this._tooltipShowTimeoutId = null;
        }

        if (!this._customTooltip)
            return;

        this._customTooltip.opacity = 0;
        this._customTooltip.hide();
    }

    _connectIconSizeSync() {
        this._syncIconSize();

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
        const panelHeight = Math.max(24, Main.panel?.height ?? 24);
        this._panelIconSize = Math.max(16, panelHeight - 8);
        this._icon.icon_size = this._panelIconSize;
        this._icon.set_style(`icon-size: ${this._panelIconSize}px;`);
    }

    _connectSettings() {
        const keys = [
            'enable-keyboards',
            'enable-mice',
            'enable-headphones',
            'enable-others',
            'icon-style',
            'instance-filters',
            'instance-display-modes',
            'instance-override-enabled',
            'instance-override-entries',
            'blacklist',
            'override-enable',
            'override-entry',
            'notification-warn-enable',
            'notification-warn-level',
            'notification-crit-enable',
            'notification-crit-level',
            'notification-filter',
            'notification-applet-icon',
        ];

        for (const key of keys)
            this._settingsSignals.push(this._settings.connect(`changed::${key}`, () => this._queueRefresh()));

        this._settingsSignals.push(this._settings.connect('changed::applet-icon', () => {
            this._applyDisplayMode(this._settings.get_string('applet-icon'));
            this._queueRefresh();
        }));

        // Only the first indicator instance (index 0) should show test notifications
        // to avoid duplicate notifications when multiple panel instances exist.
        if (this._instanceIndex === 0) {
            this._settingsSignals.push(this._settings.connect('changed::notification-warn-test',
                () => this._showWarnTestNotification()));
            this._settingsSignals.push(this._settings.connect('changed::notification-crit-test',
                () => this._showCritTestNotification()));
        }
    }

    _connectDbus() {
        const bus = Gio.DBus.system;
        this._dbusSignals.push(
            bus.signal_subscribe(
                'org.freedesktop.UPower',
                'org.freedesktop.UPower',
                'DeviceAdded',
                null,
                null,
                Gio.DBusSignalFlags.NONE,
                () => this._queueRefresh()
            )
        );
        this._dbusSignals.push(
            bus.signal_subscribe(
                'org.freedesktop.UPower',
                'org.freedesktop.UPower',
                'DeviceRemoved',
                null,
                null,
                Gio.DBusSignalFlags.NONE,
                () => this._queueRefresh()
            )
        );
    }

    _queueRefresh() {
        if (this._queuedRefreshId)
            return;

        this._queuedRefreshId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._queuedRefreshId = null;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _refresh() {
        if (this._refreshing) {
            this._refreshPending = true;
            return;
        }

        this._refreshing = true;
        try {
            this._setupDevices();
            this._buildMenu();
            this._updateIndicator();
            this._notifyIfNeeded();
        } finally {
            this._refreshing = false;
            if (this._refreshPending) {
                this._refreshPending = false;
                this._queueRefresh();
            }
        }
    }

    _setupDevices() {
        this._monitoredDevices = [];

        const knownDevices = new Set(this._settings.get_strv('known-devices'));
        for (const name of this._blacklistDeviceNames())
            knownDevices.add(name);

        for (const [ident, data] of this._dbusMap)
            this._dbusMap.set(ident, {...data, seen: false});

        let devices = [];
        try {
            const upowerClient = UPowerGlib.Client.new_full(null);
            devices = upowerClient.get_devices();
        } catch (e) {
            console.warn(`${UUID}: Failed to get UPower devices: ${e}`);
        }

        for (const dev of devices) {
            const ident = dev.model || dev.serial;
            if (ident)
                knownDevices.add(ident);

            if ((!dev.model && !dev.serial) || this._blacklistContainsActive(dev))
                continue;

            // blacklist by default non mouse/kb/phone/gaming input/mediaplayer/headphones devices
            // and then skip them (if not active in the blacklist)
            if (!this._isKnownDeviceKind(dev.kind)) {
                if (!this._blacklistContainsInactive(dev)) {
                    this._blacklistAdd(dev, true);
                    continue;
                }
            } else {
                this._blacklistAdd(dev, false);
            }

            if (this._dbusMap.has(ident)) {
                const current = this._dbusMap.get(ident);
                this._dbusMap.set(ident, {
                    ...current,
                    device: dev,
                    seen: true,
                });
            } else {
                let proxy = null;
                let signalId = 0;
                try {
                    proxy = new PowerDeviceProxy(
                        Gio.DBus.system,
                        'org.freedesktop.UPower',
                        dev.get_object_path(),
                        () => {}
                    );
                    signalId = proxy.connect('g-properties-changed', () => this._queueRefresh());
                } catch (e) {
                    console.warn(`${UUID}: Failed to create proxy for ${ident}: ${e}`);
                }

                this._dbusMap.set(ident, {
                    device: dev,
                    proxy,
                    signalId,
                    seen: true,
                });
            }
        }

        for (const [ident, data] of Array.from(this._dbusMap.entries())) {
            if (data.seen)
                continue;
            if (data.proxy && data.signalId)
                data.proxy.disconnect(data.signalId);
            this._dbusMap.delete(ident);
        }

        for (const [ident, data] of this._dbusMap) {
            const dev = data.device;
            if (!this._isMonitoringEnabledForKind(dev.kind))
                continue;
            if (!this._matchesIndicatorFilter(dev.kind))
                continue;

            this._monitoredDevices.push(ident);
        }

        this._monitoredDevices.sort((a, b) => {
            const ap = this._dbusMap.get(a)?.device?.percentage ?? 0;
            const bp = this._dbusMap.get(b)?.device?.percentage ?? 0;
            return ap - bp;
        });

        this._availableDevices = Array.from(knownDevices)
            .filter(name => name && name.trim().length > 0)
            .sort((a, b) => a.localeCompare(b, undefined, {sensitivity: 'base'}));

        this._settings.set_strv('known-devices', this._availableDevices);
        this._settings.set_strv('available-devices', this._availableDevices);

        const override = this._settings.get_string('override-entry');
        if (override && !this._monitoredDevices.includes(override))
            this._settings.set_string('override-entry', this._monitoredDevices[0] ?? '');
    }

    _buildMenu() {
        this.menu.removeAll();

        if (this._monitoredDevices.length === 0) {
            const empty = new PopupMenu.PopupMenuItem(_('No supported Bluetooth battery devices'));
            empty.reactive = false;
            this.menu.addMenuItem(empty);
            return;
        }

        for (const ident of this._monitoredDevices) {
            if (!this._dbusMap.has(ident))
                continue;

            const dev = this._dbusMap.get(ident).device;
            const iconName = this._getDeviceBatteryIcon(dev.kind, dev.percentage);
            const item = new PopupMenu.PopupBaseMenuItem();
            const icon = this._getMenuIcon(iconName);
            const title = new St.Label({
                text: ident,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const perc = new St.Label({
                text: `${Math.floor(dev.percentage)}%`,
                y_align: Clutter.ActorAlign.CENTER,
            });

            item.add_child(icon);
            item.add_child(title);
            item.add_child(perc);

            item.connect('activate', () => {
                this._openDeviceInfoWindow(ident, dev);
            });

            this.menu.addMenuItem(item);
        }
    }

    _updateIndicator() {
        if (this._monitoredDevices.length === 0) {
            this.visible = false;
            return;
        }

        const min = this._getLowestBatteryDevice();
        if (!min) {
            this.visible = false;
            return;
        }

        let selectedName = min[0];
        let selectedKind = min[1];
        let selectedPerc = min[2];

        if (this._isInstanceOverrideEnabled()) {
            const override = this._getInstanceOverrideEntry();
            if (override && this._monitoredDevices.includes(override) && this._dbusMap.has(override)) {
                const d = this._dbusMap.get(override).device;
                selectedName = override;
                selectedKind = d.kind;
                selectedPerc = d.percentage;
            }
        }

        const iconVisibilityMode = this._settings.get_string('notification-applet-icon');
        const warnLevel = this._settings.get_int('notification-warn-level');
        const critLevel = this._settings.get_int('notification-crit-level');

        if ((iconVisibilityMode === 'warn' && selectedPerc >= warnLevel) ||
            (iconVisibilityMode === 'crit' && selectedPerc >= critLevel)) {
            this.visible = false;
            return;
        }

        this.visible = true;

        const display = this._getInstanceDisplayMode();
        const iconName = this._getDeviceBatteryIcon(selectedKind, selectedPerc);
        this._icon.gicon = this._getFileIcon(iconName);
        this._icon.icon_size = this._panelIconSize;
        this._icon.set_style(`icon-size: ${this._panelIconSize}px;`);
        this._label.text = `${Math.floor(selectedPerc)}%`;
        this.accessible_name = selectedName;
        this._setHoverTooltip(selectedName);

        this._applyDisplayMode(display);
    }

    _applyDisplayMode(display) {
        const normalized = (display || '').trim().toLowerCase();
        const mode = ['icon-text', 'icon', 'text'].includes(normalized)
            ? normalized
            : 'icon-text';

        for (const child of this._indicatorBox.get_children())
            this._indicatorBox.remove_child(child);

        if (mode !== 'text')
            this._indicatorBox.add_child(this._icon);
        if (mode !== 'icon')
            this._indicatorBox.add_child(this._label);

        this._indicatorBox.queue_relayout();
    }

    _setHoverTooltip(text) {
        this._hoverTooltipText = text ?? '';
    }

    _notifyIfNeeded() {
        if (this._instanceIndex !== 0)
            return;

        const warnEnabled = this._settings.get_boolean('notification-warn-enable');
        const critEnabled = this._settings.get_boolean('notification-crit-enable');
        if (!warnEnabled && !critEnabled)
            return;

        const warnLevel = this._settings.get_int('notification-warn-level');
        const critLevel = this._settings.get_int('notification-crit-level');
        const filter = this._settings.get_int('notification-filter');

        for (const ident of this._monitoredDevices) {
            if (!this._dbusMap.has(ident))
                continue;

            const dev = this._dbusMap.get(ident).device;
            let notifiedWarn = this._notifiedDevices.get(ident)?.warn ?? false;
            let notifiedCrit = this._notifiedDevices.get(ident)?.crit ?? false;

            if (!this._notifiedDevices.has(ident) && dev.percentage === 0)
                continue;

            if (dev.percentage >= warnLevel + filter) {
                notifiedWarn = false;
            } else if (warnEnabled && !notifiedWarn && dev.percentage < warnLevel) {
                Main.notify(
                    `${ident} (${Math.floor(dev.percentage)}%)`,
                    _('Battery dropped below %d%').format(warnLevel)
                );
                notifiedWarn = true;
            }

            if (dev.percentage >= critLevel + filter) {
                notifiedCrit = false;
            } else if (critEnabled && !notifiedCrit && dev.percentage < critLevel) {
                Main.notifyError(
                    `${ident} (${Math.floor(dev.percentage)}%)`,
                    _('Battery dropped below %d%').format(critLevel)
                );
                notifiedCrit = true;
            }

            this._notifiedDevices.set(ident, {warn: notifiedWarn, crit: notifiedCrit});
        }
    }

    _getLowestBatteryDevice() {
        if (this._monitoredDevices.length === 0)
            return null;

        let lowest = null;
        let lowestIdent = '';

        for (const ident of this._monitoredDevices) {
            if (!this._dbusMap.has(ident))
                continue;

            const dev = this._dbusMap.get(ident).device;
            if (!lowest || dev.percentage <= lowest.percentage) {
                lowest = dev;
                lowestIdent = ident;
            }
        }

        if (!lowest)
            return null;

        return [lowestIdent, lowest.kind, lowest.percentage];
    }

    _isKnownDeviceKind(kind) {
        return kind === UPowerGlib.DeviceKind.MOUSE ||
            kind === UPowerGlib.DeviceKind.KEYBOARD ||
            kind === UPowerGlib.DeviceKind.GAMING_INPUT ||
            kind === UPowerGlib.DeviceKind.PHONE ||
            kind === UPowerGlib.DeviceKind.HEADPHONES ||
            kind === UPowerGlib.DeviceKind.HEADSET ||
            kind === UPowerGlib.DeviceKind.MEDIA_PLAYER;
    }

    _isMonitoringEnabledForKind(kind) {
        if (kind === UPowerGlib.DeviceKind.KEYBOARD)
            return this._settings.get_boolean('enable-keyboards');
        if (kind === UPowerGlib.DeviceKind.MOUSE)
            return this._settings.get_boolean('enable-mice');
        if (kind === UPowerGlib.DeviceKind.HEADPHONES || kind === UPowerGlib.DeviceKind.HEADSET)
            return this._settings.get_boolean('enable-headphones');
        return this._settings.get_boolean('enable-others');
    }

    _kindToken(kind) {
        if (kind === UPowerGlib.DeviceKind.KEYBOARD)
            return 'keyboards';
        if (kind === UPowerGlib.DeviceKind.MOUSE)
            return 'mice';
        if (kind === UPowerGlib.DeviceKind.HEADPHONES || kind === UPowerGlib.DeviceKind.HEADSET)
            return 'headphones';
        return 'others';
    }

    _getInstanceFilterSet() {
        const filters = this._settings.get_strv('instance-filters');
        const raw = filters[this._instanceIndex] ?? filters[0] ?? 'keyboards,mice,headphones,others';
        const normalized = (raw || '').trim().toLowerCase();

        if (!normalized || normalized === 'all')
            return new Set(['keyboards', 'mice', 'headphones', 'others']);

        const tokens = normalized
            .split(',')
            .map(token => token.trim())
            .filter(token => token.length > 0);
        const set = new Set(tokens.filter(token => ['keyboards', 'mice', 'headphones', 'others'].includes(token)));
        if (set.size === 0)
            return new Set(['keyboards', 'mice', 'headphones', 'others']);

        return set;
    }

    _matchesIndicatorFilter(kind) {
        return this._getInstanceFilterSet().has(this._kindToken(kind));
    }

    _getInstanceDisplayMode() {
        const modes = this._settings.get_strv('instance-display-modes');
        return modes[this._instanceIndex] ?? modes[0] ?? this._settings.get_string('applet-icon');
    }

    _isInstanceOverrideEnabled() {
        const arr = this._settings.get_strv('instance-override-enabled');
        const raw = (arr[this._instanceIndex] ?? arr[0] ?? 'false').trim().toLowerCase();
        return raw === 'true' || raw === '1' || raw === 'yes';
    }

    _getInstanceOverrideEntry() {
        const arr = this._settings.get_strv('instance-override-entries');
        return (arr[this._instanceIndex] ?? arr[0] ?? '').trim();
    }

    _cleanBlacklistLine(line) {
        return line.replace(/^\s*#\s*/, '').trim();
    }

    _blacklistLines() {
        return this._settings.get_string('blacklist')
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);
    }

    _blacklistDeviceNames() {
        return this._blacklistLines()
            .map(line => this._cleanBlacklistLine(line))
            .filter(line => line.length > 0);
    }

    _blacklistContainsAny(dev) {
        const model = dev.model || '';
        const serial = dev.serial || '';
        const lines = this._blacklistLines();

        return lines.some(line => {
            const value = this._cleanBlacklistLine(line);
            return value === model || value === serial;
        });
    }

    _blacklistContainsActive(dev) {
        const model = dev.model || '';
        const serial = dev.serial || '';
        const lines = this._blacklistLines();

        return lines.some(line => {
            if (line.startsWith('#'))
                return false;
            return line === model || line === serial;
        });
    }

    _blacklistContainsInactive(dev) {
        return this._blacklistContainsAny(dev) && !this._blacklistContainsActive(dev);
    }

    _blacklistAdd(dev, active) {
        if (this._blacklistContainsAny(dev))
            return;

        const value = dev.model || dev.serial;
        if (!value)
            return;

        const prefix = active ? '' : '# ';
        const text = this._settings.get_string('blacklist');
        const next = text ? `${text}\n${prefix}${value}` : `${prefix}${value}`;
        this._settings.set_string('blacklist', next);
    }

    _roundTo10(percentage) {
        return Math.floor(percentage / 10) * 10;
    }

    _toThreeDigits(percentage) {
        if (percentage === 100)
            return '100';
        if (percentage < 10)
            return `00${percentage}`;
        return `0${percentage}`;
    }

    _getDeviceBatteryIcon(type, battery) {
        let name = 'battery';
        if (type === UPowerGlib.DeviceKind.KEYBOARD)
            name = 'keyboard';
        else if (type === UPowerGlib.DeviceKind.MOUSE)
            name = 'mouse';
        else if (type === UPowerGlib.DeviceKind.HEADPHONES || type === UPowerGlib.DeviceKind.HEADSET)
            name = 'headphones';

        const percentage = this._toThreeDigits(this._roundTo10(Math.floor(battery)));
        const style = this._settings.get_string('icon-style') || 'light';
        return `${name}-${percentage}-${style}`;
    }

    _getFileIcon(iconName) {
        const file = Gio.File.new_for_path(`${this._extPath}/icons/${iconName}.svg`);
        return new Gio.FileIcon({file});
    }

    _getMenuIcon(iconName) {
        const size = Math.max(16, this._panelIconSize);
        const icon = new St.Icon({
            gicon: this._getFileIcon(iconName),
            style_class: 'popup-menu-icon',
            icon_size: size,
        });
        icon.set_style(`icon-size: ${size}px; margin-right: 8px;`);
        return icon;
    }

    _openDeviceInfoWindow(name, dev) {
        let raw = '';
        try {
            raw = dev.to_text();
        } catch (_e) {
            raw = `${_('Battery')}: ${Math.floor(dev.percentage)}%`;
        }

        const gjs = GLib.find_program_in_path('gjs') || '/usr/bin/gjs';
        try {
            Gio.Subprocess.new(
                [gjs, '-m', `${this._extPath}/dev-info-window.js`, name, raw],
                Gio.SubprocessFlags.NONE
            );
        } catch (e) {
            Main.notifyError(_('Bluetooth Battery'), `${_('Failed to open device info window')}: ${e.message}`);
        }
    }

    _showWarnTestNotification() {
        const level = this._settings.get_int('notification-warn-level');
        Main.notify(_('Test notification'), _('Battery dropped below %d%').format(level));
    }

    _showCritTestNotification() {
        const level = this._settings.get_int('notification-crit-level');
        Main.notifyError(_('Test notification'), _('Battery dropped below %d%').format(level));
    }

    destroy() {
        if (this._queuedRefreshId) {
            GLib.source_remove(this._queuedRefreshId);
            this._queuedRefreshId = null;
        }

        for (const signalId of this._settingsSignals)
            this._settings.disconnect(signalId);
        this._settingsSignals = [];

        const bus = Gio.DBus.system;
        for (const signalId of this._dbusSignals)
            bus.signal_unsubscribe(signalId);
        this._dbusSignals = [];

        for (const [, data] of this._dbusMap) {
            if (data.proxy && data.signalId)
                data.proxy.disconnect(data.signalId);
        }
        this._dbusMap.clear();

        for (const [obj, signalId] of this._iconSizeSignals) {
            if (obj && signalId)
                obj.disconnect(signalId);
        }
        this._iconSizeSignals = [];

        for (const [obj, signalId] of this._tooltipSignals) {
            if (obj && signalId)
                obj.disconnect(signalId);
        }
        this._tooltipSignals = [];

        this._hideCustomTooltip();
        if (this._customTooltip) {
            Main.layoutManager.removeChrome(this._customTooltip);
            this._customTooltip.destroy();
            this._customTooltip = null;
        }

        super.destroy();
    }
});

export default class BluetoothBatteryExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        this._indicators = [];
        this._instanceCountSignal = this._settings.connect(
            'changed::instance-count',
            () => this._syncIndicators()
        );
        this._syncIndicators();
    }

    _syncIndicators() {
        const wanted = Math.max(1, Math.min(6, this._settings.get_int('instance-count')));

        while (this._indicators.length < wanted) {
            const idx = this._indicators.length;
            const indicator = new Indicator(this, idx);
            Main.panel.addToStatusArea(`${UUID}-${idx + 1}`, indicator);
            this._indicators.push(indicator);
        }

        while (this._indicators.length > wanted) {
            const indicator = this._indicators.pop();
            indicator.destroy();
        }
    }

    disable() {
        if (this._instanceCountSignal) {
            this._settings.disconnect(this._instanceCountSignal);
            this._instanceCountSignal = 0;
        }

        for (const indicator of this._indicators)
            indicator.destroy();
        this._indicators = [];

        this._settings = null;
    }
}

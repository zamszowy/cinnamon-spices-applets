import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class BluetoothBatteryPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(700, 760);

        const switchRow = (title, key, subtitle = '') => {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            return row;
        };

        const spinRow = (title, key, min, max, step = 1, subtitle = '') => {
            const row = new Adw.SpinRow({
                title,
                subtitle,
                adjustment: new Gtk.Adjustment({
                    lower: min,
                    upper: max,
                    step_increment: step,
                }),
            });
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            return row;
        };

        const comboRow = (title, key, choices, subtitle = '') => {
            const model = new Gtk.StringList();
            choices.forEach(([, label]) => model.append(label));
            const row = new Adw.ComboRow({title, subtitle, model});

            const syncFromSettings = () => {
                const value = settings.get_string(key);
                row.selected = Math.max(0, choices.findIndex(([v]) => v === value));
            };

            syncFromSettings();
            row.connect('notify::selected', () => {
                const [value] = choices[row.selected] ?? choices[0];
                settings.set_string(key, value);
            });
            settings.connect(`changed::${key}`, syncFromSettings);

            return row;
        };

        const buttonRow = (title, buttonLabel, onClick) => {
            const row = new Adw.ActionRow({title});
            const button = new Gtk.Button({label: buttonLabel, valign: Gtk.Align.CENTER});
            button.connect('clicked', onClick);
            row.add_suffix(button);
            row.activatable_widget = button;
            return row;
        };

        const parseBlacklist = () => settings.get_string('blacklist')
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);

        const cleanBlacklistEntry = entry => entry.replace(/^\s*#\s*/, '').trim();

        const isActiveBlacklisted = deviceName => parseBlacklist()
            .some(line => !line.startsWith('#') && line === deviceName);

        const setBlacklistState = (deviceName, ignored) => {
            const lines = parseBlacklist().filter(line => cleanBlacklistEntry(line) !== deviceName);
            if (ignored)
                lines.push(deviceName);
            else
                lines.push(`# ${deviceName}`);
            settings.set_string('blacklist', lines.join('\n'));
        };

        const ALL_TOKENS = ['keyboards', 'mice', 'headphones', 'others'];

        const normalizeFilter = value => {
            const normalized = (value ?? '').trim().toLowerCase();
            if (!normalized || normalized === 'all')
                return ALL_TOKENS;

            const tokens = normalized
                .split(',')
                .map(token => token.trim())
                .filter(token => ALL_TOKENS.includes(token));

            return tokens.length > 0 ? Array.from(new Set(tokens)) : ALL_TOKENS;
        };

        const ensureArrayLength = (key, count, fallback) => {
            const arr = settings.get_strv(key).slice();
            while (arr.length < count)
                arr.push(fallback(arr.length));
            if (arr.length > count)
                arr.splice(count);
            settings.set_strv(key, arr);
            return arr;
        };

        const mainPage = new Adw.PreferencesPage({
            title: _('Settings'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(mainPage);

        const monitorGroup = new Adw.PreferencesGroup({
            title: _('Enable battery monitoring for'),
        });
        mainPage.add(monitorGroup);
        monitorGroup.add(switchRow(_('Keyboards'), 'enable-keyboards'));
        monitorGroup.add(switchRow(_('Mice'), 'enable-mice'));
        monitorGroup.add(switchRow(_('Headphones'), 'enable-headphones'));
        monitorGroup.add(switchRow(_('Other devices'), 'enable-others'));

        const appearanceGroup = new Adw.PreferencesGroup({
            title: _('Indicator'),
        });
        mainPage.add(appearanceGroup);
        appearanceGroup.add(comboRow(
            _('Icon style'),
            'icon-style',
            [['dark', _('Dark')], ['light', _('Light')], ['symbolic', _('Symbolic')]]
        ));
        appearanceGroup.add(spinRow(
            _('Number of indicators'),
            'instance-count',
            1,
            6,
            1,
            _('Create multiple panel instances')
        ));

        const instancesGroup = new Adw.PreferencesGroup({
            title: _('Instance configuration'),
            description: _('Configure each panel instance independently.'),
        });
        mainPage.add(instancesGroup);

        const instanceRows = [];
        const clearInstanceRows = () => {
            while (instanceRows.length > 0)
                instancesGroup.remove(instanceRows.pop());
        };

        const addInstanceRows = (instanceIndex, filters, displayModes, overrideEnabledArr, overrideEntriesArr) => {
            const n = instanceIndex + 1;
            const title = new Adw.ActionRow({title: `${_('Instance')} ${n}`});
            title.set_sensitive(false);
            instancesGroup.add(title);
            instanceRows.push(title);

            const displayChoices = [
                ['icon-text', _('Icon and text')],
                ['icon', _('Icon only')],
                ['text', _('Text only')],
            ];
            const displayModel = new Gtk.StringList();
            displayChoices.forEach(([, label]) => displayModel.append(label));
            const displayRow = new Adw.ComboRow({
                title: _('Display mode'),
                model: displayModel,
            });
            const currentMode = displayModes[instanceIndex] ?? 'icon-text';
            displayRow.selected = Math.max(0, displayChoices.findIndex(([v]) => v === currentMode));
            displayRow.connect('notify::selected', () => {
                const safeModes = ensureArrayLength('instance-display-modes', settings.get_int('instance-count'), () => 'icon-text');
                safeModes[instanceIndex] = displayChoices[displayRow.selected]?.[0] ?? 'icon-text';
                settings.set_strv('instance-display-modes', safeModes);
            });
            instancesGroup.add(displayRow);
            instanceRows.push(displayRow);

            const filterSet = new Set(normalizeFilter(filters[instanceIndex]));
            for (const [token, label] of [
                ['keyboards', _('Include keyboards')],
                ['mice', _('Include mice')],
                ['headphones', _('Include headphones')],
                ['others', _('Include other devices')],
            ]) {
                const row = new Adw.SwitchRow({title: label});
                row.active = filterSet.has(token);
                row.connect('notify::active', () => {
                    const allFilters = ensureArrayLength('instance-filters', settings.get_int('instance-count'), () => 'keyboards,mice,headphones,others');
                    const current = new Set(normalizeFilter(allFilters[instanceIndex]));
                    if (row.active)
                        current.add(token);
                    else
                        current.delete(token);

                    if (current.size === 0)
                        current.add(token);

                    allFilters[instanceIndex] = Array.from(current).join(',');
                    settings.set_strv('instance-filters', allFilters);
                });
                instancesGroup.add(row);
                instanceRows.push(row);
            }

            const overrideSwitch = new Adw.SwitchRow({
                title: _('Manually select main device'),
                subtitle: _('Use selected device instead of lowest battery for this instance'),
            });
            const enabledRaw = (overrideEnabledArr[instanceIndex] ?? 'false').trim().toLowerCase();
            overrideSwitch.active = enabledRaw === 'true' || enabledRaw === '1' || enabledRaw === 'yes';
            overrideSwitch.connect('notify::active', () => {
                const arr = ensureArrayLength('instance-override-enabled', settings.get_int('instance-count'), () => 'false');
                arr[instanceIndex] = overrideSwitch.active ? 'true' : 'false';
                settings.set_strv('instance-override-enabled', arr);
            });
            instancesGroup.add(overrideSwitch);
            instanceRows.push(overrideSwitch);

            const selectableDevices = settings.get_strv('available-devices')
                .filter(name => !isActiveBlacklisted(name));
            const dropdownItems = selectableDevices.length > 0
                ? selectableDevices
                : ['(no device available)'];

            const overrideModel = new Gtk.StringList();
            overrideModel.splice(0, 0, dropdownItems);
            const overrideRow = new Adw.ComboRow({
                title: _('Selected device'),
                model: overrideModel,
            });

            const currentOverride = overrideEntriesArr[instanceIndex] ?? '';
            overrideRow.selected = Math.max(0, dropdownItems.findIndex(v => v === currentOverride));
            overrideRow.sensitive = overrideSwitch.active && selectableDevices.length > 0;

            overrideSwitch.connect('notify::active', () => {
                overrideRow.sensitive = overrideSwitch.active && selectableDevices.length > 0;
            });

            overrideRow.connect('notify::selected', () => {
                if (selectableDevices.length === 0)
                    return;
                const idx = Math.max(0, Math.min(overrideRow.selected, selectableDevices.length - 1));
                const arr = ensureArrayLength('instance-override-entries', settings.get_int('instance-count'), () => '');
                arr[instanceIndex] = selectableDevices[idx];
                settings.set_strv('instance-override-entries', arr);
            });

            if (selectableDevices.length > 0 && !selectableDevices.includes(currentOverride)) {
                const arr = ensureArrayLength('instance-override-entries', settings.get_int('instance-count'), () => '');
                arr[instanceIndex] = selectableDevices[0];
                settings.set_strv('instance-override-entries', arr);
            }

            instancesGroup.add(overrideRow);
            instanceRows.push(overrideRow);
        };

        let syncingInstances = false;
        const refreshInstancesGroup = () => {
            if (syncingInstances)
                return;
            syncingInstances = true;

            const count = settings.get_int('instance-count');
            const filters = ensureArrayLength('instance-filters', count, () => 'keyboards,mice,headphones,others');
            const displayModes = ensureArrayLength('instance-display-modes', count, () => 'icon-text');
            const overrideEnabled = ensureArrayLength('instance-override-enabled', count, () => 'false');
            const overrideEntries = ensureArrayLength('instance-override-entries', count, () => '');

            clearInstanceRows();
            for (let i = 0; i < count; i++)
                addInstanceRows(i, filters, displayModes, overrideEnabled, overrideEntries);

            syncingInstances = false;
        };

        settings.connect('changed::instance-count', refreshInstancesGroup);
        settings.connect('changed::instance-filters', refreshInstancesGroup);
        settings.connect('changed::instance-display-modes', refreshInstancesGroup);
        settings.connect('changed::instance-override-enabled', refreshInstancesGroup);
        settings.connect('changed::instance-override-entries', refreshInstancesGroup);
        settings.connect('changed::available-devices', refreshInstancesGroup);
        settings.connect('changed::blacklist', refreshInstancesGroup);
        refreshInstancesGroup();

        const notificationsPage = new Adw.PreferencesPage({
            title: _('Notifications'),
            icon_name: 'preferences-desktop-notification-symbolic',
        });
        window.add(notificationsPage);

        const warnGroup = new Adw.PreferencesGroup({title: _('Warning level')});
        notificationsPage.add(warnGroup);
        warnGroup.add(switchRow(
            _('Enable warning notifications'),
            'notification-warn-enable'
        ));
        warnGroup.add(spinRow(
            _('Warn below [%]'),
            'notification-warn-level',
            1,
            100
        ));
        warnGroup.add(buttonRow(
            _('Test notification'),
            _('Run test'),
            () => settings.set_int('notification-warn-test', settings.get_int('notification-warn-test') + 1)
        ));

        const critGroup = new Adw.PreferencesGroup({title: _('Critical level')});
        notificationsPage.add(critGroup);
        critGroup.add(switchRow(
            _('Enable critical notifications'),
            'notification-crit-enable'
        ));
        critGroup.add(spinRow(
            _('Critical below [%]'),
            'notification-crit-level',
            1,
            100
        ));
        critGroup.add(buttonRow(
            _('Test notification'),
            _('Run test'),
            () => settings.set_int('notification-crit-test', settings.get_int('notification-crit-test') + 1)
        ));

        const behaviorGroup = new Adw.PreferencesGroup({title: _('Indicator visibility')});
        notificationsPage.add(behaviorGroup);
        behaviorGroup.add(spinRow(
            _('Notify again after recharge by [%]'),
            'notification-filter',
            0,
            100,
            1
        ));
        behaviorGroup.add(comboRow(
            _('Show panel indicator only if'),
            'notification-applet-icon',
            [['always', _('Show always')], ['warn', _('Battery below warning level')], ['crit', _('Battery below critical level')]]
        ));

        const blacklistPage = new Adw.PreferencesPage({
            title: _('Blacklist'),
            icon_name: 'edit-delete-symbolic',
        });
        window.add(blacklistPage);

        const blacklistGroup = new Adw.PreferencesGroup({
            title: _('Ignored devices'),
            description: _('Turn ignore mode on or off per device.'),
        });
        blacklistPage.add(blacklistGroup);

        const blacklistRows = [];
        const removeBlacklistRows = () => {
            while (blacklistRows.length > 0)
                blacklistGroup.remove(blacklistRows.pop());
        };

        let syncingRows = false;
        const refreshBlacklistRows = () => {
            if (syncingRows)
                return;
            syncingRows = true;

            removeBlacklistRows();
            const devices = settings.get_strv('available-devices');
            if (devices.length === 0) {
                const row = new Adw.ActionRow({title: _('No devices detected yet')});
                row.set_sensitive(false);
                blacklistGroup.add(row);
                blacklistRows.push(row);
                syncingRows = false;
                return;
            }

            for (const deviceName of devices) {
                const row = new Adw.SwitchRow({
                    title: deviceName,
                    subtitle: _('Ignore this device'),
                });
                row.active = isActiveBlacklisted(deviceName);
                row.connect('notify::active', () => {
                    setBlacklistState(deviceName, row.active);
                });
                blacklistGroup.add(row);
                blacklistRows.push(row);
            }

            syncingRows = false;
        };

        settings.connect('changed::available-devices', refreshBlacklistRows);
        settings.connect('changed::blacklist', refreshBlacklistRows);
        refreshBlacklistRows();
    }
}

// GNOME Shell 45+ extension preferences – uses libadwaita + GTK4.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import {ExtensionPreferences, gettext as _}
    from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class UpdatesNotifierPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const s = this.getSettings();
        window.set_default_size(640, 640);

        // ── Helpers ────────────────────────────────────────────────────────

        /** Adw.SwitchRow bound to a boolean GSettings key. */
        const switchRow = (title, subtitle, key) => {
            const row = new Adw.SwitchRow({ title, subtitle: subtitle ?? '' });
            s.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            return row;
        };

        /** Adw.SpinRow bound to an integer GSettings key. */
        const spinRow = (title, subtitle, key, min, max, step = 1) => {
            const row = new Adw.SpinRow({
                title,
                subtitle: subtitle ?? '',
                adjustment: new Gtk.Adjustment({ lower: min, upper: max, step_increment: step }),
            });
            s.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            return row;
        };

        /** Adw.EntryRow bound to a string GSettings key. */
        const entryRow = (title, key) => {
            const row = new Adw.EntryRow({ title });
            s.bind(key, row, 'text', Gio.SettingsBindFlags.DEFAULT);
            return row;
        };

        /** Adw.ComboRow for a fixed list of string values. */
        const comboRow = (title, subtitle, key, choices) => {
            const model = new Gtk.StringList();
            choices.forEach(([, label]) => model.append(label));
            const row = new Adw.ComboRow({
                title,
                subtitle: subtitle ?? '',
                model,
            });
            // Initialise
            const current = s.get_string(key);
            row.selected = Math.max(0, choices.findIndex(([v]) => v === current));
            row.connect('notify::selected', () => {
                const [value] = choices[row.selected] ?? choices[0];
                s.set_string(key, value);
            });
            s.connect(`changed::${key}`, () => {
                const v = s.get_string(key);
                row.selected = Math.max(0, choices.findIndex(([c]) => c === v));
            });
            return row;
        };

        // ── Page: Behaviour ────────────────────────────────────────────────

        const behavPage = new Adw.PreferencesPage({
            title: _('Behaviour'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(behavPage);

        // Group: polling
        const pollingGroup = new Adw.PreferencesGroup({ title: _('Polling') });
        behavPage.add(pollingGroup);
        pollingGroup.add(spinRow(
            _('Refresh interval'), _('Minutes between automatic update checks'),
            'update-refresh', 1, 1440, 1));
        pollingGroup.add(switchRow(
            _('Include firmware updates'),
            _('Requires fwupdmgr and jq'),
            'show-firmware'));

        // Group: click behaviour
        const clickGroup = new Adw.PreferencesGroup({ title: _('Click behaviour') });
        behavPage.add(clickGroup);
        const showWinRow = switchRow(
            _('Open window on left-click'),
            _('Show update list instead of popup menu'),
            'show-window-on-click');
        clickGroup.add(showWinRow);
        const refreshRow = switchRow(
            _('Refresh on click when no updates'),
            _('Only applies when "Open window on left-click" is enabled'),
            'refresh-when-no-updates');
        clickGroup.add(refreshRow);

        // Group: menu entries
        const menuGroup = new Adw.PreferencesGroup({ title: _('Menu entries') });
        behavPage.add(menuGroup);
        menuGroup.add(switchRow(
            _('Show "Check for new updates"'), null, 'command-update-show'));
        menuGroup.add(switchRow(
            _('Show "Upgrade packages"'), null, 'command-upgrade-show'));
        menuGroup.add(entryRow(_('Upgrade command'), 'command-upgrade'));

        // ── Page: Appearance ───────────────────────────────────────────────

        const appearPage = new Adw.PreferencesPage({
            title: _('Appearance'),
            icon_name: 'applications-graphics-symbolic',
        });
        window.add(appearPage);

        // Group: indicator
        const indicatorGroup = new Adw.PreferencesGroup({ title: _('Indicator') });
        appearPage.add(indicatorGroup);
        indicatorGroup.add(switchRow(
            _('Hide when no updates'), null, 'hide-applet'));
        indicatorGroup.add(comboRow(
            _('Icon style'), null, 'icon-style',
            [['dark', _('Dark')], ['light', _('Light')], ['symbolic', _('Symbolic')]]));

        // Group: level thresholds
        const levelGroup = new Adw.PreferencesGroup({
            title: _('Icon levels'),
            description: _('Show different icons depending on how many updates are pending'),
        });
        appearPage.add(levelGroup);
        levelGroup.add(switchRow(
            _('Enable level icons'), null, 'different-levels'));
        levelGroup.add(spinRow(
            _('Low → Medium threshold'),
            _('Below this count the "low" icon is shown'),
            'level-1', 1, 9999));
        levelGroup.add(spinRow(
            _('Medium → High threshold'),
            _('Below this count the "medium" icon is shown; "high" above'),
            'level-2', 1, 9999));

        // Group: label
        const labelGroup = new Adw.PreferencesGroup({ title: _('Update-count label') });
        appearPage.add(labelGroup);
        labelGroup.add(switchRow(_('Show label'), null, 'show-label'));
        labelGroup.add(spinRow(
            _('Font size (%)'), null, 'label-font-size', 1, 200));
        labelGroup.add(spinRow(
            _('Font weight'), _('CSS font-weight, e.g. 300 = light, 700 = bold'),
            'label-font-weight', 100, 1000, 100));
        labelGroup.add(spinRow(
            _('Vertical offset (px)'),
            _('Positive = shift down, negative = shift up'),
            'label-vertical-position', -20, 20));
    }
}

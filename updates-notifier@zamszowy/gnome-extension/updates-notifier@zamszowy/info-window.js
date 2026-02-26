#!/usr/bin/gjs -m
// Updates list window – GTK 4, GJS ES-module.
// Invoked by updates.sh: info-window.js <ext-dir> <updates-file>

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gettext from 'gettext';

if (!String.prototype.format) {
    String.prototype.format = (...args) =>
        this.replace(/\{(\d+)\}/g, (m, i) => (i in args ? args[i] : m));
}
// ARGV[0] = extension directory, ARGV[1] = updates file path

const extDir = ARGV[0];
const updatesFile = ARGV[1];

// Push extension dir so relative `import` resolves updates.js
// (Not needed since we use a direct path import below.)

const UUID = 'updates-notifier@zamszowy';
Gettext.bindtextdomain(UUID, `${GLib.get_home_dir()}/.local/share/locale`);
const _ = (str) => Gettext.dgettext(UUID, str);

// Load Updates class from extension directory.
const { Updates } = await import(`file://${extDir}/updates.js`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function capitalize(str) {
    if (!str) return str;
    str = str.trimStart();
    return str.charAt(0).toLocaleUpperCase() + str.slice(1);
}

function getPkgDetails(pkgid, callback) {
    let argv;
    if (GLib.find_program_in_path('pkgcli'))
        argv = ['pkgcli', 'show-update', pkgid];
    else if (GLib.find_program_in_path('pkgctl'))
        argv = ['pkgctl', 'show-update', pkgid];
    else
        argv = ['pkcon', 'get-update-detail', pkgid];

    const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    });
    launcher.setenv('LANG', 'en_US.UTF-8', true);
    try {
        const proc = launcher.spawnv(argv);
        proc.communicate_utf8_async(null, null, (p, res) => {
            const [ok, stdout, stderr] = p.communicate_utf8_finish(res);
            if (ok) {
                const lines = stdout.split('\n');
                const idx = lines.findIndex(l => l.trim() === 'Results:');
                const details = (idx >= 0 ? lines.slice(idx + 1) : lines).join('\n');
                callback(details.trim() || _('No details available.'));
            } else {
                callback(`${_('Error:')}\n${stderr}`);
            }
        });
    } catch (e) {
        callback(`${_('Failed to run command:')}\n${e.message}`);
    }
}

function getFirmwareDetails(deviceid, callback) {
    try {
        const proc = new Gio.Subprocess({
            argv: ['fwupdmgr', 'get-updates', deviceid],
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        });
        proc.init(null);
        proc.communicate_utf8_async(null, null, (p, res) => {
            const [ok, stdout, stderr] = p.communicate_utf8_finish(res);
            callback(ok && stdout.trim() ? stdout : `${_('Error:')}\n${stderr}`);
        });
    } catch (e) {
        callback(`${_('Failed to run command:')}\n${e.message}`);
    }
}

// ---------------------------------------------------------------------------
// Detail window
// ---------------------------------------------------------------------------

function showDetails(item) {
    const detailWin = new Gtk.Window({ title: item.name, default_width: 700, default_height: 520 });
    const vbox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8,
        margin_top: 8, margin_bottom: 8, margin_start: 8, margin_end: 8 });
    detailWin.set_child(vbox);

    // Loading row
    const spinner = new Gtk.Spinner();
    spinner.start();
    const loadingLabel = new Gtk.Label({ label: _('Loading update details…') });
    const hbox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
    hbox.append(spinner);
    hbox.append(loadingLabel);
    vbox.append(hbox);

    // Key controller
    const keyCtrl = new Gtk.EventControllerKey();
    keyCtrl.connect('key-pressed', (_ctrl, keyval, _code, state) => {
        if (keyval === Gdk.KEY_Escape ||
                (keyval === Gdk.KEY_w && (state & Gdk.ModifierType.CONTROL_MASK))) {
            detailWin.destroy();
            return true;
        }
        return false;
    });
    detailWin.add_controller(keyCtrl);
    detailWin.present();

    const setText = (text) => {
        spinner.stop();
        hbox.hide();
        const scroll = new Gtk.ScrolledWindow({ vexpand: true });
        const tv = new Gtk.TextView({ editable: false, cursor_visible: false,
            wrap_mode: Gtk.WrapMode.WORD });
        scroll.set_child(tv);
        tv.buffer.text = text;
        vbox.append(scroll);
    };

    const isFirmware = item.values.isFirmware === '1';
    if (!isFirmware)
        getPkgDetails(item.values.pkgid, setText);
    else
        getFirmwareDetails(item.values.deviceid, setText);
}

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------

Gtk.init();

const css = `
.update-name { font-weight: bold; }
.update-spec  { opacity: 0.65; }
.update-info  { opacity: 0.65; }
.update-desc  { font-style: italic; opacity: 0.35; }
`;
const prov = new Gtk.CssProvider();
// load_from_string is GTK 4.12+; fall back to load_from_data for older runtimes.
if (typeof prov.load_from_string === 'function')
    prov.load_from_string(css);
else
    prov.load_from_data(css, -1);

Gtk.StyleContext.add_provider_for_display(
    Gdk.Display.get_default(), prov, Gtk.STYLE_PROVIDER_PRIORITY_USER);

const win = new Gtk.Window({ title: _('Updates'), default_width: 720, default_height: 720 });

// Outer VBox
const vbox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
win.set_child(vbox);

// Search bar (hidden by default)
const searchEntry = new Gtk.SearchEntry({ placeholder_text: _('Search updates…') });
searchEntry.hide();
vbox.append(searchEntry);

// Scrolled list
const scroll = new Gtk.ScrolledWindow({ vexpand: true });
const listbox = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.SINGLE });
scroll.set_child(listbox);
vbox.append(scroll);

// ── Populate -------------------------------------------------------------------
const allRows = [];

const [ok, buffer] = GLib.file_get_contents(updatesFile);
if (ok) {
    const text = new TextDecoder().decode(buffer);
    const updates = new Map(
        [...Updates.fromStr(text).map.entries()]
            .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    );
    win.title = `${updates.size} ${_('updates')}`;

    const makeLabel = (str, cls) => {
        const lbl = new Gtk.Label({ label: str, xalign: 0, hexpand: cls === 'update-desc' });
        lbl.get_style_context().add_class(cls);
        return lbl;
    };

    for (const [name, u] of updates) {
        const row = new Gtk.ListBoxRow();
        const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8,
            margin_top: 4, margin_bottom: 4, margin_start: 6, margin_end: 6 });
        box.append(makeLabel(capitalize(u.type), 'update-info'));
        box.append(makeLabel(name, 'update-name'));
        if (u.localVersion && u.localVersion !== u.version)
            box.append(makeLabel(`${u.localVersion} → ${u.version}`, 'update-spec'));
        else
            box.append(makeLabel(u.version, 'update-spec'));
        box.append(makeLabel(u.description, 'update-desc'));
        row.set_child(box);
        row._item = { name, values: u };
        listbox.append(row);
        allRows.push(row);
    }
} else {
    const errLabel = new Gtk.Label({
        label: _('Failed to read updates file.'),
        xalign: 0, yalign: 0,
    });
    vbox.remove(scroll);
    vbox.append(errLabel);
}

// ── Filter / activate ---------------------------------------------------------

function applyFilter() {
    const q = searchEntry.text.toLowerCase();
    for (const row of allRows) {
        const t = `${row._item.values.type} ${row._item.name} ${row._item.values.description}`;
        row.set_visible(t.toLowerCase().includes(q));
    }
}
searchEntry.connect('changed', applyFilter);

listbox.connect('row-activated', (_box, row) => {
    if (row._item) showDetails(row._item);
});

// ── Key events ----------------------------------------------------------------

const loop = new GLib.MainLoop(null, false);

const keyCtrl = new Gtk.EventControllerKey();
keyCtrl.connect('key-pressed', (_ctrl, keyval, _code, state) => {
    const ctrl = state & Gdk.ModifierType.CONTROL_MASK;

    if (keyval === Gdk.KEY_f && ctrl) {
        if (searchEntry.get_visible()) {
            searchEntry.hide();
            searchEntry.text = '';
            applyFilter();
        } else {
            searchEntry.show();
            searchEntry.grab_focus();
        }
        return true;
    }

    if (keyval === Gdk.KEY_Escape) {
        if (searchEntry.get_visible()) {
            searchEntry.hide();
            searchEntry.text = '';
            applyFilter();
        } else {
            win.destroy();
            loop.quit();
        }
        return true;
    }

    if (keyval === Gdk.KEY_w && ctrl) {
        win.destroy();
        loop.quit();
        return true;
    }

    return false;
});
win.add_controller(keyCtrl);

win.connect('close-request', () => {
    loop.quit();
    return false;
});

win.present();
loop.run();

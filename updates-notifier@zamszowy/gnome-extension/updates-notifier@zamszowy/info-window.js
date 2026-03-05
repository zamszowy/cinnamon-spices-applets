#!/usr/bin/gjs -m
// Invoked by updates.sh: info-window.js <ext-dir> <updates-file>

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Gettext from 'gettext';

if (!String.prototype.format) {
    String.prototype.format = (...args) =>
        this.replace(/\{(\d+)\}/g, (m, i) => (i in args ? args[i] : m));
}
// ARGV[0] = extension directory, ARGV[1] = updates file path

const extDir = ARGV[0];
const updatesFile = ARGV[1];

const UUID = 'updates-notifier@zamszowy';
Gettext.bindtextdomain(UUID, `${GLib.get_home_dir()}/.local/share/locale`);
const _ = (str) => Gettext.dgettext(UUID, str);

// Load Updates class from extension directory.
const { Updates } = await import(`file://${extDir}/updates.js`);

function capitalize(str) {
    if (!str) return str;
    str = str.trimStart();
    return str.charAt(0).toLocaleUpperCase() + str.slice(1);
}

function getPkgDetails(pkgid, callback) {
    let pkg_cmd = [];
    if (GLib.find_program_in_path("pkgcli")) {
        pkg_cmd = ["pkgcli", "show-update", pkgid];
    } else if (GLib.find_program_in_path("pkgctl")) {
        pkg_cmd = ["pkgctl", "show-update", pkgid];
    } else {
        pkg_cmd = ["pkcon", "get-update-detail", pkgid];
    }

    let launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
    });
    launcher.setenv("LANG", "en_US.UTF-8", true);
    try {
        let subprocess = launcher.spawnv(pkg_cmd);
        subprocess.communicate_utf8_async(null, null, (proc, res) => {
            let [ok, stdout, stderr] = proc.communicate_utf8_finish(res);
            if (ok) {
                // Split into lines
                let lines = stdout.split("\n");
                // Find "Results:" line
                let idx = lines.findIndex(l => l.trim() === "Results:");
                let details = idx >= 0 ? lines.slice(idx + 1) : lines;
                const details_str = details.join("\n");

                callback(details_str.length > 0 ? details_str : _("No details available."));
            } else {
                callback(_("Error:\n{0}").format(stderr));
            }
        });
    } catch (e) {
        callback(_("Failed to run command:\n{0}").format(e.message));
    }
}

function getFirmwareDetails(deviceid, callback) {
    let launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
    });
    try {
        let subprocess = launcher.spawnv(["fwupdmgr", "get-updates", deviceid]);
        subprocess.communicate_utf8_async(null, null, (proc, res) => {
            let [ok, stdout, stderr] = proc.communicate_utf8_finish(res);
            if (ok) {
                callback(stdout.length > 0 ? stdout : _("No details available."));
            } else {
                callback(_("Error:\n{0}").format(stderr));
            }
        });
    } catch (e) {
        callback(_("Failed to run command:\n{0}").format(e.message));
    }
}

function showDetails(item) {
    const detailWin = new Gtk.Window({ title: item.name, default_width: 700, default_height: 520 });
    const vbox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL, spacing: 8,
        margin_top: 8, margin_bottom: 8, margin_start: 8, margin_end: 8
    });
    detailWin.set_child(vbox);

    const spinner = new Gtk.Spinner();
    spinner.start();
    const loadingLabel = new Gtk.Label({ label: _('Loading update details…') });
    const hbox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
    hbox.append(spinner);
    hbox.append(loadingLabel);
    vbox.append(hbox);

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
        const tv = new Gtk.TextView({
            editable: false, cursor_visible: false,
            wrap_mode: Gtk.WrapMode.WORD
        });
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

const vbox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
win.set_child(vbox);

// Search bar (hidden by default)
const searchEntry = new Gtk.SearchEntry({ placeholder_text: _('Search updates…') });
searchEntry.hide();
vbox.append(searchEntry);

// Ensure Escape works even when the search entry has focus
const searchKeyCtrl = new Gtk.EventControllerKey();
searchKeyCtrl.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
searchKeyCtrl.connect('key-pressed', (_ctrl, keyval, _keycode, state) => {
    const ctrl = state & Gdk.ModifierType.CONTROL_MASK;

    if (keyval === Gdk.KEY_Escape) {
        searchEntry.hide();
        searchEntry.text = '';
        applyFilter();
        listbox.grab_focus(); // or win.grab_focus()
        return true;
    }

    // optional: keep Ctrl+W behavior consistent when search has focus
    if (keyval === Gdk.KEY_w && ctrl) {
        win.destroy();
        loop.quit();
        return true;
    }

    return false;
});
searchEntry.add_controller(searchKeyCtrl);

// Scrolled list
const scroll = new Gtk.ScrolledWindow({ vexpand: true });
const listbox = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.SINGLE });
scroll.set_child(listbox);
vbox.append(scroll);

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
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL, spacing: 8,
            margin_top: 4, margin_bottom: 4, margin_start: 6, margin_end: 6
        });
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

function applyFilter() {
    const q = searchEntry.text.toLowerCase();
    if (q.length === 0) {
        searchEntry.hide();
        listbox.grab_focus();
    }
    for (const row of allRows) {
        const t = `${row._item.values.type} ${row._item.name} ${row._item.values.description}`;
        row.set_visible(t.toLowerCase().includes(q));
    }
}
searchEntry.connect('changed', applyFilter);

listbox.connect('row-activated', (_box, row) => {
    if (row._item) showDetails(row._item);
});

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

    // Start search on any printable character
    const noMod = !(state & (Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.ALT_MASK | Gdk.ModifierType.SUPER_MASK));
    if (noMod && !searchEntry.get_visible()) {
        const cp = Gdk.keyval_to_unicode(keyval);
        if (cp > 32 && keyval !== Gdk.KEY_Delete && keyval !== Gdk.KEY_BackSpace) {
            const ch = String.fromCodePoint(cp);
            if (ch.trim().length > 0) {
                searchEntry.show();
                searchEntry.text = ch;
                searchEntry.grab_focus();
                searchEntry.set_position(-1);
                applyFilter();
                return true;
            }
        }
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

#!/usr/bin/gjs -m
// Error log viewer – GTK 4, GJS ES-module.
// Invoked by updates.sh: error-window.js <error-file-path>

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gettext from 'gettext';

const UUID = 'updates-notifier@zamszowy';
Gettext.bindtextdomain(UUID, `${GLib.get_home_dir()}/.local/share/locale`);
const _ = (str) => Gettext.dgettext(UUID, str);

Gtk.init();

const win = new Gtk.Window({
    title: _('Update check error'),
    default_width: 640,
    default_height: 420,
});

const vbox = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL, spacing: 8,
    margin_top: 8, margin_bottom: 8, margin_start: 8, margin_end: 8,
});
win.set_child(vbox);

const scroll = new Gtk.ScrolledWindow({ vexpand: true });
const tv = new Gtk.TextView({
    editable: false,
    cursor_visible: false,
    wrap_mode: Gtk.WrapMode.WORD_CHAR,
    monospace: true,
});
scroll.set_child(tv);
vbox.append(scroll);

// Load error file
const errorPath = ARGV[0];
const [success, contents] = GLib.file_get_contents(errorPath);
if (success)
    tv.buffer.text = new TextDecoder().decode(contents);
else
    tv.buffer.text = _('Error log file not found.');

// Close button
const closeBtn = new Gtk.Button({ label: _('Close'), halign: Gtk.Align.END });
vbox.append(closeBtn);

const loop = new GLib.MainLoop(null, false);

closeBtn.connect('clicked', () => { win.destroy(); loop.quit(); });

win.connect('close-request', () => {
    loop.quit();
    return false;
});

// Key controller
const keyCtrl = new Gtk.EventControllerKey();
keyCtrl.connect('key-pressed', (_ctrl, keyval, _code, state) => {
    if (keyval === Gdk.KEY_Escape ||
            (keyval === Gdk.KEY_w && (state & Gdk.ModifierType.CONTROL_MASK))) {
        win.destroy();
        loop.quit();
        return true;
    }
    return false;
});
win.add_controller(keyCtrl);

win.present();
loop.run();

#!/usr/bin/gjs -m

import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
import Gdk from 'gi://Gdk';

Gtk.init();

const title = ARGV[0] ?? 'Device info';
const text = ARGV[1] ?? '';

const win = new Gtk.Window({
    title,
    default_width: 680,
    default_height: 520,
});

const vbox = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    spacing: 8,
    margin_top: 8,
    margin_bottom: 8,
    margin_start: 8,
    margin_end: 8,
});

const scroll = new Gtk.ScrolledWindow({vexpand: true});
const textView = new Gtk.TextView({
    editable: false,
    cursor_visible: false,
    monospace: true,
    wrap_mode: Gtk.WrapMode.WORD_CHAR,
});
textView.buffer.text = text;
scroll.set_child(textView);
vbox.append(scroll);

const closeBtn = new Gtk.Button({
    label: 'Close',
    halign: Gtk.Align.END,
});
closeBtn.connect('clicked', () => win.destroy());
vbox.append(closeBtn);

win.set_child(vbox);

const keyCtrl = new Gtk.EventControllerKey();
keyCtrl.connect('key-pressed', (_ctrl, keyval, _keycode, state) => {
    if (keyval === Gdk.KEY_Escape ||
        (keyval === Gdk.KEY_w && (state & Gdk.ModifierType.CONTROL_MASK))) {
        win.destroy();
        return true;
    }
    return false;
});
win.add_controller(keyCtrl);

const loop = new GLib.MainLoop(null, false);
win.connect('close-request', () => {
    loop.quit();
    return false;
});

win.present();
loop.run();

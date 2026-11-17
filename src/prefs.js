// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

/** A shortcut needs a modifier other than Shift, unless it is a function key. */
function isUsableShortcut(keyval, mask) {
    if (!Gtk.accelerator_valid(keyval, mask))
        return false;
    if (keyval >= Gdk.KEY_F1 && keyval <= Gdk.KEY_F35)
        return true;
    return (mask & ~Gdk.ModifierType.SHIFT_MASK) !== 0;
}

export default class EasyClipPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        window.add(page);

        const shortcuts = new Adw.PreferencesGroup({
            title: _('Shortcuts'),
            description: _('GNOME normally opens the notification list with Super+V. While EasyClip uses that shortcut, the notification list stays on Super+M.'),
        });
        shortcuts.add(this._makeShortcutRow(window, settings,
            'toggle-clipboard', _('Open clipboard history')));
        shortcuts.add(this._makeShortcutRow(window, settings,
            'toggle-emoji', _('Open emoji picker')));
        page.add(shortcuts);

        const behavior = new Adw.PreferencesGroup({title: _('Behavior')});
        const paste = new Adw.SwitchRow({
            title: _('Paste when chosen'),
            subtitle: _('When off, choosing an entry only puts it on the clipboard'),
        });
        settings.bind('paste-on-select', paste, 'active', Gio.SettingsBindFlags.DEFAULT);
        behavior.add(paste);

        const [, range] = settings.settings_schema.get_key('history-size').get_range()
            .recursiveUnpack();
        const size = new Adw.SpinRow({
            title: _('History size'),
            subtitle: _('Entries to keep, not counting pinned ones'),
            adjustment: new Gtk.Adjustment({
                lower: range[0],
                upper: range[1],
                step_increment: 5,
                page_increment: 25,
            }),
        });
        settings.bind('history-size', size, 'value', Gio.SettingsBindFlags.DEFAULT);
        behavior.add(size);
        page.add(behavior);
    }

    _makeShortcutRow(window, settings, key, title) {
        const row = new Adw.ActionRow({title, activatable: true});
        const label = new Gtk.ShortcutLabel({
            disabled_text: _('Disabled'),
            valign: Gtk.Align.CENTER,
        });
        const reset = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            tooltip_text: _('Reset to default'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        row.add_suffix(label);
        row.add_suffix(reset);

        const update = () => {
            label.accelerator = settings.get_strv(key)[0] ?? '';
            reset.visible = settings.get_user_value(key) !== null;
        };
        settings.connect(`changed::${key}`, update);
        update();

        reset.connect('clicked', () => settings.reset(key));
        row.connect('activated', () =>
            this._captureShortcut(window, title, accels => settings.set_strv(key, accels)));
        return row;
    }

    /** Ask for a key combination; `onChosen` gets it as a list of zero or one accelerators. */
    _captureShortcut(parent, title, onChosen) {
        const dialog = new Adw.Window({
            title,
            modal: true,
            transient_for: parent,
            default_width: 440,
            default_height: 360,
        });
        const view = new Adw.ToolbarView();
        view.add_top_bar(new Adw.HeaderBar());
        view.set_content(new Adw.StatusPage({
            icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
            title: _('Press the new shortcut'),
            description: _('Esc to cancel  ·  Backspace to disable'),
        }));
        dialog.set_content(view);

        const keys = new Gtk.EventControllerKey();
        keys.connect('key-pressed', (_controller, keyval, _keycode, state) => {
            const mask = state & Gtk.accelerator_get_default_mod_mask();
            const key = Gdk.keyval_to_lower(keyval);
            if (!mask && key === Gdk.KEY_Escape) {
                dialog.close();
            } else if (!mask && key === Gdk.KEY_BackSpace) {
                onChosen([]);
                dialog.close();
            } else if (isUsableShortcut(key, mask)) {
                onChosen([Gtk.accelerator_name(key, mask)]);
                dialog.close();
            }
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(keys);
        dialog.present();
    }
}

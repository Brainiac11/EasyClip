// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const CLIPBOARD = Meta.SelectionType.SELECTION_CLIPBOARD;
const UTF8_TEXT = 'text/plain;charset=utf-8';
const TEXT_MIMES = [UTF8_TEXT, 'UTF8_STRING', 'text/plain', 'STRING', 'TEXT'];
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/gif', 'image/tiff'];
const SECRET_MIME = 'x-kde-passwordManagerHint';
// Nothing larger than these is ever read from the clipboard, whatever an application offers.
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;
const READ_CHUNK_BYTES = 256 * 1024;
// 8K is 33 megapixels; anything past this is not worth the memory it takes to decode.
const MAX_IMAGE_PIXELS = 40 * 1000 * 1000;
// Thumbnails are stored at twice the size they are shown at, for HiDPI.
const THUMB_WIDTH = 320;
const THUMB_HEIGHT = 130;
const PREVIEW_LINES = 4;
const SEARCH_KEY_LENGTH = 20000;
const EMOJI_COLUMNS = 8;
const RECENT_EMOJI = 32;
const SEARCH_RESULTS = 120;
const PASTE_DELAY_MS = 120;
const SAVE_DELAY_MS = 1000;
// Only this much of a list is built up front; the rest is built as it scrolls into reach.
const FIRST_ROWS = 12;
const MORE_ROWS = 12;
const BUILD_AHEAD_PX = 60;
// A focus change this soon after a desktop switch belongs to the switch, not to a click elsewhere.
const WORKSPACE_SWITCH_MS = 500;
const REFOCUS_DELAY_MS = 150;
const TERMINALS = /terminal|ptyxis|kitty|alacritty|wezterm|konsole|xterm|tilix|terminator|ghostty|kgx|org\.gnome\.console|urxvt|guake|yakuake|foot|blackbox|tabby|warp/i;

const PRIVATE_REPLACE = Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION;

const CACHE_DIR_NAME = 'easyclip';
const OWN_SHORTCUT_KEYS = ['toggle-clipboard', 'toggle-emoji'];
const SHELL_KEYBINDINGS = 'org.gnome.shell.keybindings';
const SHELL_TRAY_KEY = 'toggle-message-tray';

/** A form of an accelerator to compare by: '<Super>v' and '<super>V' are the same shortcut. */
function accelKey(accel) {
    const modifiers = [...accel.matchAll(/<([^>]+)>/g)].map(m => m[1].toLowerCase()).sort();
    return `${modifiers.join('+')}+${accel.replace(/<[^>]+>/g, '').toLowerCase()}`;
}

function readJson(path, fallback) {
    try {
        const [, data] = GLib.file_get_contents(path);
        return JSON.parse(new TextDecoder().decode(data));
    } catch {
        return fallback;
    }
}

function writeJson(path, value) {
    const bytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify(value)));
    Gio.File.new_for_path(path).replace_contents_bytes_async(
        bytes, null, false, PRIVATE_REPLACE, null, (file, res) => {
            try {
                file.replace_contents_finish(res);
            } catch (e) {
                console.warn(`EasyClip: could not write ${path}: ${e.message}`);
            }
        });
}

/**
 * A wrapping label that is at most PREVIEW_LINES tall and ellipsizes the rest.
 *
 * A wrapping, ellipsizing label reports one line as its minimum height, and a scroll view
 * squeezes its content down to the minimum; so this asks for its clamped height outright.
 */
const PreviewLabel = GObject.registerClass({
    GTypeName: 'EasyClipPreviewLabel',
}, class PreviewLabel extends St.Label {
    _init(params) {
        super._init(params);
        this.clutter_text.line_wrap = true;
        this.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    }

    vfunc_get_preferred_height(forWidth) {
        const node = this.get_theme_node();
        const [line, natural] = this.clutter_text.get_preferred_height(
            node.adjust_for_width(forWidth));
        const height = Math.min(natural, line * PREVIEW_LINES);
        return node.adjust_preferred_height(height, height);
    }
});

/** Clipboard entries, newest first, persisted under the user's cache directory. */
class History {
    constructor(dir, limit, onChanged) {
        this._dir = dir;
        this._imageDir = GLib.build_filenamev([dir, 'images']);
        this._path = GLib.build_filenamev([dir, 'history.json']);
        this._onChanged = onChanged;
        this._saveId = 0;
        this._alive = true;
        this._pending = new Set();
        this._searchKeys = new WeakMap();
        this.limit = limit;
        this.items = [];
    }

    load() {
        GLib.mkdir_with_parents(this._imageDir, 0o700);
        const stored = readJson(this._path, []);
        this.items = (Array.isArray(stored) ? stored : []).filter(it =>
            (it?.type === 'text' && typeof it.text === 'string') ||
            (it?.type === 'image' && typeof it.sum === 'string' &&
                GLib.file_test(this.imagePath(it), GLib.FileTest.EXISTS)));
        this._removeOrphanImages();
    }

    destroy() {
        this._alive = false;
        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._saveId = 0;
            try {
                Gio.File.new_for_path(this._path).replace_contents(
                    new TextEncoder().encode(JSON.stringify(this.items)),
                    null, false, PRIVATE_REPLACE, null);
            } catch (e) {
                console.warn(`EasyClip: could not save history: ${e.message}`);
            }
        }
    }

    imagePath(item) {
        return GLib.build_filenamev([this._imageDir, `${item.sum}.${item.ext}`]);
    }

    thumbPath(item) {
        return GLib.build_filenamev([this._imageDir, `${item.sum}.thumb.png`]);
    }

    /** Lower-cased text to search in, computed once per entry rather than once per keystroke. */
    searchKey(item) {
        let key = this._searchKeys.get(item);
        if (key === undefined) {
            key = item.text.slice(0, SEARCH_KEY_LENGTH).toLowerCase();
            this._searchKeys.set(item, key);
        }
        return key;
    }

    addText(text) {
        if (!text || !text.trim())
            return;
        const index = this.items.findIndex(it => it.type === 'text' && it.text === text);
        if (index === 0)
            return;
        const item = index > 0
            ? this.items.splice(index, 1)[0]
            : {type: 'text', text, pinned: false};
        this._push(item);
    }

    addImage(bytes, mime) {
        const size = bytes.get_size();
        if (size === 0 || size > MAX_IMAGE_BYTES)
            return;
        const sum = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA1, bytes);
        if (this._raiseImage(sum) || this._pending.has(sum))
            return;

        const item = {type: 'image', sum, mime, ext: mime.split('/')[1], pinned: false};
        const discard = reason => {
            this._pending.delete(sum);
            this._deleteFiles(item);
            if (reason)
                console.warn(`EasyClip: skipped ${mime} from the clipboard: ${reason}`);
        };
        this._pending.add(sum);

        // Store the file first, then read its dimensions from the header. Nothing is decoded
        // until the pixel count is known to be sane: a small file can describe a huge image.
        const path = this.imagePath(item);
        Gio.File.new_for_path(path).replace_contents_bytes_async(
            bytes, null, false, PRIVATE_REPLACE, null, (file, result) => {
                try {
                    file.replace_contents_finish(result);
                } catch (e) {
                    discard(e.message);
                    return;
                }
                if (!this._alive) {
                    discard();
                    return;
                }
                GdkPixbuf.Pixbuf.get_file_info_async(path, null, (_source, res) => {
                    let format = null, width = 0, height = 0;
                    try {
                        [format, width, height] = GdkPixbuf.Pixbuf.get_file_info_finish(res);
                    } catch (e) {
                        discard(e.message);
                        return;
                    }
                    if (!this._alive) {
                        discard();
                    } else if (!format || width < 1 || height < 1) {
                        discard('not a readable image');
                    } else if (width * height > MAX_IMAGE_PIXELS) {
                        discard(`${width} × ${height} is too large to keep`);
                    } else {
                        Object.assign(item, {width, height});
                        this._makeThumbnail(item, bytes, discard);
                    }
                });
            });
    }

    _makeThumbnail(item, bytes, discard) {
        const scale = Math.min(1,
            2 * THUMB_WIDTH / item.width, 2 * THUMB_HEIGHT / item.height);
        item.thumbWidth = Math.max(1, Math.round(item.width * scale));
        item.thumbHeight = Math.max(1, Math.round(item.height * scale));
        // Decoding and scaling happen off the main thread; only the small result comes back.
        GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
            Gio.MemoryInputStream.new_from_bytes(bytes),
            item.thumbWidth, item.thumbHeight, false, null, (_source, res) => {
                try {
                    const thumb = GdkPixbuf.Pixbuf.new_from_stream_finish(res);
                    if (!this._alive) {
                        discard();
                        return;
                    }
                    thumb.savev(this.thumbPath(item), 'png', [], []);
                } catch (e) {
                    discard(e.message);
                    return;
                }
                this._pending.delete(item.sum);
                if (!this._raiseImage(item.sum))
                    this._push(item);
            });
    }

    /** Move an entry that was just pasted to the top. */
    raise(item) {
        const index = this.items.indexOf(item);
        if (index > 0) {
            this.items.splice(index, 1);
            this.items.unshift(item);
            this._changed();
        }
    }

    remove(item) {
        const index = this.items.indexOf(item);
        if (index < 0)
            return;
        this.items.splice(index, 1);
        this._deleteFiles(item);
        this._changed();
    }

    togglePin(item) {
        item.pinned = !item.pinned;
        this._trim();
        this._changed();
    }

    clear() {
        this.items = this.items.filter(it => {
            if (!it.pinned)
                this._deleteFiles(it);
            return it.pinned;
        });
        this._changed();
    }

    setLimit(limit) {
        this.limit = limit;
        this._trim();
        this._changed();
    }

    _raiseImage(sum) {
        const index = this.items.findIndex(it => it.type === 'image' && it.sum === sum);
        if (index < 0)
            return false;
        if (index > 0)
            this._push(this.items.splice(index, 1)[0]);
        return true;
    }

    _push(item) {
        this.items.unshift(item);
        this._trim();
        this._changed();
    }

    _trim() {
        let unpinned = 0;
        this.items = this.items.filter(it => {
            if (it.pinned || ++unpinned <= this.limit)
                return true;
            this._deleteFiles(it);
            return false;
        });
    }

    _deleteFiles(item) {
        if (item.type !== 'image')
            return;
        for (const path of [this.imagePath(item), this.thumbPath(item)])
            Gio.File.new_for_path(path).delete_async(GLib.PRIORITY_DEFAULT, null, () => {});
    }

    _removeOrphanImages() {
        const known = new Set(this.items.filter(it => it.type === 'image').map(it => it.sum));
        try {
            const dir = GLib.Dir.open(this._imageDir, 0);
            let name;
            while ((name = dir.read_name()) !== null) {
                if (!known.has(name.split('.')[0]))
                    GLib.unlink(GLib.build_filenamev([this._imageDir, name]));
            }
            dir.close();
        } catch (e) {
            console.warn(`EasyClip: could not tidy the image cache: ${e.message}`);
        }
    }

    _changed() {
        if (!this._saveId) {
            // Low priority and debounced: a burst of copies is written to disk once.
            this._saveId = GLib.timeout_add(GLib.PRIORITY_LOW, SAVE_DELAY_MS, () => {
                this._saveId = 0;
                writeJson(this._path, this.items);
                return GLib.SOURCE_REMOVE;
            });
        }
        this._onChanged();
    }
}

/**
 * The overlay: a shell-drawn panel placed next to the text caret or the pointer.
 *
 * It takes keyboard focus but no input grab, so everything else keeps working while it is open:
 * touchpad gestures, shortcuts, scrolling and clicking the windows underneath. It closes when
 * focus goes elsewhere, and follows along when the desktop is switched.
 */
class Popup {
    constructor(extension) {
        this._ext = extension;
        this._history = extension.history;
        this._recentPath = GLib.build_filenamev([extension.cacheDir, 'recent-emoji.json']);
        this._recent = null;
        this._groups = null;
        this._names = null;
        this._panel = null;
        this._entries = [];
        this._cells = [];
        this._blinkId = 0;
        this._focusCheckId = 0;
        this._refocusId = 0;
        this._growId = 0;
    }

    get isOpen() {
        return this._panel !== null;
    }

    toggle(tab) {
        if (!this.isOpen)
            this.open(tab);
        else if (tab === this._tab)
            this.close();
        else
            this._setTab(tab);
    }

    open(tab = 'clipboard') {
        if (this.isOpen)
            return;

        const anchor = this._findAnchor();
        this._buildPanel();
        Main.layoutManager.addTopChrome(this._panel);

        this._entries = [];
        this._cells = [];
        this._selected = -1;
        this._query = '';
        this._category = null;
        this._tab = null;
        this._setTab(tab);
        this._place(anchor);

        this._switchTime = 0;
        global.stage.connectObject(
            'notify::key-focus', () => this._queueFocusCheck(),
            'captured-event', (_stage, event) => this._onStageEvent(event), this);
        global.workspace_manager.connectObject('active-workspace-changed', () => {
            this._switchTime = GLib.get_monotonic_time();
            this._queueFocusCheck();
        }, this);
        Main.overview.connectObject('showing', () => this.close(), this);
        this._entry.grab_key_focus();

        this._panel.opacity = 0;
        this._panel.ease({
            opacity: 255,
            duration: 110,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    close() {
        if (!this.isOpen)
            return;
        const panel = this._panel;
        this._panel = null;

        global.stage.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        Main.overview.disconnectObject(this);
        for (const id of [this._blinkId, this._focusCheckId, this._refocusId, this._growId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._blinkId = this._focusCheckId = this._refocusId = this._growId = 0;

        // Dropping key focus hands the keyboard back to the window underneath.
        const focus = global.stage.key_focus;
        if (focus && panel.contains(focus))
            global.stage.set_key_focus(null);
        Main.layoutManager.removeChrome(panel);
        panel.destroy();

        this._entries = this._cells = [];
        this._row = this._entry = this._list = this._scroll = this._footer = null;
        this._categoryBar = this._clearButton = this._tabButtons = this._categoryButtons = null;
    }

    /** Called when the history changes while the popup may be showing it. */
    refresh() {
        if (this.isOpen && this._tab === 'clipboard')
            this._rebuild(true);
    }

    destroy() {
        this.close();
    }

    // -- staying out of the way -------------------------------------------

    /** A press on shell UI outside the popup closes it; the press itself still goes through. */
    _onStageEvent(event) {
        const type = event.type();
        if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN) {
            const target = global.stage.get_event_actor(event);
            if (!target || !this._panel.contains(target))
                this.close();
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _queueFocusCheck() {
        if (this._focusCheckId)
            return;
        // Deferred, so that a desktop switch and the focus change it causes are seen together.
        this._focusCheckId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._focusCheckId = 0;
            this._checkFocus();
            return GLib.SOURCE_REMOVE;
        });
    }

    _checkFocus() {
        if (!this.isOpen)
            return;
        const focus = global.stage.key_focus;
        if (focus && this._panel.contains(focus))
            return;

        // Clicking a window, opening a menu or the app switcher: focus left, so close.
        // Switching desktops also moves focus, to a window over there: stay, and take it back.
        const switched = GLib.get_monotonic_time() - this._switchTime < WORKSPACE_SWITCH_MS * 1000;
        if (!switched || !this._canRefocus()) {
            this.close();
        } else if (!this._refocusId) {
            // The window over there has only just been handed the keyboard. Let that settle
            // before taking it back, so its input method and ours do not cross over.
            this._refocusId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFOCUS_DELAY_MS, () => {
                this._refocusId = 0;
                if (this._canRefocus())
                    this._entry.grab_key_focus();
                else
                    this.close();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _canRefocus() {
        return !global.stage.key_focus && !Main.overview.visible &&
            Main.actionMode === Shell.ActionMode.NORMAL;
    }

    /** Blink the text cursor the way the desktop is configured to, going solid after any typing. */
    _restartBlink() {
        if (this._blinkId) {
            GLib.source_remove(this._blinkId);
            this._blinkId = 0;
        }
        const text = this._entry.clutter_text;
        text.cursor_visible = true;

        const settings = this._ext.interfaceSettings;
        if (!text.has_key_focus() || !settings.get_boolean('cursor-blink'))
            return;
        const half = Math.max(100, Math.round(settings.get_int('cursor-blink-time') / 2));
        // Like GTK: stop blinking once the entry has sat idle for this long.
        let remaining = settings.get_int('cursor-blink-timeout') * 1000;
        this._blinkId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, half, () => {
            remaining -= half;
            if (remaining <= 0) {
                text.cursor_visible = true;
                this._blinkId = 0;
                return GLib.SOURCE_REMOVE;
            }
            text.cursor_visible = !text.cursor_visible;
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopBlink() {
        if (this._blinkId) {
            GLib.source_remove(this._blinkId);
            this._blinkId = 0;
        }
    }

    // -- layout -----------------------------------------------------------

    _buildPanel() {
        const scheme = this._ext.interfaceSettings.get_string('color-scheme');
        this._panel = new St.BoxLayout({
            style_class: scheme === 'prefer-dark' ? 'easyclip-panel' : 'easyclip-panel easyclip-light',
            vertical: true,
            reactive: true,
        });

        const header = new St.BoxLayout({style_class: 'easyclip-header'});
        this._tabButtons = {
            clipboard: this._makeTabButton(_('Clipboard'), 'clipboard'),
            emoji: this._makeTabButton(_('Emoji'), 'emoji'),
        };
        header.add_child(this._tabButtons.clipboard);
        header.add_child(this._tabButtons.emoji);
        header.add_child(new St.Widget({x_expand: true}));
        this._clearButton = new St.Button({
            style_class: 'easyclip-clear',
            label: _('Clear all'),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._clearButton.connect('clicked', () => this._history.clear());
        header.add_child(this._clearButton);
        this._panel.add_child(header);

        this._entry = new St.Entry({
            style_class: 'easyclip-entry',
            hint_text: _('Type to search'),
            can_focus: true,
            x_expand: true,
        });
        const text = this._entry.clutter_text;
        text.connect('text-changed', () => {
            this._query = this._entry.text.trim().toLowerCase();
            this._restartBlink();
            this._rebuild();
        });
        text.connect('key-press-event', (_actor, event) => {
            this._restartBlink();
            return this._onKeyPress(event);
        });
        text.connect('key-focus-in', () => this._restartBlink());
        text.connect('key-focus-out', () => this._stopBlink());
        this._panel.add_child(this._entry);

        this._categoryBar = new St.BoxLayout({style_class: 'easyclip-categories'});
        this._panel.add_child(this._categoryBar);

        this._list = new St.BoxLayout({style_class: 'easyclip-list', vertical: true});
        this._scroll = new St.ScrollView({
            style_class: 'easyclip-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
            child: this._list,
        });
        const adjustment = this._scroll.vadjustment;
        adjustment.connect('changed', () => this._queueGrow());
        adjustment.connect('notify::value', () => this._queueGrow());
        this._panel.add_child(this._scroll);

        this._footer = new St.Label({style_class: 'easyclip-footer'});
        this._footer.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._panel.add_child(this._footer);
    }

    _makeTabButton(label, tab) {
        const button = new St.Button({style_class: 'easyclip-tab', label, toggle_mode: true});
        button.connect('clicked', () => {
            this._setTab(tab);
            this._entry.grab_key_focus();
        });
        return button;
    }

    /** Where the popup should appear: under the text caret when the app reports one. */
    _findAnchor() {
        const frame = global.display.focus_window?.get_frame_rect();
        const input = Main.inputMethod;
        const caret = input?.currentFocus ? input._cursorRect : null;
        if (frame && caret && (caret.width > 0 || caret.height > 0) &&
            caret.x >= frame.x && caret.x <= frame.x + frame.width &&
            caret.y >= frame.y && caret.y <= frame.y + frame.height)
            return caret;
        const [x, y] = global.get_pointer();
        return {x, y, width: 0, height: 0};
    }

    _place(anchor) {
        const monitors = Main.layoutManager.monitors;
        const monitor = monitors.find(m =>
            anchor.x >= m.x && anchor.x < m.x + m.width &&
            anchor.y >= m.y && anchor.y < m.y + m.height) ?? Main.layoutManager.primaryMonitor;
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const [, , width, height] = this._panel.get_preferred_size();
        const gap = 8;

        let y = anchor.y + anchor.height + gap;
        if (y + height > area.y + area.height - gap)
            y = anchor.y - height - gap;
        const clamp = (value, low, high) => Math.max(low, Math.min(value, high));
        this._panel.set_position(
            Math.round(clamp(anchor.x, area.x + gap, area.x + area.width - width - gap)),
            Math.round(clamp(y, area.y + gap, area.y + area.height - height - gap)));
    }

    // -- content ----------------------------------------------------------

    _setTab(tab) {
        this._tab = tab;
        for (const [name, button] of Object.entries(this._tabButtons))
            button.checked = name === tab;
        this._clearButton.visible = tab === 'clipboard';
        this._categoryBar.visible = tab === 'emoji';
        if (tab === 'emoji') {
            this._loadEmoji();
            this._category ??= this._recent.length ? -1 : 0;
            this._buildCategoryBar();
        }
        if (this._entry.text)
            this._entry.text = '';
        else
            this._rebuild();
    }

    /**
     * Work out what the list holds, then build only the first screenful of it.
     * `_entries` is everything that matches; `_cells` are the ones that exist as actors so far.
     */
    _rebuild(keepSelection = false) {
        const selected = keepSelection ? Math.max(0, this._selected) : 0;
        this._list.destroy_all_children();
        this._cells = [];
        this._row = null;
        this._selected = -1;

        let placeholder;
        if (this._tab === 'clipboard') {
            this._columns = 1;
            this._makeCell = item => this._makeClipCell(item);
            [this._entries, placeholder] = this._findClips();
        } else {
            this._columns = EMOJI_COLUMNS;
            this._makeCell = entry => this._makeEmojiCell(entry);
            [this._entries, placeholder] = this._findEmoji();
        }

        if (!this._entries.length)
            this._addPlaceholder(placeholder);
        if (!keepSelection)
            this._scroll.vadjustment.value = 0;
        this._ensureCells(FIRST_ROWS * this._columns);
        this._select(selected, keepSelection);
    }

    _ensureCells(count) {
        const target = Math.min(count, this._entries.length);
        while (this._cells.length < target) {
            const index = this._cells.length;
            const cell = this._makeCell(this._entries[index]);
            if (this._columns === 1) {
                this._list.add_child(cell.actor);
            } else {
                if (index % this._columns === 0) {
                    this._row = new St.BoxLayout({style_class: 'easyclip-emoji-row'});
                    this._list.add_child(this._row);
                }
                this._row.add_child(cell.actor);
            }
            this._cells.push(cell);
        }
    }

    /** Build the next batch once scrolling gets near the end of what exists. */
    _queueGrow() {
        if (this._growId || !this.isOpen || this._cells.length >= this._entries.length)
            return;
        const {value, page_size: pageSize, upper} = this._scroll.vadjustment;
        if (value + pageSize < upper - BUILD_AHEAD_PX)
            return;
        // Not from inside the layout pass that reported the scroll position.
        this._growId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._growId = 0;
            this._ensureCells(this._cells.length + MORE_ROWS * this._columns);
            return GLib.SOURCE_REMOVE;
        });
    }

    _findClips() {
        const query = this._query;
        const items = this._history.items.filter(it =>
            !query || (it.type === 'text' && this._history.searchKey(it).includes(query)));
        this._clearButton.reactive = this._history.items.some(it => !it.pinned);
        return [items, query
            ? _('No copied text matches your search.')
            : _('Nothing here yet.\nCopy some text or an image and it will show up.')];
    }

    _makeClipCell(item) {
        const row = new St.Button({style_class: 'easyclip-item', x_expand: true});
        const box = new St.BoxLayout({x_expand: true});
        row.set_child(box);

        if (item.type === 'text') {
            box.add_child(new PreviewLabel({
                style_class: 'easyclip-item-text',
                text: this._preview(item.text),
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        } else {
            const content = new St.BoxLayout({
                style_class: 'easyclip-item-image',
                vertical: true,
                x_expand: true,
            });
            content.add_child(this._makeThumbnail(item));
            content.add_child(new St.Label({
                style_class: 'easyclip-item-meta',
                text: `${_('Image')}  ·  ${item.width} × ${item.height}`,
            }));
            box.add_child(content);
        }

        const actions = new St.BoxLayout({
            style_class: 'easyclip-actions',
            y_align: Clutter.ActorAlign.START,
        });
        const pin = this._makeActionButton('view-pin-symbolic', () => this._history.togglePin(item));
        if (item.pinned)
            pin.add_style_class_name('easyclip-pinned');
        actions.add_child(pin);
        actions.add_child(this._makeActionButton('window-close-symbolic',
            () => this._history.remove(item)));
        box.add_child(actions);

        const activate = () => this._ext.pasteItem(item);
        row.connect('clicked', activate);
        return {
            actor: row,
            item,
            hint: _('Enter to paste  ·  Delete to remove  ·  Tab for emoji'),
            activate,
        };
    }

    _makeThumbnail(item) {
        const scale = Math.min(1, THUMB_WIDTH / item.thumbWidth, THUMB_HEIGHT / item.thumbHeight);
        const width = Math.max(1, Math.round(item.thumbWidth * scale));
        const height = Math.max(1, Math.round(item.thumbHeight * scale));
        const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const texture = St.TextureCache.get_default().load_file_async(
            Gio.File.new_for_path(this._history.thumbPath(item)),
            width, height, scaleFactor, 1);
        return new St.Bin({
            style_class: 'easyclip-thumb',
            style: `width: ${width}px; height: ${height}px;`,
            x_align: Clutter.ActorAlign.START,
            child: texture,
        });
    }

    _makeActionButton(iconName, callback) {
        const button = new St.Button({
            style_class: 'easyclip-action',
            child: new St.Icon({icon_name: iconName}),
        });
        button.connect('clicked', callback);
        return button;
    }

    _preview(text) {
        // Only the start of the text can show; never scan a megabyte to draw four lines.
        return text.slice(0, 2000).trim().split('\n').slice(0, PREVIEW_LINES).join('\n')
            .replaceAll('\t', '  ').slice(0, 400);
    }

    _addPlaceholder(text) {
        const label = new St.Label({style_class: 'easyclip-empty', text, x_expand: true});
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_alignment = Pango.Alignment.CENTER;
        this._list.add_child(label);
        this._footer.text = '';
    }

    _loadEmoji() {
        if (this._groups)
            return;
        this._groups = readJson(GLib.build_filenamev([this._ext.path, 'emoji.json']), []);
        this._names = new Map();
        for (const group of this._groups) {
            for (const [emoji, description] of group.items)
                this._names.set(emoji, description);
        }
        const recent = readJson(this._recentPath, []);
        this._recent = (Array.isArray(recent) ? recent : []).filter(e => this._names.has(e));
    }

    _buildCategoryBar() {
        this._categoryBar.destroy_all_children();
        this._categoryButtons = new Map();
        const add = (index, icon, name) => {
            const button = new St.Button({
                style_class: 'easyclip-category',
                label: icon,
                toggle_mode: true,
                x_expand: true,
            });
            button.connect('clicked', () => {
                this._category = index;
                this._entry.grab_key_focus();
                if (this._entry.text)
                    this._entry.text = '';
                else
                    this._rebuild();
            });
            button.connect('notify::hover', () => {
                if (button.hover)
                    this._footer.text = name;
            });
            this._categoryBar.add_child(button);
            this._categoryButtons.set(index, button);
        };
        add(-1, '🕘', _('Recently used'));
        this._groups.forEach((group, index) => add(index, group.icon, group.name));
    }

    _findEmoji() {
        const query = this._query;
        for (const [index, button] of this._categoryButtons)
            button.checked = !query && index === this._category;

        let emoji;
        if (query)
            emoji = this._searchEmoji(query);
        else if (this._category === -1)
            emoji = this._recent.map(e => [e, this._names.get(e)]);
        else
            emoji = this._groups[this._category]?.items ?? [];
        return [emoji, query
            ? _('No emoji matches your search.')
            : _('Emoji you pick will be kept here.')];
    }

    _makeEmojiCell([character, description]) {
        const name = description.split(' | ', 1)[0];
        const button = new St.Button({style_class: 'easyclip-emoji', label: character});
        const activate = () => this._pickEmoji(character);
        button.connect('clicked', activate);
        button.connect('notify::hover', () => {
            if (button.hover)
                this._footer.text = name;
        });
        return {actor: button, hint: name, activate};
    }

    _searchEmoji(query) {
        const matches = [];
        for (const group of this._groups) {
            for (const entry of group.items) {
                const description = entry[1];
                const at = description.indexOf(query);
                if (at < 0)
                    continue;
                // Names that start with the query first, then word starts, then the rest.
                let rank = 2;
                if (at === 0)
                    rank = 0;
                else if (description[at - 1] === ' ')
                    rank = 1;
                matches.push({entry, rank});
            }
        }
        matches.sort((a, b) => a.rank - b.rank);
        return matches.slice(0, SEARCH_RESULTS).map(m => m.entry);
    }

    _pickEmoji(character) {
        this._recent = [character, ...this._recent.filter(e => e !== character)]
            .slice(0, RECENT_EMOJI);
        writeJson(this._recentPath, this._recent);
        this._ext.pasteEmoji(character);
    }

    // -- selection and keyboard -------------------------------------------

    _select(index, scroll = true) {
        this._cells[this._selected]?.actor.remove_style_pseudo_class('selected');
        if (!this._entries.length) {
            this._selected = -1;
            return;
        }
        this._selected = Math.max(0, Math.min(index, this._entries.length - 1));
        // Keep a few rows built beyond the selection, so the next step lands on a laid-out row.
        this._ensureCells(this._selected + 1 + 5 * this._columns);
        const cell = this._cells[this._selected];
        cell.actor.add_style_pseudo_class('selected');
        this._footer.text = cell.hint;
        if (scroll)
            this._scrollTo(cell.actor);
    }

    _scrollTo(actor) {
        if (!actor.has_allocation())
            return;
        const adjustment = this._scroll.vadjustment;
        let {y1, y2} = actor.get_allocation_box();
        for (let parent = actor.get_parent(); parent && parent !== this._list; parent = parent.get_parent()) {
            const offset = parent.get_allocation_box().y1;
            y1 += offset;
            y2 += offset;
        }
        const margin = 6;
        if (y1 - margin < adjustment.value)
            adjustment.value = Math.max(0, y1 - margin);
        else if (y2 + margin > adjustment.value + adjustment.page_size)
            adjustment.value = y2 + margin - adjustment.page_size;
    }

    _move(delta) {
        const count = this._entries.length;
        if (!count)
            return;
        const target = this._selected + delta;
        // Stepping a whole row past the end lands on the last cell instead of doing nothing.
        if (target >= 0 && target < count)
            this._select(target);
        else if (Math.abs(delta) > 1)
            this._select(delta > 0 ? count - 1 : 0);
    }

    _onKeyPress(event) {
        const emoji = this._tab === 'emoji';
        switch (event.get_key_symbol()) {
        case Clutter.KEY_Escape:
            this.close();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Tab:
        case Clutter.KEY_ISO_Left_Tab:
            this._setTab(emoji ? 'clipboard' : 'emoji');
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Down:
            this._move(this._columns);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Up:
            this._move(-this._columns);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Page_Down:
            this._move(this._columns * 4);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Page_Up:
            this._move(-this._columns * 4);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Left:
        case Clutter.KEY_Right:
            if (!emoji)
                break;
            this._move(event.get_key_symbol() === Clutter.KEY_Left ? -1 : 1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_ISO_Enter:
            this._cells[this._selected]?.activate();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Delete: {
            const item = this._cells[this._selected]?.item;
            if (emoji || this._entry.text || !item)
                break;
            this._history.remove(item);
            return Clutter.EVENT_STOP;
        }
        }
        return Clutter.EVENT_PROPAGATE;
    }
}

export default class EasyClipExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this.interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this.cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), CACHE_DIR_NAME]);

        this.history = new History(this.cacheDir,
            this._settings.get_int('history-size'), () => this._popup?.refresh());
        this.history.load();
        this._settings.connectObject('changed::history-size',
            () => this.history.setLimit(this._settings.get_int('history-size')), this);

        this._serial = 0;
        this._ownSource = null;
        this._pasteId = 0;
        this._keyboard = Clutter.get_default_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);

        this._popup = new Popup(this);

        this._selection = global.display.get_selection();
        this._selection.connectObject('owner-changed', (_selection, type, source) => {
            if (type === CLIPBOARD)
                this._captureClipboard(source);
        }, this);

        this._shellKeys = new Gio.Settings({schema_id: SHELL_KEYBINDINGS});
        this._claimShortcuts();
        this._settings.connectObject(
            'changed::toggle-clipboard', () => this._claimShortcuts(),
            'changed::toggle-emoji', () => this._claimShortcuts(), this);

        // Normal mode only: the popup pastes into windows, so it has no use over the overview.
        const modes = Shell.ActionMode.NORMAL;
        Main.wm.addKeybinding('toggle-clipboard', this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, modes, () => this._popup.toggle('clipboard'));
        Main.wm.addKeybinding('toggle-emoji', this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, modes, () => this._popup.toggle('emoji'));
    }

    disable() {
        Main.wm.removeKeybinding('toggle-clipboard');
        Main.wm.removeKeybinding('toggle-emoji');
        this._selection.disconnectObject(this);
        this._selection = null;
        this._settings.disconnectObject(this);
        this._releaseShortcuts();
        this._shellKeys = null;
        if (this._pasteId) {
            GLib.source_remove(this._pasteId);
            this._pasteId = 0;
        }
        this._popup.destroy();
        this._popup = null;
        this.history.destroy();
        this.history = null;
        this._ownSource = null;
        this._keyboard = null;
        this._settings = null;
        this.interfaceSettings = null;
    }

    /**
     * Take our shortcuts away from the shell's notification-list binding.
     *
     * GNOME binds Super+V to the notification list (Super+M opens it too), and a shortcut with
     * two owners serves neither reliably. What is taken is written to our own settings, so that
     * it is handed back on disable even if the shell was restarted in between.
     */
    _claimShortcuts() {
        this._releaseShortcuts();
        const ours = new Set(
            OWN_SHORTCUT_KEYS.flatMap(key => this._settings.get_strv(key)).map(accelKey));
        const current = this._shellKeys.get_strv(SHELL_TRAY_KEY);
        const taken = current.filter(accel => ours.has(accelKey(accel)));
        if (!taken.length)
            return;
        this._settings.set_strv('shortcuts-taken', taken);
        this._shellKeys.set_strv(SHELL_TRAY_KEY, current.filter(accel => !taken.includes(accel)));
    }

    _releaseShortcuts() {
        const taken = this._settings.get_strv('shortcuts-taken');
        if (!taken.length)
            return;
        this._settings.reset('shortcuts-taken');

        const current = this._shellKeys.get_strv(SHELL_TRAY_KEY);
        const present = new Set(current.map(accelKey));
        const restored = [...taken.filter(accel => !present.has(accelKey(accel))), ...current];
        // Back to what GNOME ships with? Then leave no override behind at all.
        const defaults = this._shellKeys.get_default_value(SHELL_TRAY_KEY).deepUnpack();
        const same = restored.length === defaults.length &&
            defaults.every(accel => restored.includes(accel));
        if (same)
            this._shellKeys.reset(SHELL_TRAY_KEY);
        else
            this._shellKeys.set_strv(SHELL_TRAY_KEY, restored);
    }

    /** Record whatever was just copied, unless it is marked secret or we put it there. */
    _captureClipboard(source) {
        const serial = ++this._serial;
        if (!source || source === this._ownSource)
            return;

        const mimes = source.get_mimetypes();
        if (mimes.includes(SECRET_MIME))
            return;

        const textMime = TEXT_MIMES.find(m => mimes.includes(m));
        const imageMime = IMAGE_MIMES.find(m => mimes.includes(m));
        if (textMime) {
            this._read(source, textMime, MAX_TEXT_BYTES, serial, bytes =>
                this.history.addText(new TextDecoder().decode(bytes.toArray()).replace(/\0+$/, '')));
        } else if (imageMime) {
            this._read(source, imageMime, MAX_IMAGE_BYTES, serial, bytes =>
                this.history.addImage(bytes, imageMime));
        }
    }

    /**
     * Read what `source` offers as `mime`, but never more than `limit` bytes.
     *
     * The stream is read in chunks and closed by hand: the moment the content turns out to be
     * too large (or something newer was copied) the application is released, instead of being
     * left writing into a pipe nobody reads.
     */
    _read(source, mime, limit, serial, callback) {
        source.read_async(mime, null, (_source, result) => {
            let stream;
            try {
                stream = source.read_finish(result);
            } catch {
                return;     // the application that owned the clipboard went away
            }
            const buffer = Gio.MemoryOutputStream.new_resizable();
            let size = 0;
            const finish = complete => {
                stream.close_async(GLib.PRIORITY_DEFAULT, null, null);
                buffer.close(null);
                if (complete && size > 0 && serial === this._serial && this.history)
                    callback(buffer.steal_as_bytes());
            };
            const readMore = () => {
                stream.read_bytes_async(READ_CHUNK_BYTES, GLib.PRIORITY_DEFAULT, null, (_stream, res) => {
                    let chunk;
                    try {
                        chunk = stream.read_bytes_finish(res);
                    } catch {
                        finish(false);
                        return;
                    }
                    const length = chunk.get_size();
                    size += length;
                    if (length === 0) {
                        finish(true);
                    } else if (size > limit || serial !== this._serial || !this.history) {
                        finish(false);
                    } else {
                        buffer.write_bytes(chunk, null);
                        readMore();
                    }
                });
            };
            readMore();
        });
    }

    /** Put something on the clipboard, remembering it is ours so it is not read straight back. */
    _offer(mime, bytes) {
        this._ownSource = Meta.SelectionSourceMemory.new(mime, bytes);
        this._selection.set_owner(CLIPBOARD, this._ownSource);
    }

    _offerText(text) {
        this._offer(UTF8_TEXT, new GLib.Bytes(new TextEncoder().encode(text)));
    }

    pasteItem(item) {
        if (item.type === 'text') {
            this._offerText(item.text);
        } else {
            try {
                const [bytes] = Gio.File.new_for_path(this.history.imagePath(item)).load_bytes(null);
                this._offer(item.mime, bytes);
            } catch (e) {
                console.warn(`EasyClip: stored image is gone: ${e.message}`);
                this.history.remove(item);
                return;
            }
        }
        this._finishPaste();
        this.history.raise(item);
    }

    pasteEmoji(character) {
        // Emoji are kept in the picker's own "recent" list, not in the clipboard history.
        this._offerText(character);
        this._finishPaste();
    }

    _finishPaste() {
        // Closing drops the popup's key focus, which gives the keyboard back to the window.
        this._popup.close();
        if (!this._settings.get_boolean('paste-on-select'))
            return;

        // Give the window a moment to get keyboard focus back before typing the paste shortcut.
        if (this._pasteId)
            GLib.source_remove(this._pasteId);
        this._pasteId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PASTE_DELAY_MS, () => {
            this._pasteId = 0;
            const terminal = TERMINALS.test(global.display.focus_window?.get_wm_class() ?? '');
            const keys = terminal
                ? [Clutter.KEY_Control_L, Clutter.KEY_Shift_L, Clutter.KEY_v]
                : [Clutter.KEY_Control_L, Clutter.KEY_v];
            for (const key of keys)
                this._keyboard.notify_keyval(GLib.get_monotonic_time(), key, Clutter.KeyState.PRESSED);
            for (const key of keys.reverse())
                this._keyboard.notify_keyval(GLib.get_monotonic_time(), key, Clutter.KeyState.RELEASED);
            return GLib.SOURCE_REMOVE;
        });
    }
}

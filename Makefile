# EasyClip build. The version and UUID live in src/metadata.json and nowhere else.

UUID    := $(shell sed -n 's/.*"uuid": *"\([^"]*\)".*/\1/p' src/metadata.json)
VERSION := $(shell sed -n 's/.*"version-name": *"\([^"]*\)".*/\1/p' src/metadata.json)
PACKAGE := gnome-shell-extension-easyclip

BUILD := build
ZIP   := $(BUILD)/$(UUID).shell-extension.zip
DEB   := $(BUILD)/$(PACKAGE)_$(VERSION)_all.deb

SCHEMA  := src/schemas/org.gnome.shell.extensions.easyclip.gschema.xml
SOURCES := src/extension.js src/prefs.js src/stylesheet.css src/emoji.json src/metadata.json

USER_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: all check zip deb dist install uninstall clean version

all: dist

# Cheap checks that need nothing but glib and python3.
check:
	python3 -I -c "import json, sys; [json.load(open(p, encoding='utf-8')) for p in sys.argv[1:]]" \
		src/metadata.json src/emoji.json
	glib-compile-schemas --strict --dry-run src/schemas
	@test -n "$(UUID)" && test -n "$(VERSION)" || { echo "could not read uuid/version-name from src/metadata.json"; exit 1; }

# The extension as a zip: for `gnome-extensions install` and for extensions.gnome.org.
zip: $(ZIP)
$(ZIP): $(SOURCES) $(SCHEMA)
	@mkdir -p $(BUILD)
	@rm -f $@
	cd src && TZ=UTC zip -q -X -r ../$@ $(notdir $(SOURCES)) schemas/$(notdir $(SCHEMA))
	@echo "built $@"

# The extension as a Debian package, installed system-wide under /usr/share.
deb: $(DEB)
$(DEB): $(SOURCES) $(SCHEMA) packaging/build-deb.sh packaging/control.in packaging/copyright
	@mkdir -p $(BUILD)
	sh packaging/build-deb.sh $@

dist: check zip deb
	cd $(BUILD) && sha256sum $(notdir $(ZIP)) $(notdir $(DEB)) > SHA256SUMS
	@cat $(BUILD)/SHA256SUMS

# Install for the current user only, straight from the source tree (no root needed).
install: check
	mkdir -p $(USER_DIR)/schemas
	install -m 644 $(SOURCES) $(USER_DIR)/
	install -m 644 $(SCHEMA) $(USER_DIR)/schemas/
	glib-compile-schemas --strict $(USER_DIR)/schemas
	@echo
	@echo "Installed to $(USER_DIR)"
	@echo "Log out and back in, then run:  gnome-extensions enable $(UUID)"

uninstall:
	rm -rf $(USER_DIR)

clean:
	rm -rf $(BUILD)

version:
	@echo $(VERSION)

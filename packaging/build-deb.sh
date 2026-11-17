#!/bin/sh
# Build the EasyClip .deb with nothing but dpkg-deb.
# usage: packaging/build-deb.sh OUTPUT.deb   (run from the repository root)
set -eu

out="$1"
package=gnome-shell-extension-easyclip
uuid=$(sed -n 's/.*"uuid": *"\([^"]*\)".*/\1/p' src/metadata.json)
version=$(sed -n 's/.*"version-name": *"\([^"]*\)".*/\1/p' src/metadata.json)
url=$(sed -n 's/.*"url": *"\([^"]*\)".*/\1/p' src/metadata.json)
[ -n "$uuid" ] && [ -n "$version" ] && [ -n "$url" ] || { echo "could not read uuid/version-name/url from src/metadata.json" >&2; exit 1; }

# Timestamps come from the last commit, so the same commit always builds the same package.
if [ -z "${SOURCE_DATE_EPOCH:-}" ]; then
    SOURCE_DATE_EPOCH=$(git log -1 --format=%ct 2>/dev/null || date +%s)
fi
export SOURCE_DATE_EPOCH

umask 022
stage=$(mktemp -d)
chmod 755 "$stage"
trap 'rm -rf "$stage"' EXIT

ext="$stage/usr/share/gnome-shell/extensions/$uuid"
doc="$stage/usr/share/doc/$package"
install -d "$ext" "$doc" "$stage/usr/share/glib-2.0/schemas" "$stage/DEBIAN"

install -m 644 src/extension.js src/prefs.js src/stylesheet.css src/emoji.json src/metadata.json "$ext/"
# System-wide extensions keep their schema with everyone else's; glib's dpkg trigger compiles it.
install -m 644 src/schemas/*.gschema.xml "$stage/usr/share/glib-2.0/schemas/"
install -m 644 packaging/copyright "$doc/copyright"

maintainer=$(sed -n 's/^Maintainer: *//p' packaging/control.in)
cat > "$doc/changelog" <<EOF
$package ($version) unstable; urgency=medium

  * Release $version. What changed is listed in CHANGELOG.md:
    $url/blob/main/CHANGELOG.md

 -- $maintainer  $(date -R -u -d "@$SOURCE_DATE_EPOCH")
EOF
gzip -9 -n "$doc/changelog"

(cd "$stage" && find usr -type f -print0 | LC_ALL=C sort -z | xargs -0 md5sum > DEBIAN/md5sums)
find "$stage" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
size=$(du -k -s --exclude=DEBIAN "$stage" | cut -f1)
sed -e "s/@VERSION@/$version/" -e "s/@INSTALLED_SIZE@/$size/" packaging/control.in > "$stage/DEBIAN/control"

dpkg-deb --root-owner-group -Zxz --build "$stage" "$out" > /dev/null
echo "built $out"

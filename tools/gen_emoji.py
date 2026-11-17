#!/usr/bin/env python3
"""Build the compact emoji table bundled with the extension.

usage: gen_emoji.py EMOJI_TEST_TXT CLDR_ANNOTATIONS_XML OUT_JSON
"""
import json
import re
import sys
import xml.etree.ElementTree as ET

emoji_test, cldr_xml, out_path = sys.argv[1:4]

ICONS = {
    'Smileys & Emotion': '😀',
    'People & Body': '👋',
    'Animals & Nature': '🐻',
    'Food & Drink': '🍔',
    'Travel & Places': '🚗',
    'Activities': '⚽',
    'Objects': '💡',
    'Symbols': '💟',
    'Flags': '🏁',
}
SKIN = set(range(0x1F3FB, 0x1F400))

# keywords, keyed by the emoji with U+FE0F stripped (that is how CLDR lists them)
keywords = {}
for node in ET.parse(cldr_xml).getroot().iter('annotation'):
    if node.get('type') == 'tts':
        continue
    keywords[node.get('cp')] = [k.strip().lower() for k in node.text.split('|')]

line_re = re.compile(r'^([0-9A-F ]+?)\s*;\s*fully-qualified\s*#\s*\S+\s+E(\d+\.\d+)\s+(.+)$')
groups = []
current = None
for line in open(emoji_test, encoding='utf-8'):
    line = line.rstrip('\n')
    if line.startswith('# group:'):
        name = line.split(':', 1)[1].strip()
        current = None
        if name in ICONS:
            current = {'name': name, 'icon': ICONS[name], 'items': []}
            groups.append(current)
        continue
    if current is None:
        continue
    m = line_re.match(line)
    if not m:
        continue
    cps = [int(c, 16) for c in m.group(1).split()]
    if any(c in SKIN for c in cps):
        continue
    char = ''.join(map(chr, cps))
    name = m.group(3).lower()
    words = []
    for word in [name] + keywords.get(char.replace('\ufe0f', ''), []):
        if word not in words and word not in name.split():
            words.append(word)
    if name not in words:
        words.insert(0, name)
    current['items'].append([char, ' | '.join(words)])

with open(out_path, 'w', encoding='utf-8') as f:
    json.dump(groups, f, ensure_ascii=False, separators=(',', ':'))

for g in groups:
    print(f"{g['icon']} {g['name']}: {len(g['items'])}")
print('total', sum(len(g['items']) for g in groups))

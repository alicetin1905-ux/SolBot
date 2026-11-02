#!/usr/bin/env bash
# Stamps every module import, the stylesheet and the entry script with one
# version, so browsers never mix cached old files with new ones after a deploy.
# Run before every commit that changes js/ or css/.
set -euo pipefail
cd "$(dirname "$0")/.."
V="${1:-$(date +%Y%m%d%H%M%S)}"
sed -i -E "s#(from '\./[a-z]+\.js)(\?v=[0-9A-Za-z]+)?'#\1?v=$V'#g" js/*.js
sed -i -E "s#(href=\"css/style\.css)(\?v=[0-9A-Za-z]+)?\"#\1?v=$V\"#; s#(src=\"js/app\.js)(\?v=[0-9A-Za-z]+)?\"#\1?v=$V\"#; s#(window\.SOLBOT_VERSION = ')[^']*'#\1$V'#" index.html
echo "version $V"

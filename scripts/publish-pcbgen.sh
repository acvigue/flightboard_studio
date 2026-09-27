#!/usr/bin/env bash
# Publish the Altium generator (../pcbgen) self-contained for one runtime, for electron-builder's extraResources.
# usage: scripts/publish-pcbgen.sh [osx-arm64|osx-x64|win-x64]   (default: this machine)
# bash, so it also runs on the Windows CI runner (Git Bash). PCBGEN_DIR overrides the pcbgen checkout.
set -euo pipefail
cd "$(dirname "$0")/.."
PCBGEN=${PCBGEN_DIR:-../pcbgen}
case "$(uname -s)" in
  Darwin) HOST=osx-$(uname -m | sed 's/x86_64/x64/') ;;
  MINGW* | MSYS* | CYGWIN*) HOST=win-x64 ;;
  *) HOST=linux-x64 ;;
esac
RID=${1:-$HOST}
DOTNET=dotnet
if [[ -x /usr/local/share/dotnet/dotnet ]]; then DOTNET=/usr/local/share/dotnet/dotnet; export DOTNET_ROOT=/usr/local/share/dotnet; fi
# AltiumSharp (pinned upstream + our patch) when the checkout does not have it yet
[[ -d "$PCBGEN/AltiumSharp/src" ]] || bash "$PCBGEN/tools/altiumsharp.sh"
OUT="$PCBGEN/out/publish/$RID"
rm -rf "$OUT"
# not trimmed: the deep cloner uses reflection. Symbols and XML docs are left out of the app.
"$DOTNET" publish "$PCBGEN/gen/PcbGen.csproj" -c Release -r "$RID" --self-contained true -p:PublishTrimmed=false \
  -p:NuGetAudit=false -p:DebugType=none -p:GenerateDocumentationFile=false -o "$OUT" | grep -E "error|->" || true
rm -f "$OUT"/*.pdb "$OUT"/*.xml
[[ -x "$OUT/PcbGen" || -f "$OUT/PcbGen.exe" ]] || { echo "publish failed: no PcbGen in $OUT"; exit 1; }
echo "published $RID: $(du -sh "$OUT" | cut -f1) in $OUT"
# the Altium template for the app: the live one (template/Plane_Template, an Altium 365 checkout) when present, else
# the committed snapshot (template-snapshot/Plane_Template: CI, a fresh clone); electron-builder bundles its design files
TPL="$PCBGEN/template/Plane_Template"
[[ -d "$TPL" ]] || TPL="$PCBGEN/template-snapshot/Plane_Template"
TOUT="$PCBGEN/out/publish/template/Plane_Template"
rm -rf "$TOUT"
mkdir -p "$TOUT"
cp -p "$TPL"/*.SchDoc "$TPL"/*.PcbDoc "$TPL"/*.PrjPcb "$TPL"/*.OutJob "$TPL"/*.BomDoc "$TOUT"/
cp -p "$TPL"/*.PrjPcbStructure "$TOUT"/ 2>/dev/null || true
echo "template: $TPL -> $TOUT ($(ls "$TOUT" | wc -l | tr -d ' ') files)"

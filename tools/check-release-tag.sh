#!/bin/bash
# Release guard (CI): the release tag must be v<package.json version>, and the
# docs download link + bridge VERSION must already be stamped to it.
#
#   tools/check-release-tag.sh <tag>
set -eo pipefail
TAG="$1"
PKG="v$(node -p "require('./package.json').version")"
echo "release tag: $TAG / package.json: $PKG"
if [ "$TAG" != "$PKG" ]; then
  echo "::error::tag $TAG does not match package.json $PKG (run npm version first)"
  exit 1
fi
node tools/stamp-docs-version.mjs --check

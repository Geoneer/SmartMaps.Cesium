define([
        '../Core/Intersect',
        '../Core/ManagedArray',
        './Cesium3DTileRefine'
    ], function(
        Intersect,
        ManagedArray,
        Cesium3DTileRefine) {
    'use strict';

    /**
     * @private
     */
    function Cesium3DTilesetOffscreenTraversal() {
    }

    var offscreenTraversal = {
        stack : new ManagedArray(),
        stackMaximumLength : 0
    };

    Cesium3DTilesetOffscreenTraversal.selectTiles = function(tileset, statistics, frameState) {
        tileset._selectedTiles.length = 0;
        tileset._requestedTiles.length = 0;
        tileset._hasMixedContent = false;
        var minimumGeometricError = 0;

        var ready = true;

        var root = tileset.root;
        root.updateVisibility(frameState);

        if (!isVisible(root)) {
            return ready;
        }

        if (tileset._geometricError <= minimumGeometricError) {
            return ready;
        }

        var stack = offscreenTraversal.stack;
        stack.push(tileset.root);

        while (stack.length > 0) {
            offscreenTraversal.stackMaximumLength = Math.max(offscreenTraversal.stackMaximumLength, stack.length);

            var tile = stack.pop();
            var add = tile.refine === Cesium3DTileRefine.ADD;
            var replace = tile.refine === Cesium3DTileRefine.REPLACE;
            var traverse = canTraverse(tileset, minimumGeometricError, tile);

            if (traverse) {
                updateAndPushChildren(tileset, tile, stack, frameState);
            }

            if (add || (replace && !traverse)) {
                loadTile(tileset, tile);
                selectDesiredTile(tileset, tile, frameState);

                if (!hasEmptyContent(tile) && !tile.contentAvailable) {
                    ready = false;
                }
            }

            visitTile(statistics);
            touchTile(tileset, tile);
        }

        offscreenTraversal.stack.trim(offscreenTraversal.stackMaximumLength);

        return ready;
    };

    function isVisible(tile) {
        return tile._visible && tile._inRequestVolume;
    }

    function hasEmptyContent(tile) {
        return tile.hasEmptyContent || tile.hasTilesetContent;
    }

    function hasUnloadedContent(tile) {
        return !hasEmptyContent(tile) && tile.contentUnloaded;
    }

    function canTraverse(tileset, minimumGeometricError, tile) {
        if (tile.children.length === 0) {
            return false;
        }

        if (tile.hasTilesetContent) {
            // Traverse external tileset to visit its root tile
            // Don't traverse if the subtree is expired because it will be destroyed
            return !tile.contentExpired;
        }

        if (tile.hasEmptyContent) {
            return true;
        }

        return tile.geometricError >= minimumGeometricError;
    }

    function updateAndPushChildren(tileset, tile, stack, frameState) {
        var children = tile.children;
        var length = children.length;

        for (var i = 0; i < length; ++i) {
            var child = children[i];
            child.updateVisibility(frameState);
            if (isVisible(child)) {
                stack.push(child);
            }
        }
    }

    function loadTile(tileset, tile) {
        if (hasUnloadedContent(tile) || tile.contentExpired) {
            tileset._requestedTiles.push(tile);
        }
    }

    function touchTile(tileset, tile) {
        tileset._cache.touch(tile);
    }

    function visitTile(statistics) {
        ++statistics.visited;
    }

    function selectDesiredTile(tileset, tile, frameState) {
        if (tile.contentAvailable && (tile.contentVisibility(frameState) !== Intersect.OUTSIDE)) {
            tileset._selectedTiles.push(tile);
        }
    }

    return Cesium3DTilesetOffscreenTraversal;
});

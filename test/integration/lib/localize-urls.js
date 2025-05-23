import path from 'path';
import fs from 'fs';
import chalk from 'chalk';
// eslint-disable-next-line import/order
import {fileURLToPath} from 'url';
const __dirname = fileURLToPath(new URL('.', import.meta.url));

import {createRequire} from 'module';
const require = createRequire(import.meta.url);

export default function localizeURLs(style, port) {
    localizeStyleURLs(style, port);

    if (style.imports) {
        for (const importSpec of style.imports) {
            localizeURLs(importSpec.data, port);
        }
    }

    if (style.metadata && style.metadata.test && style.metadata.test.operations) {
        style.metadata.test.operations.forEach((op) => {
            if (op[0] === 'addSource') {
                localizeSourceURLs(op[2], port);
            } else if (op[0] === 'setStyle') {
                if (typeof op[1] === 'object') {
                    localizeURLs(op[1], port);
                    return;
                }
                if (op[1].startsWith('mapbox://')) return;

                let styleJSON;
                try {
                    const relativePath = op[1].replace(/^local:\/\//, '');
                    if (relativePath.startsWith('mapbox-gl-styles')) {
                        styleJSON = fs.readFileSync(path.join(path.dirname(require.resolve('mapbox-gl-styles')), '..', relativePath));
                    } else {
                        styleJSON = fs.readFileSync(path.join(__dirname, '..', relativePath));
                    }
                } catch (error) {
                    console.log(chalk.blue(`* ${error}`));
                    return;
                }

                try {
                    styleJSON = JSON.parse(styleJSON.toString());
                } catch (error) {
                    console.log(chalk.blue(`* Error while parsing ${op[1]}: ${error}`));
                    return;
                }

                localizeStyleURLs(styleJSON, port);

                op[1] = styleJSON;
                op[2] = {diff: false};
            }
        });
    }
}

function localizeURL(url, port) {
    return url.replace(/^local:\/\//, `http://localhost:${port}/`);
}

function localizeMapboxSpriteURL(url, port) {
    return url.replace(/^mapbox:\/\//, `http://localhost:${port}/`);
}

function localizeMapboxFontsURL(url, port) {
    return url.replace(/^mapbox:\/\/fonts/, `http://localhost:${port}/glyphs`);
}

function localizeMapboxTilesURL(url, port) {
    return url.replace(/^mapbox:\/\//, `http://localhost:${port}/tiles/`);
}

function localizeMapboxTilesetURL(url, port) {
    return url.replace(/^mapbox:\/\//, `http://localhost:${port}/tilesets/`);
}

export function localizeSourceURLs(source, port) {
    for (const tile in source.tiles) {
        source.tiles[tile] = localizeMapboxTilesURL(source.tiles[tile], port);
        source.tiles[tile] = localizeURL(source.tiles[tile], port);
    }

    if (source.urls) {
        source.urls = source.urls.map((url) => localizeMapboxTilesetURL(url, port));
        source.urls = source.urls.map((url) => localizeURL(url, port));
    }

    if (source.url) {
        source.url = localizeMapboxTilesetURL(source.url, port);
        source.url = localizeURL(source.url, port);
    }

    if (source.data && typeof source.data == 'string') {
        source.data = localizeURL(source.data, port);
    }

    for (const model in source.models) {
        source.models[model].uri = localizeURL(source.models[model].uri, port);
    }
}

function localizeStyleURLs(style, port) {
    for (const source in style.sources) {
        localizeSourceURLs(style.sources[source], port);
    }
    if (style.models) {
        for (const modelId in style.models) {
            style.models[modelId] = localizeURL(style.models[modelId], port);
        }
    }
    if (style.sprite) {
        style.sprite = localizeMapboxSpriteURL(style.sprite, port);
        style.sprite = localizeURL(style.sprite, port);
    }

    if (style.glyphs) {
        style.glyphs = localizeMapboxFontsURL(style.glyphs, port);
        style.glyphs = localizeURL(style.glyphs, port);
    }
}

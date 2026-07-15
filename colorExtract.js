'use strict';

import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';

// Downscaling to a tiny thumbnail before averaging keeps this cheap enough to
// run synchronously on the main thread (art is almost always an already-small
// local cache file, so decoding at 8x8 is near-instant).
const SAMPLE_SIZE = 8;
const MIN_SATURATION = 0.45;
const MIN_LIGHTNESS = 0.42;
const MAX_LIGHTNESS = 0.62;

function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    const d = max - min;
    if (d !== 0) {
        s = d / (1 - Math.abs(2 * l - 1));
        switch (max) {
        case r: h = ((g - b) / d) % 6; break;
        case g: h = (b - r) / d + 2; break;
        case b: h = (r - g) / d + 4; break;
        }
        h *= 60;
        if (h < 0) h += 360;
    }
    return [h, s, l];
}

function hslToRgb(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return [
        Math.round((r + m) * 255),
        Math.round((g + m) * 255),
        Math.round((b + m) * 255),
    ];
}

function toHex(r, g, b) {
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

// Averages pixels from a small downscaled sample of the given MPRIS art URI,
// then boosts saturation/lightness into a pleasant, always-visible-on-black
// range (raw album art averages are often muddy/dark and would barely read
// as an accent color). Returns null for anything that isn't a local file —
// deliberately not fetching remote URIs just to sample a color — or on any
// decode failure (corrupt/missing file, unsupported format).
export function extractDominantColor(artUrl) {
    if (!artUrl || !artUrl.startsWith('file://'))
        return null;

    try {
        const path = Gio.File.new_for_uri(artUrl).get_path();
        if (!path)
            return null;

        const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, SAMPLE_SIZE, SAMPLE_SIZE, false);
        const pixels = pixbuf.get_pixels();
        const nChannels = pixbuf.get_n_channels();
        const rowstride = pixbuf.get_rowstride();
        const width = pixbuf.get_width();
        const height = pixbuf.get_height();

        let rSum = 0, gSum = 0, bSum = 0, count = 0;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const offset = y * rowstride + x * nChannels;
                rSum += pixels[offset];
                gSum += pixels[offset + 1];
                bSum += pixels[offset + 2];
                count++;
            }
        }
        if (count === 0)
            return null;

        const [h, s, l] = rgbToHsl(rSum / count, gSum / count, bSum / count);
        const boostedS = Math.max(s, MIN_SATURATION);
        const boostedL = Math.min(Math.max(l, MIN_LIGHTNESS), MAX_LIGHTNESS);
        const [r, g, b] = hslToRgb(h, boostedS, boostedL);

        return { r, g, b, hex: toHex(r, g, b) };
    } catch (e) {
        return null;
    }
}

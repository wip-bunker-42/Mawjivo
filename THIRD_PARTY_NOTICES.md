# Mawjivo: third-party notices

Mawjivo uses Tauri, React, Rust crates and JavaScript packages. The release generates the complete available license and attribution texts from the installed locked package sources and includes them as `THIRD_PARTY_NOTICES.txt`. The exact versions remain in `pnpm-lock.yaml` and `apps/desktop/src-tauri/Cargo.lock`.

Media processing runs separate FFmpeg executables and shared libraries, under LGPL-3.0-or-later, with OpenH264 under BSD-2-Clause. CPU decoding uses dav1d and JPEG XL, with the latter's exact upstream Brotli, Highway and skcms dependencies. PNG processing uses zlib-ng's zlib-compatible API. The verified media archive includes their full license texts and compiler runtime notices, including the GPLv3 terms incorporated by LGPLv3. No GPL or nonfree codec library is enabled in the Mawjivo build. Original FFmpeg library filenames are retained.

Corresponding source archives, a changes declaration and the exact build recipe are distributed beside the downloadable application and media archive. Their checksums and source locations are recorded in `tools/media-tools.json`; the reproducible build inputs are in `tools/media-build.json`. Release publication verifies that the sources are present before promoting a download or update manifest. The source bundle preserves every original dependency and build tool archive, and records the generated FFmpeg VERSION metadata addition in `changes.diff`.

The unmodified selectors crate uses MPL-2.0. Generated notices retain its original authors, the full official Mozilla license and the exact source download with its Cargo checksum. Source location: https://static.crates.io/crates/selectors/selectors-0.38.0.crate . Other crate notices omitted from their registry archive are retrieved from the exact upstream revision recorded in the crate's `.cargo_vcs_info.json`, with provenance hashes included in the release notices.

Users may study, modify and rebuild the separately distributed LGPL components according to their licenses. The reproducible build recipe and tool manifest allow a local source build with explicitly updated component hashes. Mawjivo does not claim ownership of these components.

Upstream: [FFmpeg](https://ffmpeg.org/), [OpenH264](https://github.com/cisco/openh264), [dav1d](https://code.videolan.org/videolan/dav1d), [JPEG XL](https://github.com/libjxl/libjxl), [zlib-ng](https://github.com/zlib-ng/zlib-ng), [LLVM MinGW](https://github.com/mstorsjo/llvm-mingw), [NASM](https://www.nasm.us/), [Tauri](https://tauri.app/), [React](https://react.dev/).

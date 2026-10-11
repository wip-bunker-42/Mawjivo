# Mawjivo: third-party notices

Mawjivo uses Tauri, React, Rust crates and JavaScript packages. The release generates the complete available license and attribution texts from the installed locked package sources and includes them as `THIRD_PARTY_NOTICES.txt`. The exact versions remain in `pnpm-lock.yaml` and `apps/desktop/src-tauri/Cargo.lock`.

Media processing runs separate FFmpeg executables and shared libraries, under LGPL-3.0-or-later, with OpenH264 under BSD-2-Clause. The verified media archive includes the full license texts and compiler runtime notices. No GPL or nonfree codec library is enabled in the Mawjivo build. Original FFmpeg library filenames are retained.

Corresponding source archives, unchanged-source declaration and exact build recipe are distributed beside the downloadable application and media archive. Their checksums and source locations are recorded in `tools/media-tools.json`; the reproducible build inputs are in `tools/media-build.json`. Release publication verifies that the sources are present before promoting a download or update manifest. These source files include FFmpeg, OpenH264 and the build inputs required to reproduce the supplied media tools.

Users may study, modify and rebuild the separately distributed LGPL components according to their licenses. The reproducible build recipe and tool manifest allow a local source build with explicitly updated component hashes. Mawjivo does not claim ownership of these components.

Upstream: [FFmpeg](https://ffmpeg.org/), [OpenH264](https://github.com/cisco/openh264), [LLVM MinGW](https://github.com/mstorsjo/llvm-mingw), [NASM](https://www.nasm.us/), [Tauri](https://tauri.app/), [React](https://react.dev/).

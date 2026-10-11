#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
task_build="$task_root/.tools/media-build"
task_prefix="$task_build/prefix"
mkdir -p "$task_build/downloads" "$task_build/src" "$task_prefix" "$task_build/output"
python3 - "$task_root" "$task_build" <<'PY'
import sys,json,urllib.request,hashlib,pathlib,tarfile
root,build=map(pathlib.Path,sys.argv[1:])
config=json.loads((root/'tools/media-build.json').read_text())
for name,item in config['archives'].items():
    suffix='.'+item.get('format', 'tar.xz' if name in ('llvm','nasm') else 'tar.gz')
    archive=build/'downloads'/(name+suffix)
    if not archive.exists():
        with urllib.request.urlopen(item['url'],timeout=120) as response: archive.write_bytes(response.read())
    if hashlib.sha256(archive.read_bytes()).hexdigest()!=item['sha256']: raise SystemExit('Archive checksum mismatch: '+name)
    directory=build/'src'/name
    if not directory.exists():
        directory.mkdir()
        with tarfile.open(archive) as source:
            # Immutable official source archives; retain files only inside the target.
            source.extractall(directory,filter='data')
    print('Verified '+name)
PY
task_llvm="$(find "$task_build/src/llvm" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
task_ffmpeg="$(find "$task_build/src/ffmpeg" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
task_openh264="$(find "$task_build/src/openh264" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
task_nasm="$(find "$task_build/src/nasm" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
task_dav1d="$(find "$task_build/src/dav1d" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
task_jxl="$(find "$task_build/src/jxl" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
task_meson="$(find "$task_build/src/meson" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
task_ninja="$(find "$task_build/src/ninja" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
task_cmake="$(find "$task_build/src/cmake" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
task_zlibng="$(find "$task_build/src/zlibng" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
task_extra_version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["ffmpegExtraVersion"])' "$task_root/tools/media-build.json")"
export PATH="$task_build/host/bin:$task_llvm/bin:$task_cmake/bin:$PATH"
if [ ! -x "$task_build/host/bin/nasm" ]; then
  (cd "$task_nasm" && ./configure --prefix="$task_build/host" && make -j2 && make install)
fi
make -C "$task_openh264" -j2 OS=mingw_nt ARCH=x86_64 CC=x86_64-w64-mingw32-clang CXX=x86_64-w64-mingw32-clang++ AR=llvm-ar PREFIX="$task_prefix" install-static
if [ ! -x "$task_build/host/bin/ninja" ]; then
  (cd "$task_ninja" && python3 configure.py --bootstrap)
  cp "$task_ninja/ninja" "$task_build/host/bin/ninja"
fi
export PKG_CONFIG_PATH="$task_prefix/lib/pkgconfig"
export PKG_CONFIG_LIBDIR="$task_prefix/lib/pkgconfig"
cmake -S "$task_zlibng" -B "$task_build/zlibng-build" -G Ninja \
  -DCMAKE_SYSTEM_NAME=Windows -DCMAKE_C_COMPILER=x86_64-w64-mingw32-clang \
  -DCMAKE_CXX_COMPILER=x86_64-w64-mingw32-clang++ -DCMAKE_RC_COMPILER=x86_64-w64-mingw32-windres \
  -DCMAKE_AR=llvm-ar -DCMAKE_RANLIB=llvm-ranlib -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$task_prefix" -DCMAKE_INSTALL_LIBDIR=lib \
  -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTING=OFF -DZLIB_COMPAT=ON -DINSTALL_UTILS=OFF \
  -DWITH_NATIVE_INSTRUCTIONS=OFF -DWITH_RUNTIME_CPU_DETECTION=ON
cmake --build "$task_build/zlibng-build" --parallel 2
cmake --install "$task_build/zlibng-build"
cat > "$task_build/windows-cross.ini" <<EOF
[binaries]
c = 'x86_64-w64-mingw32-clang'
cpp = 'x86_64-w64-mingw32-clang++'
ar = 'llvm-ar'
strip = 'llvm-strip'
pkg-config = 'pkg-config'
windres = 'x86_64-w64-mingw32-windres'
[host_machine]
system = 'windows'
cpu_family = 'x86_64'
cpu = 'x86_64'
endian = 'little'
[properties]
needs_exe_wrapper = true
EOF
python3 "$task_meson/meson.py" setup "$task_build/dav1d-build" "$task_dav1d" \
  --cross-file "$task_build/windows-cross.ini" --prefix "$task_prefix" --libdir lib \
  --buildtype release --default-library static -Denable_tools=false -Denable_tests=false
ninja -C "$task_build/dav1d-build" -j2
ninja -C "$task_build/dav1d-build" install
for task_dependency in brotli highway skcms; do
  task_dependency_source="$(find "$task_build/src/$task_dependency" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  mkdir -p "$task_jxl/third_party/$task_dependency"
  cp -a "$task_dependency_source/." "$task_jxl/third_party/$task_dependency/"
done
cmake -S "$task_jxl" -B "$task_build/jxl-build" -G Ninja \
  -DCMAKE_SYSTEM_NAME=Windows -DCMAKE_C_COMPILER=x86_64-w64-mingw32-clang \
  -DCMAKE_CXX_COMPILER=x86_64-w64-mingw32-clang++ -DCMAKE_RC_COMPILER=x86_64-w64-mingw32-windres \
  -DCMAKE_AR=llvm-ar -DCMAKE_RANLIB=llvm-ranlib -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$task_prefix" -DCMAKE_INSTALL_LIBDIR=lib \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTING=OFF \
  -DJPEGXL_STATIC=ON -DJPEGXL_ENABLE_SKCMS=ON -DJPEGXL_ENABLE_TOOLS=OFF \
  -DJPEGXL_ENABLE_DEVTOOLS=OFF -DJPEGXL_ENABLE_DOXYGEN=OFF -DJPEGXL_ENABLE_MANPAGES=OFF \
  -DJPEGXL_ENABLE_BENCHMARK=OFF -DJPEGXL_ENABLE_EXAMPLES=OFF -DJPEGXL_ENABLE_JNI=OFF \
  -DJPEGXL_ENABLE_SJPEG=OFF -DJPEGXL_ENABLE_OPENEXR=OFF -DJPEGXL_ENABLE_VIEWERS=OFF \
  -DJPEGXL_ENABLE_PLUGINS=OFF -DJPEGXL_ENABLE_TCMALLOC=OFF -DJPEGXL_BUNDLE_LIBPNG=OFF
cmake --build "$task_build/jxl-build" --parallel 2
cmake --install "$task_build/jxl-build"
# An archive nested in our Git checkout must not inherit Mawjivo's Git revision.
python3 - "$task_root/tools/media-build.json" "$task_ffmpeg/VERSION" <<'PY'
import json,pathlib,sys
config=json.loads(pathlib.Path(sys.argv[1]).read_text())
version=config['ffmpegVersion'].removesuffix('-'+config['ffmpegExtraVersion'])
pathlib.Path(sys.argv[2]).write_text(version+'\n')
PY
cd "$task_ffmpeg"
./configure \
  --prefix="$task_prefix" --arch=x86_64 --target-os=mingw32 --enable-cross-compile \
  --cross-prefix=x86_64-w64-mingw32- --cc=x86_64-w64-mingw32-clang --cxx=x86_64-w64-mingw32-clang++ \
  --ld=x86_64-w64-mingw32-clang --ar=llvm-ar --nm=llvm-nm --ranlib=llvm-ranlib \
  --disable-autodetect --enable-libopenh264 --enable-libdav1d --enable-libjxl --enable-zlib --enable-shared --disable-static \
  --enable-version3 --disable-gpl --disable-nonfree --disable-doc --disable-debug \
  --disable-network --disable-ffplay --pkg-config=pkg-config --pkg-config-flags=--static \
  --extra-cflags="-I$task_prefix/include" --extra-ldflags="-L$task_prefix/lib -static" \
  --extra-libs=-lstdc++ --extra-version="$task_extra_version"
make -j2
make install
python3 - "$task_root" "$task_build" "$task_ffmpeg" "$task_openh264" "$task_llvm" <<'PY'
import sys,pathlib,json,hashlib,zipfile,shutil,subprocess
root,build,ffmpeg,openh264,llvm=map(pathlib.Path,sys.argv[1:])
package=build/'package'/'ffmpeg-mawjivo-win64'
(package/'bin').mkdir(parents=True,exist_ok=True)
for file in (build/'prefix'/'bin').iterdir():
    if file.suffix in ('.exe','.dll'): shutil.copy(file,package/'bin'/file.name)
shutil.copy(ffmpeg/'COPYING.LGPLv3',package/'LICENSE.txt')
licenses=package/'licenses';licenses.mkdir(exist_ok=True)
shutil.copy(openh264/'LICENSE',licenses/'OpenH264.txt')
for name in ('dav1d','jxl','brotli','highway','skcms','zlibng'):
    source=next((build/'src'/name).iterdir())
    legal=[p for p in source.iterdir() if p.is_file() and p.name.upper().startswith(('LICENSE','COPYING','NOTICE','AUTHORS','PATENTS'))]
    if not legal: raise SystemExit('Missing dependency license: '+name)
    for file in legal: shutil.copy(file,licenses/(name+'-'+file.name))
for file in llvm.rglob('*'):
    if file.is_file() and any(word in file.name.upper() for word in ('LICENSE','COPYING','NOTICE')):
        dest=licenses/'llvm-runtime'/file.relative_to(llvm);dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy(file,dest)
config=json.loads((root/'tools/media-build.json').read_text())
(package/'SOURCES.json').write_text(json.dumps(config,indent=2)+'\n')
# A release must contain no accidental external runtime DLL dependencies.
owned={p.name.lower() for p in (package/'bin').iterdir()}
imports=set()
for file in (package/'bin').iterdir():
    dump=subprocess.check_output([str(llvm/'bin/llvm-objdump'),'-p',str(file)],text=True)
    for line in dump.splitlines():
        if 'DLL Name:' in line: imports.add(line.split('DLL Name:')[1].strip().lower())
(build/'output/imports.json').write_text(json.dumps(sorted(imports),indent=2))
unexpected=[name for name in imports if name not in owned and name.startswith(('libc++','libunwind','libwinpthread','libgcc','libstdc++'))]
if unexpected: raise SystemExit('Unexpected toolchain runtime DLL: '+','.join(unexpected))
binary=build/'output/media-tools-win32-x64.zip'
with zipfile.ZipFile(binary,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as output:
    for file in package.rglob('*'):
        if file.is_file(): output.write(file,file.relative_to(package.parent))
sources=build/'output/media-tools-sources.zip'
with zipfile.ZipFile(sources,'w',zipfile.ZIP_STORED) as output:
    for file in (build/'downloads').iterdir(): output.write(file,'archives/'+file.name)
    for name in ('tools/media-build.json','scripts/build-media-tools.sh'):output.write(root/name,name)
    output.write(ffmpeg/'ffbuild/config.mak','ffmpeg-config.mak')
    output.write(build/'windows-cross.ini','windows-cross.ini')
    output.write(build/'jxl-build/CMakeCache.txt','jxl-CMakeCache.txt')
    version=(ffmpeg/'VERSION').read_text().strip()
    output.writestr('changes.diff','--- /dev/null\n+++ b/VERSION\n@@ -0,0 +1 @@\n+'+version+'\n')
    output.writestr('README.txt','Exact unmodified upstream source archives for FFmpeg, OpenH264, dav1d, JPEG XL, Brotli, Highway, skcms and zlib-ng; pinned build tools and the complete build recipe. Run scripts/build-media-tools.sh on Ubuntu 24.04 with Python 3.12, GNU make, pkg-config and standard host build utilities. The only FFmpeg source addition is the VERSION build metadata recorded in changes.diff. LGPL-3.0-or-later shared FFmpeg DLLs; no GPL or nonfree library enabled. Full runtime license texts are included in the binary archive.\n')
digest=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
manifest={'schemaVersion':1,'version':config['ffmpegVersion'],'license':'LGPL-3.0-or-later','upstream':'https://ffmpeg.org/','sourceCommit':config['ffmpegCommit'],'builderSource':'scripts/build-media-tools.sh','licenseSha256':digest(package/'LICENSE.txt'),'licenseFiles':{str(p.relative_to(package)):digest(p) for p in licenses.rglob('*') if p.is_file()},'sources':{'file':sources.name,'sha256':digest(sources),'bytes':sources.stat().st_size},'platforms':{'win32-x64':{'archiveRoot':package.name,'sha256':digest(binary),'files':{p.name:digest(p) for p in (package/'bin').iterdir()}}}}
(build/'output/manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'binaryBytes':binary.stat().st_size,'sourceBytes':sources.stat().st_size,'components':len(owned),'licenses':len(list(licenses.rglob('*')))}))
PY
